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
        replayTemporalPendingDiagnostic: null, activeAbortController: null, deferredVisibilityResumeGeneration: null, deferredReadStartGeneration: null, readStopReason: 'none',
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
        'respond', 'settleReplayAdExit', 'recordReplayTemporalDiscard', 'observeReplayTemporalPendingRemoval', 'observeReplayTemporalPendingMerge', 'startReadLoop', 'restartReplayFromCurrentPosition', 'createReplayPipelineDiagnostic', 'createReplayForegroundRecoveryDiagnostic', 'suspendReplayForMediaPause', 'savedSequentialDiagnostic'];
    vm.runInContext(names.map(n => fn(main, n)).join('\n') + '\nreplayPipelineDiagnostic=createReplayPipelineDiagnostic();replayForegroundRecoveryDiagnostic=createReplayForegroundRecoveryDiagnostic();', c);
    // The real MAIN message guard now recognizes typed cleanup ACKs. Use the
    // Product declaration, as the cleanup integration transport does; no ACK is sent.
    const ackType = main.match(/^    const PENDING_ONLY_CLEAR_ACK_TYPE = '[^']+';$/m);
    assert.ok(ackType, 'Product ACK type declaration');
    vm.runInContext(ackType[0], c);
    const loop = c.startReadLoop;
    c.startReadLoop = function (...args) { c.lastGrant = args[2]; c.running = loop(...args); return c.running; };
    c.window.addEventListener = (type, cb) => { if(type==='message') c.listener=cb; else c.pauseListener=cb; };
    const start = main.indexOf("    window.addEventListener('message', (event) => {");
    vm.runInContext(main.slice(start, main.indexOf('\n    });', start) + 8), c);
    const send = type => c.listener({ source: c.window, origin: 'x', data: { source: 'liveflow-content-script', type, pageLifecycleGeneration: c.pageLifecycleGeneration } });
    c.cancelReplayTemporalWakeup=()=>{c.wakes=(c.wakes||0)+1;};
    const pauseStart=main.indexOf("    window.addEventListener('pause', (event) => {");
    vm.runInContext(main.slice(pauseStart,main.indexOf('\n    }, true);',pauseStart)+14),c);
    const pause=()=>c.pauseListener({target:video});
    const count = name => calls.filter(x => x.name === name).length;
    return { c, video, data, calls, stages, snapshots, adapterReads, send, count, pause };
}

test('owned initial-ad intent pause aligns reducer without Authority effects',()=>{
 const h=harness();h.send('INITIAL');h.pause();
 assert.equal(h.c.replayControlShadow.status().mismatchCount,0);
 assert.equal(h.count('HTTP'),0);assert.equal(h.c.currentLoopGeneration,0);
 assert.equal(h.c.replayBootstrapAuthority,null);assert.ok(h.c.replayInitialBootstrapIntent);
});

