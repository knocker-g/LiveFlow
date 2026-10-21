// Offline characterization. Real Scheduler Runtime/queue/geometry and state machine.
// Mock boundaries: media clock, candidate rectangles, timer delivery and renderer commit.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');const {createRequire}=require('node:module');
const pending=require('../src/pending-selection'),foundations=require('../src/scheduler-foundations');
const D=require('./fixtures/final-visual-candidates').candidateC.config;
function harness(extra={}){const file=path.resolve('test/scheduler-runtime.test.js'),c=vm.createContext({require:createRequire(file)});vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n').split('\ntest(')[0]+'\nmake=harness;',c);return c.make({...extra,candidateProof:extra.candidateProof||proof,config:{maxPendingCount:150,pendingPressureCapacity:150,scanDepth:5,cohortMaximumItems:5,cohortMaximumSpan:800,normalOverlapPolicy:D.normalOverlapPolicy,collisionAllowances:D.collisionAllowances,...extra.config}});}
const proof=()=>({candidates:[{rectangle:{x:100,y:0,width:50,height:20,velocity:100,exitX:0,surfaceRight:866},lane:0,laneSpan:1}],activeComments:[]});
test('scanned safe SPECIAL beats NORMAL and loser remains for next opportunity',()=>{const h=harness();h.enqueue('normal');h.enqueue('special','liveChatPaidMessageRenderer');h.fire();assert.deepEqual(Array.from(h.launched),['special']);assert.equal(h.runtime.status().pendingCount,1);h.fire();assert.deepEqual(Array.from(h.launched),['special','normal']);});
for(const blocked of ['structural','collision'])test(blocked+' SPECIAL does not block next safe SPECIAL/normal',()=>{
 for(const type of ['liveChatPaidStickerRenderer','liveChatTextMessageRenderer']){const events=[];const h=harness({observe:e=>events.push(e),candidateProof:item=>item.payload.id==='blocked'?(blocked==='structural'?{unrepresentableSpecial:true}:{blockedReason:'NO_USABLE_LANE'}):proof()});h.enqueue('blocked','liveChatPaidMessageRenderer');h.enqueue('safe',type);h.fire();assert.deepEqual(Array.from(h.launched),['safe']);assert.equal(h.runtime.status().pendingCount,blocked==='structural'?0:1);assert.ok(events.some(e=>e.type===(blocked==='structural'?'STRUCTURAL_DROPPED':'COLLISION_NO_USABLE_LANE')));}
});
test('same temporal cohort SPECIAL completes omitted rotating scan with31 pending',()=>{
 const inspected=[],events=[];const h=harness({observe:e=>events.push(e),candidateProof:item=>{inspected.push(item.id);return proof();}});
 for(let i=0;i<31;i++)h.enqueue(i===1?'special':'normal-'+i,i===1?'liveChatPaidMessageRenderer':'liveChatTextMessageRenderer');
 assert.deepEqual(Array.from(foundations.rotatingModularStride(31,5,0)),[0,5,10,15,20]);
 h.fire();assert.deepEqual(Array.from(h.launched),['special']);assert.equal(inspected.includes('special'),true);assert.equal(inspected.length,6);assert.equal(new Set(inspected).size,inspected.length);assert.equal(h.runtime.status().pendingCount,30);assert.equal(events.some(e=>/DROPPED|PRUNED/.test(e.type)),false);
 // Independent identical geometry/clock control: the same SPECIAL is placeable.
 const control=harness();control.enqueue('special','liveChatPaidMessageRenderer');control.fire();assert.deepEqual(Array.from(control.launched),['special']);
 const cohort=foundations.temporalCohort(Array.from({length:31},()=>({enqueuedAt:100})),{maximumItems:5,maximumSpan:800});assert.ok(cohort.some(c=>c.index===1));
});
test('stale and capacity removals are explicit and unchanged by SPECIAL',()=>{
 const q=pending.createPendingQueue();for(const [id,at,type]of [['special',0,'liveChatPaidMessageRenderer'],['normal',1,'liveChatTextMessageRenderer']])q.enqueue(pending.createPendingItem({id,enqueuedAt:at,rendererType:type,payload:{},footprint:{}}));assert.equal(q.pruneStale(100,20).length,2);
 const h=harness({config:{maxPendingCount:1}});h.enqueue('old-special','liveChatPaidMessageRenderer');h.enqueue('new-normal');h.fire();assert.deepEqual(Array.from(h.launched),['new-normal']);
});
