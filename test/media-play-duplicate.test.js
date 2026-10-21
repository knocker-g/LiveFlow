const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../src/replay-control-plane-core');
const chat = require('../src/chat-read-core');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8').replaceAll('\r\n', '\n');
function fn(name) {
    const start = main.indexOf('    function ' + name + '(');
    assert.ok(start >= 0, name);
    return main.slice(start, main.indexOf('\n    }\n', start) + 7);
}
// Real registered listener, orchestration, readiness predicate and both reducers.
// Network/snapshot, Temporal flush and specialized recovery are observation stubs;
// this fixture does not claim their internal authorization or response-fence coverage.
function harness(state = core.createReplayState('READING')) {
    const listeners = {}, tasks = [], calls = [];
    const video = { paused: false, seeking: false, ended: false, currentTime: 30 };
    const c = vm.createContext({
        window: { LiveFlowChatReadCore: chat, queueMicrotask: cb => tasks.push(cb),
            addEventListener(type, cb, capture) { assert.equal(capture, true); listeners[type] = cb; } },
        document: { hidden: false, querySelector: () => null }, performance: { now: () => 0 },
        replayControlPlaneCore: core, replayControlShadow: core.createShadowController(state),
        replayProductionControlState: state, replayProductionPendingAction: 'KEEP',
        replayInitialBootstrapIntent: null, replayInitialBootstrapWait: null,
        replaySeekNeedsReanchor: false, replaySeekInProgress: false, replaySeekEpoch: 0,
        pageLifecycleGeneration: 0, pageRevision: 0, currentLoopGeneration: 4,
        pageState: { mode: 'replay' }, runtimeUserEnabled: true, readStopReason: 'none',
        replayPausedSequentialAuthority: null, replayRestartSequence: 0,
        replayRestartDiagnostic: {}, REPLAY_RESTART_REASONS: new Set(['RESUME', 'SEEK']),
        getCurrentMainVideo: () => video,
        setReplayRestartStage: stage => calls.push(stage),
        resumeInitialReplayBootstrap: () => calls.push('INITIAL_INTENT'),
        startReplayBootstrap: () => calls.push('BOOTSTRAP_WAIT'),
        queueReplayReanchor: () => { calls.push('SEEK'); return true; },
        flushReplayPending: () => calls.push('SAVED_RESUME'),
        respond: () => { calls.push('SNAPSHOT'); return false; },
        startReadLoop: () => { throw Error('unexpected READ'); }
    });
    const registration = main.match(/    window.addEventListener\('play', restartReplayFromCurrentPosition, true\);/)[0];
    vm.runInContext(['observeReplayControlShadow', 'beginReplayRestart', 'restartReplayFromCurrentPosition'].map(fn).join('\n') + '\n' + registration, c);
    return { c, video, calls, play: target => listeners.play({ type: 'play', target: target || video }),
        flush: () => { while (tasks.length) tasks.shift()(); } };
}
test('READING duplicate play suppresses only dispatch, not restart/snapshot work', () => {
    const h = harness();
    h.play(); h.flush(); h.play(); h.flush();
    assert.equal(h.c.replayControlShadow.status().mismatchCount, 0);
    assert.equal(h.c.replayControlShadow.status().transitionCount, 0);
    assert.equal(h.c.replayRestartSequence, 2);
    assert.equal(h.calls.filter(x => x === 'SNAPSHOT').length, 2);
    assert.equal(h.c.currentLoopGeneration, 4);
    assert.equal(h.c.replayProductionControlState.phase, 'READING');
});
for (const target of ['READING', 'BUFFER_PAUSED']) test('legal MEDIA_PAUSED resume to ' + target, () => {
    const h = harness(core.createReplayState('SUSPENDED', 'MEDIA_PAUSED', target));
    h.c.readStopReason = 'playback-paused'; h.c.replayPausedSequentialAuthority = Object.freeze({});
    h.play(); h.flush();
    assert.equal(h.c.replayProductionControlState.phase, target);
    assert.equal(h.c.replayControlShadow.status().mismatchCount, 0);
    assert.equal(h.c.replayControlShadow.status().transitionCount, 1);
    assert.deepEqual(h.calls, ['SAVED_RESUME']);
});
test('initial bootstrap wait and intent retain specialized routing', () => {
    const h = harness(core.createReplayState('BOOTSTRAPPING'));
    h.c.replayInitialBootstrapWait = {}; h.play();
    assert.equal(h.c.replayControlShadow.status().mismatchCount, 0);
    assert.deepEqual(h.calls, ['BOOTSTRAP_WAIT']);
    h.c.replayInitialBootstrapIntent = {}; h.play();
    assert.deepEqual(h.calls, ['BOOTSTRAP_WAIT', 'INITIAL_INTENT']);
    assert.equal(h.c.replayRestartSequence, 0);
});
test('foreign/replaced video and queued readiness changes remain fenced', () => {
    const h = harness(); h.play({}); assert.equal(h.c.replayRestartSequence, 0);
    h.play(); h.c.getCurrentMainVideo = () => ({}); h.flush();
    assert.deepEqual(h.calls, ['WAITING_MEDIA']);
});
for (const field of ['hidden', 'paused', 'seeking', 'ended']) test('queued ' + field + ' change prevents downstream snapshot', () => {
    const h = harness(); h.play();
    if (field === 'hidden') h.c.document.hidden = true; else h.video[field] = true;
    h.flush(); assert.deepEqual(h.calls, ['WAITING_MEDIA']);
});
test('seekNeedsReanchor uses dedicated route without MEDIA_PLAY', () => {
    const h = harness(core.createReplayState('REANCHORING')); h.c.replaySeekNeedsReanchor = true;
    h.play(); h.flush(); assert.deepEqual(h.calls, ['SEEK']);
    assert.equal(h.c.replayControlShadow.status().transitionCount, 0);
});
for (const state of [core.createReplayState('REANCHORING'), core.createReplayState('STOPPED'), core.createReplayState('BOOTSTRAPPING'), core.createReplayState('BUFFER_PAUSED'), core.createReplayState('SUSPENDED', 'AD'), core.createReplayState('SUSPENDED', 'HIDDEN')]) {
    test('native play does not dispatch generic resume in ' + state.phase + '/' + state.suspendedReason, () => {
        const h = harness(state); h.c.document.hidden = state.suspendedReason === 'HIDDEN';
        const authority = Object.freeze({fixture:'UNTOUCHED'}); h.c.replaySeekAuthority = authority;
        h.play(); h.flush(); h.play(); h.flush();
        assert.equal(h.c.replayControlShadow.status().mismatchCount, 0);
        assert.equal(h.c.replayControlShadow.status().transitionCount, 0);
        assert.equal(h.c.replayProductionControlState, state);
        assert.equal(h.c.replaySeekAuthority, authority);
        assert.equal(h.c.replayRestartSequence, 2);
        assert.equal(h.c.currentLoopGeneration, 4);
        // Preserve post-dispatch listener behavior, including readiness rejection.
        assert.deepEqual(h.calls, state.suspendedReason === 'HIDDEN'
            ? ['WAITING_MEDIA','WAITING_MEDIA']
            : ['WAITING_FRAME_ROLE','SNAPSHOT','WAITING_SNAPSHOT','WAITING_FRAME_ROLE','SNAPSHOT','WAITING_SNAPSHOT']);
    });
}
for (const reason of ['AD','HIDDEN']) test('direct forbidden MEDIA_PLAY still detected for '+reason, () => {
    const h=harness(core.createReplayState('SUSPENDED',reason));
    h.c.observeReplayControlShadow('MEDIA_PLAY');
    assert.equal(h.c.replayControlShadow.status().mismatchCount,1);
});

test('other forbidden events still increment mismatch', () => {
    const h = harness(); h.c.observeReplayControlShadow('BOOTSTRAP_FAILED');
    assert.equal(h.c.replayControlShadow.status().mismatchCount, 1);
});
