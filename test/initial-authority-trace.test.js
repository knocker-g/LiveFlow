const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createInitialAuthorityTrace } = require('../tools/density-comparison/initial-authority-trace');
const chat = require('../src/chat-read-core');
const originalMain = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8');
const originalCore = fs.readFileSync(require.resolve('../src/replay-control-plane-core'), 'utf8');
const identity = { sourceSHA: 'a'.repeat(40), commonBuildID: 'b'.repeat(64) };
const injected = import('../tools/density-comparison/instrument-initial-authority.mjs').then(m =>
    m.instrumentInitialAuthorityTrace(originalMain, originalCore, identity));
function fn(text, name) {
    text = text.replaceAll('\r\n', '\n');
    let start = text.indexOf('    function ' + name + '(');
    if (start < 0) start = text.indexOf('    async function ' + name + '(');
    const end = text.indexOf('\n    }\n', start) + 7;
    assert.ok(start >= 0 && end > start, name);
    return text.slice(start, end);
}
function loadCore(text) {
    const c = vm.createContext({ module: { exports: {} } }); vm.runInContext(text, c); return c.module.exports;
}
async function harness(traced, { paused = true, hidden = false, collectorThrows = false } = {}) {
    const generated = await injected, calls = [], lifecycleEvents = [], stages = [];
    const api = loadCore(traced ? generated.core : originalCore), counted = {};
    for (const [key, value] of Object.entries(api)) counted[key] = typeof value !== 'function' ? value : function (...args) {
        calls.push({ name: key,
            receiver: this === counted, kind: args[0]?.kind || args[0]?.expectedKind || args[1] || null });
        return value.apply(this, args);
    };
    const video = { paused, ended: false, seeking: false, currentTime: 0, duration: 600 };
    const doc = { hidden, visibilityState: hidden ? 'hidden' : 'visible' };
    const readCore = { ...chat, canStartReadLoop(f) { calls.push({ name: 'canStartReadLoop', facts: { ...f } }); return chat.canStartReadLoop(f); },
        canScheduleNextRead(f) { calls.push({ name: 'canScheduleNextRead', facts: { ...f } }); return chat.canScheduleNextRead(f); } };
    const context = vm.createContext({ document: doc, window: { LiveFlowChatReadCore: readCore, location: { origin: 'https://fixture.invalid' },
        postMessage(m) { lifecycleEvents.push(JSON.parse(JSON.stringify(m))); } }, AbortController,
        pageLifecycleGeneration: 0, pageRevision: 0, currentLoopGeneration: 0, activeLoopGeneration: 0, readCount: 0,
        diagnosticScopes: { currentEpoch: () => 0 }, replayControlPlaneCore: counted,
        replayProductionControlState: api.createReplayState('STOPPED'), replayConsumedAuthorityRegistry: api.createConsumedAuthorityRegistry(),
        replayBootstrapAuthority: null, replayBootstrapEligibilityLifecycleId: -1, replaySeekAuthority: null,
        replayInitialBootstrapWait: null, runtimeUserEnabled: true,
        replayPausedSequentialAuthority: null, replayReanchorLock: false, replayPlayerSeekDiagnosticLock: false,
        readRequestInFlight: false, navigationPending: false, pageState: { mode: 'replay', targetIdentity: 'fixture', context: {}, continuation: '' },
        replayRestartDiagnostic: { sequence: 1 }, replayPending: [], replayStartTimeSeconds: 0,
        replayAwaitingFirstFreshSequentialResponse: false, replaySequentialResumeHandoff: false,
        replayReanchorIntent: null, replayAdActive: false, replayAdExitNeedsReanchor: false,
        replaySeekInProgress: false, replaySeekNeedsReanchor: false, replaySeekEpoch: 0,
        replayForegroundRecoveryOwnedVideo: null, replayReanchorAbortController: null, replayForegroundRetainedAbortController: null,
        activeAbortController: null, deferredVisibilityResumeGeneration: null, deferredReadStartGeneration: null, readStopReason: 'none',
        LIFECYCLE_DIAGNOSTIC_TYPE: 'lifecycle',
        getCurrentMainVideo() { calls.push({ name: 'getCurrentMainVideo' }); return video; },
        isCurrentPageStateTarget() { calls.push({ name: 'isCurrentPageStateTarget' }); return true; },
        replaySeekAuthorityEligibleForHidden() { calls.push({ name: 'retentionEligibility' }); return false; },
        replayAdIsActive() { calls.push({ name: 'adEligibility' }); return false; },
        observeReplayForegroundHidden() {}, observeReplayForegroundVisible() {},
        stopReadLoop(reason) { calls.push({ name: 'stopReadLoop', reason }); context.currentLoopGeneration++; context.activeLoopGeneration = 0; },
        setReplayRestartStage(...args) { stages.push(args); },
        async performRead(...args) { calls.push({ name: 'performRead', token: args[0], mode: args[6] }); return { ok: false, errorType: 'invalid_json' }; }
    });
    const main = traced ? generated.main : originalMain;
    if (traced) {
        const start = main.indexOf('function createInitialAuthorityTrace('), end = main.indexOf('    const replayControlShadow =', start);
        let setup = main.slice(start, end);
        if (collectorThrows) setup = setup.replace(/const initialAuthorityTrace = createInitialAuthorityTrace\([^\n]+\);/,
            'const initialAuthorityTrace = { record() { throw Error("SECRET_FAULT"); }, fault() {}, snapshot() { return { collectorFault: true }; } };');
        vm.runInContext(setup, context);
    }
    context.replayControlShadow = api.createShadowController(undefined,
        traced ? (step, details) => context.initialTrace(step, details) : undefined);
    const functions = ['currentReplayAuthorityBinding', 'createReplayPipelineDiagnostic', 'createReplayForegroundRecoveryDiagnostic',
        'observeReplayControlShadow', 'authorizeReplayAuthority', 'acceptReplayBootstrapCandidate', 'startReplayBootstrap',
        'invalidateAuthorityHandle', 'invalidateReplayBootstrapAuthority', 'restartReplayFromCurrentPosition',
        'enterReplaySuspended', 'resumeReadAfterVisibility', 'startReadLoop', 'postLifecycleDiagnostic'];
    vm.runInContext(functions.map(n => fn(main, n)).join('\n') +
        '\nreplayPipelineDiagnostic = createReplayPipelineDiagnostic();\nreplayForegroundRecoveryDiagnostic = createReplayForegroundRecoveryDiagnostic();', context);
    const originalLoop = context.startReadLoop;
    context.startReadLoop = function (...args) { calls.push({ name: 'startReadLoop', lifecycle: args[0], source: args[1] }); context.lastGrant = args[2]; context.running = originalLoop.apply(this, args); return context.running; };
    context.observeReplayControlShadow('LIFECYCLE_START', {}, 'BOOTSTRAPPING');
    return { c: context, video, doc, calls, snapshot: () => traced ? context.initialTraceSnapshot() : null,
        behavior: () => JSON.parse(JSON.stringify({ calls, lifecycleEvents, stages, phase: context.replayProductionControlState,
            generation: context.currentLoopGeneration, active: context.activeLoopGeneration, readCount: context.readCount,
            registry: context.replayConsumedAuthorityRegistry.diagnostic() })) };
}