for(const scenario of ['wait','stale','cancelled','none','reading','midroll']) test('actual pause listener: '+scenario,()=>{
 const h=harness({ad:scenario!=='wait',paused:true});h.send('INITIAL');
 if(scenario==='stale') h.c.pageRevision++;
 if(scenario==='cancelled') h.c.replayInitialBootstrapCancelledLifecycleId=0;
 if(scenario==='none') h.c.replayInitialBootstrapIntent=null;
 if(scenario==='wait') h.c.startReplayBootstrap(0);
 if(scenario==='reading'||scenario==='midroll'){
  h.c.replayInitialBootstrapIntent=null;const phase=scenario==='reading'?'READING':'SUSPENDED';
  const state=core.createReplayState(phase,scenario==='midroll'?'AD':undefined);
  h.c.replayProductionControlState=state;h.c.replayControlShadow=core.createShadowController(state);
 }
 const gen=h.c.currentLoopGeneration, auth=h.c.replayBootstrapAuthority;
 h.pause();h.pause();
 assert.equal(h.c.currentLoopGeneration,gen);assert.equal(h.c.replayBootstrapAuthority,auth);
 assert.equal(h.count('HTTP'),0);assert.equal(h.c.activeLoopGeneration,0);
 assert.equal(h.c.readStopReason,'playback-paused');assert.equal(h.c.wakes,2);
 assert.equal(h.c.replayControlShadow.status().mismatchCount,['stale','cancelled','none'].includes(scenario)?2:scenario==='reading'?1:0);
});
test('duplicate readiness/pause keeps one original Authority and READ ceiling',async()=>{
 const h=harness();h.send('INITIAL');h.pause();h.pause();h.c.ad=false;
 // Keep paused before readiness, then permit only genuine play handoff.
 h.video.paused=true;h.send('AD_EXIT');h.c.settleReplayAdExit({target:h.video});h.pause();
 h.video.paused=false;h.c.restartReplayFromCurrentPosition({type:'play',target:h.video});await h.c.running;
 assert.equal(h.count('HTTP'),1);assert.equal(h.count('createReplayAuthority'),1);
 assert.equal(h.c.replayControlShadow.status().mismatchCount,0);
});
const {createInitialAuthorityTrace}=require('../tools/density-comparison/initial-authority-trace');
const identity={sourceSHA:'a'.repeat(40),commonBuildID:'b'.repeat(64)};
function success(c){
 for(const step of ['BOOTSTRAP_ACCEPTANCE','AUTHORIZATION_RESULT','GRANT_CLAIM_RESULT','READ_RESULT'])c.record(step,{kind:'BOOTSTRAP',outcome:'SUCCESS'});
 c.record('READ_LIFECYCLE_EVENT',{event:'READ_REQUEST_BEGIN'});
 c.record('SHADOW_DISPATCH',{event:'BOOTSTRAP_SUCCEEDED'});
}
test('critical archive survives noise, freezes on actual terminal and copies snapshots',()=>{
 const c=createInitialAuthorityTrace(identity);c.record('TRACE_INSTALLED');c.record('INITIAL_REQUEST_RECEIVED');
 for(let i=0;i<400;i++)c.record('INITIAL_DISPATCH_GUARD_REJECTED',{reason:'SOURCE_GUARD'});
 c.record('READ_RESULT',{outcome:'SUCCESS'});assert.equal(c.snapshot().criticalArchive.frozen,false);
 success(c);const before=c.snapshot().criticalArchive;assert.equal(before.completeness,'COMPLETE');
 for(let i=0;i<400;i++)c.record('INITIAL_RESPOND_ENTRY');
 assert.deepEqual(c.snapshot().criticalArchive,before);assert.equal(c.snapshot().rows.length,256);
 before.rows[0].step='MUTATED';assert.equal(c.snapshot().criticalArchive.rows[0].step,'TRACE_INSTALLED');
});
test('archive cap128 overflow and fault report INCOMPLETE without changing ring',()=>{
 const c=createInitialAuthorityTrace(identity);c.record('TRACE_INSTALLED');for(let i=0;i<130;i++)c.record('INITIAL_RESPOND_ENTRY');success(c);
 const a=c.snapshot().criticalArchive;assert.equal(a.rows.length,128);assert.equal(a.overflow,true);assert.equal(a.completeness,'INCOMPLETE');
 const f=createInitialAuthorityTrace(identity);f.record('TRACE_INSTALLED');f.record('bad');success(f);
 assert.equal(f.snapshot().criticalArchive.fault,true);assert.equal(f.snapshot().criticalArchive.completeness,'INCOMPLETE');
});
test('first mismatch retains scope and evaluated fact; anonymous allowlist only',()=>{
 const c=createInitialAuthorityTrace(identity);c.record('TRACE_INSTALLED');c.record('SHADOW_DISPATCH',{event:'MEDIA_PAUSE',mismatchDelta:1,mismatch:'FORBIDDEN_LEGACY_TRANSITION',lifecycle:0,generation:0,initialBootstrap:'ABSENT',token:'SECRET',url:'SECRET',target:'SECRET'});
 for(let i=0;i<300;i++)c.record('SHADOW_CAPABILITY');
 assert.equal(c.snapshot().firstMismatch.initialBootstrap,'ABSENT');assert.equal(c.snapshot().firstMismatch.lifecycle,0);
 assert.doesNotMatch(JSON.stringify(c.snapshot()),/SECRET|token|url|target/);
});
test('missing initial milestones stay INCOMPLETE even with success terminal',()=>{
 const c=createInitialAuthorityTrace(identity);c.record('TRACE_INSTALLED');c.record('SHADOW_DISPATCH',{event:'BOOTSTRAP_SUCCEEDED'});
 assert.equal(c.snapshot().criticalArchive.completeness,'INCOMPLETE');
});
test('generated MAIN/Core anchors compile; archive stays dev-only',async()=>{
 const {instrumentInitialAuthorityTrace}=await import('../tools/density-comparison/instrument-initial-authority.mjs');
 const {instrumentInitialRequestMain}=await import('../tools/density-comparison/instrument-initial-request.mjs');
 const result=instrumentInitialAuthorityTrace(main,fs.readFileSync(require.resolve('../src/replay-control-plane-core'),'utf8'),identity);
 new vm.Script(instrumentInitialRequestMain(result.main));new vm.Script(result.core);
 assert.match(result.main,/INITIAL_INTENT_RESUME_ENTRY/);assert.match(result.main,/criticalArchive/);
 assert.doesNotMatch(main,/criticalArchive|createInitialAuthorityTrace/);
 assert.doesNotMatch(fs.readFileSync('manifest.json','utf8'),/initial-authority-trace|density-comparison/);
});

