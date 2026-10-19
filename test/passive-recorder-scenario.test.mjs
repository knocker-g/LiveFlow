import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mapDiagnostics,mapPassiveDiagnostics,observePassive,passiveObservationExpression} from '../tools/hybrid-diagnostic-adapter.mjs';
import {runPassiveRecorderScenario,PASSIVE_OPERATION,recorderCommandPage,createPassiveCapture} from '../tools/passive-recorder-scenario.mjs';
import {retainedFacts} from '../tools/hybrid-seek-scenario.mjs';
import {createOwnedRecorder} from '../tools/density-comparison/owned-recorder.mjs';
import {installRecorderBridge,projectRecorderEvidence} from '../tools/density-comparison/recorder-bridge.mjs';
const expected={prefix:'b919fdf34325',sourceSHA:'c880919dea33d406aaa98d1377e6888ce131d08b',commonBuildID:'5b414f33d781d654178e5e9c4131b243fee34f8eee52830422fe97d102c634c6'};
let serial=0;
function raw(phase='READING') {
    const x=JSON.parse(fs.readFileSync('test/fixtures/hybrid-diagnostic-reading.json'));
    x.panel='DEV D / '+expected.prefix+' ';
    for(const t of [x.shadow.initialAuthorityTrace,x.shadow.initialRequestDispatch.content])t.identity={...expected};
    x.shadow.shadowPhase=phase;x.shadow.initialAuthorityTrace.rows.at(-1).phase=phase;
    x.accounting.pendingClear={pendingOperations:0,fault:false};
    x.reanchor={controlPhase:phase,authorityState:'OBSERVED_UNUSED',authorityCurrent:true,lifecycleCurrent:true,revisionCurrent:true,targetCurrent:true,generationCurrent:true,inFlight:false,navigationPending:false,adActive:false,seekActive:false,mainContentOwnershipValid:true,playerTimingValid:true,visibility:'VISIBLE'};
    x.restart={generationCurrent:true,frameRoleCurrent:true,ownedFrameConnected:true,sameSnapshotCurrent:true};
    x.media={currentTime:10,duration:100};x.passive={connected:true,paused:false,ended:false,seeking:false,readyState:4,geometry:{viewportWidth:100,viewportHeight:100,dpr:1,playerWidth:100,playerHeight:100,surfaceWidth:100,surfaceHeight:100}};
    return x;
}
for(const phase of ['READING','BUFFER_PAUSED'])test('passive '+phase+' admission; Seek remains READING-only',()=>{
    for(const candidate of ['B','D']){
        const bound={...expected,prefix:candidate==='B'?'465722ed544e':expected.prefix},x=raw(phase);
        x.panel='DEV '+candidate+' / '+bound.prefix+' ';
        assert.equal(mapPassiveDiagnostics(x,{expected:bound}).adapterStatus,'READY');
        assert.equal(mapDiagnostics(x,{expected:bound}).adapterStatus,phase==='READING'?'READY':'BLOCKED');
    }
});
for(const [name,edit]of [
    ['identity',x=>{x.panel='DEV B / 465722ed544e';}],
    ['authority',x=>{x.reanchor.authorityCurrent=false;}],
    ['scope',x=>{x.accounting.diagnosticScope.incomplete=true;}],
    ['fault',x=>{x.shadow.initialAuthorityTrace.collectorFault=true;}],
    ['paused',x=>{x.passive.paused=true;}],
    ['missing geometry',x=>{delete x.passive.geometry;}],
    ['empty geometry',x=>{x.passive.geometry={};}],
    ['missing geometry member',x=>{delete x.passive.geometry.surfaceHeight;}],
    ['MAIN/Shadow mismatch',x=>{x.shadow.shadowPhase='BUFFER_PAUSED';}],
    ['unknown Accounting',x=>{delete x.accounting.stages.scheduler.input;}]
])test(name+' fails closed before Recorder start',async()=>{
    const x=raw();edit(x);let starts=0;const capture=async()=>mapPassiveDiagnostics(x,{expected});capture.expectedIdentity=expected;
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),transportFactory:()=>{starts++;throw Error();}});
    assert.equal(r.status,'BLOCKED');assert.equal(starts,0);assert.equal(r.prohibitedActions,0);
});
function options(capture){const packet='fixture_'+ ++serial;return{packet,expected,capture,durationMs:1,
    approval:{packet,operation:PASSIVE_OPERATION,recorder:true,documentKey:String(raw().documentTimeOrigin)},
    ready:{packet,foregroundExclusive:true,documentKey:String(raw().documentTimeOrigin)}};}
