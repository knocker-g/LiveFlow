import { EXPECTED, bindExpectedIdentity } from './hybrid-seek-scenario.mjs';
const count = n => Number.isSafeInteger(n) && n >= 0;
const stageNames = ['parser','classification','temporal','dueBridge','future','bridge','pending','scheduler','launch','renderer'];
const conserved = s => s && ['input','forwarded','explicitRemoval','retained','lost','overflow'].every(k=>count(s[k])) &&
    s.valid === true && s.lost === 0 && s.overflow === 0 && s.input === s.forwarded + s.explicitRemoval + s.retained;
const contiguous = t => t && t.collectorFault === false && t.truncated === false && Array.isArray(t.rows) && t.rows.length > 0 &&
    t.rows.length <= 256 && t.rows.length === t.total && t.rows.every((r,i)=>r.sequence === i+1);
const ringValid = t => t && t.collectorFault === false && Array.isArray(t.rows) && t.rows.length > 0 && t.rows.length <= 256 &&
    count(t.total) && t.rows.at(-1).sequence === t.total && t.rows.every((r,i)=>r.sequence === t.total-t.rows.length+i+1) &&
    (t.truncated === false && t.rows[0].sequence === 1 || t.truncated === true && t.rows.length === 256);

// Exact generated panel grammar; neither candidate nor prefix comes from expected.
export function parsePanelIdentity(panel, facts) {
    if(typeof panel!=='string'||panel.length>64)return null;
    if(facts&&(facts.ownerDocumentMatch===false||('matches' in facts&&facts.matches!==1)))return null;
    const match=/^DEV ([BD]) \/ ([a-f0-9]{12})[ \t]*$/.exec(panel);
    return match?{candidate:match[1],prefix:match[2]}:null;
}

