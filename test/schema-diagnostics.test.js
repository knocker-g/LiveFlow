const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    sanitizeShape,
    fingerprintShape,
    createSchemaCollector
} = require('../src/schema-diagnostics-core.js');

function syntheticResponse(renderer = {
    message: { runs: [{ text: 'PRIVATE_MESSAGE' }] },
    authorName: { simpleText: 'PRIVATE_AUTHOR' },
    authorPhoto: { thumbnails: [{ url: 'https://private.invalid/avatar' }] },
    continuation: 'PRIVATE_CONTINUATION',
    visitorData: 'PRIVATE_VISITOR',
    trackingParams: 'PRIVATE_TRACKING'
}) {
    return {
        continuationContents: {
            liveChatContinuation: {
                actions: [{ unknownAction: { item: { unknownRenderer: renderer } } }]
            }
        }
    };
}

test('shape sanitizer replaces primitive values and sensitive content with types', () => {
    const shape = sanitizeShape({
        message: 'PRIVATE_MESSAGE', authorName: 'PRIVATE_AUTHOR', count: 92831,
        enabled: true, missing: null, url: 'https://private.invalid/image',
        continuation: 'PRIVATE_CONTINUATION', visitorData: 'PRIVATE_VISITOR',
        trackingParams: 'PRIVATE_TRACKING'
    });
    const output = JSON.stringify(shape);
    for (const secret of ['PRIVATE_MESSAGE', 'PRIVATE_AUTHOR', '92831', 'https://private.invalid/image', 'PRIVATE_CONTINUATION', 'PRIVATE_VISITOR', 'PRIVATE_TRACKING']) {
        assert.equal(output.includes(secret), false);
    }
    assert.deepEqual(shape, {
        message: 'string', authorName: 'string', count: 'number', enabled: 'boolean',
        missing: 'null', url: 'string', continuation: 'string', visitorData: 'string', trackingParams: 'string'
    });
});

test('shape sanitizer records nested, non-empty, and empty array structure only', () => {
    const shape = sanitizeShape({ empty: [], runs: [{ text: 'FIRST_SECRET' }, { text: 'UNINSPECTED_SECRET' }] });
    assert.deepEqual(shape.empty, { type: 'array', length: 'empty' });
    assert.deepEqual(shape.runs, { type: 'array', length: 'non-empty', element: { text: 'string' } });
    assert.equal(JSON.stringify(shape).includes('UNINSPECTED_SECRET'), false);
});

test('shape sanitizer bounds depth, keys, nodes, output, and circular references', () => {
    const circular = { child: {} };
    circular.child.parent = circular;
    assert.equal(sanitizeShape(circular).child.parent, '<circular>');
    assert.deepEqual(sanitizeShape({ a: { b: { c: 'secret' } } }, { maxDepth: 2 }), { a: { b: '<max-depth>' } });
    assert.deepEqual(sanitizeShape({ a: 1, b: 2 }, { maxObjectKeys: 1 }), { a: 'number', '<truncated-keys>': 'present' });
    assert.equal(JSON.stringify(sanitizeShape({ a: { b: 1 }, c: 2 }, { maxNodes: 2 })).includes('<node-limit>'), true);
    assert.deepEqual(sanitizeShape({ verboseProperty: { nestedProperty: 'secret' } }, { maxOutputChars: 10 }), { '<output-limit>': 'present' });
});

test('shape sanitizer handles malformed access and redacts dynamic keys', () => {
    const input = { 'identifier-123-private': 'PRIVATE_VALUE' };
    Object.defineProperty(input, 'broken', { enumerable: true, get() { throw new Error('test'); } });
    assert.deepEqual(sanitizeShape(input), { '<sanitizer-error>': 'present' });
    assert.deepEqual(sanitizeShape({ 'identifier-123-private': 'PRIVATE_VALUE' }), { '<dynamic-key>': 'string' });
});

test('shape fingerprints are deterministic and contain no source values', () => {
    const a = fingerprintShape({ b: 'string', a: 'number' });
    const b = fingerprintShape({ a: 'number', b: 'string' });
    assert.equal(a, b);
    assert.match(a, /^shape-[0-9a-f]{8}$/);
});