function transportFixture() {
    let now=0,id=0;const timers=new Map(),listeners=new Set();
    const window={addEventListener:(t,f)=>listeners.add(f),removeEventListener:(t,f)=>listeners.delete(f)};
    const c=vm.createContext({});vm.runInContext(fs.readFileSync('tools/density-comparison/recorder.js','utf8'),c);
    const controller=createOwnedRecorder({...expected,buildID:expected.prefix+'0'.repeat(52)},()=>({at:now,mediaTime:10+now/1000,surface:{left:0,top:0,right:100,bottom:100},boxes:[],videoID:'PRIVATE'}),{
        now:()=>now,binding:()=>({document:window,video:window,generation:1,lifecycle:0,epoch:0}),
        setInterval:fn=>{timers.set(++id,fn);return id;},clearInterval:n=>timers.delete(n),setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:n=>timers.delete(n)
    },c.createComparisonRecorder);
    let reply;
    installRecorderBridge(controller,{...expected,buildID:expected.prefix+'0'.repeat(52)},{window,origin:'fixture',instanceId:'b'.repeat(32),documentKey:String(raw().documentTimeOrigin),post:x=>{reply=x.result;}});
    const factory=(_page,{operationId})=>{
        let request=0;const capability='a'.repeat(32);
        const command=(command,extra={})=>{reply=null;for(const f of listeners)f({source:window,origin:'fixture',data:{type:'LIVEFLOW_DEV_OWNED_RECORDER_V1',documentKey:String(raw().documentTimeOrigin),operationId,requestId:'r'+ ++request,capability,instanceId:'b'.repeat(32),command,...extra}});return reply;};
        return{probe:extra=>command('STOP',extra),capability,instanceId:'b'.repeat(32),release:async()=>command('RELEASE'),qualify:async()=>command('INFO',{expected}),start:async()=>command('START',{expected,qualified:true}),stop:async reason=>command('STOP',{reason}),evidence:async()=>command('EVIDENCE')};
    };
    return{factory,timers,advance:()=>{now=100;},controller};
}
test('actual Recorder→bridge ACK→runner confirms resource release; legal phase change allowed',async()=>{
    const f=transportFixture(),pre=mapPassiveDiagnostics(raw(),{expected});
    const capture=async()=>pre;capture.expectedIdentity=expected;
    capture.observe=async()=>{f.advance();const x=raw('BUFFER_PAUSED');x.media.currentTime=11;return{last:mapPassiveDiagnostics(x,{expected,before:pre}),reason:'NORMAL',cleanup:true};};
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),transportFactory:f.factory});
    assert.equal(r.status,'CAPTURE_PASS');assert.equal(r.cleanup,'PASS');assert.equal(r.resourcesConfirmed,true);assert.equal(f.timers.size,0);
    assert.equal(r.humanAcceptance,'PENDING');assert.equal(r.densityComparison,'NOT_PROVEN');assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('identity invalidation permits only owned cleanup, no result export',async()=>{
    const f=transportFixture(),pre=mapPassiveDiagnostics(raw(),{expected});let exports=0;
    const capture=async()=>pre;capture.expectedIdentity=expected;capture.observe=async()=>{const x=raw();x.panel='INVALID';return{last:mapPassiveDiagnostics(x,{expected,before:pre}),reason:'INVALIDATED',cleanup:true};};
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),transportFactory:(...args)=>{const t=f.factory(...args);t.evidence=async()=>{exports++;throw Error();};return t;}});
    assert.equal(exports,0);assert.equal(r.cleanup,'PASS');assert.equal(r.captureExecution,'INVALID');assert.equal(f.timers.size,0);
});
test('missing ACK latches UNKNOWN; next capture cannot execute, late ACK cannot promote',async()=>{
    const pre=mapPassiveDiagnostics(raw(),{expected});let reads=0;
    const capture=async()=>{reads++;return pre;};capture.expectedIdentity=expected;capture.observe=async()=>({last:pre,reason:'DETACHED',cleanup:true});
    const page={isClosed:()=>false};let ack={state:'CLEANUP_UNKNOWN'};
    const factory=()=>({instanceId:'b'.repeat(32),qualify:async()=>({profile:'OWNED_RECORDER_V1',instanceId:'b'.repeat(32),expectedMatch:true,available:true,maxObservationMs:10000}),start:async()=>({status:'STARTED',deadlineAt:10000}),stop:async()=>ack});
    const first=await runPassiveRecorderScenario(page,{...options(capture),transportFactory:factory});assert.equal(first.status,'CLEANUP_UNKNOWN');
    ack={stopConfirmed:true,resources:0,callbacks:0,captureValid:true};const before=reads;
    const second=await runPassiveRecorderScenario(page,{...options(capture),transportFactory:factory});assert.equal(reads,before);assert.equal(second.firstBadBoundary,'DETACHED_OR_UNRESOLVED_CLEANUP');assert.equal(first.status,'CLEANUP_UNKNOWN');
});
test('projection redacts arbitrary data and does not fabricate missing counters',()=>{
    const p=projectRecorderEvidence({finished:true,errors:['PRIVATE'],frames:[],summary:{},truncated:false,token:'PRIVATE'});
    assert.equal(p.launches,'UNKNOWN');assert.equal(p.fault,true);assert.ok(!JSON.stringify(p).includes('PRIVATE'));
});

