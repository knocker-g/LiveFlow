// Offline characterization: real Content AD observer -> guarded MAIN -> real Core.
// Reuses the existing actual transport/accepted-response fixture, without running its tests.
// Mocked: player DOM/class delivery, microtask driver, normalized HTTP response and
// next-read boundary. The latter claims the real Sequential grant; it sends no HTTP.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const control=require('../src/replay-control-plane-core');
const main=fs.readFileSync(require.resolve('../src/page-state-main'),'utf8').replaceAll('\r\n','\n');
const content=fs.readFileSync(require.resolve('../src/youtube-chat'),'utf8').replaceAll('\r\n','\n');
function fn(text,name){
    let start=text.indexOf('    function '+name+'(');
    if(start<0)start=text.indexOf('    async function '+name+'(');
    const end=text.indexOf('\n    }\n',start);
    assert.ok(start>=0&&end>start,name);return text.slice(start,end+7);
}
async function setup(){
    const integrationFile=path.resolve('test/pending-clear-production-integration.test.js');
    const helper=vm.createContext({require:createRequire(integrationFile),AbortController,structuredClone});
    vm.runInContext(fs.readFileSync(integrationFile,'utf8').replaceAll('\r\n','\n').split('\ntest(')[0]+'\ninstall=installRealTransport;',helper);
    const filename=path.resolve('test/reanchor-repeated-cleanup.test.js');
    let prefix=fs.readFileSync(filename,'utf8').replaceAll('\r\n','\n').split('\ntest(')[0];
    const start=prefix.indexOf('    // Existing transport adapter boundary:'),end=prefix.indexOf('    c.startReadLoop =',start);
    assert.ok(start>=0&&end>start);
    prefix=prefix.slice(0,start)+'    installRealTransport(h,c,video);\n'+prefix.slice(end);
    const call='    const outcome = await c.runQueuedReplayReanchor(intent); h.flush();';
    assert.equal(prefix.split(call).length,2);
    prefix=prefix.replace(call,'    const outcome = null;'); // Stop at setup, before any request.
    prefix=prefix.replace("{ id: 'due', replayOffsetMsec:","{ id: 'due', messageType: 'text', replayOffsetMsec:")
        .replace("{ id: 'future', replayOffsetMsec:","{ id: 'future', messageType: 'text', replayOffsetMsec:");
    const outer=vm.createContext({require:createRequire(filename),AbortController,installRealTransport:helper.install});
    vm.runInContext(prefix+'\nmake=scenario;',outer);
    const s=await outer.make(false),c=s.c,video=c.getCurrentMainVideo(),player=c.getCurrentMainMedia().player;
    let ad=false,current=video,mutation;
    player.classList={contains:name=>ad&&['ad-showing','ad-interrupting'].includes(name)};
    c.document={hidden:false,querySelector:()=>({querySelector:()=>player})};
    c.getCurrentMainVideo=()=>current;
    c.getCurrentMainMedia=()=>({video:current,player});
    Object.assign(c,{replayInitialBootstrapIntent:null,replayBootstrapEligibilityLifecycleId:0,
        replayInitialBootstrapCancelledLifecycleId:-1,replayBootstrapAuthority:null,
        replayReanchorIntent:null,replayAdExitNeedsReanchor:false,replayAdActive:false,
        replayForegroundRecoveryDiagnostic:{},playbackContextObservedPlayer:null,playbackContextObserver:null,playbackContextWasAd:false,
        MutationObserver:class{constructor(cb){mutation=cb;}observe(){}disconnect(){}},
        replayProductionControlState:control.createReplayState('READING'),
        replayControlShadow:control.createShadowController(control.createReplayState('READING'))});
    // Restore actual Authority eligibility (the inherited unrelated scenario stubs it).
    vm.runInContext(['invalidateAuthorityHandle','invalidateReplayBootstrapAuthority','replaySeekAuthorityIsCurrent','replayAdIsActive',
        'enterReplaySuspended','observeSuspendedRecoveryCapabilities','queueReplayReanchor','settleReplayAdExit'].map(n=>fn(main,n)).join('\n')+
        '\n'+['isAdPlaybackActive','ensurePlaybackContextObserver'].map(n=>fn(content,n)).join('\n'),c);
    const readyListeners=new Map(),add=c.window.addEventListener;
    c.window.addEventListener=(type,listener,capture)=>{
        if(type==='message')return add(type,listener,capture);
        assert.equal(capture,true);readyListeners.set(type,listener);
    };
    for(const type of ['playing','canplay','loadeddata']){
        const registration=`    window.addEventListener('${type}', settleReplayAdExit, true);`;
        assert.ok(main.includes(registration));vm.runInContext(registration,c);
    }
    c.ensurePlaybackContextObserver(player);
    const reanchor=c.replaySeekAuthority;
    assert.equal(c.replaySeekAuthorityIsCurrent(),true);
    s.requests.length=0;s.authorizations.length=0;s.transitions.length=0;s.microtasks.length=0;
    function changeAd(value,deliver=true){ad=value;mutation();if(deliver)s.h.flush();}
    async function drain(){let count=0;while(s.microtasks.length){assert.ok(++count<=8,'bounded one-shot drain');await s.microtasks.shift()();s.h.flush();}}
    return {...s,video,player,reanchor,changeAd,drain,
        readiness:(type='playing',target=current)=>readyListeners.get(type)({type,target}),
        replaceVideo:()=>{current={...video};return current;},
        authority:()=>reanchor.diagnostic(c.currentReplayAuthorityBinding(c.pageLifecycleGeneration)),
        enter(){changeAd(true);assert.equal(c.replayProductionControlState.phase,'SUSPENDED');assert.equal(c.replayProductionControlState.suspendedReason,'AD');assert.equal(s.requests.length,0);assert.equal(c.readRequestInFlight,false);}
    };
}