// Fixed-shape diagnostics, including failures. No arbitrary keys or enum text.
export function incompleteEvidence(raw, expected = EXPECTED) {
    const n=x=>count(x)?x:'UNKNOWN', b=x=>typeof x==='boolean'?x:'UNKNOWN';
    const e=(x,values)=>values.includes(x)?x:'UNKNOWN';
    const a=raw?.accounting, ds=a?.diagnosticScope, tr=raw?.shadow?.initialAuthorityTrace;
    const trIdentity=tr?.identity, content=raw?.shadow?.initialRequestDispatch?.content;
    const datasetIdentity=raw?.readFacts?.dataset?.identity;
    const contentIdentity=content?.identity;
    const panelIdentity=parsePanelIdentity(raw?.panel,raw?.readFacts?.panel),prefix=panelIdentity?.prefix;
    const predicate=(present,valid,match)=>present===false?'MISSING':present!==true?'UNKNOWN':valid===false?'INVALID':valid!==true?'UNKNOWN':match===true?'PASS':match===false?'MISMATCH':'UNKNOWN';
    const identity=(x,observable=true)=>{const present=observable?x!=null:'UNKNOWN',valid=typeof x?.sourceSHA==='string'&&/^[a-f0-9]{40}$/.test(x.sourceSHA)&&typeof x?.commonBuildID==='string'&&/^[a-f0-9]{64}$/.test(x.commonBuildID);const match=valid?x.sourceSHA===expected.sourceSHA&&x.commonBuildID===expected.commonBuildID:'UNKNOWN';return {present,expectedMatch:match,predicate:predicate(present,valid,match)};};
    const phases=['READING','REANCHORING','STOPPED','SUSPENDED','BOOTSTRAPPING','BUFFER_PAUSED'];
    const events=('LIFECYCLE_START BOOTSTRAP_AUTHORIZED BOOTSTRAP_SUCCEEDED BOOTSTRAP_FAILED SEQUENTIAL_AUTHORIZED SEQUENTIAL_SUCCEEDED SEQUENTIAL_FAILED INITIAL_ALIGNMENT_REQUIRED SEEK_STARTED SEEK_COMPLETED HIDDEN_ENTER VISIBLE_ENTER AD_ENTER AD_EXIT_READY MEDIA_PAUSE MEDIA_PLAY PLAYBACK_RATE_CHANGED BUFFER_HIGH_WATERMARK BUFFER_LOW_WATERMARK EARLY_RESUME_ELIGIBLE EARLY_RESUME_AUTHORIZED EARLY_RESUME_COMPLETED REANCHOR_AUTHORIZED REANCHOR_SUCCEEDED REANCHOR_FAILED DISABLE GENERATION_INVALIDATED TARGET_REPLACED TARGET_CHANGED CAPABILITY_LOST').split(' ');
    const paths=['BOOTSTRAP','SEQUENTIAL','REANCHOR','LEGACY_IMPLICIT_BOOTSTRAP','RAW_DEFERRED_START_PATH'];
    const row=x=>x&&typeof x==='object'?{sequence:n(x.sequence),step:e(x.step,['SHADOW_DISPATCH','SHADOW_CAPABILITY','CONTROL_TRANSITION']),type:e(x.mismatch,['PHASE_MISMATCH','FORBIDDEN_LEGACY_TRANSITION','CAPABILITY_PATH_MISMATCH']),event:e(x.event,events),path:e(x.path,paths),lifecycle:n(x.lifecycle),epoch:n(x.epoch),beforePhase:e(x.beforePhase,phases),afterPhase:e(x.afterPhase,phases),failure:e(x.failure,['NONE','FORBIDDEN_EVENT','AUTHORITY_FAILURE','CAPABILITY_REQUIRED_UNAVAILABLE']),mismatchDelta:n(x.mismatchDelta)}:'UNKNOWN';
    const rows=Array.isArray(tr?.rows)?tr.rows.slice(-256):null;
    const history=rows?.filter(x=>['SHADOW_DISPATCH','SHADOW_CAPABILITY'].includes(x.step)&&count(x.mismatchDelta)&&x.mismatchDelta>0).slice(-8).map(row);
    const facts=raw?.readFacts;
    const getter=x=>({present:b(x?.present),statusPresent:b(x?.statusPresent),classification:e(x?.classification,['MISSING','ACCESSOR','INVALID','THREW','OK']),statusType:e(x?.statusType,['OBJECT','NULL','OTHER','UNKNOWN'])});
    const first=tr?.firstMismatch;
    const shadowCount=raw?.shadow?.mismatchCount;
    return {authority:{state:e(raw?.reanchor?.authorityState,['OBSERVED_UNUSED','CONSUMED','INVALID']),available:b(raw?.reanchor?.authorityAvailable),current:b(raw?.reanchor?.authorityCurrent),lifecycleCurrent:b(raw?.reanchor?.lifecycleCurrent),revisionCurrent:b(raw?.reanchor?.revisionCurrent),targetCurrent:b(raw?.reanchor?.targetCurrent),generationCurrent:b(raw?.reanchor?.generationCurrent),requestInFlight:b(raw?.reanchor?.requestInFlight)},identity:{panel:{candidate:e(panelIdentity?.candidate,['B','D']),matches:n(raw?.readFacts?.panel?.matches),exists:b(facts?.panel?.exists),ownerDocumentMatch:b(facts?.panel?.ownerDocumentMatch),patternMatch:typeof raw?.panel==='string'?Boolean(prefix):'UNKNOWN',expectedMatch:prefix?prefix===expected.prefix:'UNKNOWN',predicate:predicate(raw?.panel!=null,Boolean(prefix),prefix?prefix===expected.prefix:'UNKNOWN')},main:{...identity(trIdentity,!facts||facts.getters?.shadow?.classification==='OK'),getter:getter(facts?.getters?.shadow)},content:{...identity(contentIdentity,!facts||facts.getters?.shadow?.classification==='OK')},datasetIdentity:{...identity(datasetIdentity,Boolean(facts)&&['VALID','MISSING'].includes(facts.dataset?.parse)),datasetPresent:b(facts?.dataset?.present),withinLimit:b(facts?.dataset?.withinLimit),parse:e(facts?.dataset?.parse,['VALID','INVALID','OVERSIZE','MISSING','UNKNOWN']),provenance:!facts||!['VALID','MISSING'].includes(facts.dataset?.parse)?'UNKNOWN':!datasetIdentity?'MISSING':!trIdentity?'UNKNOWN':datasetIdentity.sourceSHA===trIdentity.sourceSHA&&datasetIdentity.commonBuildID===trIdentity.commonBuildID?'MATCH_MAIN':'MISMATCH_MAIN'},validatedContentExport:{...identity(contentIdentity,!facts||facts.getters?.shadow?.classification==='OK'),provenance:!facts||facts.getters?.shadow?.classification==='OK'?(!contentIdentity?'MISSING':!trIdentity?'UNKNOWN':contentIdentity.sourceSHA===trIdentity.sourceSHA&&contentIdentity.commonBuildID===trIdentity.commonBuildID?'MATCH_MAIN':'MISMATCH_MAIN'):'UNKNOWN',documentCorrespondence:e(raw?.shadow?.initialRequestDispatch?.documentCorrespondence,['CURRENT_DOCUMENT_DOM_EXPORT','NOT_OBSERVED','INCONCLUSIVE']),admission:facts&&facts.getters?.shadow?.classification!=='OK'?'UNKNOWN':!contentIdentity?'MISSING':contentIdentity.sourceSHA===expected.sourceSHA&&contentIdentity.commonBuildID===expected.commonBuildID?'PASS':'MISMATCH'},documentCorrespondence:e(raw?.shadow?.initialRequestDispatch?.documentCorrespondence,['CURRENT_DOCUMENT_DOM_EXPORT','NOT_OBSERVED','INCONCLUSIVE'])},
        getterFacts:Object.fromEntries(['shadow','accounting','pipeline','reanchor','restart'].map(k=>[k,getter(facts?.getters?.[k])])),
        ownership:{mainContent:b(raw?.reanchor?.mainContentOwnershipValid),playerTiming:b(raw?.reanchor?.playerTimingValid),navigationPending:b(raw?.reanchor?.navigationPending),adActive:b(raw?.reanchor?.adActive),seekActive:b(raw?.reanchor?.seekActive),generationCurrent:b(raw?.restart?.generationCurrent),frameRoleCurrent:b(raw?.restart?.frameRoleCurrent),sameSnapshotCurrent:b(raw?.restart?.sameSnapshotCurrent)},
        pending:{temporal:n(a?.temporalPending),unclassified:n(a?.temporalUnclassified),due:n(a?.temporalDueAwaitingBridge),scheduler:n(a?.schedulerRetained)},
        control:{mismatchCount:n(shadowCount),transitionCount:n(raw?.shadow?.transitionCount),firstMismatch:row(first),context:row(first?.context),history:history??'UNKNOWN',historyStatus:!rows||!count(shadowCount)?'UNKNOWN':tr.truncated===true||rows.filter(x=>['SHADOW_DISPATCH','SHADOW_CAPABILITY'].includes(x.step)&&count(x.mismatchDelta)&&x.mismatchDelta>0).length>8||rows.filter(x=>['SHADOW_DISPATCH','SHADOW_CAPABILITY'].includes(x.step)&&count(x.mismatchDelta)).reduce((sum,x)=>sum+x.mismatchDelta,0)!==shadowCount?'HISTORY_INCOMPLETE':'AVAILABLE',earliestSequence:n(rows?.[0]?.sequence),latestSequence:n(rows?.at(-1)?.sequence),truncated:b(tr?.truncated),archive:{completeness:e(tr?.criticalArchive?.completeness,['COMPLETE','INCOMPLETE']),frozen:b(tr?.criticalArchive?.frozen),fault:b(tr?.criticalArchive?.fault),overflow:b(tr?.criticalArchive?.overflow)}},epoch:n(ds?.epoch),incomplete:b(ds?.incomplete),discarded:n(ds?.discardedIncomplete),
        phase:e(raw?.reanchor?.controlPhase,['READING','REANCHORING','STOPPED','SUSPENDED','BOOTSTRAPPING','BUFFER_PAUSED']),
        visibility:e(raw?.visibility,['visible','hidden']), mismatch:n(raw?.shadow?.mismatchCount),
        collectorFault:b(tr?.collectorFault), loss:n(a?.lostUnaccounted),overflow:n(a?.overflowUnaccounted),accountingComplete:b(a?.accountingComplete),
        ackPending:n(a?.pendingClear?.pendingOperations),ackFault:b(a?.pendingClear?.fault),
        seekObserved:Array.isArray(tr?.rows)&&tr.rows.some(x=>x.step==='CONTROL_TRANSITION'&&x.event==='SEEK_STARTED')?true:'UNKNOWN',
        stages:Object.fromEntries(stageNames.map(k=>[k,{valid:b(a?.stages?.[k]?.valid),...Object.fromEntries(['input','forwarded','explicitRemoval','retained','lost','overflow'].map(f=>[f,n(a?.stages?.[k]?.[f])]))}])),
        scopes:Array.isArray(ds?.scopes)?ds.scopes.slice(0,9).map(s=>{const t=s?.archivedAttribution;return {lifecycle:n(s?.lifecycle),epoch:n(s?.epoch),sequence:n(s?.sequence),buffered:n(s?.buffered),
            state:e(s?.state,['OPEN','CLOSED','INCOMPLETE']), closure:e(t?.closure,['NOT_CLOSED','TERMINAL_VALIDATED','TERMINAL_INVALID','INCOMPLETE']),
            sequenceCompleteness:e(t?.sequenceCompleteness,['OPEN','COMPLETE','INCOMPLETE']),terminalObserved:b(t?.terminalObserved),
            temporalSeek:n(t?.seekRemoval), schedulerLifecycle:n(t?.schedulerReasons?.lifecycle),retained:n(t?.pending),unclassified:n(t?.unclassified),pendingUnclassified:n(t?.pendingUnclassified),
            temporalReasons:Object.fromEntries(['HIDDEN','AD','NAVIGATION','SEEK','FAIL_CLOSED','READ_START_RESET','REANCHOR_REPLACED','NO_FRESH_CHAIN','USER_DISABLED','PAGEHIDE','MODE_TRANSITION','RATE_CHANGE','EXPLICIT','OTHER'].map(k=>[k,n(t?.terminalReasons?.[k])])),
            schedulerReasons:Object.fromEntries(['stale','capacity','emergency','lifecycle','structural'].map(k=>[k,n(t?.schedulerReasons?.[k])])),
            // Existing archive exposes temporal and scheduler only. Never copy
            // the current ledger into other old-stage slots.
            stages:Object.fromEntries(stageNames.map(k=>[k,{valid:b(t?.[k]?.valid),...Object.fromEntries(['input','forwarded','explicitRemoval','retained','lost','overflow'].map(f=>[f,n(t?.[k]?.[f])]))}])),
            closureReady:'UNKNOWN',ackApplicability:'UNKNOWN',
            accountingComplete:b(t?.accountingComplete),accountingValid:b(t?.accountingValid),loss:n(t?.lostUnaccounted),overflow:n(t?.overflowUnaccounted),fault:b(t?.collectorFault)};}):'UNKNOWN'};
}