test('lost start acknowledgement still performs owned cleanup without another start',async()=>{
    const f=transportFixture(),pre=mapPassiveDiagnostics(raw(),{expected});let starts=0;
    const capture=async()=>pre;capture.expectedIdentity=expected;
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),transportFactory:(...args)=>{
        const t=f.factory(...args),start=t.start;t.start=async()=>{starts++;await start();throw Error();};return t;
    }});
    assert.equal(starts,1);assert.equal(r.cleanup,'PASS');assert.equal(r.captureExecution,'INVALID');assert.equal(f.timers.size,0);
});
test('cancellation during observation stops once without evidence export',async()=>{
    const f=transportFixture(),pre=mapPassiveDiagnostics(raw(),{expected}),abort=new AbortController();let stops=0,exports=0;
    const capture=async()=>pre;capture.expectedIdentity=expected;capture.observe=async()=>{abort.abort();return{last:pre,reason:'OWNED_STOP',cleanup:true};};
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),signal:abort.signal,transportFactory:(...args)=>{
        const t=f.factory(...args),stop=t.stop;t.stop=async reason=>{stops++;return stop(reason);};t.evidence=async()=>{exports++;};return t;
    }});
    assert.equal(stops,1);assert.equal(exports,0);assert.equal(r.cleanup,'PASS');assert.equal(r.captureExecution,'INVALID');assert.equal(f.timers.size,0);
});
test('finite2s cleanup confirmation timeout is UNKNOWN, not native stop proof',async()=>{
    const pre=mapPassiveDiagnostics(raw(),{expected});let stops=0;
    const capture=async()=>pre;capture.expectedIdentity=expected;capture.observe=async()=>({last:pre,reason:'DETACHED',cleanup:true});
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),transportFactory:()=>({instanceId:'b'.repeat(32),qualify:async()=>({profile:'OWNED_RECORDER_V1',instanceId:'b'.repeat(32),expectedMatch:true,available:true,maxObservationMs:10000}),start:async()=>({status:'STARTED',deadlineAt:10000}),stop:()=>{stops++;return new Promise(()=>{});}})});
    assert.equal(stops,1);assert.equal(r.status,'CLEANUP_UNKNOWN');assert.equal(r.resourcesConfirmed,false);assert.equal(r.browserReleased,true);
});