function enablePlay(h) {
    h.video.paused = false;
    h.c.beginReplayRestart = () => {};
    h.c.respond = () => false;
    h.doc.querySelector = () => null;
    h.c.window.queueMicrotask = callback => callback();
    h.c.restartReplayFromCurrentPosition({ type: 'play', target: h.video });
}

test('paused bootstrap hands original unused Authority to genuine play once; duplicates cannot amplify READ', async () => {
    const h = await harness(true); h.c.acceptReplayBootstrapCandidate('PRIVATE');
    const original = h.c.replayBootstrapAuthority;
    h.c.startReplayBootstrap(0); h.c.startReplayBootstrap(0);
    assert.equal(h.c.currentLoopGeneration, 0); assert.equal(h.c.readCount, 0);
    assert.equal(h.c.lastGrant, undefined); assert.equal(h.c.replayInitialBootstrapWait.authority, original);
    assert.equal(h.c.replayProductionControlState.phase, 'BOOTSTRAPPING');
    enablePlay(h); await h.c.running;
    assert.equal(original.diagnostic().authorityState, 'CONSUMED');
    assert.equal(h.c.lastGrant.diagnostic().state, 'CLAIMED');
    assert.equal(h.c.replayInitialBootstrapWait, null);
    assert.equal(h.snapshot().firstMismatch, null);
    enablePlay(h); h.c.startReplayBootstrap(0); h.c.acceptReplayBootstrapCandidate('OTHER');
    assert.equal(h.calls.filter(c => c.name === 'authorizeAuthorityRequest').length, 1);
    assert.equal(h.calls.filter(c => c.name === 'claimAuthorityRequestGrant').length, 1);
    assert.equal(h.calls.filter(c => c.name === 'performRead').length, 1);
});

