// Offline preparation only. The injected host callback is never called by preparation.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {bindExpectedIdentity} from './hybrid-seek-scenario.mjs';
const root=new URL('../',import.meta.url),prepared=new WeakMap();
const digest=s=>createHash('sha256').update(s).digest('hex');
const failed=boundary=>Object.freeze({status:'OFFLINE_PREFLIGHT_FAILED',boundary,hostInvoked:false});

// Runs inside the existing page, after the reviewed read-only getters. No action APIs.
function projectReadOnly(raw,mapped) {
    const e=mapped.evidence,n=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:'UNKNOWN';
    const b=x=>typeof x==='boolean'?x:'UNKNOWN',en=(x,a)=>a.includes(x)?x:'UNKNOWN';
    const base={identity:e?.identity,recorderStart:0,browserReadSnapshots:1,retries:0,forbiddenActions:0,browserReleased:true};
    if(!e||e.identity.panel.candidate!=='D'||!['panel','main','content'].every(k=>e.identity[k].predicate==='PASS')||e.identity.documentCorrespondence!=='CURRENT_DOCUMENT_DOM_EXPORT')
        return {...base,status:'BLOCKED_IDENTITY',firstUnresolvedGate:mapped.adapterBoundary||'IDENTITY'};
    const a=raw.reanchor;
    if(!a||a.authorityCurrent!==true||a.lifecycleCurrent!==true||a.revisionCurrent!==true||a.targetCurrent!==true||a.generationCurrent!==true||!['OBSERVED_UNUSED','CONSUMED'].includes(a.authorityState))
        return {...base,status:'EVIDENCE_INCOMPLETE',firstUnresolvedGate:'AUTHORITY_CURRENTNESS',evidence:e};
    const desc=d=>!d?{kind:'MISSING',type:'UNKNOWN'}:{kind:'value'in d?'DATA':'ACCESSOR',type:'value'in d?(d.value===null?'null':typeof d.value):'UNKNOWN'};
    const cd=Object.getOwnPropertyDescriptor(window,'LiveFlowChatReadCore'),cv=cd&&'value'in cd?cd.value:null;
    const md=cv&&['object','function'].includes(typeof cv)?Object.getOwnPropertyDescriptor(cv,'canReevaluatePageLifecycle'):null;
    const init=raw.shadow?.chatReadCoreInitialization;
    const initStageNames=['CORE_ENTER','API_READY','COMMONJS_EXPORT_COMPLETED','WINDOW_PUBLICATION_COMPLETED','THREW','NOT_OBSERVED'];
    const surface=document.getElementById('liveflow-danmaku-surface'),sr=surface?.getBoundingClientRect();
    const nodes=surface?Array.from(surface.querySelectorAll('.liveflow-danmaku')).slice(0,256):[];
    const sample=nodes.slice(0,16).map(node=>{
        const r=node.getBoundingClientRect();let visible=true,cursor=node;
        for(let depth=0;cursor&&depth<8;depth++,cursor=cursor.parentElement){const s=getComputedStyle(cursor);if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0)visible=false;}
        return {connected:node.isConnected,styleVisible:visible,width:n(r.width),height:n(r.height),intersectsViewport:r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight,
            intersectsSurface:sr?r.right>sr.left&&r.bottom>sr.top&&r.left<sr.right&&r.top<sr.bottom:'UNKNOWN'};
    });
    const output=sample.some(s=>s.connected&&s.styleVisible&&s.width>0&&s.height>0&&s.intersectsViewport&&s.intersectsSurface===true);
    const pipe=raw.pipeline,counters=Object.fromEntries(['responsesObserved','messagesObserved','sequentialResponsesProcessed','bridgeInput','enqueued','pendingCurrent','launchAttempted','launchCommitted','launched','launchRejected','stalePruned','capacityDropped','emergencyPendingDropped','schedulerLifecycleDiscarded','schedulerStructuralDiscarded','geometryUnknown'].map(k=>[k,n(pipe?.[k])]));
    const allStages=e.stages&&Object.values(e.stages).length===10&&Object.values(e.stages).every(s=>s.valid===true&&s.lost===0&&s.overflow===0&&s.input===s.forwarded+s.explicitRemoval+s.retained);
    const corePresent=desc(cd).kind==='DATA'&&desc(md).type==='function';
    const good=mapped.adapterStatus==='READY'&&corePresent&&allStages&&output&&counters.messagesObserved>0&&counters.launched>0;
    return {...base,status:good?'RUNTIME_QUALIFIED':'EVIDENCE_INCOMPLETE',firstUnresolvedGate:good?null:mapped.adapterBoundary||(!corePresent?'CORE_API':!allStages?'ACCOUNTING':!output?'VISIBLE_GEOMETRY':'NONZERO_PROCESSING'),
        core:{binding:desc(cd),method:desc(md),stage:en(init?.stage,initStageNames),collectorFault:b(init?.collectorFault),methodCalls:0},
        acquisitionScheduler:counters,renderer:{surfacePresent:!!surface,surfaceConnected:surface?surface.isConnected:'UNKNOWN',surfaceWidth:n(sr?.width),surfaceHeight:n(sr?.height),domCountBounded:n(nodes.length),nodeCap:256,sampleCap:16,sample,geometricOutputObserved:output},
        evidence:e,accounting:{complete:b(raw.accounting?.accountingComplete),allTenStagesConserved:allStages,loss:n(raw.accounting?.lostUnaccounted),overflow:n(raw.accounting?.overflowUnaccounted)},
        qualification:{humanReportedVisible:'REPORTED',passiveRecorderReadiness:'NOT_EVALUATED',humanBDComparisonAcceptance:'PENDING',historicalMismatch5:'UNKNOWN',historicalLoss22:'UNKNOWN'}};
}

