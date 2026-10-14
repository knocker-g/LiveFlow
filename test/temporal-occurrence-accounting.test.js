const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../src/replay-control-plane-core');
const chat = require('../src/chat-read-core');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8').replaceAll('\r\n', '\n');
const content = fs.readFileSync(require.resolve('../src/youtube-chat'), 'utf8').replaceAll('\r\n', '\n');
function fn(source, name) {
    let start = source.indexOf('    function ' + name + '(');
    if (start < 0) start = source.indexOf('    async function ' + name + '(');
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n    }\n', start) + 7);
}
function harness({ ad = true, paused = false } = {}) {
    const calls = [], stages = [], snapshots = [], adapterReads = [];
    const video = { paused, seeking: false, ended: false, currentTime: 0, duration: 600, readyState: 2 };
    const data = { token: 'BEFORE_AD_TOKEN' }, root = { data, querySelector: () => video };
    const counted = { ...core };
    for (const name of ['createReplayAuthority', 'authorizeAuthorityRequest', 'claimAuthorityRequestGrant', 'invalidateAuthority']) {
        counted[name] = function (...args) { calls.push({ name, kind: args[0]?.kind || args[0]?.expectedKind || args[1], token: args[0]?.opaqueToken }); return core[name](...args); };
    }
    const c = vm.createContext({ window: { LiveFlowChatReadCore: { ...chat,
        extractWatchTargetIdentity() { return c.urlTarget; },
        evaluateBootstrapTarget() { return { available: true, matched: c.targetMatched, supportingCandidateCount: 1, supportingMatchCount: 1 }; },
        classifyInitialChatMode() { return 'replay'; } }, location: { origin: 'x' },
        queueMicrotask(cb) { cb(); }, postMessage(m) { snapshots.push(m); } },
        location: { origin: 'x', pathname: '/watch', search: '' }, document: { hidden: false, visibilityState: 'visible', querySelector: () => root },
        AbortController, urlTarget: 'FIXTURE', targetMatched: true, ad,
        pageState: { mode: 'unknown', targetIdentity: '', context: null }, pageKey: 'x/watch',
        pageLifecycleGeneration: 0, pageRevision: 0, currentLoopGeneration: 0, activeLoopGeneration: 0,
        navigationPending: false, navigationPageDataUpdated: false, navigationCompletionTargetIdentity: '', establishedTargetIdentity: '', invalidatedTargetIdentity: '',
        lastEstablishedWatchRoot: null, lastEstablishedVideo: null, watchRootObserver: null, readAttemptedRevision: -1, readCount: 0,
        replayControlPlaneCore: counted, replayControlShadow: core.createShadowController(), replayProductionControlState: core.createReplayState('STOPPED'),
        replayConsumedAuthorityRegistry: core.createConsumedAuthorityRegistry(), replayBootstrapEligibilityLifecycleId: -1, replayBootstrapAuthority: null,
        replayInitialBootstrapWait: null, replayInitialBootstrapIntent: null, replayInitialBootstrapCancelledLifecycleId: -1,
        readRequestInFlight: false, replayReanchorLock: false, replayPlayerSeekDiagnosticLock: false, runtimeUserEnabled: true,
        replaySeekAuthority: null, replayPausedSequentialAuthority: null, replayObservedSequentialAuthority: null,
        replayReanchorIntent: null, replayAdActive: false, replayAdExitNeedsReanchor: false, replaySeekInProgress: false, replaySeekNeedsReanchor: false,
        replaySeekEpoch: 0, replayForegroundRecoveryOwnedVideo: null, replayReanchorAbortController: null, replayForegroundRetainedAbortController: null,
        replayRestartDiagnostic: { sequence: 1, restartStage: '' }, replayPlayerSeekDiagnostic: { armed: false, inFlight: false },
        replayCredentiallessSchemaDiagnostic: { armed: false }, replayPending: [], replayStartTimeSeconds: 0,
        replayAwaitingFirstFreshSequentialResponse: false, replaySequentialResumeHandoff: false,
        activeAbortController: null, deferredVisibilityResumeGeneration: null, deferredReadStartGeneration: null, readStopReason: 'none',
        REQUEST_TYPE: 'INITIAL', READ_REQUEST_TYPE: 'READ', STOP_READ_LOOP_TYPE: 'STOP', REPLAY_AD_ENTER_TYPE: 'AD_ENTER', REPLAY_AD_EXIT_TYPE: 'AD_EXIT',
        REPLAY_PIPELINE_DIAGNOSTIC_TYPE: 'PIPELINE', RESUME_READ_LOOP_TYPE: 'RESUME', RESPONSE_TYPE: 'SNAPSHOT',
        getCurrentMainVideo: () => video, replayAdIsActive: () => c.ad,
        isCurrentPageStateTarget: () => c.pageState.targetIdentity === c.urlTarget && c.targetMatched,
        bindWatchRootObserver: () => false, readContinuation(s) { adapterReads.push(s.token); return s.token; }, readInternalApiContext: () => ({}),
        readBootstrapTargetEvidence: () => ({}), applyLiveToReplayModeTransition: () => false,
        postLifecycleDiagnostic: (event, details) => calls.push({ name: event, details }),
        invalidateReplaySeekAuthority: () => {}, replaySeekAuthorityEligibleForHidden: () => false,
        observeReplayRuntimeAccounting: () => {}, terminateReplayForegroundRetainedDiagnostic: () => {}, observeReplayForegroundHidden: () => {},
        stopReadLoop() { c.currentLoopGeneration++; c.activeLoopGeneration = 0; },
        setReplayRestartStage(...args) { stages.push(args); }, beginReplayRestart: () => {},
        performRead: async () => { calls.push({ name: 'HTTP' }); return { ok: false, errorType: 'invalid_json' }; }
    });
    const names = ['currentReplayAuthorityBinding', 'observeReplayControlShadow', 'authorizeReplayAuthority', 'acceptReplayBootstrapCandidate',
        'deferReplayInitialBootstrap', 'initialReplayBootstrapIntentIsCurrent', 'admitReadyReplayBootstrap', 'resumeInitialReplayBootstrap',
        'startReplayBootstrap', 'invalidateReplayBootstrapAuthority', 'invalidateAuthorityHandle', 'enterReplaySuspended',
        'respond', 'settleReplayAdExit', 'startReadLoop', 'restartReplayFromCurrentPosition', 'createReplayPipelineDiagnostic', 'createReplayForegroundRecoveryDiagnostic'];
    vm.runInContext(names.map(n => fn(main, n)).join('\n') + '\nreplayPipelineDiagnostic=createReplayPipelineDiagnostic();replayForegroundRecoveryDiagnostic=createReplayForegroundRecoveryDiagnostic();', c);
    const loop = c.startReadLoop;
    c.startReadLoop = function (...args) { c.lastGrant = args[2]; c.running = loop(...args); return c.running; };
    c.window.addEventListener = (_, cb) => c.listener = cb;
    const start = main.indexOf("    window.addEventListener('message', (event) => {");
    vm.runInContext(main.slice(start, main.indexOf('\n    });', start) + 8), c);
    const send = type => c.listener({ source: c.window, origin: 'x', data: { source: 'liveflow-content-script', type, pageLifecycleGeneration: c.pageLifecycleGeneration } });
    const count = name => calls.filter(x => x.name === name).length;
    return { c, video, data, calls, stages, snapshots, adapterReads, send, count };
}

