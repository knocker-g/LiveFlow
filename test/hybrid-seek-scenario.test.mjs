import test from 'node:test';
import assert from 'node:assert/strict';
import {runSeekScenario, SCENARIO, EXPECTED} from '../tools/hybrid-seek-scenario.mjs';
let packetSequence = 0;
function setup(patch = {}, options = {}) {
    const pre = { main: {...EXPECTED}, content: {...EXPECTED}, documentKey: 'local-document', visibility: 'visible', phase: 'READING', authorityOK: true, currentnessOK: true, adActive: false,
        lifecycle: 0, epoch: 0, diagnosticSequence:1,scopeComplete: true, mismatch: 0, fault: false, traceComplete: true, accountingComplete: true, conservation: true, loss: 0, overflow: 0,
        temporalPending: 2, schedulerPending: 3, mediaTime: 120, duration: 1000,evidence:{scopes:[{lifecycle:0,epoch:0,temporalSeek:0,schedulerLifecycle:0}]}, ...patch };
    const post = {...pre, epoch: 1, oldScopeClosed: true, oldAttributionComplete: true, oldConservation: true, oldRetained: 0, oldUnclassified: 0, oldLoss: 0, oldOverflow: 0, actualSeekObserved: true,temporalSeekRemoval:2,schedulerLifecycleRemoval:3, ...options.post};
    const calls = [];
    const slider = {count: async () => options.count ?? 1, isVisible: async () => true, boundingBox: async () => ({width: 1000, height: 10}), click: async x => {calls.push(x);if(options.clickThrows)throw Error('private URL token');}};
    const page = {isClosed: () => options.closed ?? false, locator: selector => {assert.equal(selector,'.html5-video-player .ytp-progress-bar[role="slider"]');return slider;}, reload: () => assert.fail('reload'), goto: () => assert.fail('navigation')};
    const phases=[];
    const packet='fixture-'+ ++packetSequence;
    const input = {expected: EXPECTED,packet, acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',approval:{packet, acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',scenario:SCENARIO, maxActions:1, deltaSeconds:30, documentKey:'local-document'},ready:{packet, foregroundExclusive:true, documentKey:'local-document'},
        capture: async (_, {phase,timeoutMs}) => {phases.push(phase);assert.ok(timeoutMs<=10000);if(phase==='POST'&&options.postThrows)throw Error('SECRET');return phase==='POST'?post:phase==='ACTION_GATE'?{...pre,...options.last}:pre;}};
    return {page,input,calls,phases};
}
for (const [name,patch] of Object.entries({wrongIdentity:{main:{...EXPECTED,prefix:'old'}},hidden:{visibility:'hidden'},suspended:{phase:'SUSPENDED'},stopped:{phase:'STOPPED'},authority:{authorityOK:false},currentness:{currentnessOK:false},ad:{adActive:true},mismatch:{mismatch:1},fault:{fault:true},emptyTemporal:{temporalPending:0},emptyScheduler:{schedulerPending:0},incomplete:{scopeComplete:false},loss:{loss:1},overflow:{overflow:1},conservation:{conservation:false},trace:{traceComplete:false},pending:{accountingComplete:false}})) {
    test('zero action: '+name,async()=>{const f=setup(patch);const r=await runSeekScenario(f.page,f.input);assert.equal(r.status,'BLOCKED');assert.equal(f.calls.length,0);assert.equal(r.browserReleased,true);});
}
for (const [name,options] of Object.entries({missingSelector:{count:0},ambiguousSelector:{count:2},detached:{closed:true},staleDocument:{last:{documentKey:'different'}},epochChanged:{last:{epoch:1}},queueDrained:{last:{schedulerPending:0}}})) {
    test('zero action: '+name,async()=>{const f=setup({},options);const r=await runSeekScenario(f.page,f.input);assert.equal(r.status,'BLOCKED');assert.equal(f.calls.length,0);});
}
test('approval and READY independent, document scoped',async()=>{
    for(const key of ['approval','ready']){const f=setup();delete f.input[key];const r=await runSeekScenario(f.page,f.input);assert.equal(r.status,'BLOCKED');assert.deepEqual(f.phases,[]);}
    const f=setup();f.input.approval.documentKey='old';assert.equal((await runSeekScenario(f.page,f.input)).firstBadBoundary,'DOCUMENT_CONSENT');
});
test('one UI seek, immediate qualified capture, bounded anonymous receipt',async()=>{
    const f=setup({token:'SECRET',rawComments:['PRIVATE'],url:'PRIVATE'});const r=await runSeekScenario(f.page,f.input);
    assert.equal(r.status,'SCENARIO_EVIDENCE_COMPLETE');assert.equal(f.calls.length,1);assert.equal(f.calls[0].position.x,150);assert.deepEqual(f.phases,['PRE','ACTION_GATE','POST']);
    assert.equal(r.action.attempted,1);assert.equal(r.action.completed,1);assert.equal(r.runtimeSeekPass,false);assert.equal(r.browserReleased,true);
    assert.doesNotMatch(JSON.stringify(r),/SECRET|PRIVATE|local-document|mediaTime|duration/);
    assert.equal((await runSeekScenario(f.page,f.input)).status,'BLOCKED');assert.equal(f.calls.length,1);
});
for(const options of [{postThrows:true},{clickThrows:true},{post:{epoch:0}},{post:{documentKey:'different'}},{post:{oldScopeClosed:false}},{post:{oldLoss:1}},{post:{traceComplete:false}}]){
    test('attempt retained, no retry on failed/incomplete post '+JSON.stringify(options),async()=>{const f=setup({},options);const r=await runSeekScenario(f.page,f.input);assert.equal(r.status,'INCONCLUSIVE');assert.equal(f.calls.length,1);assert.equal(r.action.attempted,1);assert.equal(r.browserReleased,true);assert.doesNotMatch(JSON.stringify(r),/SECRET|private URL/);});
}
test('concurrent invocation of one approved packet cannot double seek',async()=>{
    const f=setup();const results=await Promise.all([runSeekScenario(f.page,f.input),runSeekScenario(f.page,f.input)]);
    assert.equal(f.calls.length,1);assert.equal(results.filter(r=>r.action.attempted===1).length,1);
});