test('generated observer preserves evaluated pause facts in critical context',async()=>{
 const {instrumentInitialAuthorityTrace}=await import('../tools/density-comparison/instrument-initial-authority.mjs');
 const result=instrumentInitialAuthorityTrace(main,fs.readFileSync(require.resolve('../src/replay-control-plane-core'),'utf8'),identity);
 const h=harness();h.send('INITIAL');const collector=createInitialAuthorityTrace(identity);collector.record('TRACE_INSTALLED');
 const exports={};const sandbox=vm.createContext({module:{exports},console});vm.runInContext(result.core,sandbox);
 h.c.replayControlPlaneCore=sandbox.module.exports;
 h.c.replayControlShadow=h.c.replayControlPlaneCore.createShadowController(h.c.replayProductionControlState,(step,details)=>collector.record(step,details));
 h.c.initialTrace=(step,details)=>collector.record(step,{lifecycle:0,generation:h.c.currentLoopGeneration,...details});
 vm.runInContext(fn(result.main,'observeReplayControlShadow'),h.c);h.pause();
 const rows=collector.snapshot().criticalArchive.rows;assert.ok(rows.some(r=>r.step==='CONTROL_TRANSITION'&&r.initialIntent==='PRESENT'&&r.bootstrapWait==='ABSENT'&&r.initialBootstrap==='PRESENT'));
 assert.ok(rows.some(r=>r.step==='SHADOW_DISPATCH'&&r.initialBootstrap==='PRESENT'));assert.equal(collector.snapshot().firstMismatch,null);
});
test('fault during or after frozen capture marks incomplete; terminal failure stays explicit',()=>{
 const c=createInitialAuthorityTrace(identity);c.record('TRACE_INSTALLED');c.record('SHADOW_DISPATCH',{event:'BOOTSTRAP_FAILED'});
 assert.equal(c.snapshot().criticalArchive.terminal,'BOOTSTRAP_FAILED');assert.equal(c.snapshot().criticalArchive.frozen,true);
 c.fault();assert.equal(c.snapshot().criticalArchive.completeness,'INCOMPLETE');
});

