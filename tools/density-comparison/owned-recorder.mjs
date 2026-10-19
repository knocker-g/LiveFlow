// Dev-only, closure-local. No Product APIs; dependencies are explicit for VM fixtures.
export function createOwnedRecorder(identity, read, host, createRecorder) {
    identity = Object.freeze({...identity});
    const records = new Map();
    const legacy = createRecorder(identity, read, host);
    let active = null, blocked = false;
    const finite = n => typeof n === 'number' && Number.isFinite(n);
    const reasons = ['NORMAL', 'DEADLINE', 'CANCELLED', 'INVALIDATED', 'DETACHED', 'FAILED'];
    const current = () => host.binding();
    const same = (a, b) => a && b && ['document', 'video', 'generation', 'lifecycle', 'epoch'].every(k => a[k] === b[k]);
    const matching = owner => {
        const r = owner && records.get(owner.operationId);
        return r && r.owner === owner ? r : null;
    };
    function snapshot(r) {
        return Object.freeze({state: r.state, reason: r.reason, started: r.started,
            stopConfirmed: r.state === 'STOP_CONFIRMED', captureValid: r.valid,
            resources: r.resources.size, callbacks: r.callbacks, deadlineReached: r.deadlineReached,
            deadlineAt: finite(r.deadline) ? r.deadline : 'UNKNOWN'});
    }
    function confirm(r) {
        if (r.state !== 'STOP_REQUESTED' || r.callbacks !== 0 || r.resources.size !== 0) return;
        r.state = 'STOP_CONFIRMED';
        // Hold ownership until caller has actually received the stop ACK.
    }
    function stop(r, reason) {
        if (r.state === 'STOP_CONFIRMED' || r.state === 'FAILED') return snapshot(r);
        if (reason === 'NORMAL' && r.state === 'STARTED' && !check(r)) return snapshot(r);
        r.valid = r.valid && reason === 'NORMAL';
        r.reason = reasons.includes(reason) ? reason : 'FAILED';
        r.state = 'STOP_REQUESTED'; // Close admission before touching any resource.
        try {
            r.recorder?.stop();
            for (const [id, kind] of [...r.resources]) {
                (kind === 'interval' ? host.clearInterval : host.clearTimeout)(id);
                r.resources.delete(id); // Never erase unconfirmed resource ownership on throw.
            }
            confirm(r);
        } catch {
            r.state = 'FAILED'; r.valid = false; blocked = true;
        }
        return snapshot(r);
    }
    function check(r) {
        if (r.state !== 'STARTED') return false;
        try {
            if (!same(r.binding, current())) { stop(r, 'INVALIDATED'); return false; }
            if (host.now() >= r.deadline) {
                r.deadlineReached = true; stop(r, 'DEADLINE'); return false;
            }
        } catch { stop(r, 'DETACHED'); return false; }
        return true;
    }
    function allocate(r, kind, fn, delay) {
        const id = (kind === 'interval' ? host.setInterval : host.setTimeout)(() => {
            if (kind === 'timeout') r.resources.delete(id);
            if (kind === 'timeout' && host.now() >= r.deadline) {
                r.callbacks++;
                try{r.deadlineReached = true; stop(r, 'DEADLINE');}
                finally{r.callbacks--;confirm(r);}
                return;
            }
            if (!check(r)) return;
            r.callbacks++;
            try { fn(); } catch { stop(r, 'FAILED'); }
            finally { r.callbacks--; confirm(r); }
        }, delay);
        r.resources.set(id, kind);
        return id;
    }
    function start({operationId, expected, qualified}) {
        if (blocked || active || records.size >= 32 || !qualified ||
            typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(operationId) || records.has(operationId) ||
            !expected || !['prefix','sourceSHA','commonBuildID'].every(k => typeof expected[k] === 'string') ||
            expected.prefix !== identity.buildID.slice(0, 12) || expected.sourceSHA !== identity.sourceSHA || expected.commonBuildID !== identity.commonBuildID ||
            legacy.result()?.finished === false) return {status: 'REJECTED'};
        const r = {state: 'CREATED', reason: 'NORMAL', valid: true, started: false,
            callbacks: 0, resources: new Map(), deadlineReached: false};
        r.owner = Object.freeze({operationId}); // Object identity is the unforgeable local capability.
        records.set(operationId, r); active = r;
        try {
            r.binding = Object.freeze({...current()});
            if (!r.binding.document || !r.binding.video ||
                !['generation','lifecycle','epoch'].every(k => Number.isSafeInteger(r.binding[k]) && r.binding[k] >= 0)) throw Error();
            r.state = 'QUALIFIED';
            r.deadline = host.now() + 10000;
            if (!finite(r.deadline)) throw Error();
            const wrapped = {
                now: host.now,
                setInterval: (fn, delay) => allocate(r, 'interval', fn, delay),
                clearInterval: id => { host.clearInterval(id); r.resources.delete(id); }
            };
            const safeRead = () => {
                try {
                    if (!same(r.binding,current())) { stop(r,'INVALIDATED'); throw Error(); }
                    if (host.now() >= r.deadline) { r.deadlineReached=true;stop(r,'DEADLINE');throw Error(); }
                    const frame=read();
                    if (!same(r.binding,current())) { stop(r,'INVALIDATED'); throw Error(); }
                    if (host.now() >= r.deadline) { r.deadlineReached=true;stop(r,'DEADLINE');throw Error(); }
                    return frame;
                } catch {
                    if(r.state==='QUALIFIED'||r.state==='STARTED')stop(r,'FAILED');
                    throw Error();
                }
            };
            r.recorder = createRecorder(identity, safeRead, wrapped);
            // Arm the owned deadline before first read/timer allocation in Recorder.start.
            allocate(r, 'timeout', () => stop(r, 'DEADLINE'), 10000);
            r.recorder.start();
            r.started = true; r.state = 'STARTED';
            return {status: 'STARTED', owner: r.owner, snapshot: snapshot(r)};
        } catch {
            stop(r, 'FAILED');
            return {status: r.state === 'STOP_CONFIRMED' ? 'FAILED_CLEAN' : 'FAILED', owner: r.owner, snapshot: snapshot(r)};
        }
    }
    function event(kind, value) {
        const r = active;
        if (!r) { legacy[kind](value); return; }
        if (check(r)) r.recorder[kind](value);
    }
    return Object.freeze({
        availability() {return !blocked&&!active&&records.size<32&&legacy.result()?.finished!==false;},
        startOperation: start,
        stopOperation(owner, reason = 'CANCELLED') { const r = matching(owner); return r ? stop(r, reason) : {state: 'NOT_OWNER', stopConfirmed: false}; },
        statusOperation(owner) { const r = matching(owner); return r ? snapshot(r) : {state: 'NOT_OWNER', stopConfirmed: false}; },
        releaseOperation(owner) {
            const r=matching(owner);
            if(!r||r.state!=='STOP_CONFIRMED'||blocked)return {released:false};
            if(active===r)active=null;
            return {released:true};
        },
        markUnknown(owner) { const r = matching(owner); if (r) { blocked = true; r.valid = false; if (r.state !== 'STOP_CONFIRMED') r.state = 'CLEANUP_UNKNOWN'; } },
        resultOperation(owner) { const r = matching(owner); return r?.state === 'STOP_CONFIRMED' && r.valid ? r.recorder.result() : null; },
        // Existing manual UI remains legacy; it cannot interfere with an owned operation.
        start() { if (!active && !blocked) legacy.start(); },
        stop() { if (!active) legacy.stop(); }, result() { return active ? null : legacy.result(); },
        event: value => event('event', value), selection: value => event('selection', value),
        launch: value => event('launch', value), exit: value => event('exit', value)
    });
}