test('collector is opt-in and suppresses duplicate unknown action and renderer shapes', () => {
    const logs = [];
    const collector = createSchemaCollector({ logger: (...parts) => logs.push(parts.join(' ')) });
    assert.deepEqual(collector.collect(syntheticResponse()), { observed: 0, duplicate: 0 });
    collector.enable();
    assert.deepEqual(collector.collect(syntheticResponse()), { observed: 1, duplicate: 0 });
    assert.deepEqual(collector.collect(syntheticResponse()), { observed: 0, duplicate: 1 });
    const summary = collector.getSummary();
    assert.equal(summary.observedShapeCount, 1);
    assert.equal(summary.actionRendererShapes[0].actionType, 'unknownAction');
    assert.equal(summary.actionRendererShapes[0].rendererType, 'unknownRenderer');
    assert.deepEqual(summary.actionRendererShapes[0].nestedActionTypes, ['unknownAction']);
    const output = JSON.stringify({ logs, summary });
    for (const secret of ['PRIVATE_MESSAGE', 'PRIVATE_AUTHOR', 'private.invalid', 'PRIVATE_CONTINUATION', 'PRIVATE_VISITOR', 'PRIVATE_TRACKING']) {
        assert.equal(output.includes(secret), false);
    }
});

test('collector summarizes badge and message-run shapes without their values', () => {
    const collector = createSchemaCollector({ logger() {} });
    collector.enable();
    collector.collect(syntheticResponse({
        authorBadges: [{ badgeRenderer: { icon: { iconType: 'PRIVATE_ROLE' } } }],
        message: { runs: [{ emoji: { image: { thumbnails: [{ url: 'PRIVATE_EMOJI_URL' }] }, accessibility: { label: 'PRIVATE_ALT' } } }] }
    }));
    const output = JSON.stringify(collector.getSummary());
    assert.equal(collector.getSummary().badgeStructures.length, 1);
    assert.equal(collector.getSummary().messageRunStructures.length, 1);
    assert.equal(output.includes('PRIVATE_ROLE'), false);
    assert.equal(output.includes('PRIVATE_EMOJI_URL'), false);
    assert.equal(output.includes('PRIVATE_ALT'), false);
});

test('collector applies a session-wide shape limit and reset clears session state', () => {
    const collector = createSchemaCollector({ logger() {}, limits: { maxShapes: 1 } });
    collector.enable();
    collector.collect(syntheticResponse({ authorBadges: [], message: { runs: [] } }));
    const summary = collector.getSummary();
    assert.equal(summary.totalShapeCount, 1);
    assert.equal(summary.shapeLimitReached, true);
    const reset = collector.reset();
    assert.equal(reset.totalShapeCount, 0);
    assert.equal(reset.shapeLimitReached, false);
});

test('collector safely ignores malformed inputs and isolates logger failures', () => {
    const collector = createSchemaCollector({ logger() { throw new Error('logger failure'); } });
    collector.enable();
    assert.deepEqual(collector.collect(null), { observed: 0, duplicate: 0 });
    assert.equal(collector.collect(syntheticResponse()).failed, true);
    assert.doesNotThrow(() => collector.getSummary());
});

test('collector printSummary emits and returns only the bounded sanitized summary', () => {
    const logs = [];
    const collector = createSchemaCollector({ logger: (...parts) => logs.push(parts.join(' ')), limits: { maxActions: 1, maxShapes: 2, maxSummaryChars: 400 } });
    collector.enable();
    collector.collect(syntheticResponse());
    const summary = collector.printSummary();
    assert.equal(summary.totalShapeCount <= 2, true);
    assert.equal(JSON.stringify(summary).length <= 400, true);
    assert.equal(summary.summaryTruncated, true);
    assert.equal(logs.at(-1), JSON.stringify(summary, null, 2));
});

test('diagnostics integration is MAIN-world, permission-neutral, and network-free', () => {
    const root = path.resolve(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const source = fs.readFileSync(path.join(root, 'src', 'schema-diagnostics-core.js'), 'utf8');
    const pageState = fs.readFileSync(path.join(root, 'src', 'page-state-main.js'), 'utf8');
    const main = manifest.content_scripts.find((entry) => entry.world === 'MAIN');
    const isolated = manifest.content_scripts.find((entry) => entry.world === 'ISOLATED');
    assert.equal(main.js.includes('src/schema-diagnostics-core.js'), true);
    assert.equal(isolated.js.includes('src/schema-diagnostics-core.js'), false);
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
    assert.match(pageState, /LiveFlowSchemaDiagnostics\?\.collect\?\.\(payload\)/);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|setInterval|chrome\.storage|clipboard/);
});