// Pure mapper: never fills absent evidence with a successful default.
export function mapDiagnostics(raw, { expected = EXPECTED, before } = {}) {
    return mapQualifiedDiagnostics(raw, {expected,before}, false);
}

function mapQualifiedDiagnostics(raw, { expected, before }, passive) {
    const evidence=incompleteEvidence(raw, expected);
    const fail = boundary => ({ adapterStatus: 'BLOCKED', adapterBoundary: boundary, evidence: {...evidence, firstBadPredicate: boundary} });
    if (!raw || raw.readFault) return fail('MISSING_EXPORT_OR_REJECTED_READ');
    const sh=raw.shadow, tr=sh?.initialAuthorityTrace, dispatch=sh?.initialRequestDispatch, ct=dispatch?.content;
    const a=raw.accounting, ds=a?.diagnosticScope;
    const panelIdentity=parsePanelIdentity(raw.panel,raw.readFacts?.panel),prefix=panelIdentity?.prefix;
    if (!prefix || !tr?.identity || !ct?.identity) return fail('IDENTITY_MISSING');
    if (prefix !== expected.prefix || [tr.identity,ct.identity].some(x=>x.sourceSHA!==expected.sourceSHA || x.commonBuildID!==expected.commonBuildID)) return fail('IDENTITY_MISMATCH');
    if (!Number.isFinite(raw.documentTimeOrigin) || dispatch.documentCorrespondence!=='CURRENT_DOCUMENT_DOM_EXPORT' || dispatch.crossWorldOrdering!=='UNORDERED') return fail('DOCUMENT_UNPROVEN');
    const documentKey=String(raw.documentTimeOrigin);
    if (before && documentKey!==before.documentKey) return fail('STALE_DOCUMENT');
    if(!ds) return fail('SCOPE_EXPORT_MISSING');
    if(!count(ds.epoch))return fail('SCOPE_EPOCH_INVALID');
    if(!Array.isArray(ds.scopes))return fail('SCOPE_LIST_MISSING');
    if(ds.scopes.length>9)return fail('SCOPE_CAPACITY');
    if(ds.scopes.some(s=>!s||typeof s!=='object'))return fail('SCOPE_ENTRY_INVALID');
    if(new Set(ds.scopes.map(s=>s.epoch)).size!==ds.scopes.length)return fail('SCOPE_DUPLICATE_EPOCH');
    if(ds.incomplete!==false)return fail('SCOPE_INCOMPLETE_FLAG');
    if(ds.discardedIncomplete!==0)return fail('SCOPE_DISCARDED_OR_UNKNOWN');
    const scopes=ds.scopes.filter(s=>s.epoch===ds.epoch);
    if(scopes.length!==1) return fail('SCOPE_IDENTITY');
    const current=scopes[0];
    if (!count(current.lifecycle) || !count(current.sequence) || current.sequence<1 || current.state!=='OPEN' || current.buffered!==0) return fail('SCOPE_SEQUENCE');
    if(before && (current.lifecycle!==before.lifecycle || ds.epoch<before.epoch)) return fail('SCOPE_CHANGED');
    if(a.pendingClear?.pendingOperations!==0 || a.pendingClear?.fault!==false) return fail('ACK_UNRESOLVED_OR_MISSING');
    if(!ringValid(tr) || !contiguous(ct)) return fail('TRACE_SEQUENCE_OR_FAULT');
    const ar=tr.criticalArchive;
    if(ar?.capacity!==128 || ar.frozen!==true || ar.completeness!=='COMPLETE' || ar.fault!==false || ar.overflow!==false || !Array.isArray(ar.rows) || ar.rows.length>128 || ar.rows[0]?.step!=='TRACE_INSTALLED' ||
        ar.rows.some((r,i)=>!count(r.sequence)||r.sequence<1||(i>0&&r.sequence<=ar.rows[i-1].sequence))) return fail('ARCHIVE_INCOMPLETE');
    const latest=tr.rows.filter(r=>r.lifecycle===current.lifecycle && r.epoch===ds.epoch).at(-1);
    if(!latest || latest.phase!==raw.reanchor?.controlPhase) return fail('CURRENT_SCOPE_TRACE_MISSING');
    const r=raw.reanchor;
    if(!r || !(passive ? ['READING','BUFFER_PAUSED'] : ['READING']).includes(r.controlPhase) || sh.shadowPhase!==r.controlPhase) return fail('PHASE');
    if(sh.mismatchCount!==0 || tr.firstMismatch!==null) return fail('MISMATCH');
    // These are existing read-only diagnostic facts, not calls to Authority APIs.
    if(r.navigationPending!==false || r.adActive!==false || r.seekActive!==false || r.mainContentOwnershipValid!==true || r.playerTimingValid!==true ||
        raw.restart?.generationCurrent!==true || raw.restart?.frameRoleCurrent!==true || raw.restart?.ownedFrameConnected!==true || raw.restart?.sameSnapshotCurrent!==true) return fail('CURRENTNESS_OR_OWNERSHIP_UNPROVEN');
    if(raw.visibility!=='visible' || r.visibility!=='VISIBLE') return fail('HIDDEN');
    if(!stageNames.every(k=>conserved(a.stages?.[k])) || a.accountingComplete!==true || a.lostUnaccounted!==0 || a.overflowUnaccounted!==0) return fail('CANONICAL_ACCOUNTING');
    if(!count(a.temporalPending)||!count(a.temporalUnclassified)||!count(a.temporalDueAwaitingBridge)||!count(a.temporalPendingUnclassified)||a.temporalPendingUnclassified>a.temporalPending || !count(a.schedulerRetained) || a.schedulerRetained!==a.stages.scheduler.retained || raw.pipeline?.pendingCurrent!==a.schedulerRetained) return fail('PENDING_PUBLICATION');
    const out={ adapterStatus:'READY', adapterBoundary:null, main:{prefix,sourceSHA:tr.identity.sourceSHA,commonBuildID:tr.identity.commonBuildID},content:{prefix,sourceSHA:ct.identity.sourceSHA,commonBuildID:ct.identity.commonBuildID},documentKey,
        visibility:raw.visibility,phase:r.controlPhase,lifecycle:current.lifecycle,epoch:ds.epoch,diagnosticSequence:current.sequence,scopeComplete:true,
        authorityOK:true,currentnessOK:true,adActive:false,mismatch:0,fault:false,traceComplete:true,accountingComplete:true,conservation:true,loss:0,overflow:0,
        temporalPending:a.temporalPending+a.temporalUnclassified+a.temporalDueAwaitingBridge,schedulerPending:a.schedulerRetained,
        mediaTime:raw.media?.currentTime,duration:raw.media?.duration,
        pendingSource:'CANONICAL_PUBLISHED_NOT_DIRECT_RUNTIME', crossWorldOrdering:'UNORDERED',evidence };
    // A successful current scope cannot mask an incomplete/missing older archive.
    const old=ds.scopes.filter(s=>s.epoch!==ds.epoch);
    const closed=s=>s.state==='CLOSED' && s.buffered===0 && count(s.sequence) && s.sequence>0 && s.accountingValid===true &&
        s.archivedAttribution?.profile==='ARCHIVED_ATTRIBUTION_V1' && s.archivedAttribution.lifecycle===s.lifecycle && s.archivedAttribution.epoch===s.epoch && s.archivedAttribution.sequence===s.sequence &&
        s.archivedAttribution.sequenceCompleteness==='COMPLETE' && s.archivedAttribution.state==='CLOSED' && s.archivedAttribution.terminalObserved===true &&
        s.archivedAttribution.closure==='TERMINAL_VALIDATED' && s.archivedAttribution.collectorFault===false && s.archivedAttribution.accountingComplete===true && s.archivedAttribution.accountingValid===true &&
        s.archivedAttribution.lostUnaccounted===0 && s.archivedAttribution.overflowUnaccounted===0 && conserved(s.archivedAttribution.temporal) && conserved(s.archivedAttribution.scheduler);
    if(old.some(s=>!closed(s))) return fail('OLD_SCOPE_INCOMPLETE');
    if(before && ds.epoch!==before.epoch){
        const matching=old.filter(s=>s.epoch===before.epoch && s.lifecycle===before.lifecycle);
        if(matching.length!==1 || ds.epoch!==before.epoch+1) return fail('OLD_SCOPE_MISSING_OR_MULTIPLE_TRANSITIONS');
        const t=matching[0].archivedAttribution;
        if(!count(t.seekRemoval)||t.terminalReasons?.SEEK!==t.seekRemoval||!count(t.schedulerReasons?.lifecycle)||
            t.pending!==0||t.future!==0||t.unclassified!==0||t.pendingUnclassified!==0||t.dueAwaitingBridge!==0||t.temporal.retained!==0||t.scheduler.retained!==0) return fail('OLD_TERMINAL_ATTRIBUTION');
        const schedulerReasons=['stale','capacity','emergency','lifecycle','structural'].map(k=>t.schedulerReasons[k]);
        const temporalReasons=['HIDDEN','AD','NAVIGATION','SEEK','FAIL_CLOSED','READ_START_RESET','REANCHOR_REPLACED','NO_FRESH_CHAIN','USER_DISABLED','PAGEHIDE','MODE_TRANSITION','RATE_CHANGE','EXPLICIT','OTHER'].map(k=>t.terminalReasons[k]);
        if(!schedulerReasons.every(count)||schedulerReasons.reduce((x,y)=>x+y,0)!==t.scheduler.explicitRemoval || !temporalReasons.every(count)||temporalReasons.reduce((x,y)=>x+y,0)>t.temporal.explicitRemoval) return fail('OLD_REASON_ACCOUNTING');
        // Counts are copied from actual archived counters, never pre-pending subtraction.
        Object.assign(out,{oldScopeClosed:true,oldAttributionComplete:true,oldConservation:true,oldRetained:0,oldUnclassified:0,oldLoss:0,oldOverflow:0,
            temporalSeekRemoval:t.seekRemoval,schedulerLifecycleRemoval:t.schedulerReasons.lifecycle,
            actualSeekObserved:tr.rows.some(x=>x.step==='CONTROL_TRANSITION'&&x.event==='SEEK_STARTED'&&x.lifecycle===before.lifecycle&&x.epoch===before.epoch)});
    }
    return out;
}

