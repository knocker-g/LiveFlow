// External, dev-only orchestration. No browser creation, CDP, or Product imports.
export const SCENARIO = 'REPLAY_UI_SEEK_FORWARD_30_V1';
export const ACCEPTANCE_SCOPES=Object.freeze(['SEEK_HANDOFF_TERMINAL','SEEK_DUAL_NONZERO_ATTRIBUTION']);
export const EXPECTED = Object.freeze({ prefix: 'adf8f1e2df34', sourceSHA: '5ac978747d0eea5ed3d52024658c1f20b7db5e2b', commonBuildID: '5757b139c9502b0e27ee34c341b3fa3e5bd2b0a8fbb1724ef2d9b632a50c86de' });
const sliderSelector = '.html5-video-player .ytp-progress-bar[role="slider"]';
// Session-local one-shot guard; never evict an attempted packet for reuse.
const attemptedPackets = new Set();
const identityOK = x => x && Object.entries(EXPECTED).every(([k,v]) => x[k] === v);
const number = n => Number.isSafeInteger(n) && n >= 0;

// capture(page,{phase,timeoutMs}) must return one atomic, read-only, normalized
// snapshot from existing surfaces. It must not navigate, retry, poll or act.
// documentKey and media times are used locally, never included in receipts.
function gate(s, before) {
    if (s?.adapterStatus === 'BLOCKED') return 'DIAGNOSTIC_ADAPTER_BLOCKED';
    if (!s || !identityOK(s.main) || !identityOK(s.content)) return 'IDENTITY';
    if (typeof s.documentKey !== 'string' || !s.documentKey) return 'DOCUMENT';
    if (before && s.documentKey !== before.documentKey) return 'DOCUMENT_CHANGED';
    if (s.visibility !== 'visible') return 'HIDDEN';
    if (s.phase !== 'READING') return 'PHASE';
    if (s.authorityOK !== true || s.currentnessOK !== true || s.adActive !== false) return 'AUTHORITY_CURRENTNESS_AD';
    if (!number(s.lifecycle) || !number(s.epoch) || s.scopeComplete !== true) return 'SCOPE';
    if (before && s.lifecycle !== before.lifecycle) return 'LIFECYCLE_CHANGED';
    if (s.mismatch !== 0 || s.fault !== false || s.traceComplete !== true) return 'DIAGNOSTIC';
    if (s.accountingComplete !== true || s.conservation !== true || s.loss !== 0 || s.overflow !== 0) return 'ACCOUNTING';
    if (!number(s.temporalPending) || !number(s.schedulerPending)) return 'COUNTERS';
    return null;
}
const knownBool=x=>typeof x==='boolean'?x:'UNKNOWN';
const knownNumber=x=>number(x)?x:'UNKNOWN';
const boundaryNames=new Set(('MISSING_EXPORT_OR_REJECTED_READ IDENTITY_MISSING IDENTITY_MISMATCH DOCUMENT_UNPROVEN STALE_DOCUMENT SCOPE_EXPORT_MISSING SCOPE_EPOCH_INVALID SCOPE_LIST_MISSING SCOPE_CAPACITY SCOPE_DUPLICATE_EPOCH SCOPE_INCOMPLETE_FLAG SCOPE_DISCARDED_OR_UNKNOWN SCOPE_IDENTITY SCOPE_SEQUENCE SCOPE_CHANGED ACK_UNRESOLVED_OR_MISSING TRACE_SEQUENCE_OR_FAULT ARCHIVE_INCOMPLETE CURRENT_SCOPE_TRACE_MISSING PHASE MISMATCH CURRENTNESS_OR_OWNERSHIP_UNPROVEN HIDDEN CANONICAL_ACCOUNTING PENDING_PUBLICATION OLD_SCOPE_INCOMPLETE OLD_SCOPE_MISSING_OR_MULTIPLE_TRANSITIONS OLD_TERMINAL_ATTRIBUTION OLD_REASON_ACCOUNTING POST_BASELINE_MISSING POST_NO_CAPTURE CAPTURE_CONTRACT DETACHED_TAB READ_REJECTED_OR_TIMEOUT').split(' '));
boundaryNames.add('SCOPE_ENTRY_INVALID');
const safeBoundary=x=>boundaryNames.has(x)?x:'UNKNOWN';
function stageConservation(stages){
    const names=['parser','classification','temporal','dueBridge','future','bridge','pending','scheduler','launch','renderer'];
    if(!names.every(k=>['input','forwarded','explicitRemoval','retained','lost','overflow'].every(f=>number(stages?.[k]?.[f]))&&typeof stages[k].valid==='boolean'))return 'UNKNOWN';
    return names.every(k=>{const s=stages[k];return s.valid&&s.lost===0&&s.overflow===0&&s.input===s.forwarded+s.explicitRemoval+s.retained;});
}
// Re-project adapter summaries at the export boundary; never spread arbitrary data.
// P1.9 fixed-schema re-projection at receipt boundary; no arbitrary strings/keys.
export function retainedObservability(e) {
    const num=x=>Number.isSafeInteger(x)&&x>=0?x:'UNKNOWN',bool=x=>typeof x==='boolean'?x:'UNKNOWN';
    const en=(x,values)=>values.includes(x)?x:'UNKNOWN';
    const phases=['READING','REANCHORING','STOPPED','SUSPENDED','BOOTSTRAPPING','BUFFER_PAUSED'];
    const events=('LIFECYCLE_START BOOTSTRAP_AUTHORIZED BOOTSTRAP_SUCCEEDED BOOTSTRAP_FAILED SEQUENTIAL_AUTHORIZED SEQUENTIAL_SUCCEEDED SEQUENTIAL_FAILED INITIAL_ALIGNMENT_REQUIRED SEEK_STARTED SEEK_COMPLETED HIDDEN_ENTER VISIBLE_ENTER AD_ENTER AD_EXIT_READY MEDIA_PAUSE MEDIA_PLAY PLAYBACK_RATE_CHANGED BUFFER_HIGH_WATERMARK BUFFER_LOW_WATERMARK EARLY_RESUME_ELIGIBLE EARLY_RESUME_AUTHORIZED EARLY_RESUME_COMPLETED REANCHOR_AUTHORIZED REANCHOR_SUCCEEDED REANCHOR_FAILED DISABLE GENERATION_INVALIDATED TARGET_REPLACED TARGET_CHANGED CAPABILITY_LOST').split(' ');
    const row=x=>x&&typeof x==='object'?{...Object.fromEntries(['sequence','lifecycle','epoch','mismatchDelta'].map(k=>[k,num(x[k])])),step:en(x.step,['SHADOW_DISPATCH','SHADOW_CAPABILITY','CONTROL_TRANSITION']),type:en(x.type,['PHASE_MISMATCH','FORBIDDEN_LEGACY_TRANSITION','CAPABILITY_PATH_MISMATCH']),event:en(x.event,events),path:en(x.path,['BOOTSTRAP','SEQUENTIAL','REANCHOR','LEGACY_IMPLICIT_BOOTSTRAP','RAW_DEFERRED_START_PATH']),beforePhase:en(x.beforePhase,phases),afterPhase:en(x.afterPhase,phases),failure:en(x.failure,['NONE','FORBIDDEN_EVENT','AUTHORITY_FAILURE','CAPABILITY_REQUIRED_UNAVAILABLE'])}:'UNKNOWN';
    const getter=x=>({present:bool(x?.present),statusPresent:bool(x?.statusPresent),classification:en(x?.classification,['MISSING','ACCESSOR','INVALID','THREW','OK']),statusType:en(x?.statusType,['OBJECT','NULL','OTHER','UNKNOWN'])});
    const arm=x=>({present:bool(x?.present),expectedMatch:bool(x?.expectedMatch),predicate:en(x?.predicate,['PASS','MISSING','INVALID','MISMATCH','UNKNOWN'])});
    const i=e?.identity,c=e?.control;
    return {firstBadPredicate:boundaryNames.has(e?.firstBadPredicate)?e.firstBadPredicate:'UNKNOWN',
        identity:{panel:{exists:bool(i?.panel?.exists),ownerDocumentMatch:bool(i?.panel?.ownerDocumentMatch),patternMatch:bool(i?.panel?.patternMatch),expectedMatch:bool(i?.panel?.expectedMatch),predicate:en(i?.panel?.predicate,['PASS','MISSING','INVALID','MISMATCH','UNKNOWN'])},main:{...arm(i?.main),getter:getter(i?.main?.getter)},content:{...arm(i?.content)},datasetIdentity:{...arm(i?.datasetIdentity),datasetPresent:bool(i?.datasetIdentity?.datasetPresent),withinLimit:bool(i?.datasetIdentity?.withinLimit),parse:en(i?.datasetIdentity?.parse,['VALID','INVALID','OVERSIZE','MISSING','UNKNOWN']),provenance:en(i?.datasetIdentity?.provenance,['MATCH_MAIN','MISMATCH_MAIN','MISSING','UNKNOWN'])},validatedContentExport:{...arm(i?.validatedContentExport),provenance:en(i?.validatedContentExport?.provenance,['MATCH_MAIN','MISMATCH_MAIN','MISSING','UNKNOWN']),documentCorrespondence:en(i?.validatedContentExport?.documentCorrespondence,['CURRENT_DOCUMENT_DOM_EXPORT','NOT_OBSERVED','INCONCLUSIVE']),admission:en(i?.validatedContentExport?.admission,['PASS','MISSING','MISMATCH','UNKNOWN'])},documentCorrespondence:en(i?.documentCorrespondence,['CURRENT_DOCUMENT_DOM_EXPORT','NOT_OBSERVED','INCONCLUSIVE'])},
        getterFacts:Object.fromEntries(['shadow','accounting','pipeline','reanchor','restart'].map(k=>[k,getter(e?.getterFacts?.[k])])),
        ownership:Object.fromEntries(['mainContent','playerTiming','navigationPending','adActive','seekActive','generationCurrent','frameRoleCurrent','sameSnapshotCurrent'].map(k=>[k,bool(e?.ownership?.[k])])),
        authority:{state:en(e?.authority?.state,['OBSERVED_UNUSED','CONSUMED','INVALID']),...Object.fromEntries(['available','current','lifecycleCurrent','revisionCurrent','targetCurrent','generationCurrent','requestInFlight'].map(k=>[k,bool(e?.authority?.[k])]))},
        pending:Object.fromEntries(['temporal','unclassified','due','scheduler'].map(k=>[k,num(e?.pending?.[k])])),
        control:{mismatchCount:num(c?.mismatchCount),transitionCount:num(c?.transitionCount),firstMismatch:row(c?.firstMismatch),context:row(c?.context),history:Array.isArray(c?.history)?c.history.slice(0,8).map(row):'UNKNOWN',historyStatus:en(c?.historyStatus,['AVAILABLE','HISTORY_INCOMPLETE','UNKNOWN']),earliestSequence:num(c?.earliestSequence),latestSequence:num(c?.latestSequence),truncated:bool(c?.truncated),archive:{completeness:en(c?.archive?.completeness,['COMPLETE','INCOMPLETE']),frozen:bool(c?.archive?.frozen),fault:bool(c?.archive?.fault),overflow:bool(c?.archive?.overflow)}}};
}

