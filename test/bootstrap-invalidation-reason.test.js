const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../src/replay-control-plane-core');
const { createInitialAuthorityTrace } = require('../tools/density-comparison/initial-authority-trace');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8').replaceAll('\r\n', '\n');
const coreSource = fs.readFileSync(require.resolve('../src/replay-control-plane-core'), 'utf8');
const identity = { sourceSHA: 'a'.repeat(40), commonBuildID: 'b'.repeat(64) };
const modulePromise = import('../tools/density-comparison/instrument-initial-authority.mjs');
function fn(source, name) {
    const start = source.indexOf('    function ' + name + '(');
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n    }\n', start) + 7);
}
async function run(reason, instrumented, options = {}) {
    const mod = await modulePromise;
    const generated = mod.instrumentInitialAuthorityTrace(main, coreSource, identity).main;
    const collector = createInitialAuthorityTrace(identity), calls = [];
    const binding = core.createAuthorityBinding({ lifecycleId: 0, revision: 0, targetId: 'PRIVATE_TARGET', generation: 0 }).binding;
    const original = core.createReplayAuthority({ kind: 'BOOTSTRAP', opaqueToken: 'PRIVATE_TOKEN', binding, provenance: 'ADAPTER_BOOTSTRAP' }).authority;
    const video = { paused: true, ended: false, seeking: false, currentTime: 12345 };
    const c = vm.createContext({ pageLifecycleGeneration: 0, pageState: { mode: 'replay', context: {} },
        replayBootstrapEligibilityLifecycleId: 0, runtimeUserEnabled: true, readRequestInFlight: false,
        activeLoopGeneration: 0, replayReanchorLock: false, replayPlayerSeekDiagnosticLock: false,
        replayProductionControlState: core.createReplayState('BOOTSTRAPPING'),
        replayControlPlaneCore: core, replayConsumedAuthorityRegistry: core.createConsumedAuthorityRegistry(),
        replayControlShadow: { compareCapability() { calls.push('compare'); } },
        initialAuthorityTrace: options.throwing ? { record() { throw Error('PRIVATE_STACK'); }, fault: collector.fault } : collector,
        currentReplayAuthorityBinding() { calls.push('binding'); return binding; },
        getCurrentMainVideo() { calls.push('media'); return video; },
        replayAdIsActive() { calls.push({ call: 'ad', receiver: this === c }); return reason === 'AD_ACTIVE'; },
        isCurrentPageStateTarget() { calls.push({ call: 'target', receiver: this === c }); return reason !== 'TARGET_NOT_CURRENT'; },
        invalidateReplayBootstrapAuthority() { calls.push('invalidate'); core.invalidateAuthority(original); c.replayBootstrapAuthority = null; c.replayInitialBootstrapWait = null; },
        setReplayRestartStage(stage) { calls.push(stage); }, observeReplayControlShadow(event) { calls.push(event); }
    });
    const authority = { diagnostic(arg) { calls.push({ call: 'diagnostic', receiver: this === authority, binding: arg === binding }); return { ...original.diagnostic(arg), authorityCurrent: reason !== 'AUTHORITY_NOT_CURRENT' }; } };
    c.replayBootstrapAuthority = authority;
    const wait = {};
    Object.defineProperty(wait, 'authority', { get() { calls.push('wait-authority'); return reason === 'WAIT_AUTHORITY_CHANGED' ? {} : authority; } });
    Object.defineProperty(wait, 'video', { get() { calls.push('wait-media'); return reason === 'WAIT_MEDIA_CHANGED' ? {} : video; } });
    c.replayInitialBootstrapWait = reason?.startsWith('WAIT_') ? wait : null;
    Object.defineProperty(c, 'navigationPending', { get() { calls.push('navigation'); return reason === 'NAVIGATION_PENDING' ? (options.truthy || true) : false; } });
    c.document = {};
    Object.defineProperty(c.document, 'hidden', { get() { calls.push('hidden'); return reason === 'HIDDEN'; } });
    const source = instrumented ? mod.instrumentBootstrapInvalidationReason(fn(main, 'startReplayBootstrap')) : fn(main, 'startReplayBootstrap');
    vm.runInContext(fn(generated, 'initialInvalidationReason') + '\n' + source, c);
    if (options.fullBuffer) for (let i = 0; i < 300; i++) collector.record('SAFE_EVENT', {});
    const result = c.startReplayBootstrap(0);
    return { result, calls: JSON.parse(JSON.stringify(calls)), state: original.diagnostic().authorityState, trace: collector.snapshot(), c };
}
const reasons = ['HIDDEN', 'AD_ACTIVE', 'NAVIGATION_PENDING', 'AUTHORITY_NOT_CURRENT', 'TARGET_NOT_CURRENT', 'WAIT_AUTHORITY_CHANGED', 'WAIT_MEDIA_CHANGED'];
for (const reason of reasons) test('first truthy reason: ' + reason, async () => {
    const original = await run(reason, false), traced = await run(reason, true);
    assert.deepEqual(traced.calls, original.calls); assert.equal(traced.result, original.result);
    assert.equal(traced.state, 'INVALID'); assert.equal(traced.calls.filter(x => x === 'invalidate').length, 1);
    assert.deepEqual(traced.trace.rows.map(r => r.reason), [reason]);
    if (['HIDDEN', 'AD_ACTIVE', 'NAVIGATION_PENDING', 'AUTHORITY_NOT_CURRENT'].includes(reason)) assert.equal(traced.calls.some(x => x.call === 'target'), false);
    if (reason === 'WAIT_AUTHORITY_CHANGED') assert.equal(traced.calls.includes('wait-media'), false);
});
test('all operands false preserves paused defer, original return and getters; no reason', async () => {
    const original = await run(null, false), traced = await run(null, true);
    assert.deepEqual(traced.calls, original.calls); assert.equal(traced.result, original.result);
    assert.equal(traced.state, 'OBSERVED_UNUSED'); assert.equal(traced.trace.total, 0);
    assert.equal(traced.calls.includes('invalidate'), false);
});
test('helper returns exact original operand values without conversion', async () => {
    const h = await run(null, true);
    const value = { private: 'NEVER_EXPORT' };
    assert.equal(h.c.initialInvalidationReason('NAVIGATION_PENDING', value), value);
    for (const value of [false, null, undefined, 0, '', NaN]) assert.ok(Object.is(h.c.initialInvalidationReason('HIDDEN', value), value));
    assert.ok(!JSON.stringify(h.c.initialAuthorityTrace.snapshot()).includes('NEVER_EXPORT'));
});
test('collector failure and ring exhaustion preserve original invalidation operations', async () => {
    const original = await run('AD_ACTIVE', false);
    for (const options of [{ throwing: true }, { fullBuffer: true }]) {
        const traced = await run('AD_ACTIVE', true, options);
        assert.deepEqual(traced.calls, original.calls); assert.equal(traced.result, original.result); assert.equal(traced.state, 'INVALID');
        if (options.throwing) assert.equal(traced.trace.collectorFault, true);
        if (options.fullBuffer) { assert.equal(traced.trace.rows.length, 256); assert.equal(traced.trace.truncated, true); }
    }
});
test('full generated order puts reason between START_ENTRY and actual invalidation', async () => {
    const { instrumentInitialAuthorityTrace } = await modulePromise;
    const generated = instrumentInitialAuthorityTrace(main, coreSource, identity).main;
    const rows = [], c = vm.createContext({ initialTrace(step, details) { rows.push({ step, ...details }); },
        initialAuthorityTrace: { record(step, details) { rows.push({ step, ...details }); }, fault() {} },
        pageLifecycleGeneration: 0, pageState: { mode: 'replay' }, replayBootstrapEligibilityLifecycleId: 0,
        currentReplayAuthorityBinding() { return {}; }, getCurrentMainVideo() { return {}; },
        replayBootstrapAuthority: { diagnostic() { return { authorityCurrent: true, authorityKind: 'BOOTSTRAP', authorityState: 'OBSERVED_UNUSED' }; } },
        document: { hidden: false }, replayAdIsActive() { return true; },
        replayControlPlaneCore: { invalidateAuthority() { return { ok: true }; } }, replayInitialBootstrapWait: null });
    vm.runInContext(['initialInvalidationReason', 'startReplayBootstrap', 'invalidateReplayBootstrapAuthority', 'invalidateAuthorityHandle'].map(n => fn(generated, n)).join('\n'), c);
    c.startReplayBootstrap(0);
    assert.deepEqual(rows.map(r => r.step), ['BOOTSTRAP_START_ENTRY', 'BOOTSTRAP_INVALIDATION_REASON', 'AUTHORITY_INVALIDATION', 'BOOTSTRAP_HANDLE_CLEARED']);
    assert.equal(rows[1].reason, 'AD_ACTIVE');
});
test('reason records whitelist only enums and do not reread environment or expose payloads', async () => {
    const { instrumentInitialAuthorityTrace } = await modulePromise;
    const generated = instrumentInitialAuthorityTrace(main, coreSource, identity).main;
    const helper = fn(generated, 'initialInvalidationReason');
    assert.doesNotMatch(helper, /document\.|diagnosticScopes|currentTime|setTimeout|await|fetch|postMessage|initialTrace\(/);
    const collector = createInitialAuthorityTrace(identity);
    for (const reason of reasons) collector.record('BOOTSTRAP_INVALIDATION_REASON', { reason, token: 'PRIVATE_TOKEN', target: 'PRIVATE_TARGET', mediaOffset: 12345, response: {}, stack: 'PRIVATE_STACK' });
    assert.deepEqual(collector.snapshot().rows.map(r => r.reason), reasons);
    for (const row of collector.snapshot().rows) assert.deepEqual(Object.keys(row), ['sequence', 'step', 'reason']);
    assert.doesNotMatch(JSON.stringify(collector.snapshot()), /PRIVATE_|12345/);
});
test('Production manifest/source exclude reason trace; changed anchor fails closed', async () => {
    const { instrumentBootstrapInvalidationReason } = await modulePromise;
    assert.doesNotMatch(main, /initialInvalidationReason|BOOTSTRAP_INVALIDATION_REASON/);
    assert.doesNotMatch(fs.readFileSync('manifest.json', 'utf8'), /tools\/|initial-authority/);
    assert.throws(() => instrumentBootstrapInvalidationReason(main.replace('document.hidden || replayAdIsActive()', 'false || replayAdIsActive()')), /missing\/ambiguous/);
});
