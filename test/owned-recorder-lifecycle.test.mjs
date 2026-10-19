import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createOwnedRecorder} from '../tools/density-comparison/owned-recorder.mjs';
const expected = {prefix:'b919fdf34325',sourceSHA:'c880919dea33d406aaa98d1377e6888ce131d08b',commonBuildID:'5b414f33d781d654178e5e9c4131b243fee34f8eee52830422fe97d102c634c6'};
const identity = {...expected,buildID:expected.prefix+'0'.repeat(52)};
function fixture({failRead=false,failClear=false,readEffect}={}) {
    let now=0,id=0,clears=0,reads=0;
    let binding={document:{},video:{},generation:1,lifecycle:0,epoch:0};
    const timers=new Map();
    const host={now:()=>now,binding:()=>binding,
        setInterval:(fn)=>{timers.set(++id,{fn,interval:true});return id;},
        setTimeout:(fn)=>{timers.set(++id,{fn,interval:false});return id;},
        clearInterval:n=>{if(failClear)throw Error();clears++;timers.delete(n);},
        clearTimeout:n=>{if(failClear)throw Error();clears++;timers.delete(n);}};
    const c=vm.createContext({});
    vm.runInContext(fs.readFileSync('tools/density-comparison/recorder.js','utf8'),c);
    const controller=createOwnedRecorder(identity,()=>{reads++;if(failRead)throw Error();readEffect?.({reads,setClock:n=>{now=n;},drift:()=>{binding={...binding,generation:2};}});return{at:now,surface:{left:0,top:0,right:100,bottom:100},boxes:[]};},host,c.createComparisonRecorder);
    return {controller,timers,reads:()=>reads,clears:()=>clears,clock:n=>{now=n;},drift:()=>{binding={...binding,generation:2};},detach:()=>{host.binding=()=>{throw Error();};},
        tick(){for(const [n,t]of [...timers]){if(!t.interval)timers.delete(n);t.fn();}},
        sample(){for(const t of [...timers.values()])if(t.interval)t.fn();},
        start:(operationId='op')=>controller.startOperation({operationId,expected,qualified:true})};
}
test('actual Recorder stop clears interval and deadline before confirmation; duplicate stop is idempotent',()=>{
    const f=fixture(),s=f.start();assert.equal(s.status,'STARTED');assert.equal(f.timers.size,2);
    const ack=f.controller.stopOperation(s.owner,'NORMAL');assert.equal(ack.state,'STOP_CONFIRMED');assert.equal(ack.resources,0);assert.equal(ack.callbacks,0);assert.equal(f.timers.size,0);
    const clears=f.clears();f.controller.stopOperation(s.owner);assert.equal(f.clears(),clears);assert.equal(f.controller.resultOperation(s.owner).finished,true);
});
test('deadline closes admission before any post-deadline sample and really releases resources',()=>{
    const f=fixture(),s=f.start(),reads=f.reads();f.clock(10000);f.tick();assert.equal(f.reads(),reads);assert.equal(f.timers.size,0);
    const ack=f.controller.statusOperation(s.owner);assert.equal(ack.stopConfirmed,true);assert.equal(ack.captureValid,false);assert.equal(ack.deadlineReached,true);
});
test('elapsed clock alone does not imply confirmation',()=>{const f=fixture(),s=f.start();f.clock(30000);assert.equal(f.controller.statusOperation(s.owner).stopConfirmed,false);assert.equal(f.timers.size,2);});
for(const type of ['drift','detach'])test(type+' closes observation and performs only old owned cleanup',()=>{const f=fixture(),s=f.start(),reads=f.reads();f[type]();f.tick();assert.equal(f.reads(),reads);assert.equal(f.timers.size,0);assert.equal(f.controller.statusOperation(s.owner).captureValid,false);});
test('partial first-read failure rolls back the already-armed deadline',()=>{const f=fixture({failRead:true}),s=f.start();assert.equal(s.status,'FAILED_CLEAN');assert.equal(s.snapshot.started,false);assert.equal(f.timers.size,0);});
test('foreign owner and stale owner cannot stop another Recorder',()=>{const f=fixture(),a=f.start();assert.equal(f.controller.stopOperation({operationId:'op'}).state,'NOT_OWNER');f.controller.stopOperation(a.owner,'NORMAL');f.controller.releaseOperation(a.owner);const b=f.start('next');f.controller.stopOperation(a.owner);assert.equal(f.controller.statusOperation(b.owner).state,'STARTED');f.controller.stopOperation(b.owner,'NORMAL');});
test('clear failure never confirms resources and blocks next start',()=>{const f=fixture({failClear:true}),s=f.start();const ack=f.controller.stopOperation(s.owner);assert.equal(ack.state,'FAILED');assert.equal(ack.stopConfirmed,false);assert.ok(ack.resources>0);assert.equal(f.start('next').status,'REJECTED');});
test('unknown cleanup blocks subsequent captures; late ACK cannot restore capture validity',()=>{const f=fixture(),s=f.start();f.controller.markUnknown(s.owner);const ack=f.controller.stopOperation(s.owner,'NORMAL');assert.equal(ack.stopConfirmed,true);assert.equal(ack.captureValid,false);assert.equal(f.start('next').status,'REJECTED');assert.equal(f.controller.resultOperation(s.owner),null);});
test('wrong build, unqualified, duplicate start cause no additional read',()=>{const f=fixture();assert.equal(f.controller.startOperation({operationId:'x',expected:{...expected,prefix:'0'.repeat(12)},qualified:true}).status,'REJECTED');assert.equal(f.reads(),0);const s=f.start();const reads=f.reads();assert.equal(f.start().status,'REJECTED');assert.equal(f.reads(),reads);f.controller.stopOperation(s.owner);});
test('read completing beyond deadline is discarded before recording and confirms actual cleanup',()=>{
    const f=fixture({readEffect:({reads,setClock})=>{if(reads===2)setClock(11000);}}),s=f.start();
    f.sample();const ack=f.controller.statusOperation(s.owner);
    assert.equal(ack.reason,'DEADLINE');assert.equal(ack.stopConfirmed,true);assert.equal(ack.callbacks,0);assert.equal(ack.resources,0);
    assert.equal(f.timers.size,0);assert.equal(f.controller.resultOperation(s.owner),null);
});
test('read completing after currentness drift is discarded and cannot qualify evidence',()=>{
    const f=fixture({readEffect:({reads,drift})=>{if(reads===2)drift();}}),s=f.start();f.sample();
    const ack=f.controller.statusOperation(s.owner);assert.equal(ack.reason,'INVALIDATED');assert.equal(ack.stopConfirmed,true);
    assert.equal(f.timers.size,0);assert.equal(f.controller.resultOperation(s.owner),null);
});
