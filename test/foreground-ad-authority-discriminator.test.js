// Offline discriminator. Reuses real Content transport/MAIN/Core fixture setup only.
// Mock boundaries: media DOM/event delivery, normalized HTTP responses, next Sequential read.
// Additional REANCHOR is parsed from a server-shaped payload by actual MAIN capture API;
// no refund, reissue of consumed token, Product patch, or actual network.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const control=require('../src/replay-control-plane-core');
const main=fs.readFileSync(require.resolve('../src/page-state-main'),'utf8').replaceAll('\r\n','\n');
function fn(name){let start=main.indexOf('    function '+name+'(');if(start<0)start=main.indexOf('    async function '+name+'(');assert.ok(start>=0,name);return main.slice(start,main.indexOf('\n    }\n',start)+7);}
async function setup(){
 const file=path.resolve('test/midroll-recovery-event-order.test.js');
 const ctx=vm.createContext({require:createRequire(file),AbortController,structuredClone});
 vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n').split('\ntest(')[0]+'\nmake=setup;',ctx);
 const h=await ctx.make(),c=h.c;
 vm.runInContext(['emptyPlayerSeekResult','createReplayGapOriginDiagnostic','createReplayTemporalLeadShadowDiagnostic','resetReplayGapOriginDiagnostic','createReplayPlayerSeekDiagnostic','abortReplayPlayerSeekDiagnostic','createReplayForegroundRecoveryDiagnostic','replaySeekAuthorityEligibleForHidden','observeReplayForegroundHidden','observeReplayForegroundVisible','resumeReadAfterVisibility','captureReplaySeekAuthority'].map(fn).join('\n'),c);
 c.replayForegroundRecoveryDiagnostic=c.createReplayForegroundRecoveryDiagnostic();
 c.replayForegroundRetainedDiagnostic={armed:false,captured:false};
 c.replayForegroundRetainedAbortController=null;
 c.replayPlayerSeekDiagnosticAbortController=null;c.replayPlayerSeekDiagnostic=c.createReplayPlayerSeekDiagnostic();
 c.document.visibilityState='visible';
 // Distinct server response continuations: never reuse a consumed Sequential token.
 const read=c.performRead;let responseNumber=0;
 c.performRead=async(...args)=>{const r=await read(...args);return {...r,continuationInfo:{...r.continuationInfo,continuation:'FRESH_RESPONSE_'+(++responseNumber)}};};
 return h;
}
async function foreground(h,{complete=true}={}){
 const c=h.c;c.document.hidden=true;c.document.visibilityState='hidden';
 assert.equal(c.enterReplaySuspended('HIDDEN'),true);
 assert.equal(c.replayForegroundRecoveryDiagnostic.retainedAtHidden,true);
 c.document.hidden=false;c.document.visibilityState='visible';
 assert.equal(c.resumeReadAfterVisibility(c.pageLifecycleGeneration,true),true);
 assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryStarted,true);
 if(!complete)return;
 await h.drain();
 assert.equal(c.replayProductionControlState.phase,'READING');
 assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryResult,'SUCCESS');
 assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryStarted,false);
 assert.equal(c.replayForegroundRecoveryDiagnostic.freshSequentialHandoff,true);
 assert.equal(h.authority().authorityState,'CONSUMED');
 assert.equal(h.requests.filter(x=>x==='REANCHOR').length,1);
 assert.equal(h.authorizations.filter(x=>x.kind==='SEQUENTIAL'&&x.ok).length,1);
 // Fresh adapter observation, a different opaque continuation, captured by actual MAIN.
 const payload={continuationContents:{liveChatContinuation:{continuations:[{playerSeekContinuationData:{continuation:'AFTER_FOREGROUND_FRESH_FIXTURE'}}]}}};
 assert.equal(c.captureReplaySeekAuthority(payload,{mode:'replay',revision:c.pageRevision,generation:c.currentLoopGeneration}),true);
 assert.equal(c.replaySeekAuthorityIsCurrent(),true);
 h.requests.length=0;h.authorizations.length=0;h.transitions.length=0;
}
for(const recovered of [false,true])for(const duplicate of [false,true])test((recovered?'foreground SUCCESS':'normal READING')+(duplicate?' duplicate AD_ENTER':' single AD_ENTER'),async()=>{
 const h=await setup(),c=h.c;if(recovered)await foreground(h);
 const authority=c.replaySeekAuthority,binding=c.currentReplayAuthorityBinding(c.pageLifecycleGeneration);
 const flag=c.replayForegroundRecoveryDiagnostic.foregroundRecoveryStarted;
 assert.equal(flag,false);assert.equal(authority.diagnostic(binding).authorityState,'OBSERVED_UNUSED');
 h.enter();const afterEnter=authority.diagnostic(binding).authorityState;
 assert.equal(authority.diagnostic(binding).authorityCurrent,true);
 assert.equal(afterEnter,'OBSERVED_UNUSED');
 assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryResult,recovered?'SUCCESS':'NOT_ATTEMPTED');
 assert.equal(c.replaySeekAuthorityIsCurrent(),true);
 if(duplicate)c.transportFixture.deliver({id:901,data:{source:'liveflow-content-script',type:c.REPLAY_AD_ENTER_TYPE}});
 assert.equal(authority.diagnostic(binding).authorityState,afterEnter);assert.equal(h.requests.length,0);
 h.changeAd(false);
 if(duplicate)c.transportFixture.deliver({id:902,data:{source:'liveflow-content-script',type:c.REPLAY_AD_EXIT_TYPE}});
 h.readiness();await h.drain();
 if(duplicate){h.readiness('canplay');await h.drain();}
 const count=h.requests.filter(x=>x==='REANCHOR').length;
 assert.equal(count,1);assert.equal(c.replayProductionControlState.phase,'READING');
 assert.equal(c.replayProductionReanchorReason,'NONE');
 assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryStarted,false);
 assert.equal(c.replayBootstrapAuthority,null);
 assert.equal(h.transitions.find(x=>x.event==='AD_ENTER').result.nextState.phase,'SUSPENDED');
 assert.equal(h.transitions.find(x=>x.event==='AD_EXIT_READY').result.nextState.phase,'REANCHORING');
 console.log(JSON.stringify({case:recovered?'FOREGROUND_SUCCESS':'NORMAL',duplicate,flagBefore:flag,authorityAfterEnter:afterEnter,availableAfterEnter:true,reason:c.replayProductionReanchorReason,phaseAfterExit:c.replayProductionControlState.phase,reanchorRequests:count,result:c.replayForegroundRecoveryDiagnostic.foregroundRecoveryResult}));
});
for(const recovered of [false,true])test((recovered?'foreground':'normal')+' stale Authority remains request0',async()=>{
 const h=await setup(),c=h.c;if(recovered)await foreground(h);c.pageRevision++;
 assert.equal(c.replaySeekAuthorityIsCurrent(),false);h.enter();h.changeAd(false);h.readiness();await h.drain();
 assert.equal(h.requests.length,0);assert.equal(c.replayProductionControlState.phase,'STOPPED');assert.equal(c.replayBootstrapAuthority,null);
});

