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
function harness({ mode = 'blocked', maximum = 10 } = {}) {
    let now=0, timer=null, generation=1; const events=[];
    const messages = [], video = {};
    const window = { location: { origin: 'https://www.youtube.com' }, postMessage: m => messages.push(m),
        LiveFlowChatReadCore: core };
    const c = vm.createContext({ window, performance: {now:()=>now}, currentChatMode: 'replay', currentPageLifecycleGeneration: 0,
        pageLifecycleGeneration: 0, REPLAY_PIPELINE_DIAGNOSTIC_TYPE: 'pipeline',
        replayPendingClearOperations: new Map(), replayContentClearOperations: new Map(),
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
    vm.runInContext(['replayPendingClearClosureReady', 'reconcileReplayPendingClear', 'observeReplayPendingClearProof',
        'createReplayPipelineDiagnostic', 'applyReplayDiagnosticSnapshot', 'openReplayDiagnosticScope',
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
        return createSchedulerRuntime({ clock: () => now, generation: () => generation, geometryAdapter,
            scheduleOneShot: fn => (timer=fn), cancelOneShot() {},
            candidateProof: () => mode==='invalidatedStructural' ? (generation=2,{unrepresentableSpecial:true}) : mode==='structural' ? {unrepresentableSpecial:true} : mode==='success'||mode==='rejected' ? {
                candidates:[{rectangle:{x:100,y:0,width:50,height:20,velocity:100},lane:0,laneSpan:1}],activeComments:[],horizontalGap:20} : null,
            launch: () => { if(mode==='success'){c.replayDiagnosticDisplayed++;c.publishReplaySchedulerDiagnostic();}return mode!=='rejected'; },
            observe: e=>{events.push(e);c.observeReplayScheduler(e);},
            config: { maxPendingAge: 1000, maxPendingCount: maximum, pendingPressureCapacity: 5, scanDepth: 3,
                cohortMaximumItems: 3, cohortMaximumSpan: 50,
                pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: .75 },
                density: { attackThresholds: [.5, .7, .9], releaseThresholds: [.2, .3, .4], minimumAttackResidence: 1, releaseDwell: 3 },
                collisionAllowances: Object.fromEntries(['CONSERVATIVE','LIMITED_CATCH_UP','BOUNDED_OVERLAP','MAXIMUM_READABLE_RESCUE'].map(k=>[k,{nominalGap:20,hardMinimumSeparation:-10,maxCatchUpRatio:.5,maxOverlapDuration:1,maxOverlapDepthRatio:.2,minimumVisibleFraction:.8}])) } });
    }
    function enqueue(n) {
        if (!c.phase3Runtime) c.phase3Runtime = runtime();
        c.replayPipelineDiagnostic.receivedActions+=n;c.replayPipelineDiagnostic.messagesObserved+=n;c.replayPipelineDiagnostic.bridged+=n;
        for (let i = 0; i < n; i++) {
            const id = 'item-' + i;
            assert.equal(c.phase3Runtime.enqueue({ id }, { id, enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer', footprint: {} }), true);
        }
        c.publishReplayBatchAccounting({ inputCount: n, enqueuedCount: n }); flush();
    }
    return { c, messages, deliver, flush, enqueue, events, setNow:v=>{now=v;}, fire:()=>{const cb=timer;timer=null;cb?.();flush();}, seek: () => {
        const previous = c.openReplayDiagnosticScope(); c.postReplayDiagnosticScope(previous);
        c.handleReplayMediaContextChange({ type: 'seeking', target: video });
    } };
}

test('actual quiet enqueue publishes real pending and conserves',()=>{
 const h=harness();h.enqueue(1);assert.equal(h.c.replayAccountingStatus().lostUnaccounted,0);
 h.enqueue(1);assert.equal(h.c.phase3Runtime.status().pendingCount,2);assert.equal(h.c.replayAccountingStatus().schedulerRetained,2);
 assert.equal(h.c.replayAccountingStatus().stages.scheduler.lost,0);
});

function conserved(h){const a=h.c.replayAccountingStatus();assert.equal(a.stages.scheduler.valid,true,JSON.stringify(a.stages.scheduler));assert.equal(a.lostUnaccounted,0);assert.equal(a.overflowUnaccounted,0);}
function actualBatch(h,n){
 if(!h.c.phase3Runtime)h.enqueue(1);
 const c=h.c;c.replayPipelineDiagnostic.receivedActions+=n;c.replayPipelineDiagnostic.messagesObserved+=n;c.replayPipelineDiagnostic.bridged+=n;
 Object.assign(c,{runtime:c.phase3Runtime,visibleMessages:Array.from({length:n},(_,i)=>({id:'batch-'+i,messageType:'text'})),scheduledGeneration:1,scheduledVideo:{},launchSettingsSnapshot:{},performance:{now:()=>0},phase5Tuning:{lineHeight:20},inputCount:n});
 const start=content.indexOf('        let enqueuedCount = 0;'),end=content.indexOf('        observeLivePresentationBatch(',start);
 vm.runInContext('{'+content.slice(start,end)+'}',c);h.flush();
}
test('actual batch-N publishes once after quiet queue mutations and retains all items',()=>{
 const h=harness();h.enqueue(1);const prior=h.c.replayDiagnosticSequence;actualBatch(h,5);conserved(h);
 assert.equal(h.c.phase3Runtime.status().pendingCount,6);assert.equal(h.c.replayDiagnosticSequence-prior,1);
});
test('empty to ARMED snapshot is deferred until actual batch input counters commit',()=>{
 const h=harness();h.c.phase3Runtime=null;
 // Obtain Runtime normally, clear it, then keep input/removal history and send an actual new batch.
 h.enqueue(1);h.c.phase3Runtime.clear();h.flush();const prior=h.c.replayDiagnosticSequence;
 actualBatch(h,3);conserved(h);assert.equal(h.c.replayDiagnosticSequence-prior,1);assert.equal(h.c.phase3Runtime.status().pendingCount,3);
});
for(const mode of ['success','rejected','structural','stale'])test('actual stable publication after '+mode,()=>{
 const h=harness({mode:mode==='stale'?'blocked':mode});h.enqueue(2);if(mode==='stale')h.setNow(2000);
 const n=h.events.length;h.fire();conserved(h);
 if(mode==='success'){assert.equal(h.c.replayPipelineDiagnostic.launchCommitted,1);assert.equal(h.c.replayPipelineDiagnostic.launched,1);assert.equal(h.events.slice(n).filter(e=>e.type==='LAUNCH_COMMITTED').length,1);}
 if(mode==='rejected')assert.equal(h.c.phase3Runtime.status().pendingCount,2);
 if(mode==='structural')assert.equal(h.c.replayPipelineDiagnostic.schedulerStructuralDiscarded,2);
 if(mode==='stale')assert.equal(h.c.replayPipelineDiagnostic.stalePruned,2);
});
test('emergency and lifecycle removals retain real counts, repeated clear does not duplicate',()=>{
 const h=harness({maximum:2});h.enqueue(1);actualBatch(h,5);conserved(h);assert.equal(h.c.replayPipelineDiagnostic.emergencyPendingDropped,4);
 h.c.phase3Runtime.clear();h.flush();conserved(h);assert.equal(h.c.replayPipelineDiagnostic.schedulerLifecycleDiscarded,2);
 h.c.phase3Runtime.clear();h.flush();conserved(h);assert.equal(h.c.replayPipelineDiagnostic.schedulerLifecycleDiscarded,2);
});
test('capacity relief final publication reflects actual removed item without extra opportunity',()=>{
 const h=harness();h.enqueue(2);const dropped=h.c.phase3Runtime.queue.relieveSaturation(1);
 h.c.observeReplayScheduler({type:'CAPACITY_DROPPED',count:dropped.length});h.flush();conserved(h);
 assert.equal(h.c.replayPipelineDiagnostic.capacityDropped,1);assert.equal(h.c.phase3Runtime.status().pendingCount,1);
});
test('intermediate renderer publication is suppressed, stable commit and sequence reconcile',()=>{
 const h=harness({mode:'success'});h.enqueue(1);const before=h.c.replayDiagnosticSequence;h.fire();conserved(h);
 assert.equal(h.c.replayDiagnosticSequence-before,1);assert.equal(h.c.phase3Runtime.status().pendingCount,0);
 assert.equal(h.c.replayAccountingStatus().diagnosticScope.scopes[0].sequence,h.c.replayDiagnosticSequence);
});
test('missing genuine terminal still signals loss; no residual-derived pending',()=>{
 const h=harness();h.enqueue(1);h.c.phase3Runtime.queue.enforceHardCount(0);h.c.publishReplaySchedulerDiagnostic();h.flush();
 assert.equal(h.c.replayAccountingStatus().stages.scheduler.lost,1);
});

test('invalidated evaluation with structural removal and empty queue still publishes terminal totals',()=>{
 const h=harness({mode:'invalidatedStructural'});h.enqueue(2);h.fire();conserved(h);
 assert.equal(h.c.phase3Runtime.status().pendingCount,0);assert.equal(h.c.replayPipelineDiagnostic.schedulerStructuralDiscarded,2);
 assert.ok(h.events.some(e=>e.type==='GENERATION_INVALIDATED'));
});
test('actual batch exception is not swallowed and diagnostic publication flag is restored',()=>{
 const h=harness();h.enqueue(1);h.c.phase3Runtime={enqueue(){throw Error('Product failure');},status:()=>({state:'IDLE',pendingCount:1})};
 assert.throws(()=>actualBatch(h,1),/Product failure/);assert.equal(h.c.replayDiagnosticBatchInProgress,false);
});
test('generated diagnostic Content transform compiles without package generation',async()=>{
 const {instrumentInitialRequestContent}=await import('../tools/density-comparison/instrument-initial-request.mjs');
 const panelCopy=content.replaceAll('\r\n','\n').replace('    const LOG_PREFIX','    const comparisonNodes = new WeakMap();\n    const LOG_PREFIX')
  .replace('    initializePersistentSettings().then','    function installComparisonPanel() {\n        document.documentElement.append(panel);\n    }\n    initializePersistentSettings().then');
 new vm.Script(instrumentInitialRequestContent(panelCopy,{sourceSHA:'a'.repeat(40),commonBuildID:'b'.repeat(64)}));
});