test('collector getter fault cannot affect generated shadow branch or request effects',async()=>{
 const {instrumentInitialAuthorityTrace}=await import('../tools/density-comparison/instrument-initial-authority.mjs');
 const result=instrumentInitialAuthorityTrace(main,fs.readFileSync(require.resolve('../src/replay-control-plane-core'),'utf8'),identity);
 const sandbox=vm.createContext({module:{exports:{}}});vm.runInContext(result.core,sandbox);
 const state=core.createReplayState('BOOTSTRAPPING'), baseline=core.createShadowController(state);
 const traced=sandbox.module.exports.createShadowController(state,()=>{throw Error('collector fault');});
 assert.equal(traced.dispatch('MEDIA_PAUSE',{initialBootstrap:true}).shadowPhase,baseline.dispatch('MEDIA_PAUSE',{initialBootstrap:true}).shadowPhase);
 const c=createInitialAuthorityTrace(identity);c.record('TRACE_INSTALLED');
 c.record('INITIAL_RESPOND_ENTRY',{get lifecycle(){throw Error('fault');}});
 assert.equal(c.snapshot().criticalArchive.completeness,'INCOMPLETE');assert.equal(c.snapshot().collectorFault,true);
});
test('firstMismatch copies actual preceding control context without leaking arbitrary fields',()=>{
 const c=createInitialAuthorityTrace(identity);c.record('TRACE_INSTALLED');c.record('CONTROL_TRANSITION',{event:'MEDIA_PAUSE',initialIntent:'PRESENT',initialBootstrap:'ABSENT',bootstrapWait:'ABSENT',lifecycle:0});
 c.record('SHADOW_DISPATCH',{event:'MEDIA_PAUSE',mismatchDelta:1});
 assert.equal(c.snapshot().firstMismatch.context.initialIntent,'PRESENT');
 const s=c.snapshot();s.firstMismatch.context.initialIntent='MUTATED';assert.equal(c.snapshot().firstMismatch.context.initialIntent,'PRESENT');
});

test('every stale intent binding rejects media-wait; unowned pause has zero effects',()=>{
 for(const mutate of [h=>h.c.pageLifecycleGeneration++,h=>h.c.currentLoopGeneration++,h=>h.c.urlTarget='OTHER']){
  const h=harness();h.send('INITIAL');mutate(h);h.pause();assert.equal(h.c.replayControlShadow.status().mismatchCount,1);
  assert.equal(h.count('HTTP'),0);assert.equal(h.count('authorizeAuthorityRequest'),0);
 }
 const h=harness();h.send('INITIAL');h.c.pauseListener({target:{}});assert.equal(h.c.wakes,undefined);assert.equal(h.c.replayControlShadow.status().mismatchCount,0);
});
test('READING pause preserves original abort and saved single-use SEQUENTIAL effects',()=>{
 const h=harness();h.send('INITIAL');h.c.replayInitialBootstrapIntent=null;
 const state=core.createReplayState('READING');h.c.replayProductionControlState=state;h.c.replayControlShadow=core.createShadowController(state);
 const authority=core.createReplayAuthority({kind:'SEQUENTIAL',opaqueToken:'PRIVATE',binding:core.createAuthorityBinding({lifecycleId:0,revision:0,targetId:'FIXTURE',generation:0}).binding,provenance:'ADAPTER_SEQUENTIAL'}).authority;
 h.c.replayObservedSequentialAuthority=authority;h.c.activeLoopGeneration=4;let aborted=0;h.c.activeAbortController={abort(){aborted++;}};
 h.pause();assert.equal(aborted,1);assert.equal(h.c.replayPausedSequentialAuthority,authority);assert.equal(h.c.activeLoopGeneration,0);
 assert.equal(h.c.replaySequentialResumeHandoff,true);assert.equal(h.c.currentLoopGeneration,0);assert.equal(h.count('HTTP'),0);
});
