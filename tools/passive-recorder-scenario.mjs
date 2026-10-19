import {randomBytes} from 'node:crypto';
import {bindExpectedIdentity, retainedFacts} from './hybrid-seek-scenario.mjs';
import {mapPassiveDiagnostics, readDiagnosticPage, readPassiveDiagnosticPage, passiveObservationExpression} from './hybrid-diagnostic-adapter.mjs';

export const PASSIVE_OPERATION = 'PASSIVE_RECORDER_V1';
export const CLEANUP_CONFIRMATION_MS = 2000;
// Session-local latch: never discard an unresolved operation or reload to bypass it.
const unresolved = new WeakSet();
const attempted = new Set();

async function timed(task, ms) {
    let timer;
    try { return await Promise.race([task(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error()),ms);})]); }
    finally {clearTimeout(timer);}
}

export function createPassiveCapture({expected:requested}={}) {
    const expected=bindExpectedIdentity(requested);
    const capture=async(page,{before}={})=>{
        if(!expected)return {adapterStatus:'BLOCKED',adapterBoundary:'EXPECTED_IDENTITY_INVALID'};
        const raw=await timed(()=>page.evaluate(`(()=>{const readDiagnosticPage=${readDiagnosticPage};return (${readPassiveDiagnosticPage})();})()`),2000);
        return mapPassiveDiagnostics(raw,{expected,before});
    };
    capture.observe=(page,{before,operationId,capability,instanceId,durationMs,deadlineAt})=>page.evaluate(passiveObservationExpression({expected,before,operationId,capability,instanceId,durationMs,deadlineAt}));
    Object.defineProperty(capture,'expectedIdentity',{value:expected});
    return capture;
}

// Temporary diagnostic request listener; actual cleanup belongs to the Recorder.
export function recorderCommandPage(command) {
    return new Promise(resolve=>{
        let done=false,timer;
        const finish=result=>{if(done)return;done=true;window.removeEventListener('message',listener);clearTimeout(timer);resolve(result);};
        const listener=e=>{
            const d=e.data;
            if(e.source===window&&e.origin===location.origin&&d?.type==='LIVEFLOW_DEV_OWNED_RECORDER_V1_ACK'&&
                d.requestId===command.requestId&&d.operationId===command.operationId&&d.capability===command.capability&&
                (command.command==='INFO'||d.instanceId===command.instanceId))finish(d.result);
        };
        if(String(performance.timeOrigin)!==command.documentKey){finish({state:'CLEANUP_UNKNOWN'});return;}
        window.addEventListener('message',listener);
        timer=setTimeout(()=>finish({state:'CLEANUP_UNKNOWN'}),1900);
        try{window.postMessage(command,location.origin);}catch{finish({state:'CLEANUP_UNKNOWN'});}
    });
}

export function createRecorderTransport(page,{expected,documentKey,operationId}) {
    const capability=randomBytes(16).toString('hex');let sequence=0,instanceId;
    const command=(kind,extra={})=>page.evaluate(recorderCommandPage,{type:'LIVEFLOW_DEV_OWNED_RECORDER_V1',
        command:kind,operationId,capability,instanceId,documentKey,requestId:'r'+ ++sequence,...extra});
    return {qualify:async()=>{const r=await command('INFO',{expected});if(/^[a-f0-9]{32}$/.test(r?.instanceId??''))instanceId=r.instanceId;return r;},
        start:()=>command('START',{expected,qualified:true}),stop:reason=>command('STOP',{reason}),release:()=>command('RELEASE'),
        evidence:()=>command('EVIDENCE'),unknown:()=>command('UNKNOWN'),capability,get instanceId(){return instanceId;}};
}