function temporalHarness(){
 const h=harness({ad:false}),c=h.c;
 Object.assign(c,{REPLAY_MAX_PENDING:2,replayTimingDiagnosticSeen:{filtered:new Set(),future:new Set(),due:new Set(),capacityDropped:new Set()},
 replayGapEvidence:null,replayGapOriginDiagnostic:{},replayTemporalStarvationDiagnostic:{},replayPressureEpisodeActive:false,
 replayEpisodeAdvancedBudgetUsed:0,replayEarlyResumeCompleted:false,replayRunwayDepletionEpisodeState:'UNKNOWN',
 replayEarlyResumeSuppressionState:'CLEAR',replayAcquisitionPausedForBuffer:false,replayReadAheadDeferred:false,
 activeWaitTimer:null,replayTemporalPendingDiagnostic:null,replayCoverageHoleEpisodeState:{active:false,spent:false},readStopReason:'none',forwarded:[]});
 for(const name of ['updateReplayTemporalStarvationDiagnostic','updateReplayTemporalLeadShadowDiagnostic','armReplayTemporalWakeup','cancelReplayTemporalWakeup','observeReplayGapPersistence','resetReplayGapOriginDiagnostic','abortReplayPlayerSeekDiagnostic'])c[name]=()=>{};
 c.maybeQueueReplayCoverageHoleRepair=()=>false;c.replayGapOriginStatus=()=>({});
 c.savedSequentialDiagnostic=()=>null;c.postReadResult=result=>{c.forwarded.push(...result.messages);};
 const names=['observeReplayPendingMerge','observeReplayPipelineResponse','flushReplayPending','replayAccountingStatus','stopReadLoop','failClosedSavedSequentialResume'];
 for(const name of ['recordReplayTemporalDiscard','observeReplayTemporalPendingRemoval','observeReplayTemporalPendingMerge'])if(main.includes('    function '+name+'('))names.push(name);
 vm.runInContext(names.map(n=>fn(main,n)).join('\n'),c);
 c.pageState={mode:'replay',targetIdentity:'FIXTURE'};c.replayProductionControlState=core.createReplayState('READING');c.replayStartTimeSeconds=4;
 h.video.currentTime=5;
 const start=main.indexOf('                const priorPending = replayPending.slice();',main.indexOf('const shadowResponseEvent'));
 const end=main.indexOf("                if (continuationSource === 'BUFFER_EARLY_RESUME')",start);
 const merge=main.slice(start,end);
 const accept=items=>{c.result={ok:true,messages:items,summary:{actionCount:items.length}};c.generation=c.currentLoopGeneration;c.revision=0;c.lifecycleGeneration=0;c.diagnosticSequence=0;
 vm.runInContext('{observeReplayPipelineResponse(result);'+merge+'}',c);};
 const status=()=>c.replayAccountingStatus(c.replayPipelineDiagnostic,false);
 return {...h,accept,status,flush:()=>c.flushReplayPending(c.currentLoopGeneration,0,0,0,'temporal-wakeup')};
}
test('actual accepted response merge and selector account exact-ID removal',()=>{
 const h=temporalHarness();h.accept([{id:'same',replayOffsetMsec:8000},{id:'same',replayOffsetMsec:8000}]);
 assert.equal(h.status().stages.temporal.lost,0);assert.equal(h.c.replayPending.length,1);
});

