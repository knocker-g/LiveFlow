const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
    replayEndpoint,
    requestBodyShape,
    collectResponseShape,
    createReplayProbeCollector
} = require('../src/replay-schema-probe-core.js');

const root = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'src/replay-schema-probe.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('replay endpoint matching strips query values and rejects other paths', () => {
    assert.equal(replayEndpoint('https://www.youtube.com/live_chat_replay?v=SECRET'), '/live_chat_replay');
    assert.equal(replayEndpoint('/youtubei/v1/live_chat/get_live_chat_replay?key=SECRET'), '/youtubei/v1/live_chat/get_live_chat_replay');
    assert.equal(replayEndpoint('/youtubei/v1/live_chat/get_live_chat'), null);
});

test('request body summary retains only static keys and primitive types', () => {
    const shape = requestBodyShape(JSON.stringify({ context: { client: { visitorData: 'visitor-secret' } }, continuation: 'continuation-secret', videoId: 'video-secret', enabled: true, count: 42, abc123: 'dynamic-secret' }));
    assert.deepEqual(shape, [
        { key: 'context', type: 'object' },
        { key: 'continuation', type: 'string' },
        { key: 'count', type: 'number' },
        { key: 'enabled', type: 'boolean' },
        { key: 'videoId', type: 'string' }
    ]);
    const output = JSON.stringify(shape);
    for (const secret of ['visitor-secret', 'continuation-secret', 'video-secret', 'dynamic-secret', '42']) assert.equal(output.includes(secret), false);
});

test('response walker emits normalized paths, names, types, and never values', () => {
    const response = {
        continuationContents: { liveChatContinuation: {
            actions: [{ replayChatItemAction: { videoOffsetTimeMsec: '12345', item: { liveChatPaidMessageRenderer: { id: 'channel-secret', timestampUsec: '999', trackingParams: 'tracking-secret' } } } }],
            continuations: [{ liveChatReplayContinuationData: { continuation: 'continuation-secret', timeUntilLastMessageMsec: 500 } }]
        } }, visitorData: 'visitor-secret', apiKey: 'api-key-secret'
    };
    const result = collectResponseShape(response);
    assert.ok(result.replayTimingCandidates.some((entry) => entry.path === 'continuationContents.liveChatContinuation.actions[].replayChatItemAction.videoOffsetTimeMsec' && entry.type === 'string'));
    assert.ok(result.continuationPaths.some((entry) => entry.path.includes('liveChatReplayContinuationData.continuation')));
    assert.ok(result.continuationTimingPaths.some((entry) => entry.path.includes('timeUntilLastMessageMsec')));
    assert.ok(result.rendererNames.includes('liveChatPaidMessageRenderer'));
    assert.ok(result.actionNames.includes('replayChatItemAction'));
    assert.ok(result.continuationDataNames.includes('liveChatReplayContinuationData'));
    const output = JSON.stringify(result);
    for (const secret of ['12345', 'channel-secret', 'tracking-secret', 'continuation-secret', 'visitor-secret', 'api-key-secret', '999', '500']) assert.equal(output.includes(secret), false);
});

test('timing classification ranks video offsets and omits UI paths from session summary', () => {
    const shape = collectResponseShape({
        actions: [{ replayChatItemAction: { timestampUsec: 'secret', videoOffsetTimeMsec: 'secret' } }],
        continuations: [{ liveChatReplayContinuationData: { timeoutMs: 42 } }],
        layout: { animationTimeMs: 99 }
    });
    assert.match(shape.replayTimingCandidates[0].path, /videoOffsetTimeMsec$/);
    assert.ok(shape.continuationTimingPaths.some((entry) => /timeoutMs$/.test(entry.path)));
    const collector = createReplayProbeCollector(); collector.enable(); collector.observeResponse({ layout: { animationTimeMs: 99 } });
    const summary = collector.summary();
    assert.equal(Object.hasOwn(summary, 'visualUiTimingPaths'), false);
    assert.equal(summary.ignoredTimingCounts.visualUi, 1);
});