test('deferred bootstrap invalidates for HIDDEN/AD and cannot resurrect', async () => {
    for (const reason of ['HIDDEN', 'AD']) {
        const h = await harness(false); h.c.acceptReplayBootstrapCandidate('PRIVATE'); h.c.startReplayBootstrap(0);
        const handle = h.c.replayBootstrapAuthority;
        h.c.enterReplaySuspended(reason);
        assert.equal(handle.diagnostic().authorityState, 'INVALID');
        assert.equal(h.c.replayInitialBootstrapWait, null);
        enablePlay(h); h.c.startReplayBootstrap(0);
        assert.equal(h.c.acceptReplayBootstrapCandidate('OTHER'), false);
        assert.equal(h.calls.filter(c => c.name === 'performRead').length, 0);
    }
});

test('paused handoff fails closed for currentness, ownership, context, capabilities and exclusion conflicts', async () => {
    const changes = {
        lifecycle: h => h.c.pageLifecycleGeneration++, revision: h => h.c.pageRevision++,
        target: h => h.c.pageState.targetIdentity = 'other', generation: h => h.c.currentLoopGeneration++,
        ownership: h => h.c.getCurrentMainVideo = () => ({ ...h.video }),
        targetFacts: h => h.c.isCurrentPageStateTarget = () => false,
        context: h => h.c.pageState.context = null,
        capability: h => h.c.replayControlPlaneCore.canUseCapabilityPath = () => ({ allowed: false }),
        hidden: h => h.doc.hidden = true, ad: h => h.c.replayAdIsActive = () => true,
        navigation: h => h.c.navigationPending = true,
        disabled: h => h.c.runtimeUserEnabled = false,
        ended: h => h.video.ended = true, seeking: h => h.video.seeking = true,
        timing: h => h.video.currentTime = NaN,
        inFlight: h => h.c.readRequestInFlight = true, active: h => h.c.activeLoopGeneration = 7,
        reanchor: h => h.c.replayReanchorLock = true, diagnostic: h => h.c.replayPlayerSeekDiagnosticLock = true
    };
    for (const [name, change] of Object.entries(changes)) {
        const h = await harness(false); h.c.acceptReplayBootstrapCandidate('PRIVATE'); h.c.startReplayBootstrap(0);
        change(h); h.video.paused = false; const generation = h.c.currentLoopGeneration;
        h.c.startReplayBootstrap(h.c.pageLifecycleGeneration);
        assert.equal(h.calls.filter(c => c.name === 'authorizeAuthorityRequest').length, 0, name);
        assert.equal(h.calls.filter(c => c.name === 'performRead').length, 0, name);
        assert.equal(h.c.currentLoopGeneration, generation, name);
    }
});

test('navigation and target transition use bootstrap invalidation, never a grant retention path', () => {
    for (const name of ['invalidatePageLifecycle', 'applyLiveToReplayModeTransition', 'respond']) {
        assert.match(fn(originalMain, name), /invalidateReplayBootstrapAuthority\(\)/);
    }
    assert.match(fn(originalMain, 'invalidateReplayBootstrapAuthority'), /invalidateAuthorityHandle\(replayBootstrapAuthority\)/);
    assert.match(fn(originalMain, 'respond'), /pageState\.targetIdentity !== targetIdentity\) invalidateReplayBootstrapAuthority\(\)/);
});