// Pre-action, B-only opportunity wait. A publication is a signal, never queue
// authority. Its receiver-applied sequence must match the re-read current scope.
export function observeOpportunity({read,map,env,before,timeoutMs}) {
    return new Promise(resolve=>{
        let done=false,queued=false,timer,last,trigger=null,high=before.diagnosticSequence,events=0,captures=0;
        const start=env.now();let publication={match:'UNKNOWN',appliedSequence:'UNKNOWN',triggerSequence:'UNKNOWN',receiptAgeMs:'UNKNOWN'};
        const finish=reason=>{if(done)return;done=true;
            for(const type of ['message','visibilitychange','pagehide'])env.removeEventListener(type,onEvent,true);
            env.clearTimeout(timer);
            resolve({last:last??{adapterStatus:'BLOCKED',adapterBoundary:'READ_REJECTED_OR_TIMEOUT'},wait:{reason,events,captures,durationMs:Math.max(0,env.now()-start),cleanup:true,publication,
                freshnessLimit:'NO_PRODUCER_TIMESTAMP_OR_QUEUE_REVISION'}});
        };
        const capture=initial=>{
            queued=false;if(done)return;
            if(captures>=4){finish('CAPTURE_CAP');return;}
            try {
                last=map(read());captures++;
                if(last.adapterStatus!=='READY'||last.documentKey!==before.documentKey||last.lifecycle!==before.lifecycle||last.epoch!==before.epoch){finish('PREFLIGHT_FAILED');return;}
                const seq=last.diagnosticSequence;
                let matched=false;
                if(initial){matched=Number.isSafeInteger(seq)&&seq>before.diagnosticSequence;publication={match:matched?'INITIAL_NEW_SEQUENCE':'UNKNOWN',appliedSequence:seq,triggerSequence:'UNKNOWN',receiptAgeMs:'UNKNOWN'};}
                else if(trigger){matched=seq===trigger.sequence&&last.schedulerPending===trigger.pending;publication={match:matched?'MATCHED':'NOT_APPLIED_OR_SUPERSEDED',appliedSequence:seq,triggerSequence:trigger.sequence,receiptAgeMs:Math.max(0,env.now()-trigger.received),epoch:trigger.epoch,lifecycle:trigger.lifecycle};}
                if(Number.isSafeInteger(seq))high=Math.max(high,seq);
                if(matched&&last.temporalPending>0&&last.schedulerPending>0){finish('OPPORTUNITY');return;}
                if(captures>=4)finish('CAPTURE_CAP');
            }catch{finish('READ_FAULT');}
        };
        function onEvent(event){try{
            if(done)return;
            if(event.type==='pagehide'){finish('DETACHED');return;}
            if(event.type==='visibilitychange'){if(!queued){queued=true;env.queueMicrotask(()=>capture(false));}return;}
            if(event.source!==env.window||event.origin!==env.origin)return;
            const d=event.data;
            if(d?.source!=='liveflow-content-script'||d.type!=='LIVEFLOW_REPLAY_PIPELINE_DIAGNOSTIC')return;
            if(++events>=12){finish('EVENT_CAP');return;}
            if(d.pageLifecycleGeneration!==before.lifecycle||d.diagnosticScopeEpoch!==before.epoch||d.diagnosticTerminal!==false||d.diagnosticIncomplete!==false||
                !Number.isSafeInteger(d.diagnosticSequence)||d.diagnosticSequence<=high||!Number.isSafeInteger(d.scheduler?.pendingCurrent)||d.scheduler.pendingCurrent<0)return;
            high=d.diagnosticSequence;trigger={sequence:high,epoch:d.diagnosticScopeEpoch,lifecycle:d.pageLifecycleGeneration,pending:d.scheduler.pendingCurrent,received:env.now()};
            if(!queued){queued=true;env.queueMicrotask(()=>capture(false));}
        }catch{finish('READ_FAULT');}}
        try{
            for(const type of ['message','visibilitychange','pagehide'])env.addEventListener(type,onEvent,true);
            timer=env.setTimeout(()=>finish('DEADLINE'),Math.max(1,Math.min(5000,timeoutMs)));
            capture(true);
        }catch{finish('READ_FAULT');}
    });
}

