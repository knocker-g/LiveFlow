const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = fs.readFileSync(require.resolve('../src/chat-read-core'), 'utf8');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8').replaceAll('\r\n', '\n');
function fn(s, n) { const i = s.indexOf('    function ' + n + '('); assert.ok(i >= 0); return s.slice(i, s.indexOf('\n    }\n', i) + 7); }
async function transforms() { return import('../tools/density-comparison/instrument-core-initialization.mjs'); }
async function run({ original = false, skip = false, prepare = () => {} } = {}) {
    const t = await transforms(), c = vm.createContext({});
    vm.runInContext('window=globalThis;', c); prepare(c);
    let error;
    try { if (!skip) vm.runInContext(original ? core : t.instrumentChatReadInitialization(core), c); } catch (e) { error = e; }
    // Use generated status function installed on the already existing diagnostic status surface.
    const seed = '    function initialTraceSnapshot() {\n    }\n' +
        '    window.LiveFlowReplayControlPlaneShadowDiagnostic = Object.freeze({ status() { return { initialAuthorityTrace: initialTraceSnapshot(), }; } });';
    vm.runInContext(t.instrumentCoreInitializationStatus(seed), c);
    return { c, error, status: () => c.window.LiveFlowReplayControlPlaneShadowDiagnostic.status().chatReadCoreInitialization };
}
test('normal MAIN publishes same Core API, order, descriptor and immutable bounded trace', async () => {
    const plain = await run({ original: true }), traced = await run();
    assert.equal(traced.error, undefined);
    assert.deepEqual(Object.keys(traced.c.LiveFlowChatReadCore), Object.keys(plain.c.LiveFlowChatReadCore));
    const s = traced.status();
    assert.deepEqual(Array.from(s.rows, r => r.stage), ['CORE_ENTER', 'API_READY', 'COMMONJS_EXPORT_COMPLETED', 'WINDOW_PUBLICATION_COMPLETED']);
    assert.equal(s.rows[3].valueMatches, true); assert.equal(s.rows[3].ownDescriptor, true);
    assert.equal(s.rows[3].target, 'GLOBAL_THIS'); assert.equal(s.currentOwnDescriptor, true);
    assert.ok(Object.isFrozen(s)); assert.ok(Object.isFrozen(s.rows)); assert.ok(s.rows.every(Object.isFrozen));
    assert.equal(traced.c.LiveFlowChatReadCore.canReevaluatePageLifecycle({ navigationPending: false }), true);
    assert.equal(traced.c.LiveFlowChatReadCore.canReevaluatePageLifecycle({ navigationPending: true }), false);
});
test('Core not executed returns NOT_OBSERVED without injecting binding', async () => {
    const h = await run({ skip: true }); assert.equal(h.status().stage, 'NOT_OBSERVED');
    assert.equal(Object.getOwnPropertyDescriptor(h.c, 'LiveFlowChatReadCore'), undefined);
});
test('successful CommonJS export keeps evaluation and publication order', async () => {
    const histories = [];
    for (const original of [true, false]) {
        const calls = []; let exported;
        const h = await run({ original, prepare(c) {
            c.module = {}; Object.defineProperty(c.module, 'exports', {
                get() { calls.push('get exports'); return {}; },
                set(value) { calls.push('set exports'); exported = value; assert.equal(c.LiveFlowChatReadCore, undefined); }
            });
        } });
        assert.equal(h.error, undefined); assert.equal(exported, h.c.LiveFlowChatReadCore); histories.push(calls);
        if (!original) assert.equal(h.status().rows.at(-1).valueMatches, true);
    }
    assert.deepEqual(histories, [['get exports', 'set exports'], ['get exports', 'set exports']]);
});
for (const kind of ['get', 'set']) test('CommonJS ' + kind + ' exception preserves exact propagation and original access count', async () => {
    const thrown = { privateMessage: 'PRIVATE_ERROR' };
    const observations = [];
    for (const original of [true, false]) {
        let gets = 0, sets = 0;
        const h = await run({ original, prepare(c) {
            c.module = {}; Object.defineProperty(c.module, 'exports', {
                get() { gets++; if (kind === 'get') throw thrown; return {}; },
                set() { sets++; throw thrown; }
            });
        } });
        assert.equal(h.error, thrown); observations.push([gets, sets]);
        assert.equal(Object.getOwnPropertyDescriptor(h.c, 'LiveFlowChatReadCore'), undefined);
        if (!original) { assert.equal(h.status().stage, 'THREW'); assert.equal(h.status().rows.at(-1).during, 'COMMONJS_EXPORT'); assert.doesNotMatch(JSON.stringify(h.status()), /PRIVATE_ERROR|privateMessage|stack/); }
    }
    assert.deepEqual(observations[0], observations[1]);
});
for (const inherited of [false, true]) test('non-writable ' + (inherited ? 'inherited' : 'own') + ' binding preserves silent publication failure', async () => {
    const h = await run({ prepare(c) {
        if (inherited) vm.runInContext("Object.defineProperty(Object.prototype,'LiveFlowChatReadCore',{value:null,configurable:true,writable:false});", c);
        else Object.defineProperty(c, 'LiveFlowChatReadCore', { value: null, writable: false, configurable: true });
    } });
    assert.equal(h.error, undefined); const s = h.status();
    assert.equal(s.stage, 'WINDOW_PUBLICATION_COMPLETED'); assert.equal(s.rows.at(-1).valueMatches, false);
    assert.equal(s.rows.at(-1).ownDescriptor, !inherited); assert.equal(vm.runInContext('window.LiveFlowChatReadCore', h.c), null);
});
test('successful publication history survives later own-binding disappearance', async () => {
    const h = await run(); vm.runInContext('delete window.LiveFlowChatReadCore;', h.c);
    const s = h.status(); assert.equal(s.rows.at(-1).valueMatches, true); assert.equal(s.currentOwnDescriptor, false);
});
test('descriptor inspection does not execute binding accessor', async () => {
    let gets = 0, sets = 0;
    const h = await run({ prepare(c) {
        Object.defineProperty(c, 'LiveFlowChatReadCore', { configurable: true,
            get() { gets++; throw Error('getter must not execute'); }, set() { sets++; } });
    } });
    assert.equal(h.error, undefined); const s = h.status();
    assert.equal(sets, 1); assert.equal(gets, 0); assert.equal(s.rows.at(-1).dataDescriptor, false);
    assert.equal(s.rows.at(-1).valueMatches, false); assert.equal(s.currentDataDescriptor, false);
});
test('diagnostic store fault and missing Core preserve actual respond fail-closed', async () => {
    const h = await run({ prepare(c) { Object.defineProperty(c, '__liveflowDevCoreInitialization', { get() { throw Error('must not execute'); }, configurable: false }); } });
    assert.equal(h.error, undefined); assert.equal(typeof h.c.LiveFlowChatReadCore.canReevaluatePageLifecycle, 'function');
    assert.equal(h.status().collectorFault, true);
    vm.runInContext('delete window.LiveFlowChatReadCore;', h.c);
    Object.assign(h.c, { pageKey: '', pageRevision: 0, pageLifecycleGeneration: 0, readCount: 0,
        pageState: {}, navigationPending: false, navigationPageDataUpdated: false,
        location: { origin: 'x', pathname: '/watch', search: '' }, document: { querySelector: () => null },
        bindWatchRootObserver: () => false, readContinuation: () => { throw Error('downstream must not execute'); } });
    vm.runInContext(fn(main, 'respond'), h.c);
    assert.equal(h.c.respond(), false); assert.equal(h.c.readCount, 0);
});
test('full diagnostic transform chain compiles; source and non-trace generator path unchanged', async () => {
    const t = await transforms();
    const { instrumentInitialAuthorityTrace } = await import('../tools/density-comparison/instrument-initial-authority.mjs');
    const { instrumentInitialRequestMain } = await import('../tools/density-comparison/instrument-initial-request.mjs');
    const { instrumentArchivedAttribution } = await import('../tools/density-comparison/instrument-archived-attribution.mjs');
    const p = instrumentInitialAuthorityTrace(main, fs.readFileSync(require.resolve('../src/replay-control-plane-core'), 'utf8'), { sourceSHA: 'a'.repeat(40), commonBuildID: 'b'.repeat(64) });
    new vm.Script(t.instrumentCoreInitializationStatus(instrumentArchivedAttribution(instrumentInitialRequestMain(p.main))));
    assert.throws(() => t.instrumentChatReadInitialization(''), /anchor/);
    assert.doesNotMatch(core, /CHAT_READ_CORE_INIT_V1|devCoreMark/);
    const generated = t.instrumentChatReadInitialization(core);
    assert.ok(generated.includes("if (typeof module !== 'undefined' && module.exports) {\n        module.exports = api;\n    }"));
    assert.doesNotMatch(generated.slice(0, generated.indexOf('    try {\n(function')), /fetch\(|postMessage|setTimeout|setInterval|addEventListener/);
});
