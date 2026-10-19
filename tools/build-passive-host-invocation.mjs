// Offline packaging for browser_run_code_unsafe's import-free function(page) VM.
import fs from 'node:fs';
import {bindExpectedIdentity} from './hybrid-seek-scenario.mjs';
const root=new URL('../',import.meta.url);
function body(file,imports) {
    let source=fs.readFileSync(new URL(file,root),'utf8');
    for(const line of imports){if(!source.includes(line))throw Error('Unsupported module import contract');source=source.replace(line,'');}
    source=source.replaceAll('export ','');
    if(/^import\s/m.test(source)||/\bimport\s*\(/.test(source))throw Error('Unbundled import');
    return source;
}
export function buildPassiveHostInvocation({packet,expected:input,ready,approval,durationMs=8000}={}) {
    const expected=bindExpectedIdentity(input);
    if(!expected||!/^[a-zA-Z0-9_-]{1,64}$/.test(packet??'')||ready?.packet!==packet||ready?.foregroundExclusive!==true||
        approval?.packet!==packet||approval?.operation!=='PASSIVE_RECORDER_V1'||approval?.recorder!==true||!Number.isInteger(durationMs)||durationMs<1||durationMs>9000)throw Error('Explicit operation authorization required');
    const seek=body('tools/hybrid-seek-scenario.mjs',[]);
    const adapter=body('tools/hybrid-diagnostic-adapter.mjs',["import { EXPECTED, bindExpectedIdentity } from './hybrid-seek-scenario.mjs';"]);
    const passive=body('tools/passive-recorder-scenario.mjs',["import {randomBytes} from 'node:crypto';","import {bindExpectedIdentity, retainedFacts} from './hybrid-seek-scenario.mjs';","import {mapPassiveDiagnostics, readDiagnosticPage, readPassiveDiagnosticPage, passiveObservationExpression} from './hybrid-diagnostic-adapter.mjs';"]);
    return `async(page)=>{
const seek=(()=>{${seek};return {EXPECTED,bindExpectedIdentity,retainedFacts};})();
const adapter=(()=>{const {EXPECTED,bindExpectedIdentity}=seek;${adapter};return {mapPassiveDiagnostics,readDiagnosticPage,readPassiveDiagnosticPage,passiveObservationExpression};})();
let entropy=null,used=false;
// Only the existing page interface is required; no host globals or import callback.
const randomBytes=n=>{if(n!==16||used||!entropy)throw Error();used=true;return {toString:format=>{if(format!=='hex')throw Error();return entropy;}};};
const passive=(()=>{const {bindExpectedIdentity,retainedFacts}=seek;const {mapPassiveDiagnostics,readDiagnosticPage,readPassiveDiagnosticPage,passiveObservationExpression}=adapter;${passive};return {createPassiveCapture,runPassiveRecorderScenario};})();
const expected=${JSON.stringify(expected)},packet=${JSON.stringify(packet)};
if(!page.url().startsWith("https://www.youtube.com/watch?"))return {status:'BLOCKED_BROWSER',firstBadBoundary:'TARGET_TAB',browserReleased:true};
const capture=passive.createPassiveCapture({expected}),pre=await capture(page);
if(pre.adapterStatus!=='READY')return {status:'EVIDENCE_INCOMPLETE',firstBadBoundary:pre.adapterBoundary,pre:seek.retainedFacts(pre.evidence),captureExecution:'NOT_RUN',browserReleased:true,prohibitedActions:0};
// Web Crypto allocates only diagnostic capability entropy, after identity qualification.
try{entropy=await page.evaluate(()=>Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''));}catch{return {status:'BLOCKED_BROWSER',firstBadBoundary:'ENTROPY_UNAVAILABLE',captureExecution:'NOT_RUN',browserReleased:true};}
if(typeof entropy!=='string'||!/^[a-f0-9]{32}$/.test(entropy))return {status:'BLOCKED_BROWSER',firstBadBoundary:'ENTROPY_UNAVAILABLE',browserReleased:true};
return await passive.runPassiveRecorderScenario(page,{packet,expected,capture,durationMs:${durationMs},ready:{packet,foregroundExclusive:true,documentKey:pre.documentKey},approval:{packet,operation:'PASSIVE_RECORDER_V1',recorder:true,documentKey:pre.documentKey}});
}`;
}