for(const failed of [false,true])test((failed?'failed':'active')+' foreground still invalidates on AD_ENTER',async()=>{
 const h=await setup(),c=h.c;await foreground(h,{complete:false});
 if(failed){h.video.paused=true;await h.drain();h.video.paused=false;assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryResult,'PLAYER_NOT_READY');}
 assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryStarted,true);
 const authority=c.replaySeekAuthority;h.enter();
 assert.equal(authority.diagnostic(c.currentReplayAuthorityBinding(c.pageLifecycleGeneration)).authorityState,'INVALID');
 assert.equal(c.replaySeekAuthority,null);assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryResult,'AD_ACTIVE');
 h.changeAd(false);h.readiness();await h.drain();
 assert.equal(h.requests.length,0);assert.equal(c.replayProductionControlState.phase,'STOPPED');assert.equal(c.replayBootstrapAuthority,null);
});
for(const kind of ['missing','consumed'])test('completed foreground '+kind+' Authority never requests',async()=>{
 const h=await setup(),c=h.c;await foreground(h);
 if(kind==='missing')c.replaySeekAuthority=null;
 else {const r=control.authorizeAuthorityRequest({authority:c.replaySeekAuthority,expectedKind:'REANCHOR',currentBinding:c.currentReplayAuthorityBinding(c.pageLifecycleGeneration),consumedRegistry:c.replayConsumedAuthorityRegistry});assert.equal(r.ok,true);assert.equal(control.claimAuthorityRequestGrant(r.grant,'REANCHOR').ok,true);}
 h.enter();h.changeAd(false);h.readiness();await h.drain();assert.equal(h.requests.length,0);assert.equal(c.replayProductionControlState.phase,'STOPPED');assert.equal(c.replayBootstrapAuthority,null);
});
for(const change of ['document','video','lifecycle','revision','target','generation','stop','invalidate'])test('completed foreground retained readiness rejects '+change,async()=>{
 const h=await setup(),c=h.c;await foreground(h);h.enter();h.changeAd(false,false);h.readiness();assert.ok(c.replayAdExitReadiness);
 if(change==='document')c.document={...c.document};
 if(change==='video')h.replaceVideo();
 if(change==='lifecycle')c.pageLifecycleGeneration++;
 if(change==='revision')c.pageRevision++;
 if(change==='target')c.pageState.targetIdentity='REPLACED';
 if(change==='generation')c.currentLoopGeneration++;
 if(change==='stop')c.stopReadLoop('explicit');
 if(change==='invalidate')c.invalidateReplaySeekAuthority();
 h.h.flush();await h.drain();assert.equal(h.requests.length,0);assert.equal(h.authorizations.length,0);assert.equal(c.replayBootstrapAuthority,null);
});
test('completed foreground foreign readiness is not permission',async()=>{
 const h=await setup(),c=h.c;await foreground(h);h.enter();h.changeAd(false,false);h.readiness('playing',{});assert.equal(c.replayAdExitReadiness,null);h.h.flush();await h.drain();assert.equal(h.requests.length,0);assert.equal(h.authorizations.length,0);
});
test('completed foreground readiness before AD_EXIT recovers exactly once',async()=>{
 const h=await setup(),c=h.c;await foreground(h);h.enter();h.changeAd(false,false);h.readiness();h.h.flush();await h.drain();
 assert.equal(h.requests.filter(x=>x==='REANCHOR').length,1);assert.equal(h.requests.filter(x=>x==='SEQUENTIAL_HANDOFF').length,1);assert.equal(c.replayProductionControlState.phase,'READING');assert.equal(h.authorizations.every(x=>x.ok),true);assert.equal(c.replayBootstrapAuthority,null);
});

