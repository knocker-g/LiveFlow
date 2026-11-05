'use strict';

const scheduler = require('./scheduler-runtime.js');
const pending = require('./pending-selection.js');
const MAX_RETAINED_RUNTIME_SOURCES_PER_OWNER = 64;

// Extension-private diagnostic ownership. No Product work is authorized here.
function createRuntimeSourceRegistry({ owner, onProof }) {
    if (!owner || typeof owner !== 'object' || typeof onProof !== 'function') return null;
    const retained = new Map(), runtimes = new WeakMap(), routes = new WeakMap();
    const seen = new WeakSet(), queued = new WeakSet(), items = new WeakMap(), attempts = new WeakMap();
    const faults = new Set(), events = [];
    let dependencies = null, busy = false, released = 0, current = null, productFence = null, privateParticipation = null;
    const totals = { item: 0, evaluation: 0 };
    const fault = reason => { faults.add(reason); };
    function enqueue(kind, proof, record) {
        if (faults.size) return;
        if (!proof || typeof proof !== 'object' || seen.has(proof) || queued.has(proof) || routes.has(proof)) { fault('DUPLICATE_PROOF'); return; }
        if (events.length >= 64 + 1024 * 10) { fault('PROOF_BUFFER_OVERFLOW'); return; }
        if (record) routes.set(proof, { record, kind });
        queued.add(proof); events.push({ kind, proof, record });
        if (['item','evaluation','renderer','content'].includes(kind)) onProof(kind, proof);
    }
    function create(options) {
        const offeredFence = options.productMutationFence;
        if (offeredFence) {
            const participates = typeof offeredFence.participates === 'function' ? offeredFence.participates() : null;
            if (participates !== true && participates !== false) throw new TypeError('ORIGINAL_PRODUCT_PARTICIPATION_UNKNOWN');
            if (privateParticipation !== null && privateParticipation !== participates) throw new TypeError('ORIGINAL_PRODUCT_PATH_MISMATCH');
            if (privateParticipation === null) privateParticipation = participates;
        } else if (privateParticipation === null) privateParticipation = false;
        if (options.productMutationFence && options.productMutationFence !== productFence) {
            if (current || privateParticipation === true) {
                if (productFence || current) throw new TypeError('ORIGINAL_PRODUCT_FENCE_MISMATCH');
            }
            productFence = options.productMutationFence;
        }
        if (productFence) options = { ...options, productMutationFence: productFence };
        // Only the existing current reference holds an untracked source. Never
        // overwrite queued/busy original Product work after diagnostic overflow.
        if (current && !runtimes.has(current) && privateParticipation === true &&
            (typeof productFence?.quiescent !== 'function' || productFence.quiescent() !== true ||
                typeof current.replacementReady !== 'function' || current.replacementReady() !== true))
            throw new TypeError('ORIGINAL_RUNTIME_NOT_QUIESCENT');
        let record = null;
        const tracked = faults.size === 0 && retained.size < MAX_RETAINED_RUNTIME_SOURCES_PER_OWNER;
        if (!tracked) {
            if (!faults.size) fault('RUNTIME_SOURCE_OVERFLOW');
            const runtime = scheduler.createSchedulerRuntime(options);
            if (runtime) current = runtime;
            return runtime ? Object.freeze({ runtime, tracked: false }) : null;
        }
        const source = scheduler.createPrivateSchedulerRuntime(options,
            (_item, _outcome, proof) => enqueue('evaluation', proof, record),
            (_event, proof) => enqueue('item', proof, record));
        if (!source) return null;
        const identity = scheduler.recognizePrivateRuntimeSource(source);
        if (!identity) { fault('SOURCE_IDENTITY'); return null; }
        record = { source, identity, owner, phase: 'ACTIVE', items: new Map(), scopes: new Set(),
            observed: { item: 0, evaluation: 0 }, detached: null, seal: null };
        source.watchSealedFault(() => fault('SOURCE_AFTER_SEAL'));
        retained.set(identity, record); runtimes.set(source.runtime, record);
        current = source.runtime;
        return Object.freeze({ runtime: source.runtime, tracked: true, identity });
    }
    function recognize(kind, proof) {
        const route = routes.get(proof), r = route?.record;
        if (!r || route.kind !== kind || r.phase === 'RELEASED' || retained.get(r.identity) !== r) return null;
        return kind === 'item' ? r.source.recognizeProof(proof) : r.source.recognizeEvaluationProof(proof);
    }
    function sourceStatus(kind) {
        let count = totals[kind];
        for (const r of retained.values()) {
            const s = r.source.observationStatus();
            if (s.state !== 'OBSERVING') fault('SOURCE_FAULT');
            count += kind === 'item' ? s.itemAttempts : s.attempts;
        }
        if (!Number.isSafeInteger(count)) fault('COUNTER_OVERFLOW');
        return Object.freeze({ state: faults.size ? 'UNKNOWN' : 'OBSERVING',
            itemAttempts: kind === 'item' ? count : undefined, attempts: kind === 'evaluation' ? count : undefined,
            faults: Object.freeze([...faults]) });
    }
    function router(kind) {
        return Object.freeze({ recognize: proof => recognize(kind, proof),
            isDelivering: () => [...retained.values()].some(r => r.source.isProofDelivering()),
            status: () => sourceStatus(kind),
            coverage: () => { const s = sourceStatus(kind); return kind === 'item' ? s.itemAttempts : s.attempts; } });
    }
    function connect(value) {
        if (dependencies || retained.size || events.length || !value ||
            typeof value.content?.recognizeProof !== 'function' || typeof value.renderer?.recognizeProof !== 'function' ||
            typeof value.renderer?.recognizeRuntimeProof !== 'function' || typeof value.collector?.wasConsumed !== 'function') return false;
        dependencies = Object.freeze({ ...value }); return true;
    }
    function locate(item) {
        let found = null;
        for (const r of retained.values()) if (r.source.ownsItem(item)) {
            if (found) { fault('ITEM_SOURCE_AMBIGUOUS'); return null; } found = r;
        }
        return found;
    }
    function consume(entry) {
        const { kind, proof } = entry;
        if (seen.has(proof)) throw Error('DUPLICATE_PROOF');
        let receipt;
        if (kind === 'detached') receipt = dependencies.renderer.recognizeRuntimeProof(proof);
        else if (kind === 'content') receipt = dependencies.content.recognizeProof(proof);
        else if (kind === 'renderer') receipt = dependencies.renderer.recognizeProof(proof);
        else receipt = recognize(kind, proof);
        if (receipt?.state !== 'FINAL_DELIVERED') throw Error('UNFINALIZED_PROOF');
        if (kind !== 'detached' && dependencies.collector.wasConsumed(proof) !== true) throw Error('COLLECTOR_CONSUMPTION_MISSING');
        seen.add(proof);
        if (kind === 'detached') {
            const r = runtimes.get(receipt.runtime);
            if (!r || r.phase !== 'ACTIVE' || receipt.kind !== 'RUNTIME_DETACHED') throw Error('DETACH_IDENTITY');
            r.detached = proof; r.phase = 'RETIRING';
            r.seal = r.source.seal();
            if (!r.seal) throw Error('SOURCE_SEAL_MISSING');
            return;
        }
        if (kind === 'content') {
            if (receipt.event.disposition !== 'ADMITTED') return;
            const { item, occurrence } = receipt.event, r = locate(item);
            if (!r || items.has(item) || !occurrence || !receipt.identity.scope || !receipt.identity.pendingOwner) throw Error('CONTENT_SOURCE_IDENTITY');
            const obligation = { item, occurrence, identity: receipt.identity, removed: false,
                attempt: null, rejected: false, confirmed: false, result: null, commit: null, native: false };
            r.scopes.add(receipt.identity.scope);
            r.items.set(item, obligation); items.set(item, { record: r, obligation }); return;
        }
        if (kind === 'renderer') {
            const original = attempts.get(receipt.identity?.attempt), o = original?.obligation;
            if (!o || receipt.identity.scope !== o.identity.scope || receipt.identity.pendingOwner !== o.identity.pendingOwner) throw Error('RENDERER_SOURCE_IDENTITY');
            if (receipt.kind === 'RENDER_COMMIT') {
                if (o.commit) throw Error('DUPLICATE_COMMIT'); o.commit = receipt.identity;
            } else if (receipt.kind === 'RENDER_TERMINAL') {
                if (o.native || receipt.identity !== o.commit || receipt.cleanup !== true ||
                    !['FINISHED','REJECTED'].includes(receipt.settlement)) throw Error('NATIVE_OBLIGATION');
                o.native = true;
            } else if (receipt.kind === 'RENDER_RESULT') o.result = receipt;
            else throw Error('RENDERER_PROOF_KIND');
            return;
        }
        const r = entry.record, original = items.get(receipt.event.item);
        if (!r || !original || original.record !== r) throw Error('ITEM_SOURCE_IDENTITY');
        r.observed[kind]++;
        const o = original.obligation, e = receipt.event;
        if (kind === 'evaluation') { if (e.outcome === 'THREW') throw Error('EVALUATION_FAULT'); return; }
        if (e.type === 'LAUNCH_REQUESTED') {
            if (o.attempt || !e.attempt) throw Error('ATTEMPT_IDENTITY');
            o.attempt = e.attempt; attempts.set(e.attempt, original);
        } else if (e.type === 'LAUNCH_REJECTED') o.rejected = true;
        else if (e.type === 'ITEM_REMOVED') { if (o.removed) throw Error('DUPLICATE_REMOVAL'); o.removed = true; }
        else if (e.type === 'LAUNCH_CONFIRMED') o.confirmed = true;
    }
    function terminal(o) {
        if (!o.removed) return false;
        if (!o.attempt) return true;
        if (o.commit) return o.confirmed && o.native;
        return o.rejected && o.result?.created === false && ['drop','defer'].includes(o.result.status);
    }
    function drain() {
        if (busy) { fault('REENTRANT'); return false; }
        if (!dependencies || dependencies.collector.isDelivering() || [...retained.values()].some(r => r.source.isProofDelivering()) ||
            dependencies.renderer.isProofDelivering() || dependencies.content.isProofDelivering()) return false;
        busy = true;
        try {
            // C1 is the sole actual proof consumer. This registry only reads its
            // certified producer receipts after consumption; no second C1-R call.
            const candidate = dependencies.collector.snapshot();
            if (candidate.faults.length) fault('COLLECTOR_SOURCE_FAULT');
            const batch = events.splice(0);
            batch.sort((a,b) => (a.kind === 'content' ? 0 : 1) - (b.kind === 'content' ? 0 : 1));
            for (const e of batch) { queued.delete(e.proof); try { consume(e); } catch (error) { fault(error.message); } }
            dependencies.collector.retireComplete();
            for (const r of retained.values()) {
                for (const [item, o] of r.items) if (terminal(o) && !dependencies.collector.retainsItem(item)) {
                    r.items.delete(item); items.delete(item); if (o.attempt) attempts.delete(o.attempt);
                }
                const s = r.source.observationStatus();
                if (s.state !== 'OBSERVING') fault('SOURCE_FAULT');
                if (r.phase === 'RETIRING' && !faults.size && r.source.recognizeSealProof(r.seal) &&
                    r.observed.item === s.itemAttempts && r.observed.evaluation === s.attempts &&
                    [...r.items.values()].every(terminal)) r.phase = 'FINALIZED';
            }
            return !faults.size;
        } catch (_) { fault('REGISTRY_DRAIN_FAILED'); return false; }
        finally { busy = false; }
    }
    function release(identity) {
        drain();
        const r = retained.get(identity);
        if (!r || r.phase !== 'FINALIZED' || !r.source.recognizeSealProof(r.seal)) return false;
        dependencies.collector.retireComplete();
        if ([...r.items.keys()].some(item => dependencies.collector.retainsItem(item))) return false;
        const s = r.source.observationStatus();
        totals.item += s.itemAttempts; totals.evaluation += s.attempts;
        if (![totals.item, totals.evaluation, released + 1].every(Number.isSafeInteger)) { fault('COUNTER_OVERFLOW'); return false; }
        for (const o of r.items.values()) { items.delete(o.item); if (o.attempt) attempts.delete(o.attempt); }
        if(current===r.source.runtime)current=null;
        r.items.clear(); r.scopes.clear(); runtimes.delete(r.source.runtime); r.source = null;
        r.phase = 'RELEASED'; retained.delete(identity); released++; return true;
    }
    function actualRuntimes() {
        const values = [...retained.values()].map(r => r.source.runtime);
        if (current && !values.includes(current)) values.push(current);
        return values;
    }
    const pendingRuntime = Object.freeze({
        mutationQuiescent: () => actualRuntimes().every(runtime =>
            typeof runtime.mutationQuiescent === 'function' && runtime.mutationQuiescent()),
        resumeArms() { for (const runtime of actualRuntimes()) runtime.resumeArms?.(); },
        queue: Object.freeze({
            snapshot: () => actualRuntimes().flatMap(runtime => runtime.queue.snapshot()),
            successfulLaunchSequence: () => {
                const value = actualRuntimes().reduce((n,r) => n + r.queue.successfulLaunchSequence(), 0);
                if (!Number.isSafeInteger(value)) { fault('COUNTER_OVERFLOW'); throw new TypeError('SOURCE_CREDIT_UNKNOWN'); }
                return value;
            }
        }),
        status: () => Object.freeze({ state: actualRuntimes().some(r => r.status().state === 'EVALUATING') ? 'EVALUATING' : 'IDLE',
            pendingCount: actualRuntimes().reduce((n,r) => n + r.queue.snapshot().length, 0) }),
        enqueue: (...args) => current ? current.enqueue(...args) : false,
        removePendingOwner(binding) {
            const sources = actualRuntimes();
            if (sources.some(r => r.status().state === 'EVALUATING')) return Object.freeze({ status: 'FAILED', count: 0 });
            let count = 0;
            for (const runtime of sources) {
                if (!runtime.queue.snapshot().some(item => pending.samePendingOwner(item.pendingOwner, binding))) continue;
                const result = runtime.removePendingOwner(binding);
                if (!['APPLIED','STALE_OR_NOT_FOUND'].includes(result.status) || !Number.isSafeInteger(result.count))
                    return Object.freeze({ status: 'FAILED', count: null });
                count += result.count;
                if (!Number.isSafeInteger(count)) { fault('COUNTER_OVERFLOW'); return Object.freeze({ status: 'FAILED', count: null }); }
            }
            return Object.freeze({ status: count ? 'APPLIED' : 'STALE_OR_NOT_FOUND', count });
        }
    });
    return Object.freeze({ create, connect, drain, release, pendingRuntime, itemSource: router('item'), evaluationSource: router('evaluation'),
        disable: () => fault('EXTERNAL_SOURCE_FAULT'),
        sources: () => Object.freeze([...retained.keys()]),
        observeContent: proof => enqueue('content', proof, null), observeRenderer: proof => enqueue('renderer', proof, null),
        observeDetached: proof => enqueue('detached', proof, null),
        status: () => Object.freeze({ state: faults.size ? 'UNKNOWN' : 'OBSERVING', retained: retained.size, released,
            maximum: MAX_RETAINED_RUNTIME_SOURCES_PER_OWNER, faults: Object.freeze([...faults]) }),
        generation: identity => { const r = retained.get(identity); return r ? Object.freeze({ phase: r.phase, owner: r.owner,
            source: r.identity, scopes: Object.freeze([...r.scopes]),
            unresolved: [...r.items.values()].filter(o => !terminal(o)).length }) : null; }
    });
}
module.exports = Object.freeze({ createRuntimeSourceRegistry, MAX_RETAINED_RUNTIME_SOURCES_PER_OWNER });
