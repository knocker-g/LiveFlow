import test from 'node:test';
import assert from 'node:assert/strict';
import {runSeekScenario,SCENARIO,EXPECTED} from '../tools/hybrid-seek-scenario.mjs';
import {observeOpportunity,opportunityExpression} from '../tools/hybrid-diagnostic-adapter.mjs';
import vm from 'node:vm';
const A='SEEK_HANDOFF_TERMINAL',B='SEEK_DUAL_NONZERO_ATTRIBUTION';let serial=0;
function fixture(scope=A,patch={},opts={}){
 const pre={main:EXPECTED,content:EXPECTED,documentKey:'d',visibility:'visible',phase:'READING',authorityOK:true,currentnessOK:true,adActive:false,lifecycle:0,epoch:0,diagnosticSequence:1,scopeComplete:true,mismatch:0,fault:false,traceComplete:true,accountingComplete:true,conservation:true,loss:0,overflow:0,temporalPending:0,schedulerPending:0,mediaTime:10,duration:100,evidence:{scopes:[{epoch:0,lifecycle:0,temporalSeek:0,schedulerLifecycle:10}]},...patch};
 const post={...pre,epoch:1,oldScopeClosed:true,oldAttributionComplete:true,oldConservation:true,oldRetained:0,oldUnclassified:0,oldLoss:0,oldOverflow:0,actualSeekObserved:true,temporalSeekRemoval:2,schedulerLifecycleRemoval:13};
 let actions=0;const phases=[];const packet='ab-'+ ++serial;
 const page={isClosed:()=>false,locator:()=>({count:async()=>1,isVisible:async()=>true,boundingBox:async()=>({width:100,height:10}),click:async()=>{actions++;}})};
 const options={expected:EXPECTED,packet,acceptanceScope:scope,approval:{packet,scenario:SCENARIO,acceptanceScope:scope,maxActions:1,deltaSeconds:30,documentKey:'d'},ready:{packet,documentKey:'d',foregroundExclusive:true},capture:async(_,o)=>{phases.push(o.phase);return o.phase==='POST'?post:o.phase==='OPPORTUNITY'?opts.wait??pre:o.phase==='ACTION_GATE'?{...pre,...opts.action}:pre;}};
 return {page,options,phases,actions:()=>actions};
}
test('P1.8 explicit A accepts zero queues but never proves B',async()=>{
 const f=fixture();const r=await runSeekScenario(f.page,f.options);assert.equal(f.actions(),1);assert.equal(r.acceptance.A,'PASS');assert.equal(r.acceptance.B,'NOT_PROVEN');
});
test('P1.8 missing scope rejects before capture',async()=>{const f=fixture(undefined);delete f.options.acceptanceScope;const r=await runSeekScenario(f.page,f.options);assert.equal(r.status,'BLOCKED');assert.deepEqual(f.phases,[]);});
for(const bad of ['OTHER',null])test('invalid scope '+bad,async()=>{const f=fixture(bad);const r=await runSeekScenario(f.page,f.options);assert.equal(r.status,'BLOCKED');assert.equal(f.actions(),0);});
test('mismatched authorization cannot silently downgrade B to A',async()=>{const f=fixture(B);f.options.approval.acceptanceScope=A;const r=await runSeekScenario(f.page,f.options);assert.equal(r.status,'BLOCKED');assert.deepEqual(f.phases,[]);});
test('B zero -> published opportunity -> action gate -> exact reason deltas',async()=>{
 const f=fixture(B,{}, {action:{temporalPending:2,schedulerPending:3,diagnosticSequence:2}});
 const capture=f.options.capture;f.options.capture=async(p,o)=>o.phase==='OPPORTUNITY'?{...await capture(p,{...o,phase:'PRE'}),temporalPending:2,schedulerPending:3,wait:{reason:'OPPORTUNITY',events:1,captures:2,durationMs:20,cleanup:true,publication:{match:'MATCHED',appliedSequence:2,triggerSequence:2,receiptAgeMs:0}}}:capture(p,o);
 const r=await runSeekScenario(f.page,f.options);assert.equal(f.actions(),1);assert.equal(r.acceptance.A,'PASS');assert.equal(r.acceptance.B,'PASS');assert.equal(r.removalEvidence.schedulerLifecycleDelta,3);assert.equal(r.wait.cleanup,true);assert.equal(r.freshnessLimit,'NO_PRODUCER_TIMESTAMP_OR_QUEUE_REVISION');
});
test('B positive wait then action gate drained: no second wait/action',async()=>{
 const f=fixture(B);const capture=f.options.capture;f.options.capture=async(p,o)=>o.phase==='OPPORTUNITY'?{...await capture(p,{...o,phase:'PRE'}),temporalPending:2,schedulerPending:3,wait:{reason:'OPPORTUNITY',events:1,captures:2,durationMs:1,cleanup:true,publication:{match:'MATCHED',appliedSequence:2}}}:capture(p,o);
 const r=await runSeekScenario(f.page,f.options);assert.equal(r.firstBadBoundary,'STALE_QUALIFICATION');assert.equal(f.actions(),0);assert.equal(f.phases.filter(p=>p==='ACTION_GATE').length,1);
});
for(const patch of [{visibility:'hidden'},{phase:'STOPPED'},{main:{}},{authorityOK:false},{fault:true}])test('hard PRE cannot enter wait '+JSON.stringify(patch),async()=>{const f=fixture(B,patch);const r=await runSeekScenario(f.page,f.options);assert.equal(f.actions(),0);assert.deepEqual(f.phases,['PRE']);assert.equal(r.status,'BLOCKED');});
function waitHarness(initial={}){
 const before={adapterStatus:'READY',documentKey:'d',lifecycle:0,epoch:0,diagnosticSequence:1,temporalPending:2,schedulerPending:0};let current={...before,...initial};
 const listeners=new Map(),timers=new Map();let tick=0,time=0;const win={};
 const env={window:win,origin:'o',now:()=>time,queueMicrotask,addEventListener:(t,f)=>listeners.set(t,f),removeEventListener:t=>listeners.delete(t),setTimeout:(f,ms)=>{assert.ok(ms<=5000);timers.set(++tick,f);return tick;},clearTimeout:id=>timers.delete(id)};
 const promise=observeOpportunity({read:()=>current,map:x=>x,env,before,timeoutMs:5000});
 return {promise,set:x=>current={...current,...x},event:(patch={})=>{time++;listeners.get('message')?.({source:win,origin:'o',type:'message',data:{source:'liveflow-content-script',type:'LIVEFLOW_REPLAY_PIPELINE_DIAGNOSTIC',pageLifecycleGeneration:0,diagnosticScopeEpoch:0,diagnosticSequence:2,diagnosticTerminal:false,diagnosticIncomplete:false,scheduler:{pendingCurrent:3},...patch}});},deadline:()=>{time=5000;for(const f of [...timers.values()])f();},clean:()=>{assert.equal(listeners.size,0);assert.equal(timers.size,0);}};
}
const flush=()=>new Promise(r=>queueMicrotask(r));
test('stable publication is matched only after applied getter update',async()=>{const h=waitHarness();h.event();h.set({diagnosticSequence:2,schedulerPending:3});await flush();const r=await h.promise;assert.equal(r.wait.reason,'OPPORTUNITY');assert.equal(r.wait.publication.match,'MATCHED');assert.equal(r.wait.captures,2);h.clean();});
test('new applied publication before listener setup captured by initial snapshot',async()=>{const h=waitHarness({diagnosticSequence:2,schedulerPending:3});const r=await h.promise;assert.equal(r.wait.reason,'OPPORTUNITY');assert.equal(r.wait.events,0);assert.equal(r.wait.publication.match,'INITIAL_NEW_SEQUENCE');assert.equal(r.wait.publication.receiptAgeMs,'UNKNOWN');h.clean();});
test('not applied publication cannot authorize even positive stale getter',async()=>{const h=waitHarness();h.set({schedulerPending:3});h.event();await flush();h.deadline();assert.equal((await h.promise).wait.reason,'DEADLINE');h.clean();});
for(const patch of [{diagnosticSequence:1},{diagnosticScopeEpoch:3},{pageLifecycleGeneration:1},{diagnosticTerminal:true},{diagnosticIncomplete:true}])test('stale/old/terminal signal ignored '+JSON.stringify(patch),async()=>{const h=waitHarness();h.event(patch);await flush();h.deadline();const r=await h.promise;assert.equal(r.wait.reason,'DEADLINE');assert.equal(r.wait.captures,1);h.clean();});
test('duplicate/reversed cannot become new positive proof',async()=>{const h=waitHarness();h.event();await flush();h.set({diagnosticSequence:2,schedulerPending:3});h.event();h.event({diagnosticSequence:1});await flush();h.deadline();assert.equal((await h.promise).wait.reason,'DEADLINE');h.clean();});
test('Temporal-only change with no publication does not trigger capture',async()=>{const h=waitHarness();h.set({temporalPending:10,schedulerPending:3});h.deadline();const r=await h.promise;assert.equal(r.wait.captures,1);assert.equal(r.wait.events,0);h.clean();});
test('deadline is finite5s; still zero means not qualified',async()=>{const h=waitHarness();h.deadline();const r=await h.promise;assert.equal(r.wait.reason,'DEADLINE');assert.equal(r.wait.durationMs,5000);assert.equal(r.last.schedulerPending,0);h.clean();});
test('changed document/scope cannot qualify',async()=>{const h=waitHarness();h.set({documentKey:'new',diagnosticSequence:2,schedulerPending:3});h.event();await flush();assert.equal((await h.promise).wait.reason,'PREFLIGHT_FAILED');h.clean();});
test('B proof missing baseline reason cannot be promoted from A',async()=>{const f=fixture(B,{temporalPending:2,schedulerPending:3,evidence:{}});const r=await runSeekScenario(f.page,f.options);assert.equal(f.actions(),1);assert.equal(r.acceptance.A,'PASS');assert.equal(r.acceptance.B,'NOT_PROVEN');assert.equal(r.status,'INCONCLUSIVE');assert.equal(r.requestedAcceptanceScope,B);});
test('A does not wait; B deadline is zero-action and no downgrade',async()=>{
 const f=fixture(B);const capture=f.options.capture;f.options.capture=async(p,o)=>o.phase==='OPPORTUNITY'?{...await capture(p,{...o,phase:'PRE'}),wait:{reason:'DEADLINE',events:0,captures:1,durationMs:4500,cleanup:true}}:capture(p,o);
 const r=await runSeekScenario(f.page,f.options);assert.equal(f.actions(),0);assert.equal(r.firstBadBoundary,'OPPORTUNITY_NOT_QUALIFIED');assert.equal(r.acceptance.A,'NOT_RUN');assert.equal(r.acceptance.B,'NOT_RUN');assert.equal(r.wait.cleanup,true);
});
test('event cap12 releases all resources',async()=>{const h=waitHarness();for(let i=0;i<12;i++)h.event({diagnosticSequence:1});const r=await h.promise;assert.equal(r.wait.reason,'EVENT_CAP');assert.equal(r.wait.events,12);h.clean();});
test('capture cap4 releases resources without polling',async()=>{const h=waitHarness();for(let i=2;i<=4;i++){h.event({diagnosticSequence:i});h.set({diagnosticSequence:i});await flush();}const r=await h.promise;assert.equal(r.wait.reason,'CAPTURE_CAP');assert.equal(r.wait.captures,4);h.clean();});
test('hard wait failure stops before action',async()=>{const h=waitHarness();h.set({adapterStatus:'BLOCKED'});h.event();await flush();assert.equal((await h.promise).wait.reason,'PREFLIGHT_FAILED');h.clean();});
test('serialized waiter uses exact real mapper, no new global/API',async()=>{
 const listeners=new Map(),window={addEventListener:(t,f)=>listeners.set(t,f),removeEventListener:t=>listeners.delete(t),queueMicrotask,setTimeout,clearTimeout};const c=vm.createContext({window,location:{origin:'o'},performance:{timeOrigin:1,now:()=>0},document:{querySelector:()=>null,getElementById:()=>null}});
 const r=await vm.runInContext(opportunityExpression({before:{documentKey:'1',epoch:0,lifecycle:0,diagnosticSequence:1},expected:EXPECTED,timeoutMs:50}),c);assert.equal(r.wait.reason,'PREFLIGHT_FAILED');assert.equal(listeners.size,0);
});