function balanced(h){const t=h.status().stages.temporal;assert.equal(t.valid,true,JSON.stringify(t));assert.equal(t.lost,0);assert.equal(t.overflow,0);}
for(const scenario of ['repeated filter','idless filter','invalid timing','capacity repeat','future promotion'])test('actual temporal occurrences: '+scenario,()=>{
 const h=temporalHarness();
 if(scenario==='repeated filter'){h.accept([{id:'old',replayOffsetMsec:1000}]);h.accept([{id:'old',replayOffsetMsec:1000}]);assert.equal(h.status().beforeStartFiltered,2);assert.equal(h.status().uniqueBeforeStartFiltered,1);}
 if(scenario==='idless filter'){h.accept([{id:'',replayOffsetMsec:1000},{replayOffsetMsec:1000}]);assert.equal(h.status().beforeStartFiltered,2);assert.equal(h.status().uniqueBeforeStartFiltered,0);}
 if(scenario==='invalid timing'){h.accept([{id:'invalid',replayOffsetMsec:NaN}]);assert.equal(h.status().temporalInvalid,1);assert.equal(h.status().beforeStartFiltered,0);}
 if(scenario==='capacity repeat'){for(let i=0;i<2;i++)h.accept([{id:'near',replayOffsetMsec:7000},{id:'mid',replayOffsetMsec:8000},{id:'far',replayOffsetMsec:9000}]);assert.equal(h.status().capacityDropped,2);assert.equal(h.status().uniqueCapacityDropped,1);assert.equal(h.status().temporalDeduped,2);}
 if(scenario==='future promotion'){h.accept([{id:'future',replayOffsetMsec:8000}]);h.flush();balanced(h);h.video.currentTime=8;h.flush();h.flush();assert.equal(h.c.forwarded.length,1);assert.equal(h.status().temporalDiscarded,0);assert.equal(h.status().futureQueued,0);}
 balanced(h);
});
test('actual HIDDEN clear removes old pending exactly once and leaves Product pause effects unchanged',()=>{
 const h=temporalHarness();h.accept([{id:'a',replayOffsetMsec:8000},{id:'b',replayOffsetMsec:9000}]);h.c.document.hidden=true;h.c.enterReplaySuspended('HIDDEN');
 balanced(h);assert.equal(h.status().temporalRemovalReasons.HIDDEN,2);assert.equal(h.status().futureQueued,0);assert.equal(h.c.replayPending.length,0);
 h.c.enterReplaySuspended('HIDDEN');balanced(h);assert.equal(h.status().temporalRemovalReasons.HIDDEN,2);assert.equal(h.count('HTTP'),0);
});
test('actual fail-closed queue clear attributes occurrences, not unique IDs',()=>{
 const h=temporalHarness();h.accept([{id:'a',replayOffsetMsec:8000}]);h.c.failClosedSavedSequentialResume();h.c.failClosedSavedSequentialResume();balanced(h);
 assert.equal(h.status().temporalRemovalReasons.FAIL_CLOSED,1);
});
function replace(h,items,reason='FOREGROUND'){
 const c=h.c;c.result={ok:true,messages:items};c.intent={reason};c.playerOffsetMs=5000;
 const start=main.indexOf("                const priorPending = intent.reason === 'COVERAGE_HOLE'");
 const end=main.indexOf('                const freshBinding =',start);
 vm.runInContext('{observeReplayPipelineResponse(result);'+main.slice(start,end)+'}',c);
}
test('actual non-coverage pending replacement removes old queue once; coverage merge preserves it',()=>{
 const h=temporalHarness();h.accept([{id:'old',replayOffsetMsec:8000}]);replace(h,[{id:'new',replayOffsetMsec:9000}]);balanced(h);
 assert.equal(h.status().temporalRemovalReasons.REANCHOR_REPLACED,1);assert.deepEqual(Array.from(h.c.replayPending,x=>x.id),['new']);
 replace(h,[{id:'third',replayOffsetMsec:10000}],'COVERAGE_HOLE');balanced(h);assert.equal(h.status().temporalRemovalReasons.REANCHOR_REPLACED,1);
});
test('actual read-start reset terminal; preserving SEQUENTIAL branch makes no removal',()=>{
 const h=temporalHarness();h.accept([{id:'old',replayOffsetMsec:8000}]);const c=h.c;
 const start=main.indexOf('            const preserveSequentialPending =');const end=main.indexOf("            if (requestAuthorityKind === 'BOOTSTRAP')",start);
 c.core=chat;c.video=h.video;c.requestAuthorityKind='SEQUENTIAL';c.replaySequentialResumeHandoff=true;
 vm.runInContext('{'+main.slice(start,end)+'}',c);balanced(h);assert.equal(h.status().temporalDiscarded,0);
 c.replaySequentialResumeHandoff=false;vm.runInContext(main.slice(start,end),c);balanced(h);assert.equal(h.status().temporalRemovalReasons.READ_START_RESET,1);
});
test('accepted response without fresh chain terminal is explicit rather than unexplained loss',()=>{
 const h=temporalHarness(),c=h.c;c.result={ok:true,messages:[{id:'x',replayOffsetMsec:9000}]};c.nextSequentialAuthority=null;c.diagnosticSequence=0;
 const start=main.indexOf('                if (!nextSequentialAuthority)');const end=main.indexOf('                const responseCapabilitySnapshot',start);
 vm.runInContext('observeReplayPipelineResponse(result);while(true){'+main.slice(start,end)+'break;}',c);balanced(h);
 assert.equal(h.status().temporalRemovalReasons.NO_FRESH_CHAIN,1);assert.equal(h.c.replayPending.length,0);
});
test('accepted-before-merge and selected-before-bridge snapshots retain unfinished occurrences',()=>{
 const h=temporalHarness(),c=h.c;c.observeReplayPipelineResponse({ok:true,messages:[{id:'x',replayOffsetMsec:5000}]});balanced(h);assert.equal(h.status().temporalUnclassified,1);
 const seen=[];c.observeReplayRuntimeAccounting=()=>seen.push(c.replayAccountingStatus(c.replayPipelineDiagnostic,false).stages.temporal);
 c.replayPending=[{id:'x',replayOffsetMsec:5000}];c.observeReplayTemporalPendingMerge(1);h.flush();
 assert.ok(seen.length>0);assert.ok(seen.every(t=>t.valid));balanced(h);
});
test('stale guard leaves actual pending/counters intact; true unexplained loss still detected',()=>{
 const h=temporalHarness();h.accept([{id:'x',replayOffsetMsec:8000}]);const before=JSON.stringify(h.status());h.c.flushReplayPending(999,0,0);assert.equal(h.c.replayPending.length,1);balanced(h);
 h.c.replayPipelineDiagnostic.messagesObserved++;assert.equal(h.status().stages.temporal.lost,1);assert.equal(h.status().stages.temporal.valid,false);
});
test('queue ownership retains original diagnostic attribution when scope opens before clear',()=>{
 const h=temporalHarness();h.accept([{id:'old',replayOffsetMsec:8000}]);const old=h.c.replayPipelineDiagnostic;
 h.c.replayPipelineDiagnostic=h.c.createReplayPipelineDiagnostic();h.c.stopReadLoop('seek');
 assert.equal(old.temporalRemovalReasons.SEEK,1);assert.equal(h.c.replayAccountingStatus(old,false).stages.temporal.valid,true);balanced(h);assert.equal(h.status().temporalDiscarded,0);
});