test('actual navigation invalidates original deferred bootstrap before any later play', async () => {
    const h = await harness(false); h.c.acceptReplayBootstrapCandidate('PRIVATE'); h.c.startReplayBootstrap(0);
    const handle = h.c.replayBootstrapAuthority;
    for (const name of ['observeReplayRuntimeAccounting', 'terminateReplayForegroundRetainedDiagnostic',
        'abortReplayPlayerSeekDiagnostic', 'invalidateReplayCredentiallessSchemaDiagnostic', 'invalidateReplaySeekAuthority',
        'openReplayDiagnosticScope', 'resetReplayGapOriginDiagnostic', 'disconnectWatchRootObserver', 'postLifecycleInvalidated']) h.c[name] = () => {};
    h.c.createReplayTemporalStarvationDiagnostic = h.c.createReplayTimingDiagnosticSeen = () => ({});
    h.c.establishedTargetIdentity = 'fixture';
    vm.runInContext(fn(originalMain, 'invalidatePageLifecycle'), h.c);
    h.c.invalidatePageLifecycle();
    assert.equal(handle.diagnostic().authorityState, 'INVALID');
    assert.equal(h.c.replayInitialBootstrapWait, null);
    assert.equal(h.c.startReplayBootstrap(h.c.pageLifecycleGeneration), false);
    assert.equal(h.calls.filter(c => c.name === 'performRead').length, 0);
});

test('initial waiting reducer keeps BOOTSTRAPPING with no request intent; saved sequential semantics stay separate', async () => {
    const h = await harness(false), core = h.c.replayControlPlaneCore;
    for (const event of ['MEDIA_PAUSE', 'MEDIA_PLAY']) {
        const r = core.reduceReplayControlState(core.createReplayState('BOOTSTRAPPING'), event, { initialBootstrap: true });
        assert.equal(r.nextState.phase, 'BOOTSTRAPPING'); assert.equal(r.requestIntent, 'NONE');
        assert.equal(r.failure, 'NO_OP');
        assert.equal(core.reduceReplayControlState(core.createReplayState('BOOTSTRAPPING'), event).failure, 'FORBIDDEN_EVENT');
    }
    const reading = core.reduceReplayControlState(core.createReplayState('READING'), 'MEDIA_PAUSE').nextState;
    assert.equal(reading.suspendedReason, 'MEDIA_PAUSED');
    assert.equal(core.reduceReplayControlState(reading, 'MEDIA_PLAY').nextState.phase, 'READING');
});

test('downstream final media gate remains; post-authorization rejection never refunds Authority or stores a grant', async () => {
    const h = await harness(false, { paused: false }); h.c.acceptReplayBootstrapCandidate('PRIVATE');
    const base = h.c.window.LiveFlowChatReadCore.canStartReadLoop;
    h.c.window.LiveFlowChatReadCore.canStartReadLoop = f => { h.video.paused = true; return base(f); };
    h.c.startReplayBootstrap(0); await h.c.running;
    assert.equal(h.c.replayBootstrapAuthority.diagnostic().authorityState, 'CONSUMED');
    assert.equal(h.c.lastGrant.diagnostic().state, 'AUTHORIZED');
    assert.equal(h.c.replayInitialBootstrapWait, null);
    assert.equal(h.calls.filter(c => c.name === 'performRead').length, 0);
    h.video.paused = false; h.c.startReplayBootstrap(0);
    assert.equal(h.calls.filter(c => c.name === 'authorizeAuthorityRequest').length, 1);
});