// Sent to the existing page's MAIN execution world. Only existing status getters
// and DOM/media reads; no global writes, messages, listeners or Core action calls.
export function readDiagnosticPage() {
    const getters={};
    const status=(key,name)=>{
        const f=getters[key]={present:'UNKNOWN',statusPresent:'UNKNOWN',classification:'UNKNOWN',statusType:'UNKNOWN'};
        try{
            const d=Object.getOwnPropertyDescriptor(window,name);
            f.present=Boolean(d);if(!d){f.classification='MISSING';return null;}
            if(!('value' in d)){f.classification='ACCESSOR';return null;}
            const object=d.value,method=object&&Object.getOwnPropertyDescriptor(object,'status');
            f.statusPresent=Boolean(method);if(!method||!('value' in method)||typeof method.value!=='function'){f.classification='INVALID';return null;}
            const value=method.value.call(object);f.classification='OK';f.statusType=value===null?'NULL':typeof value==='object'?'OBJECT':'OTHER';
            return value;
        }catch{f.classification='THREW';return null;}
    };
    const panel=document.getElementById('liveflow-dev-comparison');
    let panelMatches='UNKNOWN';
    try{if(typeof document.querySelectorAll==='function')panelMatches=document.querySelectorAll('#liveflow-dev-comparison').length;}catch{ /* Evidence stays UNKNOWN. */ }
    const dataset={present:false,withinLimit:'UNKNOWN',parse:'MISSING'};
    try{const bytes=panel?.dataset?.initialRequestTrace;dataset.present=typeof bytes==='string'&&bytes.length>0;
        if(dataset.present){dataset.withinLimit=bytes.length<=65536;if(!dataset.withinLimit)dataset.parse='OVERSIZE';else{try{const parsed=JSON.parse(bytes);dataset.identity=parsed?.identity;dataset.parse='VALID';}catch{dataset.parse='INVALID';}}}
    }catch{dataset.present='UNKNOWN';dataset.parse='UNKNOWN';}
    const player=document.querySelector('ytd-watch-flexy #movie_player');
    const video=player?.querySelector('video.html5-main-video');
    const result={documentTimeOrigin:performance.timeOrigin,visibility:document.visibilityState,
        panel:panel?.firstChild?.textContent,
        shadow:status('shadow','LiveFlowReplayControlPlaneShadowDiagnostic'),accounting:status('accounting','LiveFlowReplayAccountingDiagnostic'),
        pipeline:status('pipeline','LiveFlowReplayPipelineDiagnostic'),reanchor:status('reanchor','LiveFlowReplayProductionReanchorDiagnostic'),restart:status('restart','LiveFlowReplayRestartDiagnostic'),
        media:{currentTime:video?.currentTime,duration:video?.duration},
        readFacts:{panel:{matches:panelMatches,exists:Boolean(panel),ownerDocumentMatch:panel?panel.ownerDocument===document:'UNKNOWN'},dataset,getters}};
    if(Object.values(getters).some(x=>x.classification==='THREW'))result.readFault=true;
    return result;
}