test('unknown or mixed queue ownership stays incomplete instead of receiving a false PASS',()=>{
 const h=temporalHarness();h.c.replayPending=[{id:'unobserved',replayOffsetMsec:8000}];h.c.stopReadLoop('explicit');
 assert.equal(h.status().accountingComplete,false);assert.equal(h.status().stages.temporal.overflow,1);
 const m=temporalHarness();m.accept([{id:'old',replayOffsetMsec:8000}]);const old=m.c.replayPipelineDiagnostic;
 m.c.replayPipelineDiagnostic=m.c.createReplayPipelineDiagnostic();m.c.observeReplayPipelineResponse({ok:true,messages:[{id:'new'}]});
 m.c.replayPending=m.c.replayPending.concat([{id:'new'}]);m.c.observeReplayTemporalPendingMerge(1);
 assert.equal(old.temporalAccountingIncomplete,true);assert.equal(m.status().accountingComplete,false);
});
test('terminal reason snapshot is anonymous and immutable; no new discriminator API needed',()=>{
 const h=temporalHarness();h.accept([{id:'PRIVATE_ID',message:'PRIVATE_COMMENT',replayOffsetMsec:8000}]);h.c.stopReadLoop('pagehide');
 const s=h.status();assert.equal(s.temporalRemovalReasons.PAGEHIDE,1);assert.equal(Object.isFrozen(s.temporalRemovalReasons),true);
 assert.doesNotMatch(JSON.stringify(s),/PRIVATE_ID|PRIVATE_COMMENT|opaqueToken|replayOffsetMsec/);balanced(h);
});
test('scope closure rejects nonterminal temporal retained work even with conservation',()=>{
 const h=temporalHarness();vm.runInContext(fn(main,'replayDiagnosticClosureValid'),h.c);
 h.accept([{id:'future',replayOffsetMsec:8000}]);balanced(h);assert.equal(h.c.replayDiagnosticClosureValid(h.c.replayPipelineDiagnostic),false);
 h.c.stopReadLoop('explicit');assert.equal(h.c.replayDiagnosticClosureValid(h.c.replayPipelineDiagnostic),true);
});

