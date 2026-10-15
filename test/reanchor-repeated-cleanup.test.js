const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const control = require('../src/replay-control-plane-core');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8').replaceAll('\r\n', '\n');
function fn(name) {
    let i = main.indexOf('    function ' + name + '(');
    if (i < 0) i = main.indexOf('    async function ' + name + '(');
    assert.ok(i >= 0, name); return main.slice(i, main.indexOf('\n    }\n', i) + 7);
}
async function scenario(repeated) {
    const prefix = fs.readFileSync(require.resolve('./seek-epoch-combined-listener.test'), 'utf8').split('for (const order of ')[0];
    const outer = vm.createContext({ require: createRequire(path.resolve('test/seek-epoch-combined-listener.test.js')) });
    vm.runInContext(prefix + '\nmakeCombined=combined;', outer);
    const h = outer.makeCombined(), c = h.c, video = c.getCurrentMainVideo(); video.duration = 600; video.seeking = false;
    const authorizations = [], transitions = [], requests = [], microtasks = [], cleanup = [];
    c.replayControlPlaneCore = { ...control, authorizeAuthorityRequest(args) {
        const r = control.authorizeAuthorityRequest(args); authorizations.push({ kind: args.expectedKind, reason: r.reason, ok: r.ok }); return r;
    } };
    Object.assign(c, { AbortController, pageState: { mode: 'replay', targetIdentity: 'FIXTURE', context: {} },
        runtimeUserEnabled: true, navigationPending: false, replayAdActive: false, replaySeekInProgress: false,
        replayReanchorLock: false, replayPlayerSeekDiagnosticLock: false, readRequestInFlight: false,
        replayForegroundRecoveryDiagnostic: {}, replayProductionControlState: control.createReplayState('REANCHORING'),
        replayControlShadow: control.createShadowController(control.createReplayState('REANCHORING')),
        replayConsumedAuthorityRegistry: control.createConsumedAuthorityRegistry(),
        replayPausedSequentialAuthority: null, replayTemporalStarvationDiagnostic: {}, replayEarlyResumeSuppressionState: 'CLEAR',
        replayReadAheadDeferred: false, REPLAY_REQUEST_TIMEOUT_MS: 10000, readCount: 0,
        replayReanchorIntent: null, replayReanchorAbortController: null });
    c.isCurrentPageStateTarget = () => true; c.replayAdIsActive = () => false; c.replaySeekAuthorityIsCurrent = () => true;
    c.window.setTimeout = () => 1; c.window.clearTimeout = () => {};
    c.window.queueMicrotask = cb => microtasks.push(cb);
    vm.runInContext(['currentReplayAuthorityBinding', 'authorizeReplayAuthority', 'authorizeSequentialAuthority',
        'authorizeSavedSequentialResume', 'createSequentialAuthorityCandidate', 'observeReplayPendingMerge',
        'runQueuedReplayReanchor'].map(fn).join('\n'), c);
    const observeSource = fn('observeReplayControlShadow');
    vm.runInContext(observeSource, c);
    const observe = c.observeReplayControlShadow;
    c.observeReplayControlShadow = (...args) => {
        const before = c.replayProductionControlState;
        transitions.push({ event: args[0], result: control.reduceReplayControlState(before, args[0], args[1]) });
        return observe(...args);
    };
    const stop = c.stopReadLoop; c.stopReadLoop = (...args) => { cleanup.push(args[0]); return stop(...args); };
    const clear = c.phase3Runtime.clear; c.phase3Runtime = { ...c.phase3Runtime, clear() { cleanup.push('Content.clear'); return clear(); } };
    const binding = c.currentReplayAuthorityBinding();
    const token = repeated ? 'USED_FIXTURE' : 'FRESH_FIXTURE';
    if (repeated) {
        const prior = control.createReplayAuthority({ kind: 'SEQUENTIAL', opaqueToken: token, binding, provenance: 'ADAPTER_SEQUENTIAL' }).authority;
        const auth = control.authorizeAuthorityRequest({ authority: prior, expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry: c.replayConsumedAuthorityRegistry });
        assert.equal(auth.ok, true); assert.equal(control.claimAuthorityRequestGrant(auth.grant, 'SEQUENTIAL').ok, true);
    }
    c.replaySeekAuthority = control.createReplayAuthority({ kind: 'REANCHOR', opaqueToken: 'REANCHOR_FIXTURE', binding,
        provenance: 'ADAPTER_PLAYER_SEEK' }).authority;
    const intent = { reason: 'FOREGROUND', lifecycleGeneration: 0, revision: 0, targetIdentity: 'FIXTURE', video, attempted: false };
    c.replayReanchorIntent = intent;
    c.performRead = async () => {
        requests.push('REANCHOR');
        return { ok: true, messages: [{ id: 'due', replayOffsetMsec: 5000 }, { id: 'future', replayOffsetMsec: 8000 }],
            summary: { actionCount: 2 }, continuationInfo: { continuation: token },
            reanchorTemporalCoverage: 'CROSSES_TARGET', reanchorAcceptedRelation: 'CROSSES_TARGET', playerSeekContinuationObserved: true };
    };
    // Existing transport adapter boundary: feed real Runtime enqueue and real Content publication.
    c.postReadResult = result => {
        // This legacy adapter deliberately lacks the real ACK receiver. Keep MAIN's
        // forwarding evidence so it cannot claim terminal reconciliation without ACK.
        const owner = c.ensureReplayPendingOwner(); c.replayPendingOwners.get(owner.stream).forwarded = true;
        let count = 0;
        for (const message of result.messages) if (c.phase3Runtime.enqueue(message, { id: message.id,
            enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer', footprint: {} })) count++;
        c.publishReplayBatchAccounting({ inputCount: result.messages.length, enqueuedCount: count }); h.flush();
    };
    c.startReadLoop = (...args) => { requests.push('SEQUENTIAL_HANDOFF');
        assert.equal(control.claimAuthorityRequestGrant(args[2], 'SEQUENTIAL').ok, true); };
    const outcome = await c.runQueuedReplayReanchor(intent); h.flush();
    return { h, c, outcome, authorizations, transitions, requests, microtasks, cleanup };
}
test('legacy adapter cannot claim reconciliation without real Content ACK', async () => {
    const s = await scenario(true), a = s.c.replayAccountingStatus();
    assert.equal(s.outcome, false);
    assert.ok(s.authorizations.some(r => r.kind === 'REANCHOR' && r.ok));
    assert.equal(s.authorizations.at(-1).reason, 'AUTHORITY_REPEATED');
    assert.deepEqual(s.requests, ['REANCHOR']); assert.equal(s.microtasks.length, 0);
    const final = s.transitions.at(-1);
    assert.equal(final.event, 'REANCHOR_FAILED'); assert.equal(final.result.pendingAction, 'CLEAR');
    assert.equal(s.c.replayProductionControlState.phase, 'STOPPED');
    assert.deepEqual(s.cleanup, []); // Characterizes defect; never fake a terminal removal.
    assert.equal(s.c.replayPending.length, 0); assert.equal(s.c.phase3Runtime.status().pendingCount, 3);
    assert.equal(a.temporalPending, 0); assert.equal(a.schedulerRetained, 3);
    assert.equal(s.c.replaySchedulerDiagnostic.schedulerLifecycleDiscarded, 0);
    assert.equal(s.c.replayPipelineDiagnostic.temporalRemovalReasons.FAIL_CLOSED, 1);
    assert.equal(s.c.replayPipelineDiagnostic.temporalRemovalReasons.REANCHOR_REPLACED, 3);
    assert.ok(Object.values(a.stages).every(stage => stage.valid));
    assert.equal(a.accountingComplete, false); assert.equal(a.lostUnaccounted, 0); assert.equal(a.overflowUnaccounted, 0);
    assert.equal(a.diagnosticScope.epoch, 0); assert.equal(a.diagnosticScope.scopes[0].state, 'INCOMPLETE');
    assert.equal(a.diagnosticScope.scopes.length, 1); // No new scope exists to receive fabricated removals.
    const saved = JSON.stringify(a);
    assert.equal(JSON.stringify(s.c.replayAccountingStatus()), saved);
    assert.equal(s.c.replayControlShadow.status().shadowPhase, 'STOPPED');
    assert.equal(s.c.replayDiagnosticClosureValid(s.c.replayPipelineDiagnostic), false);
});
test('unused Sequential control queues single-use handoff and conserves same response', async () => {
    const s = await scenario(false), a = s.c.replayAccountingStatus();
    assert.equal(s.outcome, true); assert.equal(s.c.replayProductionControlState.phase, 'READING');
    assert.equal(s.authorizations.at(-1).ok, true); assert.equal(s.microtasks.length, 1);
    assert.deepEqual(s.requests, ['REANCHOR']); s.microtasks[0]();
    assert.deepEqual(s.requests, ['REANCHOR', 'SEQUENTIAL_HANDOFF']);
    assert.equal(a.temporalPending, 1); assert.equal(a.schedulerRetained, 3);
    assert.equal(a.lostUnaccounted, 0); assert.equal(a.overflowUnaccounted, 0);
});