// POST only. Dependencies are explicit so the exact observer runs in a mock
// event loop and can also be serialized into the existing page MAIN world.
export function observePost({read,map,env,timeoutMs}) {
    return new Promise(resolve=>{
        const snapshots=[];let last,firstProvisional=null,events=0,captures=0,done=false,queued=false,timer;
        const finish=reason=>{if(done)return;done=true;
            for(const type of ['message','seeking','seeked','playing','pagehide'])env.removeEventListener(type,onEvent,true);
            env.clearTimeout(timer);
            resolve({last:last??{adapterStatus:'BLOCKED',adapterBoundary:'POST_NO_CAPTURE'},
                observation:{reason,events,captures,snapshots,firstProvisional,firstBadBoundary:snapshots.find(s=>s.adapterStatus==='BLOCKED')?.adapterBoundary??null,cleanup:true}});
        };
        const capture=()=>{queued=false;if(done)return;
            if(captures>=16){finish('CAPTURE_CAP');return;}
            try {
                const s=map(read());last=s;captures++;snapshots.push({adapterStatus:s.adapterStatus,adapterBoundary:s.adapterBoundary,evidence:s.evidence});
                const facts=s.evidence;
                const positive=x=>typeof x==='number'&&x>0;
                const scopes=Array.isArray(facts?.scopes)?facts.scopes:[];
                const terminal=x=>x.terminalObserved===true&&['TERMINAL_VALIDATED','TERMINAL_INVALID'].includes(x.closure);
                const provisional=scopes.find(x=>!terminal(x)&&(positive(x.loss)||positive(x.overflow)));
                if(provisional&&!firstProvisional)firstProvisional={classification:'PENDING_TERMINAL',epoch:provisional.epoch??'UNKNOWN',loss:provisional.loss??'UNKNOWN',overflow:provisional.overflow??'UNKNOWN',capture:captures};
                // A validated terminal loss is distinct from a provisional
                // counter imbalance. Neither value is corrected or suppressed.
                if(scopes.some(x=>terminal(x)&&(x.closure==='TERMINAL_INVALID'||positive(x.loss)||positive(x.overflow)))){finish('TERMINAL_FAILURE');return;}
                if(s.adapterStatus==='READY'&&s.oldScopeClosed===true&&s.oldAttributionComplete===true&&s.actualSeekObserved===true){finish('COMPLETE');return;}
                // Do not wait through a measured hard safety failure, even when
                // the mapper first stopped at the aggregate incomplete guard.
                if(facts?.visibility==='hidden'||['STOPPED','SUSPENDED'].includes(facts?.phase)||facts?.collectorFault===true||facts?.ackFault===true||
                    typeof facts?.mismatch==='number'&&facts.mismatch>0||typeof facts?.loss==='number'&&facts.loss>0||typeof facts?.overflow==='number'&&facts.overflow>0||
                    typeof facts?.discarded==='number'&&facts.discarded>0 || scopes.some(s=>s.fault===true) ||
                    ['IDENTITY_MISSING','IDENTITY_MISMATCH','STALE_DOCUMENT','DOCUMENT_UNPROVEN','MISSING_EXPORT_OR_REJECTED_READ'].includes(s.adapterBoundary)) {finish('HARD_FAILURE');return;}
                if(captures===16)finish('CAPTURE_CAP');
            }catch{finish('READ_FAULT');}
        };
        function onEvent(event){
            try {
            if(done)return;
            if(event.type==='pagehide'){finish('DETACHED');return;}
            if(event.type==='message'){
                if(event.source!==env.window || event.origin!==env.origin)return;
                const d=event.data;
                if(!((d?.source==='liveflow-content-script'&&['LIVEFLOW_REPLAY_PIPELINE_DIAGNOSTIC','LIVEFLOW_PENDING_ONLY_CLEAR_ACK'].includes(d.type)) ||
                    (d?.source==='liveflow-page-state'&&d.type==='LIVEFLOW_REPLAY_DIAGNOSTIC_SCOPE_OPEN')))return;
            }else if(event.target!==env.ownedVideo())return;
            events++;
            if(events>=32){finish('EVENT_CAP');return;}
            if(!queued){queued=true;env.queueMicrotask(capture);}
            }catch{finish('READ_FAULT');}
        }
        try{
            for(const type of ['message','seeking','seeked','playing','pagehide'])env.addEventListener(type,onEvent,true);
            timer=env.setTimeout(()=>finish('DEADLINE'),Math.max(1,Math.min(10000,timeoutMs)));
            capture(); // listener-before-read closes the already-complete race
        }catch{finish('READ_FAULT');}
    });
}

export function postCaptureExpression({before,expected,timeoutMs}) {
    // Only reviewed source functions and JSON data are serialized, never input code.
    return `(() => {const EXPECTED=${JSON.stringify(expected)};const count=${count};const stageNames=${JSON.stringify(stageNames)};
        const conserved=${conserved};const contiguous=${contiguous};const ringValid=${ringValid};
        const parsePanelIdentity=${parsePanelIdentity};const incompleteEvidence=${incompleteEvidence};const mapQualifiedDiagnostics=${mapQualifiedDiagnostics};const mapDiagnostics=${mapDiagnostics};const readDiagnosticPage=${readDiagnosticPage};
        return (${observePost})({read:readDiagnosticPage,map:raw=>mapDiagnostics(raw,${JSON.stringify({before,expected})}),timeoutMs:${Math.min(10000,timeoutMs)},
        env:{window,origin:location.origin,ownedVideo:()=>document.querySelector('ytd-watch-flexy #movie_player video.html5-main-video'),
        addEventListener:window.addEventListener.bind(window),removeEventListener:window.removeEventListener.bind(window),
        queueMicrotask:window.queueMicrotask.bind(window),setTimeout:window.setTimeout.bind(window),clearTimeout:window.clearTimeout.bind(window)}});})()`;
}

