import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {buildPassiveHostInvocation} from '../tools/build-passive-host-invocation.mjs';
import {mapPassiveDiagnostics} from '../tools/hybrid-diagnostic-adapter.mjs';
const expected={prefix:'2a5622665dc6',sourceSHA:'96a7b0dafdad3da7d22a0768fc9fc930792c21e5',commonBuildID:'96eecd1a5c3cb1bec56227a4aa1b49d833072adf532e532df9fb1e20629d6706'};
test('import-free page host reproduces old failure and executes explicit passive invocation',async()=>{
    const context=vm.createContext({setTimeout,clearTimeout});
    let reads=0,starts=0,stops=0,entropyReads=0;
    await assert.rejects(vm.runInContext('(async()=>{await import("node:crypto");})()',context),e=>e.code==='ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING');
    const packet='host_fixture',options={packet,expected,ready:{packet,foregroundExclusive:true},approval:{packet,operation:'PASSIVE_RECORDER_V1',recorder:true},durationMs:1};
    assert.throws(()=>buildPassiveHostInvocation({...options,expected:null}));
    const code=buildPassiveHostInvocation(options);assert.doesNotMatch(code,/\bimport\s*\(/);
    const invoke=vm.runInContext('('+code+')',context);
    const raw=JSON.parse(fs.readFileSync('test/fixtures/hybrid-diagnostic-reading.json'));
    raw.panel='DEV D / '+expected.prefix+' ';
    for(const t of [raw.shadow.initialAuthorityTrace,raw.shadow.initialRequestDispatch.content])t.identity={...expected};
    raw.shadow.shadowPhase='READING';raw.shadow.initialAuthorityTrace.rows.at(-1).phase='READING';
    raw.accounting.pendingClear={pendingOperations:0,fault:false};
    raw.reanchor={controlPhase:'READING',authorityState:'OBSERVED_UNUSED',authorityCurrent:true,lifecycleCurrent:true,revisionCurrent:true,targetCurrent:true,generationCurrent:true,inFlight:false,navigationPending:false,adActive:false,seekActive:false,mainContentOwnershipValid:true,playerTimingValid:true,visibility:'VISIBLE'};
    raw.restart={generationCurrent:true,frameRoleCurrent:true,ownedFrameConnected:true,sameSnapshotCurrent:true};
    raw.media={currentTime:10,duration:100};raw.passive={connected:true,paused:false,ended:false,seeking:false,readyState:4,geometry:{viewportWidth:100,viewportHeight:100,dpr:1,playerWidth:100,playerHeight:100,surfaceWidth:100,surfaceHeight:100}};
    const page={url:()=> 'https://www.youtube.com/watch?v=fixture',isClosed:()=>false,evaluate:async(fn,arg)=>{
        if(typeof fn==='function'&&String(fn).includes('getRandomValues')){entropyReads++;return 'a'.repeat(32);}
        if(typeof fn==='string'&&fn.includes('return (function observePassive')){const later=structuredClone(raw);later.media.currentTime=11;return {reason:'NORMAL',cleanup:true,last:mapPassiveDiagnostics(later,{expected})};}
        if(arg?.command){switch(arg.command){case 'INFO':return {profile:'OWNED_RECORDER_V1',expectedMatch:true,available:true,maxObservationMs:10000,instanceId:'b'.repeat(32)};case 'START':starts++;return {status:'STARTED',deadlineAt:10000};case 'STOP':stops++;return {stopConfirmed:true,resources:0,callbacks:0,captureValid:true};case 'RELEASE':return {released:true};case 'EVIDENCE':return {evidence:{finished:true,fault:false,truncated:false,conditionsChanged:false}};default:throw Error();}}
        reads++;return structuredClone(raw);
    }};
    const result=await invoke(page);assert.equal(result.status,'CAPTURE_PASS');assert.equal(result.cleanup,'PASS');assert.equal(starts,1);assert.equal(stops,1);assert.equal(entropyReads,1);assert.ok(reads>=3);assert.equal(JSON.stringify(result).includes('a'.repeat(32)),false);
    raw.panel='INVALID';starts=0;entropyReads=0;
    const rejected=await vm.runInContext('('+code+')',context)(page);assert.equal(rejected.firstBadBoundary,'IDENTITY_MISSING');assert.equal(starts,0);assert.equal(entropyReads,0);
});
