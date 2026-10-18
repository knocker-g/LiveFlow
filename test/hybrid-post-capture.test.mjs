import test from 'node:test';
import assert from 'node:assert/strict';
import {mapDiagnostics,observePost,postCaptureExpression} from '../tools/hybrid-diagnostic-adapter.mjs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {EXPECTED} from '../tools/hybrid-seek-scenario.mjs';
import {runSeekScenario,SCENARIO} from '../tools/hybrid-seek-scenario.mjs';
const require=createRequire(import.meta.url);
const {createScopes}=require('../src/diagnostic-scope-core.js');
test('incomplete evidence retains exact predicate and unknown values',()=>{
 const out=mapDiagnostics({accounting:{diagnosticScope:{epoch:1,incomplete:true}},shadow:{mismatchCount:0}});
 assert.equal(out.evidence.epoch,1);
 assert.equal(out.evidence.loss,'UNKNOWN');
 assert.equal(out.evidence.mismatch,0);
});
function harness(initial){
 const listeners=new Map(),timers=new Map();let tick=0,current=initial;
 const win={},video={};
 const env={window:win,origin:'same-origin',ownedVideo:()=>video,queueMicrotask,
  addEventListener:(type,fn)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
  removeEventListener:(type,fn)=>listeners.get(type)?.delete(fn),setTimeout:fn=>{timers.set(++tick,fn);return tick;},clearTimeout:id=>timers.delete(id)};
 const emit=(type='message',extra={})=>{const event={type,source:win,origin:'same-origin',data:{source:'liveflow-content-script',type:'LIVEFLOW_REPLAY_PIPELINE_DIAGNOSTIC'},target:video,...extra};for(const f of [...(listeners.get(type)??[])])f(event);};
 const promise=observePost({read:()=>{if(current instanceof Error)throw current;return current;},map:x=>x,env,timeoutMs:100});
 return {env,promise,emit,set:x=>current=x,deadline:()=>{for(const f of [...timers.values()])f();},clean:()=>{assert.equal(timers.size,0);assert.equal([...listeners.values()].reduce((a,s)=>a+s.size,0),0);}};
}
const waiting=()=>({adapterStatus:'BLOCKED',adapterBoundary:'SCOPE_INCOMPLETE_FLAG',evidence:{epoch:1,incomplete:true,loss:'UNKNOWN',mismatch:0}});
const complete=()=>({adapterStatus:'READY',oldScopeClosed:true,oldAttributionComplete:true,actualSeekObserved:true,evidence:{epoch:1,incomplete:false}});
const flush=()=>new Promise(resolve=>queueMicrotask(resolve));
test('P1.7 temporary old loss22 waits for delayed validated terminal',async()=>{
 const h=harness({...waiting(),evidence:{epoch:1,scopes:[{epoch:0,loss:22,overflow:0,terminalObserved:false,closure:'NOT_CLOSED'}]}});
 h.set(complete());h.emit();await flush();const r=await h.promise;
 assert.equal(r.observation.reason,'COMPLETE');assert.equal(r.observation.captures,2);assert.equal(r.observation.firstProvisional.classification,'PENDING_TERMINAL');h.clean();
});
test('P1.7 provisional22 survives deadline without becoming PASS or zero',async()=>{
 const h=harness({...waiting(),evidence:{scopes:[{epoch:0,loss:22,overflow:0,terminalObserved:false,closure:'NOT_CLOSED'}]}});h.deadline();const r=await h.promise;
 assert.equal(r.observation.reason,'DEADLINE');assert.equal(r.last.evidence.scopes[0].loss,22);assert.equal(r.observation.firstProvisional.loss,22);h.clean();
});
for(const closure of ['TERMINAL_INVALID','TERMINAL_VALIDATED'])test('P1.7 observed terminal loss fails immediately '+closure,async()=>{
 const h=harness(waiting());h.set({...waiting(),evidence:{scopes:[{epoch:0,loss:22,overflow:0,terminalObserved:true,closure}]}});h.emit();await flush();assert.equal((await h.promise).observation.reason,'TERMINAL_FAILURE');h.clean();
});
test('P1.7 no terminal inference from closure text alone',async()=>{
 const h=harness({...waiting(),evidence:{scopes:[{loss:22,terminalObserved:'UNKNOWN',closure:'TERMINAL_VALIDATED'}]}});h.deadline();assert.equal((await h.promise).observation.reason,'DEADLINE');h.clean();
});
test('P1.7 old stage slots copy only archive values, never current values',()=>{
 const stage={input:22,forwarded:0,explicitRemoval:0,retained:0,lost:22,overflow:0,valid:false};
 const out=mapDiagnostics({accounting:{stages:{parser:{...stage,input:999}},diagnosticScope:{epoch:1,scopes:[{epoch:0,archivedAttribution:{temporal:stage,scheduler:{...stage,input:33}}}]}}});
 assert.equal(out.evidence.scopes[0].stages.temporal.input,22);assert.equal(out.evidence.scopes[0].stages.scheduler.input,33);assert.equal(out.evidence.scopes[0].stages.parser.input,'UNKNOWN');assert.equal(Object.keys(out.evidence.scopes[0].stages).length,10);
});
test('event observer FAIL-before boundary now retains delayed completion',async()=>{
 const h=harness(waiting());h.set(complete());h.emit();await flush();const r=await h.promise;assert.equal(r.observation.reason,'COMPLETE');assert.equal(r.observation.captures,2);h.clean();
});
test('already complete at registration, no event needed',async()=>{const h=harness(complete());assert.equal((await h.promise).observation.captures,1);h.clean();});
test('unrelated messages and foreign media do not capture; deadline cleans',async()=>{
 const h=harness(waiting());h.emit('message',{origin:'foreign'});h.emit('message',{data:{source:'other',type:'OTHER'}});h.emit('seeking',{target:{}});await flush();h.deadline();const r=await h.promise;assert.equal(r.observation.captures,1);assert.equal(r.observation.events,0);assert.equal(r.last.evidence.loss,'UNKNOWN');h.clean();
});
test('same-task events coalesce after original handler state update',async()=>{
 const h=harness(waiting());h.emit();h.emit('seeked');h.set(complete());await flush();const r=await h.promise;assert.equal(r.observation.captures,2);assert.equal(r.observation.events,2);h.clean();
});
test('capture cap 16, no polling',async()=>{const h=harness(waiting());for(let i=0;i<15;i++){h.emit();await flush();}const r=await h.promise;assert.equal(r.observation.reason,'CAPTURE_CAP');assert.equal(r.observation.captures,16);h.clean();});
test('event cap32 while microtask coalesced, queued capture becomes no-op',async()=>{const h=harness(waiting());for(let i=0;i<32;i++)h.emit();const r=await h.promise;await flush();assert.equal(r.observation.reason,'EVENT_CAP');assert.equal(r.observation.captures,1);h.clean();});
for(const [name,value,reason] of [['persistent fault',{...waiting(),evidence:{collectorFault:true}},'HARD_FAILURE'],['read fault',new Error('PRIVATE'),'READ_FAULT'],['detach',waiting(),'DETACHED']])test(name+' cleanup',async()=>{
 const h=harness(waiting());h.set(value);h.emit(name==='detach'?'pagehide':'message');await flush();assert.equal((await h.promise).observation.reason,reason);h.clean();
});
test('listeners exist before initial read, all removed even on immediate fault',async()=>{
 const h=harness(new Error('SECRET'));const r=await h.promise;assert.equal(r.observation.reason,'READ_FAULT');assert.doesNotMatch(JSON.stringify(r),/SECRET/);h.clean();
});
for(const order of ['MAIN_FIRST','CONTENT_FIRST'])test('real scope core '+order+' delayed/duplicate terminal and new snapshot',async()=>{
 const core=createScopes(0,{},()=>{});core.receive({pageLifecycleGeneration:0,diagnosticScopeEpoch:0,diagnosticSequence:1});
 const h=harness({...waiting(),evidence:{epoch:1,scopes:[{epoch:0,loss:22,overflow:0,terminalObserved:false,closure:'NOT_CLOSED'}]}});
 const terminal={pageLifecycleGeneration:0,diagnosticScopeEpoch:0,diagnosticSequence:2,diagnosticTerminal:true};
 if(order==='CONTENT_FIRST')core.receive(terminal);
 core.open(0,{});
 const read=()=>{const ds=core.status();return ds.incomplete?waiting():complete();};
 h.set(read());h.emit();await flush();
 if(order==='MAIN_FIRST'){core.receive(terminal);core.receive(terminal);}
 core.receive({pageLifecycleGeneration:0,diagnosticScopeEpoch:1,diagnosticSequence:1});
 h.set(read());h.emit();await flush();assert.equal((await h.promise).observation.reason,'COMPLETE');h.clean();
});
test('real sequence gap/reversed terminal cannot close early',async()=>{
 const c=createScopes(0,{},()=>{});c.receive({pageLifecycleGeneration:0,diagnosticScopeEpoch:0,diagnosticSequence:1});c.open(0,{});
 c.receive({pageLifecycleGeneration:0,diagnosticScopeEpoch:0,diagnosticSequence:3,diagnosticTerminal:true});
 assert.equal(c.status().scopes[0].buffered,1);assert.equal(c.status().incomplete,true);
 c.receive({pageLifecycleGeneration:0,diagnosticScopeEpoch:1,diagnosticSequence:1});assert.equal(c.status().incomplete,true);
 c.receive({pageLifecycleGeneration:0,diagnosticScopeEpoch:0,diagnosticSequence:2});assert.equal(c.status().scopes[0].state,'CLOSED');
});
for(const order of ['ACK_FIRST','TERMINAL_FIRST','MISSING_ACK'])test('real closureReady '+order,async()=>{
 const value={ack:false};const c=createScopes(0,value,()=>{},{closureReady:v=>v.ack});
 if(order==='ACK_FIRST')value.ack=true;
 c.receive({pageLifecycleGeneration:0,diagnosticScopeEpoch:0,diagnosticSequence:1,diagnosticTerminal:true});
 if(order==='TERMINAL_FIRST'){assert.equal(c.status().incomplete,true);value.ack=true;c.reconcile();}
 assert.equal(c.status().scopes[0].state,order==='MISSING_ACK'?'INCOMPLETE':'CLOSED');
});
test('serialized observer code runs exact mapper in MAIN-like context without globals',async()=>{
 const listeners=new Map();const window={addEventListener:(t,f)=>listeners.set(t,f),removeEventListener:t=>listeners.delete(t),queueMicrotask,setTimeout,clearTimeout};
 const context=vm.createContext({window,location:{origin:'same-origin'},document:{visibilityState:'visible',querySelector:()=>null,getElementById:()=>null},performance:{timeOrigin:1}});
 const out=await vm.runInContext(postCaptureExpression({before:{documentKey:'1'},expected:EXPECTED,timeoutMs:10}),context);
 assert.equal(out.observation.reason,'HARD_FAILURE');assert.equal(out.last.adapterBoundary,'IDENTITY_MISSING');assert.equal(listeners.size,0);
 assert.equal(Object.keys(window).length,5); // no diagnostic/action API/global injection
});
test('runner retains partial facts/UNKNOWN, exact failure and one action',async()=>{
 let actions=0;const page={isClosed:()=>false,locator:()=>({count:async()=>1,isVisible:async()=>true,boundingBox:async()=>({width:100,height:10}),click:async()=>{actions++;}})};
 const pre={main:EXPECTED,content:EXPECTED,documentKey:'d',visibility:'visible',phase:'READING',authorityOK:true,currentnessOK:true,adActive:false,lifecycle:0,epoch:0,diagnosticSequence:1,scopeComplete:true,mismatch:0,fault:false,traceComplete:true,accountingComplete:true,conservation:true,loss:0,overflow:0,temporalPending:2,schedulerPending:2,mediaTime:10,duration:100};
 const packet='p16-partial';const result=await runSeekScenario(page,{expected:EXPECTED,packet,acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',approval:{packet,acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',scenario:SCENARIO,maxActions:1,deltaSeconds:30,documentKey:'d'},ready:{packet,documentKey:'d',foregroundExclusive:true},capture:async(_,o)=>o.phase==='POST'?{adapterStatus:'BLOCKED',adapterBoundary:'SCOPE_INCOMPLETE_FLAG',evidence:{epoch:1,incomplete:true,loss:'UNKNOWN',mismatch:0,secret:'PRIVATE',scopes:[{epoch:0,lifecycle:0,state:'INCOMPLETE',sequence:3,buffered:1},{epoch:1,lifecycle:0,state:'OPEN',sequence:1,buffered:0}]}}:pre});
 assert.equal(actions,1);assert.equal(result.status,'INCONCLUSIVE');assert.equal(result.firstBadBoundary,'SCOPE_INCOMPLETE_FLAG');assert.equal(result.post.lossZero,'UNKNOWN');assert.equal(result.post.oldScopeClosed,'UNKNOWN');assert.equal(result.verdicts.newScopeOpen,'OPEN');assert.equal(result.verdicts.oldClosure,'UNKNOWN');assert.equal(result.verdicts.epochTransition,true);assert.equal(result.browserReleased,true);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret/);
});
test('P1.7 runner terminal FAIL is separate from prior provisional evidence',async()=>{
 let actions=0;const page={isClosed:()=>false,locator:()=>({count:async()=>1,isVisible:async()=>true,boundingBox:async()=>({width:100,height:10}),click:async()=>{actions++;}})};
 const pre={main:EXPECTED,content:EXPECTED,documentKey:'d',visibility:'visible',phase:'READING',authorityOK:true,currentnessOK:true,adActive:false,lifecycle:0,epoch:0,diagnosticSequence:1,scopeComplete:true,mismatch:0,fault:false,traceComplete:true,accountingComplete:true,conservation:true,loss:0,overflow:0,temporalPending:2,schedulerPending:2,mediaTime:10,duration:100};
 const packet='p17-terminal-fail';const r=await runSeekScenario(page,{expected:EXPECTED,packet,acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',approval:{packet,acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',scenario:SCENARIO,maxActions:1,deltaSeconds:30,documentKey:'d'},ready:{packet,documentKey:'d',foregroundExclusive:true},capture:async(_,o)=>o.phase==='POST'?{adapterStatus:'BLOCKED',adapterBoundary:'SCOPE_INCOMPLETE_FLAG',evidence:{epoch:1},observation:{reason:'TERMINAL_FAILURE',events:1,captures:2,cleanup:true,firstProvisional:{epoch:0,loss:22,overflow:0,capture:1},snapshots:[]}}:pre});
 assert.equal(r.status,'FAIL');assert.equal(r.firstBadBoundary,'TERMINAL_ACCOUNTING_FAILURE');assert.equal(r.post.observation.firstProvisional.loss,22);assert.equal(actions,1);assert.equal(r.browserReleased,true);assert.equal(r.runtimeSeekPass,false);
});