export function opportunityExpression({before,expected,timeoutMs}) {
    return `(() => {const EXPECTED=${JSON.stringify(expected)};const count=${count};const stageNames=${JSON.stringify(stageNames)};
        const conserved=${conserved};const contiguous=${contiguous};const ringValid=${ringValid};
        const parsePanelIdentity=${parsePanelIdentity};const incompleteEvidence=${incompleteEvidence};const mapQualifiedDiagnostics=${mapQualifiedDiagnostics};const mapDiagnostics=${mapDiagnostics};const readDiagnosticPage=${readDiagnosticPage};
        return (${observeOpportunity})({before:${JSON.stringify(before)},read:readDiagnosticPage,map:raw=>mapDiagnostics(raw,${JSON.stringify({before,expected})}),timeoutMs:${Math.min(5000,timeoutMs)},
        env:{window,origin:location.origin,now:()=>performance.now(),addEventListener:window.addEventListener.bind(window),removeEventListener:window.removeEventListener.bind(window),queueMicrotask:window.queueMicrotask.bind(window),setTimeout:window.setTimeout.bind(window),clearTimeout:window.clearTimeout.bind(window)}});})()`;
}

export function createDiagnosticCapture({expected:requestedExpected}={}) {
    const expected=bindExpectedIdentity(requestedExpected);
    let before;
    const capture=async (page,{phase,timeoutMs,expected:packetExpected})=>{
        if(!expected)return {adapterStatus:'BLOCKED',adapterBoundary:'EXPECTED_IDENTITY_INVALID'};
        if(packetExpected&&(!bindExpectedIdentity(packetExpected)||Object.entries(expected).some(([k,v])=>packetExpected[k]!==v)))return {adapterStatus:'BLOCKED',adapterBoundary:'EXPECTED_CAPTURE_MISMATCH'};
        const ms=Math.min(phase==='POST'?10000:phase==='OPPORTUNITY'?5000:2000,timeoutMs);
        if(!Number.isFinite(ms)||ms<=0||!['PRE','ACTION_GATE','POST','OPPORTUNITY'].includes(phase)) return {adapterStatus:'BLOCKED',adapterBoundary:'CAPTURE_CONTRACT'};
        let timer;
        try {
            if(page.isClosed())return {adapterStatus:'BLOCKED',adapterBoundary:'DETACHED_TAB'};
            if(phase==='OPPORTUNITY'){
                if(!before)return {adapterStatus:'BLOCKED',adapterBoundary:'POST_BASELINE_MISSING'};
                const result=await page.evaluate(opportunityExpression({before,expected,timeoutMs:ms}));
                return {...result.last,wait:result.wait};
            }
            if(phase==='POST'){
                if(!before)return {adapterStatus:'BLOCKED',adapterBoundary:'POST_BASELINE_MISSING'};
                // Internal deadline owns listener cleanup; do not race it with
                // an external timer that could leave an observer behind.
                const result=await page.evaluate(postCaptureExpression({before,expected,timeoutMs:ms}));
                return {...result.last,observation:result.observation};
            }
            const raw=await Promise.race([page.evaluate(readDiagnosticPage),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error()),ms);})]);
            const out=mapDiagnostics(raw,{expected,before});
            if(phase==='PRE'&&out.adapterStatus==='READY')before=out;
            return out;
        }catch{return {adapterStatus:'BLOCKED',adapterBoundary:'READ_REJECTED_OR_TIMEOUT'};}
        finally{clearTimeout(timer);}
    };
    Object.defineProperty(capture,'expectedIdentity',{value:expected});
    return capture;
}

// Dedicated passive qualification. Seek's public mapper and phase policy stay unchanged.
export function mapPassiveDiagnostics(raw,{expected,before}={}) {
    const binding=bindExpectedIdentity(expected);
    if(!binding)return {adapterStatus:'BLOCKED',adapterBoundary:'EXPECTED_IDENTITY_INVALID'};
    const result=mapQualifiedDiagnostics(raw,{expected:binding,before},true);
    const bool=x=>typeof x==='boolean'?x:'UNKNOWN',num=x=>typeof x==='number'&&Number.isFinite(x)?x:'UNKNOWN';
    const p=raw?.passive;
    result.evidence={...result.evidence,passive:{media:{connected:bool(p?.connected),paused:bool(p?.paused),ended:bool(p?.ended),seeking:bool(p?.seeking),
        readyState:Number.isInteger(p?.readyState)&&p.readyState>=0&&p.readyState<=4?p.readyState:'UNKNOWN'},
        geometry:Object.fromEntries(['viewportWidth','viewportHeight','dpr','playerWidth','playerHeight','surfaceWidth','surfaceHeight'].map(k=>[k,num(p?.geometry?.[k])]))}};
    if(result.adapterStatus!=='READY')return result;
    const fail=boundary=>({...result,adapterStatus:'BLOCKED',adapterBoundary:boundary,evidence:{...result.evidence,firstBadPredicate:boundary}});
    if(before&&(result.epoch!==before.epoch||result.lifecycle!==before.lifecycle||result.diagnosticSequence<before.diagnosticSequence))return fail('SCOPE_CHANGED');
    if(p?.connected!==true||p.paused!==false||p.ended!==false||p.seeking!==false||!Number.isInteger(p.readyState)||p.readyState<3||p.readyState>4||!Number.isFinite(raw.media?.currentTime)||raw.media.currentTime<0||!Number.isFinite(raw.media?.duration)||raw.media.duration<=raw.media.currentTime||before&&raw.media.currentTime<before.mediaTime)return fail('PASSIVE_MEDIA');
    if(!['viewportWidth','viewportHeight','dpr','playerWidth','playerHeight','surfaceWidth','surfaceHeight'].every(k=>typeof p.geometry?.[k]==='number'&&Number.isFinite(p.geometry[k])&&p.geometry[k]>0))return fail('PASSIVE_GEOMETRY');
    const a=raw.reanchor;
    if(a.inFlight!==false||a.authorityCurrent!==true||a.lifecycleCurrent!==true||a.revisionCurrent!==true||a.targetCurrent!==true||a.generationCurrent!==true||!['OBSERVED_UNUSED','CONSUMED'].includes(a.authorityState))return fail('PASSIVE_AUTHORITY');
    if(before&&JSON.stringify(p.geometry)!==JSON.stringify(before.passiveGeometry))return fail('PASSIVE_GEOMETRY_CHANGED');
    return {...result,operation:'PASSIVE_RECORDER_V1',phase:raw.reanchor.controlPhase,passiveGeometry:{...p.geometry}};
}

export function readPassiveDiagnosticPage() {
    const raw=readDiagnosticPage();
    const p=document.querySelector('ytd-watch-flexy #movie_player');
    const v=p?.querySelector('video.html5-main-video');
    const rect=p?.getBoundingClientRect(),surface=document.getElementById('liveflow-danmaku-surface')?.getBoundingClientRect();
    raw.passive={connected:v?.isConnected===true,paused:v?.paused,ended:v?.ended,seeking:v?.seeking,readyState:v?.readyState,
        geometry:{viewportWidth:innerWidth,viewportHeight:innerHeight,dpr:devicePixelRatio,playerWidth:rect?.width,playerHeight:rect?.height,surfaceWidth:surface?.width,surfaceHeight:surface?.height}};
    return raw;
}