test('merged but not selected occurrences are retained-unclassified, never labelled future',()=>{
 const h=temporalHarness(),c=h.c;const item={id:'due',replayOffsetMsec:5000};c.observeReplayPipelineResponse({ok:true,messages:[item]});
 c.replayPending=c.replayPending.concat([item]);c.observeReplayTemporalPendingMerge(1);balanced(h);
 assert.equal(h.status().stages.temporal.retained,1);assert.equal(h.status().stages.future.input,0);
 h.flush();balanced(h);assert.equal(h.status().stages.temporal.retained,0);assert.equal(h.c.forwarded.length,1);
});

test('actual stop paths expose fixed anonymous terminal reasons without double removal',()=>{
 for(const [reason,key] of [['ad-enter','AD'],['navigation','NAVIGATION'],['user-disabled','USER_DISABLED'],['pagehide','PAGEHIDE'],['mode-transition','MODE_TRANSITION'],['playback-rate-change','RATE_CHANGE'],['explicit','EXPLICIT'],['unknown','OTHER']]){
  const h=temporalHarness();h.accept([{id:'future',replayOffsetMsec:8000}]);h.c.stopReadLoop(reason);h.c.stopReadLoop(reason);balanced(h);assert.equal(h.status().temporalRemovalReasons[key],1);assert.equal(h.status().temporalDiscarded,1);assert.equal(h.count('HTTP'),0);
 }
});