function environment() {
    const listeners=new Map(),timers=new Map(),jobs=[];let id=0,now=0;const posts=[];
    const window={},video={};
    const env={window,origin:'fixture',now:()=>now,ownedVideo:()=>video,
        addEventListener:(type,fn)=>{listeners.set(type,fn);},removeEventListener:type=>listeners.delete(type),
        setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:n=>timers.delete(n),
        queueMicrotask:fn=>jobs.push(fn),post:x=>posts.push(x)};
    return{env,listeners,timers,posts,clock:value=>{now=value;},emit(type='message',data={source:'liveflow-content-script',type:'LIVEFLOW_REPLAY_PIPELINE_DIAGNOSTIC'}){listeners.get(type)?.({type,source:window,origin:'fixture',target:video,data});},flush(){while(jobs.length)jobs.shift()();}};
}
test('observer accepts lawful phase change then invalidation cleans listeners/timer and sends owned stop only',async()=>{
    const e=environment();let x=raw(),reads=0;const baseline=mapPassiveDiagnostics(x,{expected});
    const pending=observePassive({read:()=>{reads++;return x;},map:v=>mapPassiveDiagnostics(v,{expected,before:baseline}),env:e.env,durationMs:10,cleanupCommand:{command:'STOP'}});
    e.emit('message',{type:'UNRELATED'});e.flush();assert.equal(reads,1);
    x=raw('BUFFER_PAUSED');e.emit();e.flush();assert.equal(reads,2);
    x.reanchor.authorityCurrent=false;e.emit();e.flush();const r=await pending;
    assert.equal(r.last.adapterBoundary,'PASSIVE_AUTHORITY');assert.equal(e.posts.length,1);assert.equal(e.listeners.size,0);assert.equal(e.timers.size,0);
    e.flush();assert.equal(reads,3);
});
test('observer normal deadline and detach both release resources',async()=>{
    for(const outcome of ['NORMAL','DETACHED']){
        const e=environment();const pending=observePassive({read:()=>raw(),map:v=>mapPassiveDiagnostics(v,{expected}),env:e.env,durationMs:10,cleanupCommand:{command:'STOP'}});
        if(outcome==='NORMAL')[...e.timers.values()][0]();else e.emit('pagehide');
        const r=await pending;assert.equal(r.reason,outcome);assert.equal(e.listeners.size,0);assert.equal(e.timers.size,0);
    }
});
test('observer event and capture caps remain finite and clean',async()=>{
    for(const kind of ['events','captures']){
        const e=environment();const pending=observePassive({read:()=>raw(),map:v=>mapPassiveDiagnostics(v,{expected}),env:e.env,durationMs:10,cleanupCommand:{command:'STOP'}});
        for(let i=0;i<32;i++){e.emit();if(kind==='captures')e.flush();}
        e.flush();const r=await pending;assert.ok(r.events<=32);assert.ok(r.captures<=16);assert.equal(e.listeners.size,0);assert.equal(e.timers.size,0);
    }
});
test('bridge instance/capability fences reject foreign cleanup; old stop cannot affect next operation',async()=>{
    const f=transportFixture();const a=f.factory(null,{operationId:'old'});await a.qualify();await a.start();
    await a.probe({capability:'f'.repeat(32)});assert.equal(f.timers.size,2);
    await a.probe({instanceId:'f'.repeat(32)});assert.equal(f.timers.size,2);
    await a.stop('NORMAL');assert.equal(f.timers.size,0);
    assert.equal((await a.qualify()).available,false,'hold ownership until stop ACK received and release');
    await a.release();const b=f.factory(null,{operationId:'new'});await b.qualify();await b.start();
    await a.stop('NORMAL');assert.equal(f.timers.size,2);await b.stop('NORMAL');await b.release();
});
test('old package without lifecycle handshake cannot start Recorder',async()=>{
    const pre=mapPassiveDiagnostics(raw(),{expected});let starts=0;const capture=async()=>pre;capture.expectedIdentity=expected;
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),transportFactory:()=>({qualify:async()=>null,start:async()=>{starts++;}})});
    assert.equal(starts,0);assert.equal(r.firstBadBoundary,'RECORDER_LIFECYCLE_UNAVAILABLE');assert.equal(r.cleanup,'NOT_RUN');
});
test('missing stop ACK holds Recorder ownership even across a new runner instance',async()=>{
    const f=transportFixture(),a=f.factory(null,{operationId:'unconfirmed'});await a.start();await a.stop('NORMAL');
    const b=f.factory(null,{operationId:'other'});assert.equal((await b.qualify()).available,false);assert.equal((await b.start()).state,'REJECTED');
    await a.release();assert.equal((await b.qualify()).available,true);
});
test('cancellation overtaking START keeps a tombstone and proves no later resource allocation',async()=>{
    const f=transportFixture(),operation=f.factory(null,{operationId:'cancel_before_start'});
    await operation.qualify();const ack=await operation.stop('CANCELLED');
    assert.equal(ack.stopConfirmed,true);assert.equal(ack.started,false);assert.equal(ack.resources,0);
    await operation.release();const late=await operation.start();
    assert.equal(late.state,'REJECTED');assert.equal(f.timers.size,0);
});
test('passive failure receipt keeps fixed media/geometry facts and UNKNOWN independently',()=>{
    const x=raw();delete x.passive.geometry.surfaceHeight;x.passive.readyState=2;
    const r=mapPassiveDiagnostics(x,{expected}),facts=retainedFacts(r.evidence);
    assert.equal(r.adapterBoundary,'PASSIVE_MEDIA');assert.equal(facts.passive.media.readyState,2);
    assert.equal(facts.passive.media.paused,false);assert.equal(facts.passive.geometry.surfaceHeight,'UNKNOWN');
    assert.equal(facts.passive.geometry.surfaceWidth,100);
    x.panel='INVALID';assert.equal(mapPassiveDiagnostics(x,{expected}).evidence.passive.media.readyState,2);
});
test('capture factory carries Recorder instance into cleanup expression',async()=>{
    let expression;
    const capture=createPassiveCapture({expected});
    await capture.observe({evaluate:async value=>{expression=value;return{};}},{before:{documentKey:'1'},operationId:'op',capability:'a'.repeat(32),instanceId:'b'.repeat(32),durationMs:1});
    assert.ok(expression.includes('"instanceId":"'+'b'.repeat(32)+'"'));
});
test('real capture/command factories traverse VM document, guarded bridge and actual Recorder',async()=>{
    const x=raw('BUFFER_PAUSED'),listeners=new Map(),timers=new Map();let next=0,now=0;
    const video={isConnected:true,paused:false,ended:false,seeking:false,readyState:4,currentTime:10,duration:100};
    const rectangle=()=>({width:100,height:100});
    const player={querySelector:()=>video,getBoundingClientRect:rectangle};
    const doc={visibilityState:'visible',querySelector:s=>s.includes('video.html5-main-video')?video:player,querySelectorAll:()=>[panel],
        getElementById:id=>id==='liveflow-dev-comparison'?panel:{getBoundingClientRect:rectangle}};
    const panel={ownerDocument:doc,firstChild:{textContent:x.panel},dataset:{initialRequestTrace:JSON.stringify(x.shadow.initialRequestDispatch.content)}};
    const window={addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
        removeEventListener(type,fn){listeners.get(type)?.delete(fn);},queueMicrotask,
        postMessage(data){queueMicrotask(()=>{for(const fn of [...(listeners.get('message')||[])])fn({source:window,origin:'fixture',type:'message',data});});},
        setTimeout(fn,delay){timers.set(++next,{fn,delay});return next;},clearTimeout:id=>timers.delete(id)};
    for(const [name,value]of Object.entries({LiveFlowReplayControlPlaneShadowDiagnostic:x.shadow,LiveFlowReplayAccountingDiagnostic:x.accounting,
        LiveFlowReplayPipelineDiagnostic:x.pipeline,LiveFlowReplayProductionReanchorDiagnostic:x.reanchor,LiveFlowReplayRestartDiagnostic:x.restart}))window[name]={status(){return value;}};
    const context=vm.createContext({window,document:doc,location:{origin:'fixture'},performance:{timeOrigin:x.documentTimeOrigin,now:()=>now},
        innerWidth:100,innerHeight:100,devicePixelRatio:1,setTimeout:window.setTimeout,clearTimeout:window.clearTimeout});
    vm.runInContext(fs.readFileSync('tools/density-comparison/recorder.js','utf8'),context);
    const controller=createOwnedRecorder({...expected,buildID:expected.prefix+'0'.repeat(52)},()=>({at:now,mediaTime:video.currentTime,surface:{left:0,top:0,right:100,bottom:100},boxes:[]}),{
        now:()=>now,binding:()=>({document:doc,video,generation:1,lifecycle:0,epoch:0}),setInterval:fn=>{timers.set(++next,{fn,delay:100,interval:true});return next;},
        clearInterval:id=>timers.delete(id),setTimeout:window.setTimeout,clearTimeout:window.clearTimeout},context.createComparisonRecorder);
    installRecorderBridge(controller,{...expected,buildID:expected.prefix+'0'.repeat(52)},
        {window,origin:'fixture',documentKey:String(x.documentTimeOrigin),instanceId:'b'.repeat(32),post:value=>window.postMessage(value)});
    const page={isClosed:()=>false,evaluate:async(expression,arg)=>{
        context.argument=arg;
        const result=vm.runInContext(typeof expression==='string'?expression:'('+expression+')(argument)',context);
        if(typeof expression==='string'&&expression.includes('function observePassive'))queueMicrotask(()=>{
            now=100;video.currentTime=11;
            for(const [id,t]of [...timers])if(t.delay===1){timers.delete(id);t.fn();}
        });
        return result;
    }};
    const capture=createPassiveCapture({expected});const result=await runPassiveRecorderScenario(page,options(capture));
    assert.equal(result.status,'CAPTURE_PASS');assert.equal(result.resourcesConfirmed,true);assert.equal(timers.size,0);
    assert.equal([...listeners.values()].reduce((n,set)=>n+set.size,0),1,'only document-owned bridge remains');
    assert.equal(controller.availability(),true);assert.equal(result.prohibitedActions,0);
});
test('cancel during start ACK prevents any observer or evidence read',async()=>{
    const f=transportFixture(),pre=mapPassiveDiagnostics(raw(),{expected}),abort=new AbortController();let observes=0;
    const capture=async()=>pre;capture.expectedIdentity=expected;capture.observe=async()=>{observes++;throw Error();};
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),signal:abort.signal,transportFactory:(...args)=>{
        const t=f.factory(...args),start=t.start;t.start=async()=>{const ack=await start();abort.abort();return ack;};return t;
    }});
    assert.equal(observes,0);assert.equal(r.observerCleanup,'NOT_RUN');assert.equal(r.captureExecution,'INVALID');assert.equal(r.cleanup,'PASS');assert.equal(f.timers.size,0);
});
test('Recorder ACK cannot hide an unconfirmed observer cleanup or release its operation',async()=>{
    const f=transportFixture(),pre=mapPassiveDiagnostics(raw(),{expected});
    const capture=async()=>pre;capture.expectedIdentity=expected;capture.observe=async()=>({last:pre,reason:'READ_FAULT',cleanup:false});
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),transportFactory:f.factory});
    assert.equal(r.recorderCleanup,'PASS');assert.equal(r.observerCleanup,'CLEANUP_UNKNOWN');assert.equal(r.cleanup,'CLEANUP_UNKNOWN');
    assert.equal(f.timers.size,0);assert.equal(f.controller.availability(),false);
});
test('a frozen observer returning after deadline performs no new diagnostic read',async()=>{
    const e=environment();let reads=0;
    const pending=observePassive({read:()=>{reads++;return raw();},map:v=>mapPassiveDiagnostics(v,{expected}),env:e.env,durationMs:10,deadlineAt:10000,cleanupCommand:{command:'STOP'}});
    e.clock(20000);[...e.timers.values()][0]();const r=await pending;
    assert.equal(r.reason,'DEADLINE');assert.equal(reads,1);assert.equal(e.posts.length,1);assert.equal(e.listeners.size,0);assert.equal(e.timers.size,0);
});
test('owned cancel message ends observer without another snapshot; foreign instance is ignored',async()=>{
    const e=environment();let reads=0;const command={type:'LIVEFLOW_DEV_OWNED_RECORDER_V1',command:'STOP',operationId:'op',capability:'a'.repeat(32),instanceId:'b'.repeat(32)};
    const pending=observePassive({read:()=>{reads++;return raw();},map:v=>mapPassiveDiagnostics(v,{expected}),env:e.env,durationMs:10,cleanupCommand:command});
    e.emit('message',{...command,instanceId:'c'.repeat(32)});assert.ok(e.listeners.size>0);
    e.emit('message',command);const r=await pending;assert.equal(r.reason,'OWNED_STOP_REQUESTED');assert.equal(reads,1);assert.equal(e.posts.length,0);assert.equal(e.listeners.size,0);
});
test('cancellation after normal stop ACK cannot export or promote capture',async()=>{
    const f=transportFixture(),pre=mapPassiveDiagnostics(raw(),{expected}),abort=new AbortController();let exports=0;
    const capture=async()=>pre;capture.expectedIdentity=expected;capture.observe=async()=>({last:{...pre,mediaTime:11},reason:'NORMAL',cleanup:true});
    const r=await runPassiveRecorderScenario({isClosed:()=>false},{...options(capture),signal:abort.signal,transportFactory:(...args)=>{
        const t=f.factory(...args),stop=t.stop;t.stop=async reason=>{const ack=await stop(reason);abort.abort();return ack;};t.evidence=async()=>{exports++;throw Error();};return t;
    }});
    assert.equal(exports,0);assert.equal(r.captureExecution,'INVALID');assert.equal(r.evidenceQualification,'NOT_PROVEN');assert.equal(r.cleanup,'PASS');
});