export function observePassive({read,map,env,durationMs,deadlineAt=env.now()+10000,cleanupCommand}) {
    return new Promise(resolve=>{
        let done=false,queued=false,last,events=0,captures=0,timer;
        let captureAttempts=0,publicationEvents=0,lastCaptureSource='UNKNOWN';
        const callbackCounts={initial:0,publication:0,media:0,visibility:0,timer:0};
        const timestamp=()=>{try{const x=env.now();return typeof x==='number'&&Number.isFinite(x)&&x>=0?x:'UNKNOWN';}catch{return 'UNKNOWN';}};
        const startMs=timestamp();
        const types=['message','visibilitychange','pause','seeking','ended','pagehide'];
        const stopOwned=()=>env.post(cleanupCommand);
        const finish=(reason,invalid=false)=>{
            if(done)return;done=true;
            const endMs=timestamp(); // Observation ends before owned STOP and resource cleanup.
            let cleanup=true,stopRequested=false;
            for(const t of types)try{env.removeEventListener(t,onEvent,true);}catch{cleanup=false;}
            try{env.clearTimeout(timer);}catch{cleanup=false;}
            if(invalid)try{stopOwned();stopRequested=true;}catch{ /* Runner still owns cleanup confirmation. */ }
            const measured=typeof startMs==='number'&&typeof endMs==='number'&&endMs>=startMs;
            resolve({last,reason,events,captures,cleanup,stopRequested,captureAttempts,publicationEvents,
                callbackCounts:{...callbackCounts},lastCaptureSource,
                timing:{startMs,endMs,durationMs:measured?endMs-startMs:'UNKNOWN'}});
        };
        const capture=source=>{
            queued=false;if(done)return;
            captureAttempts++;lastCaptureSource=source;
            const key={INITIAL:'initial',PUBLICATION:'publication',MEDIA:'media',VISIBILITY:'visibility',TIMER:'timer'}[source];
            if(key)callbackCounts[key]++;
            if(env.now()>=deadlineAt){finish('DEADLINE',true);return;}
            if(captures>=16){finish('CAPTURE_CAP',true);return;}
            try {last=map(read());captures++;if(last.adapterStatus!=='READY')finish('INVALIDATED',true);}
            catch{finish('READ_FAULT',true);}
        };
        function onEvent(e) {
            if(done)return;
            if(e.type==='message'){
                if(e.source!==env.window||e.origin!==env.origin)return;
                const d=e.data;
                if(d?.type==='LIVEFLOW_DEV_OWNED_RECORDER_V1'&&d.command==='STOP'&&d.operationId===cleanupCommand.operationId&&d.capability===cleanupCommand.capability&&d.instanceId===cleanupCommand.instanceId){finish('OWNED_STOP_REQUESTED');return;}
                if(d?.type==='LIVEFLOW_DEV_OWNED_RECORDER_V1_ACK'&&d.operationId===cleanupCommand.operationId&&d.capability===cleanupCommand.capability&&d.instanceId===cleanupCommand.instanceId&&
                    d.result?.stopConfirmed===true){finish('OWNED_STOP');return;}
                if(!((d?.source==='liveflow-content-script'&&['LIVEFLOW_REPLAY_PIPELINE_DIAGNOSTIC','LIVEFLOW_PENDING_ONLY_CLEAR_ACK'].includes(d.type))||
                    (d?.source==='liveflow-page-state'&&d.type==='LIVEFLOW_REPLAY_DIAGNOSTIC_SCOPE_OPEN')))return;
                publicationEvents++;
            }else if(e.type==='pagehide'){finish('DETACHED',true);return;}
            else if(e.type!=='visibilitychange'&&e.target!==env.ownedVideo())return;
            if(++events>=32){finish('EVENT_CAP',true);return;}
            if(!queued){queued=true;const source=e.type==='message'?'PUBLICATION':e.type==='visibilitychange'?'VISIBILITY':'MEDIA';env.queueMicrotask(()=>capture(source));}
        }
        try {
            for(const t of types)env.addEventListener(t,onEvent,true);
            timer=env.setTimeout(()=>{capture('TIMER');if(!done)finish('NORMAL');},Math.max(0,Math.min(9000,durationMs,deadlineAt-env.now())));
            capture('INITIAL'); // After registration, so no publication gap.
        }catch{finish('READ_FAULT',true);}
    });
}

export function passiveObservationExpression({expected,before,operationId,capability,instanceId,durationMs,deadlineAt}) {
    const command={type:'LIVEFLOW_DEV_OWNED_RECORDER_V1',documentKey:before.documentKey,operationId,capability,instanceId,requestId:'observer_cleanup',command:'STOP',reason:'INVALIDATED'};
    return `(()=>{const EXPECTED=${JSON.stringify(expected)},count=${count},stageNames=${JSON.stringify(stageNames)};
        const conserved=${conserved},contiguous=${contiguous},ringValid=${ringValid},bindExpectedIdentity=${bindExpectedIdentity};
        const parsePanelIdentity=${parsePanelIdentity},incompleteEvidence=${incompleteEvidence},mapQualifiedDiagnostics=${mapQualifiedDiagnostics};
        const mapPassiveDiagnostics=${mapPassiveDiagnostics},readDiagnosticPage=${readDiagnosticPage},readPassiveDiagnosticPage=${readPassiveDiagnosticPage};
        return (${observePassive})({read:readPassiveDiagnosticPage,map:raw=>mapPassiveDiagnostics(raw,${JSON.stringify({expected,before})}),
            durationMs:${Math.min(9000,durationMs)},deadlineAt:${JSON.stringify(deadlineAt)},cleanupCommand:${JSON.stringify(command)},env:{window,origin:location.origin,now:()=>performance.now(),
                ownedVideo:()=>document.querySelector('ytd-watch-flexy #movie_player video.html5-main-video'),
                addEventListener:window.addEventListener.bind(window),removeEventListener:window.removeEventListener.bind(window),
                setTimeout:window.setTimeout.bind(window),clearTimeout:window.clearTimeout.bind(window),queueMicrotask:window.queueMicrotask.bind(window),
                post:value=>window.postMessage(value,location.origin)}});})()`;
}
