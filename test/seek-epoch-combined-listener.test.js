const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createScopes } = require('../src/diagnostic-scope-core');
const core = require('../src/chat-read-core');
const { createSchedulerRuntime } = require('../src/scheduler-runtime');
const { createGeometryAuthority, createSubtitleGeometryAdapter } = require('../src/geometry-adapter');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8');
const content = fs.readFileSync(require.resolve('../src/youtube-chat'), 'utf8');
function source(text, name) {
    const start = text.indexOf(`function ${name}(`), body = text.indexOf('{', start);
    let depth = 1, end = body + 1;
    for (; depth && end < text.length; end++) { if (text[end] === '{') depth++; if (text[end] === '}') depth--; }
    assert.ok(start >= 0 && !depth, name);
    return text.slice(start, end);
}
function harness() {
    const messages = [], video = {};
    const window = { location: { origin: 'https://www.youtube.com' }, postMessage: m => messages.push(m),
        LiveFlowChatReadCore: core };
    const c = vm.createContext({ window, currentChatMode: 'replay', currentPageLifecycleGeneration: 0,
        pageLifecycleGeneration: 0, REPLAY_PIPELINE_DIAGNOSTIC_TYPE: 'pipeline',
        NAVIGATION_INVALIDATED_TYPE: 'navigation', pageRevision: 0, minimumAcceptedPageRevision: 0,
        logInfo() {},
        replayDiagnosticEpoch: null, replayDiagnosticLifecycle: 0, replayDiagnosticSequence: 0,
        replayDiagnosticBatch: {}, replayDiagnosticDisplayed: 0, replayDiagnosticAwaiting: null,
        replayDiagnosticIncomplete: false, replayDiagnosticBatchInProgress: false, replayGapEvidence: null, rendererGeneration: 0,
        activeDanmaku: new Map(), overlaySurface: null, overlayRoot: null,
        replayGapOriginStatus: () => ({ gapOriginClass: 'UNKNOWN' }),
        updateReplayLaunchGap() {}, resetReplayLaunchGapDiagnostic() {}, disconnectSubtitleGeometryObservers() {},
        getCurrentMainMedia: () => ({ video }) });
    vm.runInContext(['createReplaySchedulerDiagnostic', 'publishReplayScopeSnapshot', 'publishReplaySchedulerDiagnostic',
        'publishReplayBatchAccounting', 'resetReplayDiagnosticCounters', 'closeReplayDiagnosticScope',
        'handleReplayDiagnosticScopeOpen', 'observeReplayScheduler', 'cleanupOverlay', 'handleReplayMediaContextChange',
        'handlePageLifecycleInvalidated']
        .map(n => source(content, n)).join('\n') + '\nreplaySchedulerDiagnostic = createReplaySchedulerDiagnostic();', c);
    vm.runInContext(['createReplayPipelineDiagnostic', 'applyReplayDiagnosticSnapshot', 'openReplayDiagnosticScope',
        'postReplayDiagnosticScope', 'replayAccountingStatus', 'replayDiagnosticScopeStatus', 'replayDiagnosticClosureValid',
        'postLifecycleInvalidated']
        .map(n => source(main, n)).join('\n') + '\nreplayPipelineDiagnostic = createReplayPipelineDiagnostic();', c);
    c.diagnosticScopes = createScopes(0, c.replayPipelineDiagnostic, c.applyReplayDiagnosticSnapshot,
        { closureValid: c.replayDiagnosticClosureValid });
    const event = data => ({ source: window, origin: window.location.origin, data });
    function deliver(m) {
        if (m.source === 'liveflow-page-state') {
            if (m.type === 'navigation') c.handlePageLifecycleInvalidated(event(m));
            else c.handleReplayDiagnosticScopeOpen(event(m));
        } else c.diagnosticScopes.receive(m);
    }
    function flush() { while (messages.length) deliver(messages.shift()); }
    c.postReplayDiagnosticScope(); flush();
    const geometryAdapter = createSubtitleGeometryAdapter({ authority: createGeometryAuthority({ epsilon: 1 }),
        readGeometry: () => ({ state: 'KNOWN_EMPTY', exclusionRegions: [], capabilityAvailable: true }) });
    function runtime() {
        return createSchedulerRuntime({ clock: () => 0, generation: () => 1, geometryAdapter,
            scheduleOneShot: fn => fn, cancelOneShot() {}, candidateProof: () => null, launch: () => true,
            observe: c.observeReplayScheduler,
            config: { maxPendingAge: 1000, maxPendingCount: 10, pendingPressureCapacity: 5, scanDepth: 3,
                cohortMaximumItems: 3, cohortMaximumSpan: 50,
                pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: .75 },
                density: { attackThresholds: [.5, .7, .9], releaseThresholds: [.2, .3, .4], minimumAttackResidence: 1, releaseDwell: 3 },
                collisionAllowances: { CONSERVATIVE: {} } } });
    }
    function enqueue(n) {
        c.phase3Runtime = runtime();
        Object.assign(c.replayPipelineDiagnostic, { receivedActions: n, messagesObserved: n, bridged: n });
        for (let i = 0; i < n; i++) {
            const id = 'item-' + i;
            assert.equal(c.phase3Runtime.enqueue({ id }, { id, enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer', footprint: {} }), true);
        }
        c.observeReplayScheduler({ type: 'SNAPSHOT' });
        c.publishReplayBatchAccounting({ inputCount: n, enqueuedCount: n }); flush();
    }
    return { c, messages, deliver, flush, enqueue, seek: () => {
        const previous = c.openReplayDiagnosticScope(); c.postReplayDiagnosticScope(previous);
        c.handleReplayMediaContextChange({ type: 'seeking', target: video });
    } };
}

function combined() {
    const h = harness(), c = h.c, video = c.getCurrentMainMedia().video;
    Object.assign(video, { currentTime: 5, paused: false, ended: false });
    Object.assign(c, { document: { hidden: false }, pageState: { mode: 'replay' },
        replayProductionControlState: { phase: 'READING' }, replaySeekInProgress: false, replaySeekEpoch: 0,
        replayPending: [], replayTemporalPendingDiagnostic: null, currentLoopGeneration: 0, activeLoopGeneration: 0,
        activeAbortController: null, activeWaitTimer: null, replayRestartDiagnostic: { sequence: 0 },
        REPLAY_MAX_PENDING: 20, replayStartTimeSeconds: 4, replayTimingDiagnosticSeen: {
            filtered: new Set(), future: new Set(), due: new Set(), capacityDropped: new Set() },
        replayGapOriginDiagnostic: {}, replayAwaitingFirstFreshSequentialResponse: false,
        replayAcquisitionPausedForBuffer: false, replayObservedSequentialAuthority: null,
        replayCoverageHoleEpisodeState: {}, replayRunwayDepletionEpisodeState: 'UNKNOWN' });
    for (const name of ['terminateReplayForegroundRetainedDiagnostic', 'observeReplayControlShadow',
        'observeReplayRuntimeAccounting', 'beginReplayRestart', 'cancelReplayTemporalWakeup',
        'invalidateAuthorityHandle', 'setReplayRestartStage', 'updateReplayTemporalStarvationDiagnostic',
        'updateReplayTemporalLeadShadowDiagnostic', 'armReplayTemporalWakeup']) c[name] = () => {};
    c.getCurrentMainVideo = () => video; c.savedSequentialDiagnostic = () => null;
    c.maybeQueueReplayCoverageHoleRepair = () => false;
    vm.runInContext(['observeReplayPipelineResponse', 'observeReplayTemporalPendingMerge',
        'recordReplayTemporalDiscard', 'observeReplayTemporalPendingRemoval', 'flushReplayPending',
        'stopReadLoop', 'stopReplayContext', 'createReplayTimingDiagnosticSeen'].map(n => source(main, n)).join('\n'), c);
    c.window.addEventListener = (type, listener, capture) => {
        assert.equal(type, 'seeking'); assert.equal(capture, true); c.mainSeeking = listener;
    };
    const start = main.indexOf("    window.addEventListener('seeking', (event) => {");
    const end = main.indexOf('\n    }, true);', start) + '\n    }, true);'.length;
    vm.runInContext(main.slice(start, end), c);
    h.enqueue(2);
    function accept(items, classify) {
        c.result = { ok: true, messages: items, summary: { actionCount: items.length } };
        // Original accepted-response pending merge statements, not a synthetic counter assignment.
        const begin = main.indexOf('                const priorPending = replayPending.slice();', main.indexOf('const shadowResponseEvent'));
        const finish = main.indexOf('                const flushResult = flushReplayPending', begin);
        vm.runInContext('{ observeReplayPipelineResponse(result);' + main.slice(begin, finish) + '}', c);
        if (classify) c.flushReplayPending(c.currentLoopGeneration, 0, 0, 0, 'temporal-wakeup');
    }
    accept([{ id: 'future-1', replayOffsetMsec: 8000 }, { replayOffsetMsec: 9000 }], true);
    accept([{ id: 'unclassified', replayOffsetMsec: 10000 }], false);
    const old = c.replayPipelineDiagnostic;
    assert.equal(old.temporalPending, 3); assert.equal(old.temporalPendingUnclassified, 1);
    assert.equal(c.replayAccountingStatus().lostUnaccounted, 0);
    return { ...h, old, accept, seek(order) {
        const e = { type: 'seeking', target: video };
        for (const side of order) side === 'MAIN' ? c.mainSeeking(e) : c.handleReplayMediaContextChange(e);
    } };
}

for (const order of [['MAIN', 'CONTENT'], ['CONTENT', 'MAIN']]) {
    test('actual combined seeking listeners close nonzero Temporal/Scheduler queues: ' + order.join('→'), () => {
        const h = combined(), c = h.c;
        h.seek(order);
        assert.equal(h.old.temporalRemovalReasons.SEEK, 3);
        assert.equal(h.old.temporalPending, 0); assert.equal(h.old.temporalPendingUnclassified, 0);
        assert.equal(c.replayPending.length, 0);
        const pending = h.messages.splice(0), open = pending.filter(m => m.source === 'liveflow-page-state');
        open.forEach(h.deliver); // New OPEN reaches Content before delayed old terminal reaches MAIN.
        h.flush();
        pending.filter(m => m.source !== 'liveflow-page-state').reverse().forEach(h.deliver);
        h.flush();
        const s = c.replayAccountingStatus(), old = s.diagnosticScope.scopes[0];
        assert.equal(old.state, 'CLOSED'); assert.equal(old.scheduler.input, 2);
        assert.equal(old.scheduler.explicitRemoval, 2); assert.equal(old.scheduler.retained, 0);
        assert.equal(s.accountingComplete, true); assert.equal(s.lostUnaccounted, 0);
        assert.equal(s.overflowUnaccounted, 0); assert.equal(s.stages.scheduler.input, 0);
        assert.equal(c.replayAccountingStatus(h.old, false).stages.temporal.valid, true);
        const before = JSON.stringify(s); pending.filter(m => m.source !== 'liveflow-page-state').forEach(h.deliver);
        assert.equal(JSON.stringify(c.replayAccountingStatus()), before);
        h.enqueue(1); assert.equal(c.replayAccountingStatus().stages.scheduler.valid, true);
        assert.equal(c.replayAccountingStatus().stages.scheduler.explicitRemoval, 0);
        h.accept([{ id: 'new-future', replayOffsetMsec: 12000 }], true);
        const fresh = c.replayAccountingStatus();
        assert.equal(fresh.temporalDiscarded, 0); assert.equal(fresh.temporalPending, 1);
        assert.equal(fresh.stages.temporal.valid, true); assert.equal(fresh.lostUnaccounted, 0);
    });
    for (const failure of ['terminal missing', 'sequence missing', 'wrong epoch', 'unaccounted occurrence']) {
        test('combined listeners detect ' + failure + ': ' + order.join('→'), () => {
            const h = combined();
            if (failure === 'unaccounted occurrence') h.old.messagesObserved += 1;
            h.seek(order);
            const terminal = h.messages.find(m => m.diagnosticTerminal);
            assert.ok(terminal);
            let withheld;
            if (failure === 'terminal missing' || failure === 'wrong epoch') {
                h.messages.splice(h.messages.indexOf(terminal), 1); withheld = terminal;
                if (failure === 'wrong epoch') h.messages.push({ ...terminal, diagnosticScopeEpoch: 99 });
            } else if (failure === 'sequence missing') {
                const index = h.messages.findIndex(m => m.diagnosticScopeEpoch === 0 && !m.diagnosticTerminal);
                assert.ok(index >= 0); withheld = h.messages.splice(index, 1)[0];
            }
            h.flush();
            const s = h.c.replayAccountingStatus();
            assert.equal(s.accountingComplete, false); assert.equal(s.diagnosticScope.incomplete, true);
            assert.equal(s.diagnosticScope.scopes[0].state, 'INCOMPLETE');
            assert.equal(s.stages.scheduler.input, 0); // Balanced new scope cannot hide old failure.
            if (failure === 'unaccounted occurrence') {
                assert.equal(s.diagnosticScope.scopes[0].lostUnaccounted, 1);
            } else {
                h.deliver(withheld);
                assert.equal(h.c.replayAccountingStatus().accountingComplete, true);
            }
        });
    }
}

test('foreign-video seeking is rejected by both actual listeners without mutation', () => {
    const h = combined(), before = JSON.stringify(h.c.replayAccountingStatus());
    const event = { type: 'seeking', target: {} };
    h.c.mainSeeking(event); h.c.handleReplayMediaContextChange(event); h.flush();
    assert.equal(JSON.stringify(h.c.replayAccountingStatus()), before);
    assert.equal(h.c.phase3Runtime.status().pendingCount, 2);
    assert.equal(h.c.replayPending.length, 3);
});