export function buildReadOnlyInvocation({expected:input,packet}={}) {
    const expected=bindExpectedIdentity(input);
    if(!expected||typeof packet!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(packet))throw Error('Invalid explicit contract');
    const seek=fs.readFileSync(new URL('tools/hybrid-seek-scenario.mjs',root),'utf8').replaceAll('export ','');
    const adapter=fs.readFileSync(new URL('tools/hybrid-diagnostic-adapter.mjs',root),'utf8').replace("import { EXPECTED, bindExpectedIdentity } from './hybrid-seek-scenario.mjs';",'').replaceAll('export ','');
    if(/\bimport\s*(?:\(|\{)/.test(seek+adapter))throw Error('Unbundled import');
    // The adapter and projection have separate lexical scopes; never append declarations to adapter scope.
    const expression=`(()=>{const api=(()=>{const seek=(()=>{${seek};return {EXPECTED,bindExpectedIdentity};})();const {EXPECTED,bindExpectedIdentity}=seek;${adapter};return {readPassiveDiagnosticPage,mapPassiveDiagnostics};})();const raw=api.readPassiveDiagnosticPage();return (${projectReadOnly})(raw,api.mapPassiveDiagnostics(raw,{expected:${JSON.stringify(expected)}}));})()`;
    const code=`async(page)=>{if(!page.url().startsWith('https://www.youtube.com/watch?'))return {status:'BLOCKED_BROWSER',firstUnresolvedGate:'TARGET_TAB',browserReleased:true};return await page.evaluate(${JSON.stringify(expression)});}`;
    return Object.freeze({code,expression});
}

export function prepareInvocation({filename,expected,packet,build=buildReadOnlyInvocation}={}) {
    try {
        if(!bindExpectedIdentity(expected)||typeof packet!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(packet)||typeof filename!=='string'||!filename) return failed('CONTRACT');
        const artifact=build({expected,packet});
        if(typeof artifact?.code!=='string'||!artifact.code.trim()||typeof artifact.expression!=='string'||!artifact.expression.trim())return failed('EMPTY_GENERATION');
        new vm.Script('('+artifact.code+')');new vm.Script(artifact.expression);
        const target=path.resolve(filename);
        fs.writeFileSync(target,artifact.code,{encoding:'utf8',flag:'wx'}); // Never replace an existing artifact.
        const actual=fs.readFileSync(target,'utf8');
        if(!actual.trim()||actual!==artifact.code)return failed('ARTIFACT_MISMATCH');
        const result=Object.freeze({status:'READY',filename:target,sha256:digest(actual),packet});
        prepared.set(result,{target,source:actual,used:false,packet});return result;
    } catch {return failed('GENERATION_OR_VALIDATION');}
}

// Future callers must use this gate, not unconditionally call a host filename tool.
export async function invokePrepared(receipt,{invoke,authorization}={}) {
    const record=prepared.get(receipt);
    if(!record||record.used||authorization?.packet!==record.packet||authorization?.readOnly!==true||authorization?.foregroundExclusive!==true||typeof invoke!=='function')return failed('UNQUALIFIED_OR_UNAUTHORIZED');
    let source;
    try {
        source=fs.readFileSync(record.target,'utf8');
        if(!source.trim()||source!==record.source||digest(source)!==receipt.sha256)return failed('ARTIFACT_CHANGED');
        new vm.Script('('+source+')');
    }catch{return failed('ARTIFACT_UNAVAILABLE');}
    record.used=true; // Delivery uncertainty consumes the one attempt; never retry.
    // Send the verified bytes, not a path that could disappear/change after validation.
    return await invoke({code:source});
}