test('walker deduplicates paths and enforces category, depth, array, and node bounds', () => {
    const result = collectResponseShape({ actions: [
        { replayAction: { offsetTimeMsec: 'one', nested: { deep: { deeper: { deepest: { value: 'secret' } } } } } },
        { replayAction: { offsetTimeMsec: 'two' } }
    ] }, { maxArrayItems: 1, maxDepth: 3, maxNodes: 4, maxTimingPaths: 1 });
    assert.ok(result.nodesVisited <= 4);
    assert.ok(result.replayTimingCandidates.length <= 1);
    assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('malformed objects and strict summary size fail safe', () => {
    const malformed = new Proxy({}, { ownKeys() { throw new Error('blocked'); } });
    assert.deepEqual(collectResponseShape(malformed).responseTopLevelKeys, []);
    const collector = createReplayProbeCollector({ limits: { maxSummaryChars: 700, maxNames: 50 } }); collector.enable();
    collector.observeRequest({ url: '/live_chat_replay' });
    collector.observeResponse({ actions: [{ oneRenderer: { replayOffsetTime: 'secret' }, twoRenderer: {}, threeRenderer: {} }] });
    const summary = collector.summary();
    assert.ok(JSON.stringify(summary).length <= 700);
    assert.equal(summary.truncated.summary, true);
});

test('collector is disabled by default and deduplicates bounded summaries', () => {
    const collector = createReplayProbeCollector({ limits: { maxTimingPaths: 1, maxNames: 1, maxHistory: 2, maxSummaryChars: 5000 } });
    assert.equal(collector.observeRequest({ url: '/live_chat_replay?x=secret' }), false);
    assert.equal(collector.summary().endpoints.length, 0);
    collector.enable();
    collector.observeRequest({ url: '/live_chat_replay?x=secret', method: 'GET', headerNames: [] });
    collector.observeResponse({ actions: [{ replayAction: { offsetTimeMsec: 'secret' } }] });
    collector.observeResponse({ actions: [{ replayAction: { offsetTimeMsec: 'other' } }] });
    const summary = collector.summary();
    assert.deepEqual(summary.endpoints, [{ path: '/live_chat_replay', method: 'GET', count: 1 }]);
    assert.equal(summary.replayTimingCandidates.length, 1);
    assert.equal(JSON.stringify(summary).includes('secret'), false);
    assert.deepEqual(summary.authPresence, { cookieSeen: 'unknown', authorizationSeen: 'unknown' });
});

test('collector reports only explicit auth header-name presence without values', () => {
    const collector = createReplayProbeCollector(); collector.enable();
    collector.observeRequest({ url: '/live_chat_replay', headerNames: ['Cookie', 'Authorization'], body: '{"token":"secret"}' });
    const summary = collector.summary();
    assert.deepEqual(summary.authPresence, { cookieSeen: true, authorizationSeen: true });
    assert.equal(JSON.stringify(summary).includes('secret'), false);
});

test('operation deltas count endpoint requests and history stays bounded', () => {
    const collector = createReplayProbeCollector({ limits: { maxHistory: 2 } }); collector.enable();
    collector.startOperation('forwardSeek');
    collector.observeRequest({ url: '/live_chat_replay' });
    collector.finishOperation('forwardSeek');
    collector.startOperation('rate20');
    collector.observeRequest({ url: '/youtubei/v1/live_chat/get_live_chat_replay', method: 'POST' });
    collector.recordVideoEvent('play'); collector.recordVideoEvent('pause'); collector.recordVideoEvent('ratechange');
    const summary = collector.summary();
    assert.equal(summary.operationDeltas.forwardSeek, 1);
    assert.equal(summary.operationDeltas.rate20, 1);
    assert.deepEqual(summary.eventHistory.map((entry) => entry.event), ['pause', 'ratechange']);
});

test('runtime is explicit opt-in, passive, bounded, and has no external output', () => {
    assert.match(runtimeSource, /enable\(\) \{ collector\.enable\(\); installHooks\(\)/);
    assert.doesNotMatch(runtimeSource, /setInterval|requestAnimationFrame|sendBeacon|WebSocket|chrome\.storage|localStorage|sessionStorage|clipboard|innerHTML/);
    assert.doesNotMatch(runtimeSource, /credentials\s*:|Authorization\s*:|Cookie\s*:/);
    assert.match(runtimeSource, /originalFetch\.apply\(this, args\)/);
    assert.equal((runtimeSource.match(/originalFetch\.apply\(this, args\)/g) || []).length, 1);
});

test('runtime enable is idempotent, fetch stays nonblocking, and disable restores hooks', async () => {
    let fetchCalls = 0;
    let cloneCalls = 0;
    const response = { clone() { cloneCalls += 1; return { json: async () => ({ replayAction: { videoOffsetTimeMsec: 'secret' } }) }; } };
    const originalFetch = () => { fetchCalls += 1; return Promise.resolve(response); };
    function FakeXHR() {}
    FakeXHR.prototype.open = function () {};
    FakeXHR.prototype.send = function () {};
    FakeXHR.prototype.setRequestHeader = function () {};
    FakeXHR.prototype.addEventListener = function () {};
    const listeners = new Map();
    const context = {
        window: { LiveFlowReplayProbeCore: require('../src/replay-schema-probe-core.js'), fetch: originalFetch },
        XMLHttpRequest: FakeXHR,
        Headers: class { constructor() {} keys() { return []; } },
        document: { querySelector() { return null; }, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } },
        console: { log() {} }, Promise, URL
    };
    vm.runInNewContext(runtimeSource, context);
    assert.equal(context.window.fetch, originalFetch);
    context.window.LiveFlowReplayProbe.enable();
    const firstHook = context.window.fetch;
    context.window.LiveFlowReplayProbe.enable();
    assert.equal(context.window.fetch, firstHook);
    const returned = context.window.fetch('/youtubei/v1/live_chat/get_live_chat_replay?key=secret', { method: 'POST', body: '{"continuation":"secret"}' });
    assert.equal(fetchCalls, 1);
    assert.equal(await returned, response);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(cloneCalls, 1);
    context.window.LiveFlowReplayProbe.disable();
    assert.equal(context.window.fetch, originalFetch);
    assert.equal(FakeXHR.prototype.open.name, '');
    assert.equal(listeners.size, 0);
});

test('manifest loads passive probe in MAIN world without permission expansion', () => {
    const main = manifest.content_scripts.find((entry) => entry.world === 'MAIN');
    assert.ok(main.js.includes('src/replay-schema-probe-core.js'));
    assert.ok(main.js.includes('src/replay-schema-probe.js'));
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
    assert.equal(Object.hasOwn(manifest, 'background'), false);
});
