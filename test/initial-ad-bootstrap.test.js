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
        'respond', 'settleReplayAdExit', 'recordReplayTemporalDiscard', 'observeReplayTemporalPendingRemoval', 'observeReplayTemporalPendingMerge', 'startReadLoop', 'restartReplayFromCurrentPosition', 'createReplayPipelineDiagnostic', 'createReplayForegroundRecoveryDiagnostic'];
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
test('initial ad defers admission without storing opaque data or advancing generation', () => {
    const h = harness(); h.send('INITIAL'); h.send('READ');
    assert.equal(h.count('createReplayAuthority'), 0); assert.equal(h.count('authorizeAuthorityRequest'), 0); assert.equal(h.count('HTTP'), 0);
    assert.equal(h.c.currentLoopGeneration, 0); assert.equal(h.c.replayBootstrapEligibilityLifecycleId, -1);
    assert.equal(h.c.replayBootstrapAuthority, null); assert.equal(h.c.lastGrant, undefined);
    assert.deepEqual(Object.keys(h.c.replayInitialBootstrapIntent), ['lifecycle','revision','generation','target']);
    assert.doesNotMatch(JSON.stringify(h.c.replayInitialBootstrapIntent), /TOKEN|context|grant|authority/i);
    assert.equal(h.snapshots.at(-1).chatAvailable, false);
});
test('AD_EXIT admits fresh snapshot token, consumes and claims once; duplicate readiness does not amplify', async () => {
    const h = harness(); h.send('INITIAL'); h.data.token = 'AFTER_AD_TOKEN'; h.c.ad = false; h.send('AD_EXIT'); await h.c.running;
    assert.equal(h.calls.find(x => x.name === 'createReplayAuthority').token, 'AFTER_AD_TOKEN');
    assert.ok(h.adapterReads.filter(x => x === 'AFTER_AD_TOKEN').length > 0);
    assert.equal(h.c.lastGrant.diagnostic().state, 'CLAIMED');
    assert.equal(h.c.replayBootstrapAuthority.diagnostic().authorityState, 'CONSUMED');
    for (let i=0;i<3;i++) { h.send('AD_EXIT'); h.c.settleReplayAdExit({target:h.video,type:'playing'}); h.c.settleReplayAdExit({target:h.video,type:'canplay'}); h.c.settleReplayAdExit({target:h.video,type:'loadeddata'}); h.send('READ'); }
    assert.equal(h.count('createReplayAuthority'), 1); assert.equal(h.count('authorizeAuthorityRequest'), 1); assert.equal(h.count('claimAuthorityRequestGrant'), 1); assert.equal(h.count('HTTP'), 1);
});
test('AD notification before Replay mode preserves initial intent and recovers on real ready event', async () => {
    const h = harness(); h.send('AD_ENTER'); assert.equal(h.c.pageState.mode, 'unknown');
    assert.equal(h.count('createReplayAuthority'), 0); h.c.ad = false;
    h.c.settleReplayAdExit({ target: h.video, type: 'canplay' }); await h.c.running;
    assert.equal(h.c.pageState.mode, 'replay'); assert.equal(h.count('HTTP'), 1);
});
test('known Live ad notification never creates a Replay initial intent', () => {
    const h=harness();h.c.pageState.mode='live';h.send('AD_ENTER');
    assert.equal(h.c.replayInitialBootstrapIntent,null);assert.equal(h.count('createReplayAuthority'),0);
});
test('post-ad paused main content admits unused Authority and existing play handoff performs one READ', async () => {
    const h = harness({ paused: true }); h.send('INITIAL'); h.c.ad = false; h.send('AD_EXIT');
    const handle = h.c.replayBootstrapAuthority;
    assert.equal(handle.diagnostic().authorityState, 'OBSERVED_UNUSED'); assert.equal(h.c.lastGrant, undefined); assert.equal(h.c.currentLoopGeneration, 0);
    assert.equal(h.count('HTTP'), 0); h.video.paused = false;
    h.c.restartReplayFromCurrentPosition({type:'play',target:h.video}); await h.c.running;
    assert.equal(h.c.replayBootstrapAuthority, handle); assert.equal(handle.diagnostic().authorityState, 'CONSUMED'); assert.equal(h.count('HTTP'), 1);
});
test('AD after admission invalidates terminally and never admits another candidate', () => {
    const h = harness({ ad:false, paused:true }); h.send('INITIAL'); const handle=h.c.replayBootstrapAuthority;
    h.c.ad=true; h.send('AD_ENTER'); assert.equal(handle.diagnostic().authorityState,'INVALID');
    h.c.ad=false; h.video.paused=false; h.c.settleReplayAdExit=()=>false; h.c.observeSuspendedRecoveryCapabilities=()=>{};
    h.send('AD_EXIT'); h.send('INITIAL'); h.send('READ');
    assert.equal(h.count('createReplayAuthority'),1); assert.equal(h.count('HTTP'),0); assert.equal(handle.diagnostic().authorityState,'INVALID');
});
test('pre-admission hidden cancels intent and never re-arms in the same lifecycle', () => {
    const h=harness();h.send('INITIAL');h.c.document.hidden=true;h.c.enterReplaySuspended('HIDDEN');
    h.c.document.hidden=false;h.c.ad=false;h.send('AD_EXIT');h.send('INITIAL');h.send('READ');
    assert.equal(h.count('createReplayAuthority'),0);assert.equal(h.count('HTTP'),0);
});
test('actual navigation discards initial intent and does not reuse it in the new lifecycle', () => {
    const h=harness();h.send('INITIAL');
    for(const name of ['abortReplayPlayerSeekDiagnostic','invalidateReplayCredentiallessSchemaDiagnostic','openReplayDiagnosticScope',
        'resetReplayGapOriginDiagnostic','disconnectWatchRootObserver','postLifecycleInvalidated'])h.c[name]=()=>{};
    h.c.createReplayTemporalStarvationDiagnostic=h.c.createReplayTimingDiagnosticSeen=()=>({});
    vm.runInContext(fn(main,'invalidatePageLifecycle'),h.c);h.c.invalidatePageLifecycle();
    assert.equal(h.c.replayInitialBootstrapIntent,null);assert.equal(h.c.pageLifecycleGeneration,1);
    assert.equal(h.c.replayInitialBootstrapCancelledLifecycleId,0);h.c.ad=false;h.send('AD_EXIT');
    assert.equal(h.count('createReplayAuthority'),0);assert.equal(h.count('HTTP'),0);
});
test('initial readiness revalidation fails closed for each changed scope/fact/exclusion', () => {
    const changes={lifecycle:h=>h.c.pageLifecycleGeneration++,revision:h=>h.c.pageRevision++,generation:h=>h.c.currentLoopGeneration++,
        target:h=>h.c.urlTarget='OTHER',navigation:h=>h.c.navigationPending=true,hidden:h=>h.c.document.hidden=true,
        ownership:h=>h.c.getCurrentMainVideo=()=>({...h.video}),capability:h=>h.c.replayControlPlaneCore.canUseCapabilityPath=()=>({allowed:false}),
        snapshot:h=>h.c.targetMatched=false, context:h=>h.c.readInternalApiContext=()=>null,
        media:h=>h.video.readyState=0,seeking:h=>h.video.seeking=true,ended:h=>h.video.ended=true,timing:h=>h.video.currentTime=NaN,
        inFlight:h=>h.c.readRequestInFlight=true,active:h=>h.c.activeLoopGeneration=9,reanchor:h=>h.c.replayReanchorLock=true,
        diagnostic:h=>h.c.replayPlayerSeekDiagnosticLock=true,disabled:h=>h.c.runtimeUserEnabled=false};
    for(const [name,change]of Object.entries(changes)) {const h=harness();h.send('INITIAL');h.c.ad=false;change(h);
        h.c.settleReplayAdExit({target:h.video,type:'loadeddata'});assert.equal(h.count('createReplayAuthority'),0,name);assert.equal(h.count('HTTP'),0,name);}
});
test('no-ad startup retains ordinary initial request and one legitimate bootstrap', async () => {
    const h=harness({ad:false});h.send('INITIAL');assert.equal(h.count('createReplayAuthority'),1);
    h.send('READ');await h.c.running;assert.equal(h.count('HTTP'),1);assert.equal(h.c.lastGrant.diagnostic().state,'CLAIMED');
});
test('stale response after initial-ad handoff cannot commit messages or fresh Authority', async () => {
    const h=harness();h.send('INITIAL');h.c.performRead=async()=>{h.c.pageRevision++;return{ok:true,messages:[{text:'PRIVATE'}]};};
    h.c.ad=false;h.send('AD_EXIT');await h.c.running;
    assert.equal(h.c.replayPending.length,0);assert.equal(h.c.replayPipelineDiagnostic.receivedActions,0);assert.equal(h.count('createReplayAuthority'),1);
});
test('Content installs existing AD observer before ingress; actual class transition sends AD_EXIT once', () => {
    const messages=[];let callback;const player={};const c=vm.createContext({window:{location:{origin:'x',pathname:'/watch',search:''},postMessage(m){messages.push(m.type);}},
        playbackContextObservedPlayer:null,playbackContextObserver:null,playbackContextWasAd:false,ad:true,
        REPLAY_AD_ENTER_TYPE:'AD_ENTER',REPLAY_AD_EXIT_TYPE:'AD_EXIT',isAdPlaybackActive:()=>c.ad,
        RESPONSE_TYPE:'SNAPSHOT',minimumAcceptedPageRevision:0,currentPageRevision:0,currentPageLifecycleGeneration:0,currentPageKey:'',
        replayDiagnosticEpoch:0,replayDiagnosticAwaiting:null,readRequestedRevision:-1,currentMessages:[],
        getCurrentMainMedia:()=>({player}),logInfo:()=>{},attachManagementBar:()=>{},isEffectiveDisplayActive:()=>false,
        cleanupOverlay:()=>{},MutationObserver:class{constructor(cb){callback=cb;}observe(){}disconnect(){}}});
    vm.runInContext(['ensurePlaybackContextObserver','handleInitialContinuation','requestReadOnce'].map(n=>fn(content,n)).join('\n'),c);
    const snapshot={source:c.window,origin:'x',data:{source:'liveflow-page-state',type:'SNAPSHOT',mode:'replay',chatAvailable:false,context:{},pageRevision:0,pageLifecycleGeneration:0}};
    c.handleInitialContinuation(snapshot);c.handleInitialContinuation(snapshot);
    assert.deepEqual(messages,['AD_ENTER']);c.ad=false;callback();callback();assert.deepEqual(messages,['AD_ENTER','AD_EXIT']);
    const handle=fn(content,'handleInitialContinuation');assert.ok(handle.indexOf('ensurePlaybackContextObserver(media.player)')<handle.indexOf('requestReadOnce()'));
    assert.match(handle,/event\.data\.mode === 'replay'/);
});
test('initial exception does not add timers, retry, raw-token storage or change midroll/SEQUENTIAL selection', () => {
    for(const name of ['deferReplayInitialBootstrap','admitReadyReplayBootstrap','resumeInitialReplayBootstrap']) assert.doesNotMatch(fn(main,name),/setTimeout|setInterval|queueMicrotask|performRead\(|postMessage|opaqueToken\s*[:=]/);
    assert.match(fn(main,'settleReplayAdExit'),/queueReplayReanchor\('AD_EXIT'/);
    assert.match(fn(main,'startReadLoop'),/claimAuthorityRequestGrant/);
    assert.match(main,/replayPausedSequentialAuthority = nextSequentialAuthority/);
});
test('existing dev trace transforms still recognize revised source without package generation', async () => {
    const {instrumentInitialAuthorityTrace}=await import('../tools/density-comparison/instrument-initial-authority.mjs');
    const {instrumentInitialRequestMain}=await import('../tools/density-comparison/instrument-initial-request.mjs');
    const transformed=instrumentInitialAuthorityTrace(main,fs.readFileSync(require.resolve('../src/replay-control-plane-core'),'utf8'),{sourceSHA:'a'.repeat(40),commonBuildID:'b'.repeat(64)});
    new vm.Script(instrumentInitialRequestMain(transformed.main));
    assert.ok(transformed.main.includes('BOOTSTRAP_INVALIDATION_REASON'));
});
