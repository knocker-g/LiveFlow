import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mapDiagnostics,createDiagnosticCapture,readDiagnosticPage} from '../tools/hybrid-diagnostic-adapter.mjs';
import {EXPECTED,runSeekScenario,SCENARIO} from '../tools/hybrid-seek-scenario.mjs';
const evidence=JSON.parse(fs.readFileSync(new URL('./fixtures/hybrid-diagnostic-reading.json',import.meta.url)));
// Historical evidence is unchanged. Supplemental current-version fields below
// are explicit synthetic controls, NOT runtime observations of the new package.
function good(){
 const x=structuredClone(evidence);x.panel='DEV D / '+EXPECTED.prefix+' ';
 for(const t of [x.shadow.initialAuthorityTrace,x.shadow.initialRequestDispatch.content])t.identity={sourceSHA:EXPECTED.sourceSHA,commonBuildID:EXPECTED.commonBuildID};
 x.accounting.pendingClear={pendingOperations:0,fault:false};
 x.reanchor={controlPhase:'READING',navigationPending:false,adActive:false,seekActive:false,mainContentOwnershipValid:true,playerTimingValid:true,visibility:'VISIBLE'};
 x.restart={generationCurrent:true,frameRoleCurrent:true,ownedFrameConnected:true,sameSnapshotCurrent:true};
 x.media={currentTime:120,duration:1000};
 return x;
}
test('unmodified old runtime Evidence is not current identity PASS',()=>{
 assert.equal(mapDiagnostics(evidence).adapterBoundary,'IDENTITY_MISMATCH');
 assert.equal(evidence.accounting.stages.temporal.input,223);assert.equal(evidence.accounting.temporalPending,79);
});
test('actual field mapping, synthetic current-version controls, published pending',()=>{
 const x=good();const out=mapDiagnostics(x);assert.equal(out.adapterStatus,'READY');assert.equal(out.temporalPending,79);assert.equal(out.schedulerPending,0);
 x.accounting.stages.scheduler.retained=3;x.accounting.stages.scheduler.input+=3;x.accounting.schedulerRetained=3;x.pipeline.pendingCurrent=3;
 assert.equal(mapDiagnostics(x).schedulerPending,3);assert.match(mapDiagnostics(x).pendingSource,/PUBLISHED_NOT_DIRECT/);
});
function transitioned(){
 const x=good(),before=mapDiagnostics(x),old=x.accounting.diagnosticScope.scopes[0];
 old.state='CLOSED';const t=old.archivedAttribution;
 Object.assign(t,{state:'CLOSED',sequenceCompleteness:'COMPLETE',terminalObserved:true,closure:'TERMINAL_VALIDATED',future:0,pending:0,seekRemoval:79});t.terminalReasons.SEEK=79;
 t.temporal.forwarded-=79;t.temporal.explicitRemoval+=79;
 const current=structuredClone(old);current.state='OPEN';current.epoch=1;current.archivedAttribution={};
 x.accounting.diagnosticScope.scopes.push(current);x.accounting.diagnosticScope.epoch=1;
 const tr=x.shadow.initialAuthorityTrace;const last=tr.rows.at(-1);Object.assign(last,{epoch:1,lifecycle:0,phase:'READING'});
 Object.assign(tr.rows.at(-2),{step:'CONTROL_TRANSITION',event:'SEEK_STARTED',lifecycle:0,epoch:0});
 return {x,before,t};
}
test('closed old attribution independent of OPEN current ledger',()=>{
 const {x,before}=transitioned();const out=mapDiagnostics(x,{before});assert.equal(out.adapterStatus,'READY');assert.equal(out.temporalSeekRemoval,79);assert.equal(out.schedulerLifecycleRemoval,0);assert.equal(out.actualSeekObserved,true);assert.equal(out.oldScopeClosed,true);
});
for(const name of ['missing','identity','fault','contentGap','ringGap','scopeIncomplete','scopeGap','ack','pendingClearMissing','conservation','wrongLifecycle','ownership','mismatch','archiveFault']){
 test('fail closed: '+name,()=>{const x=good();
  if(name==='missing')delete x.shadow;
  if(name==='identity')x.shadow.initialRequestDispatch.content.identity.sourceSHA='old';
  if(name==='fault')x.shadow.initialAuthorityTrace.collectorFault=true;
  if(name==='contentGap')x.shadow.initialRequestDispatch.content.rows[2].sequence=99;
  if(name==='ringGap')x.shadow.initialAuthorityTrace.rows[2].sequence=99;
  if(name==='scopeIncomplete')x.accounting.diagnosticScope.incomplete=true;
  if(name==='scopeGap')x.accounting.diagnosticScope.scopes[0].buffered=1;
  if(name==='ack')x.accounting.pendingClear.pendingOperations=1;
  if(name==='pendingClearMissing')delete x.accounting.pendingClear;
  if(name==='conservation')x.accounting.stages.scheduler.input++;
  if(name==='wrongLifecycle')x.accounting.diagnosticScope.scopes[0].lifecycle=10;
  if(name==='ownership')delete x.restart.ownedFrameConnected;
  if(name==='mismatch')x.shadow.mismatchCount=1;
  if(name==='archiveFault')x.shadow.initialAuthorityTrace.criticalArchive.fault=true;
  assert.equal(mapDiagnostics(x).adapterStatus,'BLOCKED');
 });
}
for(const name of ['missingOld','sequence','seekReason','retained','loss','incomplete'])test('old archive rejection: '+name,()=>{
 const {x,before,t}=transitioned();
 if(name==='missingOld')x.accounting.diagnosticScope.scopes.shift();
 if(name==='sequence')t.sequence++;
 if(name==='seekReason')t.terminalReasons.SEEK--;
 if(name==='retained')t.pending=1;
 if(name==='loss')t.lostUnaccounted=1;
 if(name==='incomplete')t.sequenceCompleteness='INCOMPLETE';
 assert.equal(mapDiagnostics(x,{before}).adapterStatus,'BLOCKED');
});
test('stale document cannot be joined',()=>{const x=good();const before=mapDiagnostics(x);x.documentTimeOrigin++;assert.equal(mapDiagnostics(x,{before}).adapterBoundary,'STALE_DOCUMENT');});
for(const [field,boundary] of [['missing','SCOPE_EXPORT_MISSING'],['epoch','SCOPE_EPOCH_INVALID'],['list','SCOPE_LIST_MISSING'],['capacity','SCOPE_CAPACITY'],['entry','SCOPE_ENTRY_INVALID'],['duplicate','SCOPE_DUPLICATE_EPOCH'],['flag','SCOPE_INCOMPLETE_FLAG'],['discarded','SCOPE_DISCARDED_OR_UNKNOWN']])test('exact scope guard: '+field,()=>{
 const x=good(),ds=x.accounting.diagnosticScope;
 if(field==='missing')delete x.accounting.diagnosticScope;
 if(field==='epoch')delete ds.epoch;
 if(field==='list')delete ds.scopes;
 if(field==='capacity')ds.scopes=Array.from({length:10},()=>({}));
 if(field==='entry')ds.scopes=[null];
 if(field==='duplicate')ds.scopes.push({...ds.scopes[0]});
 if(field==='flag')ds.incomplete=true;
 if(field==='discarded')ds.discardedIncomplete=1;
 const out=mapDiagnostics(x);assert.equal(out.adapterBoundary,boundary);assert.equal(out.evidence.loss,0);
});
test('timeout / rejected read / detached are bounded fixed enums',async()=>{
 for(const evaluate of [async()=>{throw Error('PRIVATE_TOKEN');},()=>new Promise(()=>{})]){
  const out=await createDiagnosticCapture({expected:EXPECTED})({isClosed:()=>false,evaluate},{phase:'PRE',timeoutMs:5});assert.equal(out.adapterBoundary,'READ_REJECTED_OR_TIMEOUT');assert.doesNotMatch(JSON.stringify(out),/PRIVATE/);
 }
 assert.equal((await createDiagnosticCapture({expected:EXPECTED})({isClosed:()=>true},{phase:'PRE',timeoutMs:5})).adapterBoundary,'DETACHED_TAB');
});
test('read callback is read-only and anonymous normalized output',async()=>{
 const x=good();x.token='PRIVATE_TOKEN';x.comments=['PRIVATE_COMMENT'];
 const out=await createDiagnosticCapture({expected:EXPECTED})({isClosed:()=>false,evaluate:async fn=>{assert.equal(fn,readDiagnosticPage);return x;}},{phase:'PRE',timeoutMs:50});
 assert.equal(out.adapterStatus,'READY');assert.doesNotMatch(JSON.stringify(out),/PRIVATE|comments|token|rows/);
 assert.doesNotMatch(readDiagnosticPage.toString(),/postMessage|fetch\(|\.play\(|\.pause\(|location\s*=|addEventListener|setInterval/);
});
test('adapter missing evidence prevents runner action',async()=>{
 let actions=0;const page={isClosed:()=>false,evaluate:async()=>evidence,locator:()=>{actions++;throw Error();}};
 const r=await runSeekScenario(page,{expected:EXPECTED,packet:'adapter-negative',acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',approval:{packet:'adapter-negative',acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',scenario:SCENARIO,maxActions:1,deltaSeconds:30,documentKey:String(evidence.documentTimeOrigin)},ready:{packet:'adapter-negative',foregroundExclusive:true,documentKey:String(evidence.documentTimeOrigin)},capture:createDiagnosticCapture({expected:EXPECTED})});
 assert.equal(r.status,'BLOCKED');assert.equal(actions,0);
});
test('actual read callback preserves status receiver and invokes only existing getters',()=>{
 const calls=[];const names=['LiveFlowReplayControlPlaneShadowDiagnostic','LiveFlowReplayAccountingDiagnostic','LiveFlowReplayPipelineDiagnostic','LiveFlowReplayProductionReanchorDiagnostic','LiveFlowReplayRestartDiagnostic'];
 const window={};for(const n of names){window[n]={status(){assert.equal(this,window[n]);calls.push(n);return {};}};}
 const context=vm.createContext({window,performance:{timeOrigin:1},document:{visibilityState:'visible',querySelector:()=>({querySelector:()=>({currentTime:1,duration:100})}),getElementById:()=>({firstChild:{textContent:'DEV D / '+EXPECTED.prefix+' '}})}});
 const out=vm.runInContext('('+readDiagnosticPage.toString()+')()',context);assert.deepEqual(calls,names);assert.equal(out.media.duration,100);
});
test('runner connected to real-field adapter uses one seek and anonymous reason counts',async()=>{
 const x=good();x.accounting.stages.scheduler.retained=3;x.accounting.stages.scheduler.input+=3;x.accounting.schedulerRetained=3;x.pipeline.pendingCurrent=3;
 const post=structuredClone(x), before=mapDiagnostics(x), old=post.accounting.diagnosticScope.scopes[0],t=old.archivedAttribution;
 old.state='CLOSED';Object.assign(t,{state:'CLOSED',sequenceCompleteness:'COMPLETE',terminalObserved:true,closure:'TERMINAL_VALIDATED',future:0,pending:0,seekRemoval:79});t.terminalReasons.SEEK=79;t.temporal.forwarded-=79;t.temporal.explicitRemoval+=79;
 // Synthetic three queued Scheduler entries become three actual lifecycle removals.
 t.scheduler.input+=3;t.scheduler.explicitRemoval+=3;t.schedulerReasons.lifecycle=3;
 const current=structuredClone(old);current.state='OPEN';current.epoch=1;post.accounting.diagnosticScope.scopes.push(current);post.accounting.diagnosticScope.epoch=1;
 Object.assign(post.shadow.initialAuthorityTrace.rows.at(-1),{epoch:1,lifecycle:0,phase:'READING'});
 Object.assign(post.shadow.initialAuthorityTrace.rows.at(-2),{step:'CONTROL_TRANSITION',event:'SEEK_STARTED',lifecycle:0,epoch:0});
 let reads=0,clicks=0;
 const page={isClosed:()=>false,evaluate:async code=>{reads++;return typeof code==='string'?{last:mapDiagnostics(structuredClone(post),{before}),observation:{reason:'COMPLETE',events:0,captures:1,cleanup:true,snapshots:[]}}:structuredClone(x);},locator:()=>({count:async()=>1,isVisible:async()=>true,boundingBox:async()=>({width:1000,height:10}),click:async()=>{clicks++;}})};
 const packet='adapter-positive';const r=await runSeekScenario(page,{expected:EXPECTED,packet,acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',approval:{packet,acceptanceScope:'SEEK_DUAL_NONZERO_ATTRIBUTION',scenario:SCENARIO,maxActions:1,deltaSeconds:30,documentKey:before.documentKey},ready:{packet,documentKey:before.documentKey,foregroundExclusive:true},capture:createDiagnosticCapture({expected:EXPECTED})});
 assert.equal(r.status,'SCENARIO_EVIDENCE_COMPLETE');assert.equal(clicks,1);assert.equal(r.post.temporalSeekRemoval,79);assert.equal(r.post.schedulerLifecycleRemoval,3);assert.equal(r.runtimeSeekPass,false);
});