test('Case A: AD_EXIT then owned readiness consumes one REANCHOR and hands off one fresh Sequential',async()=>{
    const h=await setup();h.enter();h.changeAd(false);
    assert.equal(h.c.replayProductionControlState.phase,'REANCHORING');
    assert.equal(h.c.replayReanchorIntent.reason,'AD_EXIT');assert.equal(h.c.replayReanchorIntent.attempted,false);
    assert.equal(h.microtasks.length,0);assert.equal(h.authority().authorityState,'OBSERVED_UNUSED');
    h.readiness();await h.drain();
    assert.deepEqual(Array.from(h.requests),['REANCHOR','SEQUENTIAL_HANDOFF']);
    assert.equal(h.authority().authorityState,'CONSUMED');assert.equal(h.c.replayProductionControlState.phase,'READING');
    assert.deepEqual(Array.from(h.authorizations,a=>[a.kind,a.ok]),[['REANCHOR',true],['SEQUENTIAL',true]]);
    assert.equal(h.c.replayPipelineDiagnostic.freshChainStarted,true);
    h.readiness('canplay');h.readiness('loadeddata');await h.drain();
    assert.equal(h.requests.filter(x=>x==='REANCHOR').length,1);
    assert.equal(h.c.replayBootstrapAuthority,null);
});

test('Case B: owned readiness before AD_EXIT leaves an unused valid Authority and stranded intent',async()=>{
    const h=await setup();h.enter();
    // The actual class has cleared; only its asynchronous postMessage delivery is pending.
    h.changeAd(false,false);assert.equal(h.c.replayAdIsActive(),false);assert.equal(h.c.replayAdActive,true);
    h.readiness();await h.drain();
    h.h.flush();await h.drain(); // Deliberately no additional media readiness or read finalizer.
    assert.equal(h.c.replayAdActive,false);assert.equal(h.c.replayProductionControlState.phase,'REANCHORING');
    assert.equal(h.c.replayReanchorIntent.reason,'AD_EXIT');assert.equal(h.c.replayReanchorIntent.attempted,false);
    assert.equal(h.c.replaySeekAuthorityIsCurrent(),true);assert.equal(h.authority().authorityState,'OBSERVED_UNUSED');
    assert.equal(h.microtasks.length,0);assert.equal(h.requests.length,0);assert.equal(h.authorizations.length,0);
    assert.equal(h.c.replayBootstrapAuthority,null);assert.equal(h.c.readRequestInFlight,false);
});

for(const kind of ['missing','stale','consumed'])test('negative '+kind+' REANCHOR never requests or readmits Bootstrap',async()=>{
    const h=await setup();h.enter();
    if(kind==='missing')h.c.replaySeekAuthority=null;
    if(kind==='stale')h.c.pageRevision++;
    if(kind==='consumed'){
        const binding=h.c.currentReplayAuthorityBinding(h.c.pageLifecycleGeneration);
        const r=control.authorizeAuthorityRequest({authority:h.reanchor,expectedKind:'REANCHOR',currentBinding:binding,consumedRegistry:h.c.replayConsumedAuthorityRegistry});
        assert.equal(r.ok,true);assert.equal(control.claimAuthorityRequestGrant(r.grant,'REANCHOR').ok,true);
    }
    h.changeAd(false);h.readiness();await h.drain();
    assert.equal(h.requests.length,0);assert.equal(h.c.replayProductionControlState.phase,'STOPPED');
    assert.equal(h.c.replayBootstrapAuthority,null);assert.equal(h.c.replayBootstrapEligibilityLifecycleId,0);
});

test('foreign readiness is ignored; original owned-video readiness remains the sole legal trigger',async()=>{
    const h=await setup();h.enter();h.changeAd(false);h.readiness('playing',{});await h.drain();
    assert.equal(h.requests.length,0);assert.equal(h.c.replayReanchorIntent.attempted,false);
    h.readiness();await h.drain();assert.equal(h.requests.filter(x=>x==='REANCHOR').length,1);
});

for(const change of ['video','lifecycle','revision','target','navigation'])test('queued currentness fence rejects '+change+' change before callback',async()=>{
    const h=await setup();h.enter();h.changeAd(false);h.readiness();
    if(change==='video')h.replaceVideo();
    if(change==='lifecycle')h.c.pageLifecycleGeneration++;
    if(change==='revision')h.c.pageRevision++;
    if(change==='target')h.c.pageState.targetIdentity='REPLACED';
    if(change==='navigation')h.c.navigationPending=true;
    await h.drain();assert.equal(h.requests.length,0);assert.equal(h.c.replayBootstrapAuthority,null);
    assert.equal(h.authorizations.length,0);
});
