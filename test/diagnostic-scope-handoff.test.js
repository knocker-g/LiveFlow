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
test('actual MAIN/content handoff attributes real runtime clear to old input and starts a clean new ledger', () => {
    const h = harness(); h.enqueue(2);
    assert.equal(h.c.replayAccountingStatus().stages.scheduler.valid, true);
    h.seek();
    assert.equal(h.c.replayAccountingStatus().accountingComplete, false);
    // Open can reach MAIN before old terminal delivery: only diagnostics are incomplete, no runtime block.
    const open = h.messages.shift(); h.deliver(open);
    const old = h.messages.splice(0);
    for (const m of old.filter(m => m.diagnosticScopeEpoch === 1)) h.deliver(m);
    assert.equal(h.c.replayAccountingStatus().diagnosticScope.incomplete, true);
    for (const m of old.filter(m => m.diagnosticScopeEpoch === 0).reverse()) h.deliver(m);
    const status = h.c.replayAccountingStatus();
    assert.equal(status.accountingComplete, true);
    const archive = status.diagnosticScope.scopes[0];
    assert.equal(archive.state, 'CLOSED'); assert.equal(archive.scheduler.input, 2);
    assert.equal(archive.scheduler.explicitRemoval, 2); assert.equal(archive.scheduler.retained, 0);
    assert.equal(archive.scheduler.valid, true);
    assert.equal(status.stages.scheduler.input, 0); assert.equal(status.stages.scheduler.explicitRemoval, 0);
    assert.equal(status.lostUnaccounted, 0); assert.equal(status.overflowUnaccounted, 0);
    h.enqueue(3); assert.equal(h.c.replayAccountingStatus().stages.scheduler.valid, true);
    assert.equal(h.c.replayAccountingStatus().stages.scheduler.explicitRemoval, 0);
});
test('late old snapshots and duplicate terminal do not change current ledger', () => {
    const h = harness(); h.enqueue(2); h.seek();
    const copies = [...h.messages]; h.flush();
    const before = JSON.stringify(h.c.replayAccountingStatus());
    copies.filter(m => m.source === 'liveflow-content-script').forEach(h.deliver);
    assert.equal(JSON.stringify(h.c.replayAccountingStatus()), before);
});
test('ordinary cumulative input/displayed diagnostics preserve baseline accounting, independently of B/D policy', () => {
    const h = harness(); h.enqueue(2);
    h.c.phase3Runtime = null; // Synthetic completed-runtime snapshot; no live queue in this counter-only fixture.
    h.c.replaySchedulerDiagnostic.pendingCurrent = 0;
    h.c.replaySchedulerDiagnostic.launchCommitted = 2;
    h.c.replayDiagnosticDisplayed = 2; h.c.publishReplaySchedulerDiagnostic(); h.flush();
    const status = h.c.replayAccountingStatus();
    assert.equal(status.accountingComplete, true); assert.equal(status.warning, false);
    assert.equal(status.lostUnaccounted, 0); assert.equal(status.overflowUnaccounted, 0);
    h.c.publishReplaySchedulerDiagnostic(); h.flush();
    assert.equal(h.c.replayAccountingStatus().stages.scheduler.input, 2);
    assert.equal(h.c.replayAccountingStatus().displayed, 2);
});
test('missing terminal remains INCOMPLETE and warning even when current ledger is balanced', () => {
    const h = harness(); h.enqueue(2); h.seek();
    const terminal = h.messages.find(m => m.diagnosticTerminal);
    h.messages.splice(h.messages.indexOf(terminal), 1); h.flush();
    const status = h.c.replayAccountingStatus();
    assert.equal(status.stages.scheduler.valid, true);
    assert.equal(status.accountingComplete, false); assert.equal(status.warning, true);
    h.deliver(terminal); assert.equal(h.c.replayAccountingStatus().accountingComplete, true);
});
test('a missing sequence blocks terminal closure until delivered; duplicates and reversed arrival reconcile exactly once', () => {
    const seen = [], s = createScopes(0, {}, (_, m) => seen.push(m.diagnosticSequence));
    const message = n => ({ pageLifecycleGeneration: 0, diagnosticScopeEpoch: 0, diagnosticSequence: n,
        diagnosticTerminal: n === 3 });
    s.open(0, {}); s.receive(message(3)); s.receive(message(1)); s.receive(message(1));
    assert.equal(s.status().scopes[0].state, 'INCOMPLETE'); assert.deepEqual(seen, [1]);
    s.receive(message(2)); assert.deepEqual(seen, [1, 2, 3]); assert.equal(s.status().scopes[0].state, 'CLOSED');
    s.receive(message(2)); assert.deepEqual(seen, [1, 2, 3]);
});
test('unknown/lifecycle mismatched epochs are rejected; buffer exhaustion and extra post-terminal sequences fail closed', () => {
    const seen = [], s = createScopes(0, {}, (_, m) => seen.push(m.diagnosticSequence), { maximumBuffered: 2 });
    const m = (epoch, sequence, lifecycle = 0) => ({ diagnosticScopeEpoch: epoch, diagnosticSequence: sequence, pageLifecycleGeneration: lifecycle });
    assert.equal(s.receive(m(42, 1)), false); assert.equal(s.receive(m(0, 1, 1)), false);
    s.receive(m(0, 4)); assert.equal(s.status().incomplete, true); assert.deepEqual(seen, []);
    const t = createScopes(0, {}, () => {}); t.receive({ ...m(0, 1), diagnosticTerminal: true });
    t.receive(m(0, 2)); assert.equal(t.status().scopes[0].state, 'INCOMPLETE');
});
test('evicted unresolved archives remain INCOMPLETE rather than silently restoring PASS', () => {
    const s = createScopes(0, {}, () => {}, { maximumArchives: 1 });
    s.open(0, {}); s.open(0, {});
    assert.equal(s.status().discardedIncomplete, 1); assert.equal(s.status().incomplete, true);
    assert.equal(s.status().scopes.length, 2);
});
test('a terminal with invalid accounting stays INCOMPLETE after archive eviction', () => {
    const s = createScopes(0, {}, () => {}, { maximumArchives: 1, closureValid: () => false });
    s.receive({ diagnosticScopeEpoch: 0, pageLifecycleGeneration: 0, diagnosticSequence: 1, diagnosticTerminal: true });
    assert.equal(s.status().scopes[0].state, 'INCOMPLETE');
    s.open(0, {}); s.open(0, {});
    assert.equal(s.status().discardedIncomplete, 1);
});
test('missing close or repeated seek before open cannot silently bind a complete new scope', () => {
    const h = harness(); h.enqueue(2);
    const previous = h.c.openReplayDiagnosticScope(); h.c.postReplayDiagnosticScope(previous); h.flush();
    assert.equal(h.c.replayAccountingStatus().accountingComplete, false);
    assert.equal(h.c.replayAccountingStatus().diagnosticScope.scopes[1].state, 'INCOMPLETE');
    const h2 = harness(); h2.enqueue(2); h2.seek(); h2.seek(); h2.flush();
    assert.equal(h2.c.replayAccountingStatus().accountingComplete, false);
});
test('navigation and duplicate lifecycle notices preserve terminal attribution without sharing seek epochs', () => {
    const h = harness(); h.enqueue(2);
    h.c.pageLifecycleGeneration = 1; h.c.pageRevision = 1;
    h.c.postLifecycleInvalidated(); h.flush();
    const status = h.c.replayAccountingStatus();
    assert.equal(status.accountingComplete, true);
    assert.equal(status.diagnosticScope.scopes[0].scheduler.explicitRemoval, 2);
    assert.equal(status.diagnosticScope.scopes[1].lifecycle, 1);
    h.c.postLifecycleInvalidated(); h.flush();
    assert.equal(h.c.replayAccountingStatus().accountingComplete, true);
    assert.equal(h.c.replayAccountingStatus().diagnosticScope.scopes[1].state, 'OPEN');
});
test('a balanced current scope cannot qualify accounting while a closed archive retains genuine loss', () => {
    const h = harness(); h.enqueue(2);
    h.c.replayPipelineDiagnostic.receivedActions = 3;
    h.seek(); h.flush();
    const status = h.c.replayAccountingStatus();
    assert.equal(status.stages.scheduler.valid, true);
    assert.equal(status.diagnosticScope.scopes[0].lostUnaccounted, 1);
    assert.equal(status.accountingComplete, false); assert.equal(status.warning, true);
});
test('stale OPEN after close cannot resurrect the terminal epoch or contaminate the new baseline', () => {
    const h = harness(); h.enqueue(2); h.seek();
    const open = h.messages.shift();
    h.deliver({ ...open, diagnosticScopeEpoch: 0, previousEpoch: null });
    assert.equal(h.c.replayDiagnosticEpoch, null);
    h.deliver(open); h.flush();
    assert.equal(h.c.replayAccountingStatus().accountingComplete, true);
    assert.equal(h.c.replayAccountingStatus().stages.scheduler.explicitRemoval, 0);
});
test('dependency and scoped displayed/seek routes are wired in actual sources without changing runtime selection', () => {
    const manifest = JSON.parse(fs.readFileSync(require.resolve('../manifest.json'), 'utf8'));
    const scripts = manifest.content_scripts.find(s => s.js.includes('src/page-state-main.js')).js;
    assert.ok(scripts.indexOf('src/diagnostic-scope-core.js') < scripts.indexOf('src/page-state-main.js'));
    assert.match(main, /diagnosticScopes.receive\(event.data\)/);
    assert.match(main, /const previousDiagnosticEpoch = openReplayDiagnosticScope\(\);\s+postReplayDiagnosticScope\(previousDiagnosticEpoch\)/);
    assert.match(content, /replayDiagnosticDisplayed \+= 1;\s+publishReplaySchedulerDiagnostic\(\)/);
    assert.doesNotMatch(main, /event.data.type === REPLAY_DISPLAYED_TYPE &&/);
});