export function retainedFacts(e) {
    if(!e)return 'UNKNOWN';
    const pick=(x,values)=>values.includes(x)?x:'UNKNOWN';
    const counts=['lifecycle','epoch','sequence','buffered','discarded','mismatch','loss','overflow','ackPending','temporalSeek','schedulerLifecycle','retained','unclassified','pendingUnclassified'];
    const bools=['incomplete','collectorFault','accountingComplete','ackFault','terminalObserved','accountingValid','fault'];
    const stageFacts=x=>Object.fromEntries(['parser','classification','temporal','dueBridge','future','bridge','pending','scheduler','launch','renderer'].map(k=>[k,{valid:knownBool(x?.[k]?.valid),...Object.fromEntries(['input','forwarded','explicitRemoval','retained','lost','overflow'].map(f=>[f,knownNumber(x?.[k]?.[f])]))}]));
    const project=x=>({...Object.fromEntries(counts.map(k=>[k,knownNumber(x?.[k])])),...Object.fromEntries(bools.map(k=>[k,knownBool(x?.[k])])),
        stages:stageFacts(x?.stages),closureReady:'UNKNOWN',ackApplicability:'UNKNOWN',
        state:pick(x?.state,['OPEN','CLOSED','INCOMPLETE']),closure:pick(x?.closure,['NOT_CLOSED','TERMINAL_VALIDATED','TERMINAL_INVALID','INCOMPLETE']),
        sequenceCompleteness:pick(x?.sequenceCompleteness,['OPEN','COMPLETE','INCOMPLETE']),
        temporalReasons:Object.fromEntries(['HIDDEN','AD','NAVIGATION','SEEK','FAIL_CLOSED','READ_START_RESET','REANCHOR_REPLACED','NO_FRESH_CHAIN','USER_DISABLED','PAGEHIDE','MODE_TRANSITION','RATE_CHANGE','EXPLICIT','OTHER'].map(k=>[k,knownNumber(x?.temporalReasons?.[k])])),
        schedulerReasons:Object.fromEntries(['stale','capacity','emergency','lifecycle','structural'].map(k=>[k,knownNumber(x?.schedulerReasons?.[k])]))});
    return {...project(e),...retainedObservability(e),seekObserved:knownBool(e.seekObserved),phase:pick(e.phase,['READING','REANCHORING','STOPPED','SUSPENDED','BOOTSTRAPPING','BUFFER_PAUSED']),visibility:pick(e.visibility,['visible','hidden']),
        scopes:Array.isArray(e.scopes)?e.scopes.slice(0,9).map(project):'UNKNOWN',
        stages:Object.fromEntries(['parser','classification','temporal','dueBridge','future','bridge','pending','scheduler','launch','renderer'].map(k=>[k,{valid:knownBool(e.stages?.[k]?.valid),
            ...Object.fromEntries(['input','forwarded','explicitRemoval','retained','lost','overflow'].map(f=>[f,knownNumber(e.stages?.[k]?.[f])]))}]))};
}
const anonymous = s => s && ({ expectedIdentity: EXPECTED, identityMatches: s.main&&s.content?Boolean(identityOK(s.main) && identityOK(s.content)):'UNKNOWN', visibility: s.visibility === 'visible' ? 'VISIBLE' : s.visibility==='hidden'?'HIDDEN':'UNKNOWN',
    reading: typeof s.phase==='string'?s.phase === 'READING':'UNKNOWN', lifecycle: knownNumber(s.lifecycle), epoch: knownNumber(s.epoch),sequence:knownNumber(s.diagnosticSequence),
    temporalPending: knownNumber(s.temporalPending), schedulerPending: knownNumber(s.schedulerPending),
    scopeComplete: knownBool(s.scopeComplete), conservation: knownBool(s.conservation), lossZero: number(s.loss)?s.loss===0:'UNKNOWN', overflowZero: number(s.overflow)?s.overflow===0:'UNKNOWN',
    oldScopeClosed: knownBool(s.oldScopeClosed), oldAttributionComplete: knownBool(s.oldAttributionComplete), oldConservation: knownBool(s.oldConservation),
    oldRetained: knownNumber(s.oldRetained), oldUnclassified: knownNumber(s.oldUnclassified),
    oldLoss: knownNumber(s.oldLoss), oldOverflow: knownNumber(s.oldOverflow), actualSeekObserved: knownBool(s.actualSeekObserved),
    temporalSeekRemoval: knownNumber(s.temporalSeekRemoval), schedulerLifecycleRemoval: knownNumber(s.schedulerLifecycleRemoval),
    adapterBoundary:s.adapterBoundary==null?null:safeBoundary(s.adapterBoundary), evidence:retainedFacts(s.evidence),
    observation:s.observation?{reason:['COMPLETE','DEADLINE','EVENT_CAP','CAPTURE_CAP','HARD_FAILURE','TERMINAL_FAILURE','READ_FAULT','DETACHED'].includes(s.observation.reason)?s.observation.reason:'UNKNOWN',
        firstProvisional:s.observation.firstProvisional?{classification:'PENDING_TERMINAL',epoch:knownNumber(s.observation.firstProvisional.epoch),loss:knownNumber(s.observation.firstProvisional.loss),overflow:knownNumber(s.observation.firstProvisional.overflow),capture:knownNumber(s.observation.firstProvisional.capture)}:null,
        firstBadBoundary:s.observation.firstBadBoundary==null?null:safeBoundary(s.observation.firstBadBoundary),events:knownNumber(s.observation.events),captures:knownNumber(s.observation.captures),cleanup:knownBool(s.observation.cleanup),
        snapshots:Array.isArray(s.observation.snapshots)?s.observation.snapshots.slice(0,16).map(x=>({boundary:x.adapterBoundary==null?null:safeBoundary(x.adapterBoundary),facts:retainedFacts(x.evidence)})):[]}:null });

