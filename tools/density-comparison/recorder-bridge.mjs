// Dev-only protocol. This never calls a Product, Authority or playback method.
export function installRecorderBridge(controller, identity, host) {
    const operations = new Map();
    let cleanupUnknown = false;
    const key = 'LIVEFLOW_DEV_OWNED_RECORDER_V1';
    const listener = event => {
        const c = event.data;
        if (event.source !== host.window || event.origin !== host.origin || c?.type !== key ||
            c.documentKey !== host.documentKey || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.operationId || '') ||
            !/^[a-f0-9]{32}$/.test(c.capability || '') || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.requestId || '')) return;
        let record = operations.get(c.operationId), result = {state:'REJECTED',stopConfirmed:false};
        if(c.command!=='INFO'&&c.instanceId!==host.instanceId)return;
        if (c.command === 'INFO') {
            result={profile:'OWNED_RECORDER_V1',available:!cleanupUnknown&&operations.size<32&&controller.availability(),maxObservationMs:10000,
                instanceId:host.instanceId,
                expectedMatch:c.expected?.prefix===identity.buildID.slice(0,12)&&c.expected?.sourceSHA===identity.sourceSHA&&c.expected?.commonBuildID===identity.commonBuildID};
        } else if (c.command === 'START' && !record && !cleanupUnknown && operations.size < 32) {
            const started = controller.startOperation({operationId:c.operationId,expected:c.expected,qualified:c.qualified === true});
            if (started.owner) {
                record = {capability:c.capability,owner:started.owner}; operations.set(c.operationId,record);
                result = {...started.snapshot,status:started.status};
            }
        } else if (c.command === 'STOP' && !record) {
            // Cancellation may overtake delivery of START. Never permit that late start.
            if(operations.size<32)operations.set(c.operationId,{capability:c.capability,cancelled:true});
            result={state:'STOP_CONFIRMED',stopConfirmed:true,started:false,resources:0,callbacks:0,captureValid:false};
        } else if (record?.capability === c.capability && record.cancelled) {
            if(c.command==='STOP'||c.command==='STATUS')result={state:'STOP_CONFIRMED',stopConfirmed:true,started:false,resources:0,callbacks:0,captureValid:false};
            if(c.command==='RELEASE')result={released:true};
            if(c.command==='UNKNOWN'){cleanupUnknown=true;result={state:'CLEANUP_UNKNOWN'};}
        } else if (record?.capability === c.capability) {
            if (c.command === 'STOP') result = controller.stopOperation(record.owner,c.reason);
            if (c.command === 'STATUS') result = controller.statusOperation(record.owner);
            if (c.command === 'RELEASE') result = controller.releaseOperation(record.owner);
            if (c.command === 'UNKNOWN') { controller.markUnknown(record.owner); result = controller.statusOperation(record.owner); }
            if (c.command === 'EVIDENCE') result = {evidence: projectRecorderEvidence(controller.resultOperation(record.owner))};
        }
        host.post({type:key+'_ACK',requestId:c.requestId,operationId:c.operationId,capability:c.capability,instanceId:host.instanceId,result});
    };
    host.window.addEventListener('message',listener);
    // This listener is document-owned package instrumentation, not a per-capture resource.
    return Object.freeze({dispose(){host.window.removeEventListener('message',listener);}});
}

export function projectRecorderEvidence(data) {
    if (!data) return null;
    const n = x => typeof x === 'number' && Number.isFinite(x) ? x : 'UNKNOWN';
    const rect = x => Object.fromEntries(['left','top','right','bottom','x','y','width','height','velocity'].map(k=>[k,n(x?.[k])]));
    const eventNames=['CAPACITY_DROPPED','STALE_DROPPED','EMERGENCY_DROPPED','STRUCTURAL_DROPPED','PENDING_CLEARED','LAUNCH_COMMITTED','LIFECYCLE_CLEAR'];
    return {finished:data.finished === true,fault:Array.isArray(data.errors)?data.errors.length>0:'UNKNOWN',
        truncated:data.truncated === true || data.frames.length>101 || data.frames.some(f=>(f.boxes?.length??0)>128),
        launches:n(data.summary?.launch),averageVisibleSampled:n(data.summary?.averageVisibleSampled),
        maxHorizontalPx:n(data.summary?.maxHorizontalPx),maxVerticalPx:n(data.summary?.maxVerticalPx),
        events:Object.fromEntries(eventNames.map(k=>[k,n(data.summary?.events?.[k])])),
        frames:data.frames.slice(0,101).map(f=>({at:n(f.at),mediaTime:n(f.mediaTime),surface:rect(f.surface),
            boxes:Array.isArray(f.boxes)?f.boxes.slice(0,128).map(b=>({...rect(b),semanticClass:['NORMAL','SPECIAL'].includes(b.semanticClass)?b.semanticClass:'UNKNOWN'})):'UNKNOWN'})),
        conditionsChanged:Array.isArray(data.summary?.conditionChanges)?data.summary.conditionChanges.length>0:'UNKNOWN',
        canonicalAccounting:'SEPARATE_EXPORT_REQUIRED',humanAcceptance:'PENDING',densityComparison:'NOT_PROVEN',
        specialReason:'UNKNOWN',overlapDuration:'SAMPLED_ONLY'};
}