test('in-flight foreground interrupted by AD cannot hand off its late response',async()=>{
 const h=await setup(),c=h.c;const read=c.performRead;let release;
 c.performRead=(...args)=>new Promise(resolve=>{release=async()=>resolve(await read(...args));});
 await foreground(h,{complete:false});const pending=h.microtasks.shift()();
 assert.equal(c.readRequestInFlight,true);assert.equal(c.replayReanchorLock,true);
 assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryResult,'REQUEST_STARTED');
 const authority=c.replaySeekAuthority;assert.equal(authority.diagnostic(c.currentReplayAuthorityBinding(c.pageLifecycleGeneration)).authorityState,'CONSUMED');
 h.changeAd(true);assert.equal(c.replayProductionControlState.phase,'SUSPENDED');assert.equal(c.replaySeekAuthority,null);assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryResult,'AD_ACTIVE');
 await release();await pending;await h.drain();
 assert.equal(c.replayReanchorLock,false);assert.equal(c.readRequestInFlight,false);
 assert.equal(h.requests.filter(x=>x==='SEQUENTIAL_HANDOFF').length,0);assert.equal(h.requests.filter(x=>x==='REANCHOR').length,1);
 assert.equal(c.replayForegroundRecoveryDiagnostic.foregroundRecoveryStarted,true);assert.equal(c.replayBootstrapAuthority,null);
});