export async function runPassiveRecorderScenario(page,{packet,expected:requested,ready,approval,capture,transportFactory=createRecorderTransport,durationMs=8000,signal}={}) {
    const expected=bindExpectedIdentity(requested);
    const result={operation:PASSIVE_OPERATION,expectedIdentity:expected||'UNKNOWN',observationLimitMs:10000,cleanupConfirmationLimitMs:CLEANUP_CONFIRMATION_MS,
        status:'BLOCKED',firstBadBoundary:null,captureExecution:'NOT_RUN',cleanup:'NOT_RUN',
        recorderCleanup:'NOT_RUN',observerCleanup:'NOT_RUN',
        evidenceQualification:'NOT_PROVEN',densityComparison:'NOT_PROVEN',humanAcceptance:'PENDING',pre:null,post:null,
        recorder:null,resourcesConfirmed:false,prohibitedActions:0,browserReleased:false};
    let transport,started=false,cancelled=false,onAbort,stopPromise,releasePromise,cleanupDeadline,recorderConfirmed=false;
    const stop=reason=>{
        if(stopPromise)return stopPromise;
        cleanupDeadline=Date.now()+CLEANUP_CONFIRMATION_MS;
        return stopPromise=transport?timed(()=>transport.stop(reason),CLEANUP_CONFIRMATION_MS):Promise.resolve(null);
    };
    const retire=()=>releasePromise??=(async()=>{
        const remaining=cleanupDeadline-Date.now();
        if(remaining<=0||(await timed(()=>transport.release(),remaining))?.released!==true)throw Error();
    })();
    const facts=s=>s?.evidence?retainedFacts(s.evidence):'UNKNOWN';
    try {
        const descriptor=typeof capture==='function'?Object.getOwnPropertyDescriptor(capture,'expectedIdentity'):null;
        if(!expected||!descriptor||!('value' in descriptor)||JSON.stringify(expected)!==JSON.stringify(bindExpectedIdentity(descriptor.value))) {result.firstBadBoundary='EXPECTED_CAPTURE_MISMATCH';return result;}
        if(typeof packet!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(packet)||attempted.size>=128||attempted.has(packet)||approval?.packet!==packet||approval?.operation!==PASSIVE_OPERATION||approval?.recorder!==true||
            ready?.packet!==packet||ready?.foregroundExclusive!==true||!approval.documentKey||approval.documentKey!==ready.documentKey||
            !Number.isInteger(durationMs)||durationMs<1||durationMs>9000||signal?.aborted) {result.firstBadBoundary='NOT_AUTHORIZED';return result;}
        if(!page||page.isClosed()||unresolved.has(page)){result.firstBadBoundary='DETACHED_OR_UNRESOLVED_CLEANUP';return result;}
        const pre=await timed(()=>capture(page),2000);result.pre=facts(pre);
        if(pre.adapterStatus!=='READY'||pre.operation!==PASSIVE_OPERATION||pre.documentKey!==approval.documentKey){result.firstBadBoundary=pre.adapterBoundary||'DOCUMENT';return result;}
        transport=transportFactory(page,{expected,documentKey:pre.documentKey,operationId:packet});
        const protocol=typeof transport.qualify==='function'?await timed(()=>transport.qualify(),2000):null;
        if(protocol?.profile!=='OWNED_RECORDER_V1'||protocol.expectedMatch!==true||protocol.available!==true||protocol.maxObservationMs!==10000||
            typeof protocol.instanceId!=='string'||!/^[a-f0-9]{32}$/.test(protocol.instanceId)||transport.instanceId!==protocol.instanceId){result.firstBadBoundary='RECORDER_LIFECYCLE_UNAVAILABLE';return result;}
        const gate=await timed(()=>capture(page,{before:pre}),2000);result.post=facts(gate);
        if(gate.adapterStatus!=='READY'){result.firstBadBoundary=gate.adapterBoundary;return result;}
        if(signal?.aborted||page.isClosed()){result.firstBadBoundary='CANCELLED_OR_DETACHED';return result;}
        attempted.add(packet);started=true; // Delivery uncertainty counts as attempted start.
        onAbort=()=>{cancelled=true;void stop('CANCELLED').catch(()=>{});};
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted)onAbort();
        if(cancelled){result.captureExecution='INVALID';result.firstBadBoundary='CANCELLED';return result;}
        const start=await timed(()=>transport.start(),2000);
        if(start?.status!=='STARTED'||typeof start.deadlineAt!=='number'||!Number.isFinite(start.deadlineAt)){result.firstBadBoundary='START_NOT_CONFIRMED';return result;}
        result.captureExecution='STARTED';
        if(cancelled){result.captureExecution='INVALID';result.firstBadBoundary='CANCELLED';return result;}
        result.observerCleanup='UNCONFIRMED';
        const observation=await timed(()=>capture.observe(page,{before:gate,operationId:packet,capability:transport.capability,instanceId:transport.instanceId,durationMs,deadlineAt:start.deadlineAt}),durationMs+500);
        result.observerCleanup=observation.cleanup===true?'PASS':'CLEANUP_UNKNOWN';
        result.post=facts(observation.last);
        const valid=!cancelled&&observation.reason==='NORMAL'&&observation.last?.adapterStatus==='READY'&&observation.last.mediaTime>gate.mediaTime&&observation.cleanup===true;
        result.captureExecution=valid?'PASS':'INVALID';
        result.firstBadBoundary=valid?null:observation.last?.adapterBoundary||observation.reason||'OBSERVATION';
        const ack=await stop(valid?'NORMAL':'INVALIDATED');
        if(ack?.stopConfirmed!==true||ack.resources!==0||ack.callbacks!==0){result.cleanup='CLEANUP_UNKNOWN';return result;}
        recorderConfirmed=true;result.recorderCleanup='PASS';result.resourcesConfirmed=true;
        if(result.observerCleanup!=='PASS'){result.cleanup='CLEANUP_UNKNOWN';return result;}
        await retire();
        if(ack.captureValid!==true){result.captureExecution='INVALID';result.firstBadBoundary??='OWNED_RECORDER_INVALIDATED';}
        if(valid&&!cancelled&&ack.captureValid===true){
            // No evidence retrieval after an invalidating gate; cleanup remains allowed.
            const exported=await timed(()=>transport.evidence(),2000);
            result.recorder=exported?.evidence??null;
            if(result.recorder?.finished===true&&result.recorder.fault===false&&result.recorder.truncated===false&&result.recorder.conditionsChanged===false){
                result.evidenceQualification='QUALIFIED_SAMPLED_ONLY';result.status='CAPTURE_PASS';
            } else {result.status='EVIDENCE_INCOMPLETE';}
        } else result.status='EVIDENCE_INCOMPLETE';
        return result;
    } catch {result.firstBadBoundary??='TRANSPORT_OR_DETACH';result.captureExecution=started?'INVALID':'NOT_RUN';return result;}
    finally {
        signal?.removeEventListener('abort',onAbort);
        if(started&&cancelled){
            result.captureExecution='INVALID';result.evidenceQualification='NOT_PROVEN';
            result.firstBadBoundary='CANCELLED';if(result.status==='CAPTURE_PASS')result.status='EVIDENCE_INCOMPLETE';
        }
        if(started&&!recorderConfirmed) {
            try {const ack=await stop('CANCELLED');
                if(ack?.stopConfirmed===true&&ack.resources===0&&ack.callbacks===0){recorderConfirmed=true;result.recorderCleanup='PASS';result.resourcesConfirmed=true;}
            } catch { /* No ACK is not proof of resource release. */ }
        }
        if(started) {
            if(recorderConfirmed&&['NOT_RUN','PASS'].includes(result.observerCleanup)){
                try{await retire();result.cleanup='PASS';}catch{result.cleanup='CLEANUP_UNKNOWN';}
            }else result.cleanup='CLEANUP_UNKNOWN';
            if(!recorderConfirmed)result.recorderCleanup='CLEANUP_UNKNOWN';
            if(result.cleanup!=='PASS'){unresolved.add(page);result.status='CLEANUP_UNKNOWN';}
        }
        result.browserReleased=true;
    }
}