// Action approval and foreground readiness are separate, packet/document-bound
// inputs. Neither is inferred from playback or a prior SEEK_READY receipt.
export async function runSeekScenario(page, { packet, acceptanceScope, approval, ready, capture } = {}) {
    const result = { version: 1, scenario: SCENARIO, status: 'BLOCKED', firstBadBoundary: null,
        requestedAcceptanceScope:ACCEPTANCE_SCOPES.includes(acceptanceScope)?acceptanceScope:'UNKNOWN',authorizedAcceptanceScope:ACCEPTANCE_SCOPES.includes(approval?.acceptanceScope)?approval.acceptanceScope:'UNKNOWN',
        acceptance:{A:'NOT_RUN',B:'NOT_RUN'},freshnessLimit:'NO_PRODUCER_TIMESTAMP_OR_QUEUE_REVISION',wait:null,trigger:null,actionGate:null,
        humanInteractions:{midRunActions:0,intermediateHandoffs:0},
        action: { attempted: 0, completed: 0, kind: 'UI_SLIDER_CLICK', deltaSeconds: 30 },
        pre: null, post: null, browserReleased: false, runtimeSeekPass: false };
    const stop = boundary => { result.firstBadBoundary = boundary; return result; };
    try {
        if(!ACCEPTANCE_SCOPES.includes(acceptanceScope)||approval?.acceptanceScope!==acceptanceScope)return stop('ACCEPTANCE_SCOPE_NOT_AUTHORIZED');
        if (!packet || approval?.packet !== packet || approval?.scenario !== SCENARIO || approval?.maxActions !== 1 || approval?.deltaSeconds !== 30) return stop('ACTION_NOT_AUTHORIZED');
        if (attemptedPackets.has(packet) || attemptedPackets.size >= 128) return stop('PACKET_ALREADY_ATTEMPTED_OR_CAPACITY');
        if (ready?.packet !== packet || ready?.foregroundExclusive !== true) return stop('HUMAN_NOT_READY');
        if (!approval.documentKey || ready.documentKey !== approval.documentKey) return stop('DOCUMENT_CONSENT');
        if (!page || page.isClosed() || typeof capture !== 'function') return stop('TAB_OR_CAPTURE_MISSING');
        const pre = await bounded(() => capture(page, { phase: 'PRE', timeoutMs: 2000 }), 2000);
        result.pre = anonymous(pre);
        const bad = gate(pre); if (bad) return stop(bad);
        if (pre.documentKey !== approval.documentKey) return stop('STALE_DOCUMENT');
        const dual=acceptanceScope===ACCEPTANCE_SCOPES[1];
        if (dual&&(pre.temporalPending === 0 || pre.schedulerPending === 0)) {
            const opportunity=await bounded(()=>capture(page,{phase:'OPPORTUNITY',timeoutMs:4500}),5000);
            result.trigger=anonymous(opportunity);
            const w=opportunity.wait;
            const publication=w?.publication;
            result.wait={reason:['OPPORTUNITY','DEADLINE','EVENT_CAP','CAPTURE_CAP','PREFLIGHT_FAILED','READ_FAULT','DETACHED'].includes(w?.reason)?w.reason:'UNKNOWN',
                events:knownNumber(w?.events),captures:knownNumber(w?.captures),durationMs:typeof w?.durationMs==='number'&&Number.isFinite(w.durationMs)&&w.durationMs>=0?w.durationMs:'UNKNOWN',cleanup:knownBool(w?.cleanup),
                publication:{match:['MATCHED','INITIAL_NEW_SEQUENCE','NOT_APPLIED_OR_SUPERSEDED'].includes(publication?.match)?publication.match:'UNKNOWN',
                    appliedSequence:knownNumber(publication?.appliedSequence),triggerSequence:knownNumber(publication?.triggerSequence),receiptAgeMs:typeof publication?.receiptAgeMs==='number'&&Number.isFinite(publication.receiptAgeMs)&&publication.receiptAgeMs>=0?publication.receiptAgeMs:'UNKNOWN'}};
            if(gate(opportunity,pre)||opportunity.epoch!==pre.epoch)return stop('OPPORTUNITY_PREFLIGHT_FAILED');
            if(result.wait.reason!=='OPPORTUNITY'||result.wait.cleanup!==true||!number(w.events)||w.events>12||!number(w.captures)||w.captures>4||
                !['MATCHED','INITIAL_NEW_SEQUENCE'].includes(result.wait.publication.match)||!number(result.wait.publication.appliedSequence)||opportunity.temporalPending<=0||opportunity.schedulerPending<=0)return stop('OPPORTUNITY_NOT_QUALIFIED');
        }
        const slider = page.locator(sliderSelector);
        if (await slider.count() !== 1) return stop('SEEK_SELECTOR');
        if (!(await slider.isVisible())) return stop('SEEK_SELECTOR');
        const box = await slider.boundingBox();
        if (!box || box.width <= 0 || box.height <= 0 || !Number.isFinite(pre.mediaTime) || !Number.isFinite(pre.duration) || pre.mediaTime < 0 || pre.mediaTime + 30 >= pre.duration) return stop('SEEK_GEOMETRY_OR_RANGE');
        // Requalify immediately before action after asynchronous locator reads.
        const last = await bounded(() => capture(page, { phase: 'ACTION_GATE', timeoutMs: 2000 }), 2000);
        result.actionGate=anonymous(last);
        const changed = gate(last, pre); if (changed) return stop(changed);
        if (last.epoch !== pre.epoch || dual&&(last.temporalPending === 0 || last.schedulerPending === 0)) return stop('STALE_QUALIFICATION');
        if(dual&&(!number(last.diagnosticSequence)||!number(pre.diagnosticSequence)||last.diagnosticSequence<(result.wait?.publication.appliedSequence??pre.diagnosticSequence)))return stop('PUBLICATION_STALE');
        if (!Number.isFinite(last.mediaTime) || last.mediaTime < 0 || last.duration !== pre.duration || last.mediaTime + 30 >= last.duration) return stop('SEEK_RANGE_CHANGED');
        if (page.isClosed()) return stop('TAB_DETACHED');
        if (attemptedPackets.has(packet) || attemptedPackets.size >= 128) return stop('PACKET_ALREADY_ATTEMPTED_OR_CAPACITY');
        attemptedPackets.add(packet);
        result.action.attempted = 1;
        await slider.click({ position: { x: box.width * (last.mediaTime + 30) / last.duration, y: box.height / 2 }, timeout: 2000, noWaitAfter: true });
        result.action.completed = 1;
        result.acceptance.A='INCONCLUSIVE';result.acceptance.B=dual?'INCONCLUSIVE':'NOT_PROVEN';
        // Adapter owns its POST deadline and observer cleanup. The 9s budget
        // reserves time for delivery inside the total 10s observation ceiling.
        const post = await bounded(()=>capture(page, { phase: 'POST', timeoutMs: 9000 }),10000);
        result.post = anonymous(post);
        const facts=result.post.evidence;
        const current=Array.isArray(facts?.scopes)?facts.scopes.find(x=>x.epoch===facts.epoch):null;
        const old=Array.isArray(facts?.scopes)?facts.scopes.find(x=>x.epoch===pre.epoch&&x.lifecycle===pre.lifecycle):null;
        result.verdicts={uiAction:result.action.completed===1?'COMPLETED':'UNKNOWN',seekObserved:post.actualSeekObserved===true||facts?.seekObserved===true?true:'UNKNOWN',
            epochTransition:number(facts?.epoch)?facts.epoch>pre.epoch:number(post.epoch)?post.epoch>pre.epoch:'UNKNOWN',
            oldAttribution:knownBool(post.oldAttributionComplete),oldClosure:old?.state==='CLOSED'&&old?.closure==='TERMINAL_VALIDATED'?true:knownBool(post.oldScopeClosed),
            newScopeOpen:current?current.state==='OPEN'?'OPEN':current.state:'UNKNOWN',newConservation:stageConservation(facts?.stages),
            ack:{applicability:typeof facts?.ackPending==='number'&&facts.ackPending>0?'REQUIRED':'UNKNOWN',pending:facts?.ackPending??'UNKNOWN',fault:facts?.ackFault??'UNKNOWN'}};
        if(result.post.observation?.reason==='TERMINAL_FAILURE'){result.acceptance.A='FAIL';if(dual)result.acceptance.B='FAIL';result.status='FAIL';return stop('TERMINAL_ACCOUNTING_FAILURE');}
        const postBad = gate(post, pre);
        if (postBad) { result.status = 'INCONCLUSIVE'; return stop(post.adapterStatus==='BLOCKED'?safeBoundary(post.adapterBoundary):postBad); }
        if (post.epoch !== pre.epoch+1 || post.oldScopeClosed !== true || post.oldAttributionComplete !== true || post.oldConservation !== true || post.oldRetained !== 0 || post.oldUnclassified !== 0 || post.oldLoss !== 0 || post.oldOverflow !== 0 || post.actualSeekObserved !== true) {
            result.status = 'INCONCLUSIVE'; return stop('POST_ATTRIBUTION_INCOMPLETE');
        }
        result.status = 'SCENARIO_EVIDENCE_COMPLETE';
        result.acceptance.A='PASS';
        result.acceptance.B='NOT_PROVEN';
        if(dual){
            const baseline=last.evidence?.scopes?.find(x=>x.epoch===pre.epoch&&x.lifecycle===pre.lifecycle);
            const temporal=number(post.temporalSeekRemoval)&&number(baseline?.temporalSeek)?post.temporalSeekRemoval-baseline.temporalSeek:'UNKNOWN';
            const scheduler=number(post.schedulerLifecycleRemoval)&&number(baseline?.schedulerLifecycle)?post.schedulerLifecycleRemoval-baseline.schedulerLifecycle:'UNKNOWN';
            result.removalEvidence={temporalSeekDelta:typeof temporal==='number'&&temporal>=0?temporal:'UNKNOWN',schedulerLifecycleDelta:typeof scheduler==='number'&&scheduler>=0?scheduler:'UNKNOWN'};
            if(typeof temporal==='number'&&temporal>0&&typeof scheduler==='number'&&scheduler>0)result.acceptance.B='PASS';
            else{result.status='INCONCLUSIVE';return stop('DUAL_REMOVAL_NOT_PROVEN');}
        }
        // This runner receipt is not a Product/Runtime SEEK acceptance authority.
        return result;
    } catch {
        result.status = result.action.attempted ? 'INCONCLUSIVE' : 'BLOCKED';
        return stop(result.action.attempted ? 'ACTION_OR_POST_CAPTURE_FAILED' : 'PREFLIGHT_CAPTURE_FAILED');
    } finally { result.browserReleased = true; }
}

async function bounded(task, ms) {
    let timer;
    try { return await Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('BOUND_EXCEEDED')), ms); })]); }
    finally { clearTimeout(timer); }
}
