const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createInitialAuthorityTrace } = require('../tools/density-comparison/initial-authority-trace');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8').replaceAll('\r\n', '\n');
const content = fs.readFileSync(require.resolve('../src/youtube-chat'), 'utf8').replaceAll('\r\n', '\n');
const core = fs.readFileSync(require.resolve('../src/replay-control-plane-core'), 'utf8');
const identity = { sourceSHA: 'a'.repeat(40), commonBuildID: 'b'.repeat(64) };
const modules = Promise.all([import('../tools/density-comparison/instrument-initial-authority.mjs'), import('../tools/density-comparison/instrument-initial-request.mjs')]);
function fn(source, name) {
    const start = source.indexOf('    function ' + name + '(');
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n    }\n', start) + 7);
}
async function generated(contentInput = content) {
    const [a, r] = await modules;
    // In-memory stand-in for the already existing generator panel anchors; never invoke build().
    const panelCopy = contentInput.replace('    const LOG_PREFIX', '    const comparisonNodes = new WeakMap();\n    const LOG_PREFIX')
        .replace('    initializePersistentSettings().then', '    function installComparisonPanel() {\n        document.documentElement.append(panel);\n    }\n    initializePersistentSettings().then');
    return { main: r.instrumentInitialRequestMain(a.instrumentInitialAuthorityTrace(main, core, identity).main),
        content: r.instrumentInitialRequestContent(panelCopy, identity) };
}
async function harness(side, instrumented, faulty = false) {
    const g = await generated(), source = instrumented ? g[side] : side === 'main' ? main : content;
    const collector = createInitialAuthorityTrace(identity), calls = [];
    const doc = {}, panel = { ownerDocument: doc, dataset: {} }; doc.getElementById = () => panel;
    const c = vm.createContext({ document: doc, initialAuthorityTrace: collector, contentInitialRequestTrace: collector,
        pageLifecycleGeneration: 0, pageRevision: 0, currentLoopGeneration: 0,
        persistentSettingsReady: true, initialTrace() {},
        window: { location: { origin: 'https://private.invalid' } } });
    // Bind the real declaration required by the MAIN listener's first typed-ACK guard.
    vm.runInContext(main.match(/^    const PENDING_ONLY_CLEAR_ACK_TYPE = '[^']+';$/m)[0], c);
    c.window.postMessage = function (...args) { calls.push({ name: 'post', receiver: this === c.window, args: JSON.parse(JSON.stringify(args)) }); };
    if (faulty) { const bad = { record() { throw Error('PRIVATE_STACK'); }, fault() { collector.fault(); }, snapshot: collector.snapshot }; c.initialAuthorityTrace = c.contentInitialRequestTrace = bad; }
    if (instrumented) vm.runInContext((side === 'main' ? ['initialRequestMark', 'initialRequestDispatchStatus'] : ['publishInitialRequestTrace', 'contentInitialRequestMark']).map(n => fn(source, n)).join('\n'), c);
    return { c, source, collector, calls, panel, doc };
}
test('Content initial snapshot send preserves original postMessage count, receiver, arguments and return', async () => {
    const outcomes = [];
    for (const traced of [false, true]) {
        const h = await harness('content', traced); h.c.REQUEST_TYPE = 'INITIAL_SNAPSHOT';
        vm.runInContext(fn(h.source, 'requestInitialContinuation'), h.c);
        const result = h.c.requestInitialContinuation(); outcomes.push({ calls: h.calls, result });
        if (traced) assert.deepEqual(h.collector.snapshot().rows.map(r => r.step), ['INITIAL_REQUEST_SEND_ENTRY', 'INITIAL_REQUEST_SEND_RETURN']);
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
});
test('postMessage exception is unchanged and does not produce normal RETURN', async () => {
    const h = await harness('content', true); h.c.REQUEST_TYPE = 'INITIAL_SNAPSHOT';
    h.c.window.postMessage = () => { throw Error('ORIGINAL_THROW'); };
    vm.runInContext(fn(h.source, 'requestInitialContinuation'), h.c);
    assert.throws(() => h.c.requestInitialContinuation(), /ORIGINAL_THROW/);
    assert.deepEqual(h.collector.snapshot().rows.map(r => r.step), ['INITIAL_REQUEST_SEND_ENTRY']);
});
test('Content settings-ready promise and initialization order are preserved', async () => {
    for (const present of [false, true]) {
        const outcomes = [];
        for (const traced of [false, true]) {
            const h = await harness('content', traced); h.c.persistentSettingsReady = false;
            h.c.applyPersistentSettings = (_, flags) => h.calls.push({ name: 'apply', flags });
            if (present) h.c.window.LiveFlowSettingsCore = { getStoredSettings(area) { h.calls.push('get'); return Promise.resolve({}); } };
            vm.runInContext(fn(h.source, 'initializePersistentSettings'), h.c);
            await h.c.initializePersistentSettings(); outcomes.push(JSON.parse(JSON.stringify({ calls: h.calls, ready: h.c.persistentSettingsReady })));
            if (traced) assert.deepEqual(h.collector.snapshot().rows.map(r => r.step), ['CONTENT_SETTINGS_READY']);
        }
        assert.deepEqual(outcomes[1], outcomes[0]);
    }
});
test('Content detect entry records readiness rejection without invoking later Product predicates', async () => {
    const h = await harness('content', true); h.c.persistentSettingsReady = false;
    h.c.isYouTubeWatchPage = () => { throw Error('must not call'); };
    vm.runInContext(fn(h.source, 'detectPage'), h.c); assert.equal(h.c.detectPage(), undefined);
    assert.deepEqual(h.collector.snapshot().rows.map(r => r.step), ['CONTENT_DETECT_ENTRY']);
});
function listener(source) {
    const start = source.indexOf("    window.addEventListener('message', (event) => {");
    return source.slice(start, source.indexOf("    window.addEventListener('yt-navigate-finish',", start));
}
for (const scenario of ['window', 'origin', 'source', 'initial', 'read']) test('MAIN dispatch boundary: ' + scenario, async () => {
    const outcomes = [];
    for (const traced of [false, true]) {
        const h = await harness('main', traced);
        h.c.REQUEST_TYPE = 'INITIAL_SNAPSHOT'; h.c.READ_REQUEST_TYPE = 'READ'; h.c.runtimeUserEnabled = true;
        h.c.pageState = { mode: 'replay' }; h.c.respond = () => h.calls.push('respond');
        h.c.startReplayBootstrap = arg => h.calls.push({ name: 'bootstrap', arg });
        h.c.window.addEventListener = function (name, cb) { h.calls.push({ name: 'listener', event: name, receiver: this === h.c.window }); h.c.callback = cb; };
        vm.runInContext(listener(h.source), h.c);
        const event = { source: scenario === 'window' ? {} : h.c.window, origin: scenario === 'origin' ? 'other' : h.c.window.location.origin,
            data: { source: scenario === 'source' ? 'other' : 'liveflow-content-script', type: scenario === 'read' ? 'READ' : 'INITIAL_SNAPSHOT', pageLifecycleGeneration: 0 } };
        h.c.callback(event); outcomes.push(h.calls);
        if (traced) {
            const rows = h.collector.snapshot().rows;
            assert.equal(rows[0].step, 'MAIN_MESSAGE_LISTENER_READY');
            if (scenario === 'initial') assert.equal(rows.at(-1).step, 'INITIAL_REQUEST_RECEIVED');
            if (['window', 'origin', 'source'].includes(scenario)) assert.equal(rows.at(-1).step, 'INITIAL_DISPATCH_GUARD_REJECTED');
            if (scenario === 'read') assert.equal(rows.some(r => r.step === 'INITIAL_REQUEST_RECEIVED'), false);
        }
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
});
for (const scenario of ['lifecycle', 'reevaluation', 'pass']) test('respond actual early evaluation: ' + scenario, async () => {
    const outcomes = [];
    for (const traced of [false, true]) {
        const h = await harness('main', traced); const location = { origin: 'x', pathname: '/watch', search: '' };
        Object.assign(h.c, { location, pageKey: 'x/watch', navigationPending: false, navigationPageDataUpdated: false,
            bindWatchRootObserver() { h.calls.push('bind'); return false; },
            readContinuation() { h.calls.push('continuation'); throw Error('AFTER_EARLY_GATE'); } });
        h.doc.querySelector = () => { h.calls.push('watch'); return {}; };
        const readCore = { getPageRevisionState() { h.calls.push('revision'); return { changed: false }; },
            canReevaluatePageLifecycle(...args) { h.calls.push({ name: 'reeval', receiver: this === readCore, args }); return scenario === 'pass'; } };
        h.c.window.LiveFlowChatReadCore = readCore;
        vm.runInContext(fn(h.source, 'respond'), h.c);
        let result, error; try { result = h.c.respond({ expectedLifecycleGeneration: scenario === 'lifecycle' ? 1 : null }); } catch (e) { error = e.message; }
        outcomes.push(JSON.parse(JSON.stringify({ calls: h.calls, result, error })));
        if (traced) {
            const rows = h.collector.snapshot().rows;
            assert.equal(rows[0].step, 'INITIAL_RESPOND_ENTRY');
            if (scenario === 'lifecycle') assert.equal(rows.at(-1).reason, 'EXPECTED_LIFECYCLE');
            if (scenario === 'reevaluation') assert.equal(rows.at(-1).reason, 'REEVALUATION_DISABLED');
            if (scenario === 'pass') assert.equal(rows.at(-1).outcome, 'ALLOWED');
        }
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
});
test('collector fault and256 truncation do not change Content dispatch', async () => {
    for (const faulty of [false, true]) {
        const h = await harness('content', true, faulty); h.c.REQUEST_TYPE = 'INITIAL_SNAPSHOT';
        for (let i = 0; i < 300; i++) h.collector.record('SAFE_EVENT');
        vm.runInContext(fn(h.source, 'requestInitialContinuation'), h.c); h.c.requestInitialContinuation();
        assert.equal(h.calls.length, 1); assert.equal(h.collector.snapshot().rows.length, 256);
        assert.equal(h.collector.snapshot().truncated, true);
        if (faulty) assert.equal(h.collector.snapshot().collectorFault, true);
    }
});
test('MAIN collector failure does not prevent actual initial dispatch or respond', async () => {
    const h = await harness('main', true, true);
    Object.assign(h.c, { REQUEST_TYPE: 'INITIAL_SNAPSHOT', runtimeUserEnabled: true, respond: () => h.calls.push('respond') });
    h.c.window.addEventListener = (_, cb) => h.c.callback = cb;
    vm.runInContext(listener(h.source), h.c);
    h.c.callback({ source: h.c.window, origin: h.c.window.location.origin, data: { source: 'liveflow-content-script', type: 'INITIAL_SNAPSHOT' } });
    assert.deepEqual(h.calls, ['respond']); assert.equal(h.collector.snapshot().collectorFault, true);
});
test('Content DOM export failure remains passive and marks fault without suppressing send', async () => {
    const h = await harness('content', true); h.c.REQUEST_TYPE = 'INITIAL_SNAPSHOT';
    h.doc.getElementById = () => { throw Error('DOM_UNAVAILABLE'); };
    vm.runInContext(fn(h.source, 'requestInitialContinuation'), h.c); h.c.requestInitialContinuation();
    assert.equal(h.calls.length, 1); assert.equal(h.collector.snapshot().collectorFault, true);
});
test('same-document DOM export is read-only, independent and explicitly UNORDERED', async () => {
    const h = await harness('main', true);
    const c = createInitialAuthorityTrace(identity); c.record('INITIAL_REQUEST_SEND_RETURN');
    const raw = c.snapshot(); raw.token = 'PRIVATE_TOKEN'; raw.rows[0].payload = 'PRIVATE_URL';
    h.panel.dataset.initialRequestTrace = JSON.stringify(raw);
    const s = h.c.initialRequestDispatchStatus(); assert.equal(s.crossWorldOrdering, 'UNORDERED');
    assert.equal(s.documentCorrespondence, 'CURRENT_DOCUMENT_DOM_EXPORT');
    assert.doesNotMatch(JSON.stringify(s), /PRIVATE_/);
    s.content.rows.length = 0; assert.equal(h.c.initialRequestDispatchStatus().content.rows.length, 1);
    h.panel.ownerDocument = {}; assert.equal(h.c.initialRequestDispatchStatus().documentCorrespondence, 'NOT_OBSERVED');
    h.panel.ownerDocument = h.doc; h.panel.dataset.initialRequestTrace = '{';
    assert.equal(h.c.initialRequestDispatchStatus().collectorFault, true);
});
test('Product listeners/scheduling remain unchanged; diagnostic marks contain no sensitive payload', async () => {
    const g = await generated();
    assert.equal((await generated(content.replaceAll('\n', '\r\n'))).content, g.content,
        'CRLF input has identical executable instrumentation and request behavior');
    await assert.rejects(generated(content.replace('            type: REQUEST_TYPE', '            type: CHANGED_REQUEST_TYPE')), /missing\/ambiguous/);
    for (const side of ['main', 'content']) {
        const original = side === 'main' ? main : content, transformed = g[side];
        assert.deepEqual(transformed.match(/window\.addEventListener\([^\n]+/g), original.match(/window\.addEventListener\([^\n]+/g));
        assert.equal((transformed.match(/window\.postMessage\(/g) || []).length, (original.match(/window\.postMessage\(/g) || []).length);
        assert.equal((transformed.match(/queueMicrotask\(/g) || []).length, (original.match(/queueMicrotask\(/g) || []).length);
        new vm.Script(transformed);
    }
    const helper = fn(g.main, 'initialRequestMark') + fn(g.content, 'contentInitialRequestMark');
    assert.doesNotMatch(helper, /currentTime|token|target|event\.data|payload|fetch|postMessage|await|setTimeout|document\.hidden/);
    assert.doesNotMatch(fs.readFileSync('manifest.json','utf8'), /tools\/|initial-request/);
    assert.doesNotMatch(main + content, /initialRequestMark|contentInitialRequestMark|initialRequestDispatch/);
});