test('stale bootstrap response stays behind the original commit fence', async () => {
    const h = await harness(false, { paused: false }); h.c.acceptReplayBootstrapCandidate('PRIVATE');
    h.c.performRead = async () => { h.c.pageRevision++; return { ok: true, messages: [{ private: true }] }; };
    h.c.startReplayBootstrap(0); await h.c.running;
    assert.equal(h.c.readCount, 1);
    assert.equal(h.calls.filter(c => c.name === 'canScheduleNextRead').at(-1).facts.revision, 0);
    assert.equal(h.calls.filter(c => c.name === 'canScheduleNextRead').at(-1).facts.currentRevision, 1);
    assert.equal(h.c.replayPipelineDiagnostic.receivedActions, 0);
    assert.equal(h.c.replayPending.length, 0);
});
test('fixed ring bounds, sanitization, detached snapshots and fault flag', () => {
    const c = createInitialAuthorityTrace({ ...identity, secret: 'NEVER_EXPORT' });
    for (let i = 0; i < 300; i++) c.record('SAFE_EVENT', { lifecycle: 0, get token() { throw Error('must never read token'); }, reason: 'https://private.invalid', readCount: i });
    const s = c.snapshot(); assert.equal(s.rows.length, 256); assert.equal(s.total, 300); assert.equal(s.truncated, true);
    assert.equal(s.rows[0].sequence, 45); assert.equal(s.rows.at(-1).sequence, 300);
    assert.equal(s.collectorFault, false);
    assert.ok(!JSON.stringify(s).includes('NEVER_EXPORT')); assert.ok(!JSON.stringify(s).includes('private.invalid'));
    s.rows[0].step = 'TAMPER'; s.identity.sourceSHA = 'TAMPER'; assert.equal(c.snapshot().rows[0].step, 'SAFE_EVENT');
    c.record('SAFE_EVENT', { get reason() { throw Error('NEVER_EXPORT'); } }); assert.equal(c.snapshot().collectorFault, true);
    assert.ok(!JSON.stringify(c.snapshot()).includes('NEVER_EXPORT'));
});
test('trace enum allowlist preserves every existing Control Plane event and mismatch name', () => {
    const api = loadCore(originalCore), c = createInitialAuthorityTrace(identity);
    for (const event of Object.values(api.ReplayEvent)) c.record('SAFE_EVENT', { event });
    for (const mismatch of Object.values(api.ShadowMismatch)) c.record('SAFE_EVENT', { mismatch });
    const rows = c.snapshot().rows;
    assert.deepEqual(rows.filter(r => r.event).map(r => r.event), Object.values(api.ReplayEvent));
    assert.deepEqual(rows.filter(r => r.mismatch).map(r => r.mismatch), Object.values(api.ShadowMismatch));
});
test('TRACE_INSTALLED precedes bootstrap; paused initial media preserves unused Authority without Grant', async () => {
    const h = await harness(true); assert.equal(h.c.acceptReplayBootstrapCandidate('SYNTHETIC_TOKEN_NEVER_EXPORT'), true);
    assert.equal(h.c.startReplayBootstrap(0), false);
    const s = h.snapshot(), rows = s.rows;
    assert.equal(rows[0].step, 'TRACE_INSTALLED');
    assert.equal(rows.some(r => r.step === 'AUTHORIZATION_RESULT'), false);
    assert.equal(h.c.replayBootstrapAuthority.diagnostic().authorityState, 'OBSERVED_UNUSED');
    assert.equal(h.c.lastGrant, undefined);
    assert.equal(h.c.currentLoopGeneration, 0);
    assert.equal(rows.find(r => r.step === 'BOOTSTRAP_MEDIA_DEFERRED').media, 'PAUSED');
    assert.equal(rows.some(r => r.step === 'GRANT_CLAIM_RESULT'), false);
    assert.equal(h.calls.filter(c => c.name === 'performRead').length, 0);
    assert.ok(!JSON.stringify(s).includes('SYNTHETIC_TOKEN_NEVER_EXPORT'));
});
test('hidden-before-authorize records unused bootstrap invalidation and no grant; foreground rejection stays fail closed', async () => {
    const h = await harness(true, { hidden: true }); h.c.acceptReplayBootstrapCandidate('SYNTHETIC_TOKEN_NEVER_EXPORT');
    const handle = h.c.replayBootstrapAuthority;
    h.c.enterReplaySuspended('HIDDEN'); h.doc.hidden = false; h.doc.visibilityState = 'visible';
    assert.equal(h.c.resumeReadAfterVisibility(0, true), false);
    assert.equal(h.c.startReplayBootstrap(0), false);
    assert.equal(handle.diagnostic().authorityState, 'INVALID');
    const rows = h.snapshot().rows, invalid = rows.find(r => r.step === 'AUTHORITY_INVALIDATION' && r.kind === 'BOOTSTRAP');
    assert.equal(invalid.beforeState, 'OBSERVED_UNUSED'); assert.equal(invalid.afterState, 'INVALID');
    assert.ok(rows.find(r => r.step === 'FOREGROUND_PRECONDITION_REJECTED'));
    assert.equal(rows.some(r => r.step === 'AUTHORIZATION_RESULT' && r.outcome === 'SUCCESS'), false);
    assert.equal(h.calls.filter(c => c.name === 'performRead').length, 0);
});
test('authorized read path records Grant CLAIMED once and real response outcome', async () => {
    const h = await harness(true, { paused: false }); h.c.acceptReplayBootstrapCandidate('SYNTHETIC_TOKEN_NEVER_EXPORT');
    h.c.startReplayBootstrap(0); await h.c.running;
    const rows = h.snapshot().rows, claim = rows.find(r => r.step === 'GRANT_CLAIM_RESULT');
    assert.equal(claim.grantState, 'CLAIMED'); assert.equal(claim.outcome, 'SUCCESS');
    assert.equal(h.calls.filter(c => c.name === 'claimAuthorityRequestGrant').length, 1);
    assert.equal(h.calls.filter(c => c.name === 'performRead').length, 1);
    assert.equal(rows.find(r => r.step === 'READ_RESULT').outcome, 'FAILURE');
    assert.ok(!JSON.stringify(h.snapshot()).includes('SYNTHETIC_TOKEN_NEVER_EXPORT'));
});
test('existing status getter remains read-only and exports detached anonymous trace only', async () => {
    const { main } = await injected, h = await harness(true);
    const start = main.indexOf('    window.LiveFlowReplayControlPlaneShadowDiagnostic = Object.freeze({');
    const end = main.indexOf('\n    });', start) + '\n    });'.length;
    vm.runInContext(main.slice(start, end), h.c);
    const api = h.c.window.LiveFlowReplayControlPlaneShadowDiagnostic;
    assert.deepEqual(Object.keys(api), ['status']); assert.equal(Object.isFrozen(api), true);
    const status = api.status(); assert.equal(Object.isFrozen(status), true);
    assert.equal(status.initialAuthorityTrace.rows[0].step, 'TRACE_INSTALLED');
    status.initialAuthorityTrace.rows[0].step = 'TAMPER';
    assert.equal(api.status().initialAuthorityTrace.rows[0].step, 'TRACE_INSTALLED');
    assert.equal(status.initialAuthorityTrace.identity.sourceSHA, identity.sourceSHA);
    assert.ok(!JSON.stringify(status).includes('SYNTHETIC_TOKEN_NEVER_EXPORT'));
});
test('hidden preauthorization gate invalidates bootstrap without a grant', async () => {
    const h = await harness(true); h.c.acceptReplayBootstrapCandidate('SYNTHETIC_TOKEN_NEVER_EXPORT');
    const handle = h.c.replayBootstrapAuthority;
    h.doc.hidden = true; h.doc.visibilityState = 'hidden'; h.c.startReplayBootstrap(0);
    assert.equal(h.c.lastGrant, undefined);
    assert.equal(handle.diagnostic().authorityState, 'INVALID');
    h.c.enterReplaySuspended('HIDDEN');
    const invalidation = h.snapshot().rows.find(r => r.step === 'AUTHORITY_INVALIDATION' && r.kind === 'BOOTSTRAP');
    assert.equal(invalidation.beforeState, 'OBSERVED_UNUSED'); assert.equal(invalidation.afterState, 'INVALID'); assert.equal(invalidation.outcome, 'SUCCESS');
    assert.equal(h.calls.filter(c => c.name === 'performRead').length, 0);
});
test('actual early rejection branches retain behavior and event attribution', async () => {
    for (const [scenario, step] of [['suspended', 'READ_LOOP_REJECTED_SUSPENDED'], ['lifecycle', 'READ_LOOP_REJECTED_LIFECYCLE'],
        ['target', 'READ_LOOP_REJECTED_TARGET'], ['grant', 'READ_LOOP_REJECTED_GRANT'], ['conflict', 'READ_LOOP_REJECTED_CONFLICT']]) {
        const results = [];
        for (const traced of [false, true]) {
            const h = await harness(traced);
            let generation = 0, grant = null;
            if (scenario === 'suspended') h.c.replayProductionControlState = h.c.replayControlPlaneCore.createReplayState('SUSPENDED', 'HIDDEN');
            if (scenario === 'lifecycle') generation = 1;
            if (scenario === 'target') h.c.isCurrentPageStateTarget = () => false;
            if (scenario === 'conflict') {
                h.c.acceptReplayBootstrapCandidate('SYNTHETIC_TOKEN_NEVER_EXPORT');
                grant = h.c.authorizeReplayAuthority(h.c.replayBootstrapAuthority, 'BOOTSTRAP', h.c.currentReplayAuthorityBinding(), 0);
                h.c.readRequestInFlight = true;
            }
            await h.c.startReadLoop(generation, 'INITIAL_WATCH', grant);
            if (traced) assert.ok(h.snapshot().rows.some(r => r.step === step), scenario);
            results.push(h.behavior());
        }
        assert.deepEqual(results[1], results[0], scenario);
    }
});
for (const scenario of ['paused', 'hidden', 'read']) test('Product calls/branches/receiver/returns unchanged: ' + scenario, async () => {
    const results = [];
    for (const traced of [false, true]) {
        const h = await harness(traced, { paused: scenario !== 'read', hidden: scenario === 'hidden' });
        const accepted = h.c.acceptReplayBootstrapCandidate('SYNTHETIC_TOKEN_NEVER_EXPORT');
        const duplicate = h.c.acceptReplayBootstrapCandidate('SYNTHETIC_TOKEN_NEVER_EXPORT');
        if (scenario === 'hidden') { h.c.enterReplaySuspended('HIDDEN'); h.doc.hidden = false; h.doc.visibilityState = 'visible'; h.c.resumeReadAfterVisibility(0, true); }
        const started = h.c.startReplayBootstrap(0); await h.c.running;
        results.push({ accepted, duplicate, started, ...h.behavior() });
    }
    assert.deepEqual(results[1], results[0]);
});
test('collector throwing and ring exhaustion do not change Product operations', async () => {
    const baseline = await harness(false, { paused: false }), failing = await harness(true, { paused: false, collectorThrows: true });
    for (const h of [baseline, failing]) { h.c.acceptReplayBootstrapCandidate('SYNTHETIC_TOKEN_NEVER_EXPORT'); h.c.startReplayBootstrap(0); await h.c.running; }
    assert.deepEqual(failing.behavior(), baseline.behavior()); assert.equal(failing.snapshot().collectorFault, true);
    const full = await harness(true, { paused: false });
    for (let i = 0; i < 300; i++) full.c.initialTrace('SAFE_EVENT');
    full.c.acceptReplayBootstrapCandidate('SYNTHETIC_TOKEN_NEVER_EXPORT'); full.c.startReplayBootstrap(0); await full.c.running;
    assert.deepEqual(full.behavior(), baseline.behavior()); assert.equal(full.snapshot().rows.length, 256); assert.equal(full.snapshot().truncated, true);
});
test('first shadow dispatch/capability mismatch is attributed without changing original decisions', async () => {
    const { core } = await injected, generated = loadCore(core), baseline = loadCore(originalCore), collector = createInitialAuthorityTrace(identity);
    const actual = generated.createShadowController(undefined, (step, details) => collector.record(step, details));
    const original = baseline.createShadowController();
    assert.equal(JSON.stringify(actual.dispatch('SEQUENTIAL_AUTHORIZED')), JSON.stringify(original.dispatch('SEQUENTIAL_AUTHORIZED')));
    assert.equal(collector.snapshot().firstMismatch.event, 'SEQUENTIAL_AUTHORIZED');
    assert.equal(JSON.stringify(actual.compareCapability('BOOTSTRAP', null, null, true)), JSON.stringify(original.compareCapability('BOOTSTRAP', null, null, true)));
    assert.equal(JSON.stringify(actual.status()), JSON.stringify(original.status()));
    const capCollector = createInitialAuthorityTrace(identity), cap = generated.createShadowController(undefined, (s, d) => capCollector.record(s, d));
    cap.compareCapability('BOOTSTRAP', null, null, true); assert.equal(capCollector.snapshot().firstMismatch.path, 'BOOTSTRAP');
    const throws = generated.createShadowController(undefined, () => { throw Error('SECRET'); });
    assert.doesNotThrow(() => throws.dispatch('LIFECYCLE_START')); assert.doesNotThrow(() => throws.compareCapability('BOOTSTRAP', null, null, true));
});
test('unrecognized anchors stop generation and no trace code is loaded by Production manifest', async () => {
    const { instrumentInitialAuthorityTrace } = await import('../tools/density-comparison/instrument-initial-authority.mjs');
    assert.throws(() => instrumentInitialAuthorityTrace(originalMain.replace('function startReadLoop(', 'function changedReadLoop('), originalCore, identity));
    const manifest = JSON.parse(fs.readFileSync(require.resolve('../manifest.json'), 'utf8'));
    for (const file of manifest.content_scripts.flatMap(e => e.js)) assert.ok(!fs.readFileSync(path.join(__dirname, '..', file), 'utf8').includes('createInitialAuthorityTrace'));
});
test('B/D generation shares trace code, matching provenance and distinct isolated identities', async () => {
    const { build, verify } = await import('../tools/build-density-comparison.mjs');
    const output = path.resolve(__dirname, '../build/initial-trace-test-' + crypto.randomUUID());
    const packages = build(output, { initialAuthorityTrace: true });
    assert.notEqual(packages[0].extensionID, packages[1].extensionID);
    assert.equal(packages[0].commonBuildID, packages[1].commonBuildID);
    for (const p of packages) {
        assert.equal(verify(p.directory).packageDigest, p.packageDigest);
        assert.equal(p.traceProfile, 'INITIAL_AUTHORITY_ORDER_V1');
        for (const [f, digest] of Object.entries(p.inputs)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', f))).digest('hex'), digest);
        const main = fs.readFileSync(path.join(p.directory, 'src/page-state-main.js'), 'utf8');
        assert.ok(main.indexOf("record('TRACE_INSTALLED'") < main.indexOf('const replayControlShadow ='));
        assert.ok(main.includes(p.commonBuildID)); assert.ok(main.includes(p.sourceSHA));
        new vm.Script(main); new vm.Script(fs.readFileSync(path.join(p.directory, 'src/replay-control-plane-core.js'), 'utf8'));
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.directory, 'manifest.json'))).permissions, ['storage']);
        const content = fs.readFileSync(path.join(p.directory, 'src/youtube-chat.js'), 'utf8');
        const runtime = JSON.parse(content.match(/const comparisonIdentity = (.*);/)[1]);
        assert.equal(runtime.candidate, p.candidate); assert.equal(runtime.buildID, p.buildID); assert.equal(runtime.packageDigest, p.packageDigest);
        assert.equal(runtime.traceProfile, p.traceProfile); assert.equal(runtime.typography, 'A');
    }
    for (const f of ['src/page-state-main.js', 'src/replay-control-plane-core.js']) assert.equal(
        fs.readFileSync(path.join(packages[0].directory, f), 'utf8'), fs.readFileSync(path.join(packages[1].directory, f), 'utf8'));
});
