'use strict';

// Dormant private metadata only. None of these handles grants Product authority.
function createOccurrenceProvenance({ owner, document, binding, observe, observeTransition }) {
    const origins = new Set(), records = new Map(), batches = new WeakMap(), batchClaims = new WeakMap();
    const acceptedOrigins = new WeakMap();
    const originEntries = new WeakMap(), temporalProofs = new WeakMap();
    const acceptedTickets = new WeakSet();
    const transitionProofs = new WeakMap();
    let notifyingTransition = false;
    let transitionCount = 0, temporalCount = 0;
    let retirement = null, notifyingTemporal = false, faultVersion = 0, acceptanceStarted = false;
    const faults = new Set();
    const faultCodes = new Set(['REGISTRY_OVERFLOW', 'COUNTER_OVERFLOW', 'INVALID_DISCARD', 'MISSING_ORIGIN',
        'RECEIVER_THROWN', 'TEMPORAL_INCOMPLETE', 'INVALID_ASSOCIATION', 'REENTRANT_DELIVERY',
        'REENTRANT_OBSERVATION', 'ORIGIN_INCOMPLETE', 'ASSOCIATION_UNKNOWN', 'COMPOSITION_FAILED',
        'TEMPORAL_OBSERVER_MISSING', 'ADMISSION_METADATA_UNKNOWN', 'ADMISSION_OBSERVER_UNAVAILABLE',
        'DUPLICATE_DISPOSITION', 'INCOMPLETE_DISPOSITION', 'INTERRUPTED_BATCH', 'INVALID_OR_REUSED_BATCH',
        'INVALID_ORIGIN', 'INVALID_REGISTRATION', 'MISSING_RECEIVER', 'PROCESSING_THROWN', 'PARSER_AUDIT_INCOMPLETE',
        'PARSER_AUDIT_RECEIVER_THROWN',
        'REENTRANT_PROCESSING', 'REGISTRATION_UNKNOWN', 'STALE_BATCH']);
    for (const code of ['LATE_INSTALL', 'REENTRANT', 'SOURCE_UNKNOWN', 'FORGED_PROOF', 'UNFINALIZED_PROOF',
        'REUSED_PROOF', 'AUDIT_UNKNOWN', 'ASSOCIATION_UNKNOWN', 'DUPLICATE', 'CONTENT_UNKNOWN', 'ITEM_UNKNOWN',
        'ITEM_GAP', 'ATTEMPT_UNKNOWN', 'RENDERER_UNKNOWN', 'NATIVE_UNKNOWN', 'TEMPORAL_UNKNOWN',
        'METADATA_FAILED', 'COUNTER_OVERFLOW', 'MISSING_RECEIVER', 'REUSED_ORIGIN', 'ASYNC_RECEIVER']) faultCodes.add('RETIREMENT_' + code);
    const dispositions = { DEDUPLICATED: 0, FILTERED: 0, CAPACITY_DROPPED: 0, TEMPORAL_REPLACED: 0, OWNER_TERMINAL: 0 };
    let exhausted = false, delivering = false;
    function fault(reason) {
        faults.add(faultCodes.has(reason) ? reason : 'UNKNOWN_FAULT');
        if (faultVersion < Number.MAX_SAFE_INTEGER) faultVersion++; else faults.add('COUNTER_OVERFLOW');
    }
    function overflow() { exhausted = true; fault('REGISTRY_OVERFLOW'); }
    function accept(ticket, authorityBinding, messages) {
        acceptanceStarted = true;
        if (exhausted) return null;
        if (retirement && (!ticket || typeof ticket !== 'object' || acceptedTickets.has(ticket))) { fault('RETIREMENT_REUSED_ORIGIN'); return null; }
        if (origins.size >= 64 || messages.length > 1024 - records.size) { overflow(); return null; }
        if (retirement) acceptedTickets.add(ticket);
        const origin = Object.freeze({ owner, document, binding, authorityBinding, ticket,
            response: Object.freeze({}) });
        const entry = { origin, remaining: messages.length, outputCount: messages.length, audit: false, blocked: false };
        origins.add(entry);
        originEntries.set(origin, entry);
        acceptedOrigins.set(ticket, origin);
        return messages.map((message, position) => {
            const occurrence = Object.freeze({});
            records.set(occurrence, { origin, message, position, association: null, residence: 'ACCEPTED', entry, handle: occurrence });
            return occurrence;
        });
    }
    function lookup(occurrence) {
        const r = records.get(occurrence);
        return r ? Object.freeze({ origin: r.origin, message: r.message, position: r.position,
            association: r.association || 'KNOWN_UNASSIGNED', residence: r.residence }) : null;
    }
    function transition(changes, version) {
        if (typeof observeTransition !== 'function') return;
        const proof = Object.freeze({});
        const event = Object.freeze({ owner, document, binding, changes: Object.freeze(changes) });
        const receipt = { kind: 'TEMPORAL_TRANSITION', state: 'PENDING', event };
        if (transitionCount < Number.MAX_SAFE_INTEGER) transitionCount++; else fault('COUNTER_OVERFLOW');
        transitionProofs.set(proof, receipt);
        if (notifyingTransition) { fault('REENTRANT_OBSERVATION'); receipt.state = 'UNKNOWN'; return; }
        notifyingTransition = true;
        try {
            const value = observeTransition(event, proof);
            if (value !== null && ['object', 'function'].includes(typeof value)) { receipt.state = 'UNKNOWN'; fault('TEMPORAL_INCOMPLETE'); }
        } catch (_) { receipt.state = 'FAILED'; fault('RECEIVER_THROWN'); }
        finally {
            notifyingTransition = false;
            if (receipt.state === 'PENDING') receipt.state = version === faultVersion && !faults.size ? 'FINAL_DELIVERED' : 'UNKNOWN';
        }
    }
    function discard(occurrences, reason, inSelection = false) {
        if (!occurrences) { fault('MISSING_ORIGIN'); return; }
        for (const handle of occurrences) {
            const r = records.get(handle);
            if (!r || r.association) { fault('INVALID_DISCARD'); continue; }
            if (!Object.hasOwn(dispositions, reason)) { fault('INVALID_DISCARD'); continue; }
            if (retirement && r.temporalProof) { fault('RETIREMENT_DUPLICATE'); continue; }
            const previous = r.residence, version = faultVersion;
            r.residence = reason;
            if (dispositions[reason] === Number.MAX_SAFE_INTEGER) fault('COUNTER_OVERFLOW');
            else dispositions[reason]++;
            if (!retirement) {
                records.delete(handle);
                if (--r.entry.remaining === 0) origins.delete(r.entry);
                try { observe?.(Object.freeze({ occurrence: handle, origin: r.origin, position: r.position, disposition: reason })); }
                catch (_) { fault('RECEIVER_THROWN'); }
            } else {
                const event = Object.freeze({ occurrence: handle, origin: r.origin, position: r.position, disposition: reason });
                const proof = Object.freeze({}), receipt = { kind: 'TEMPORAL', state: 'PENDING', event };
                if (temporalCount < Number.MAX_SAFE_INTEGER) temporalCount++; else fault('COUNTER_OVERFLOW');
                temporalProofs.set(proof, receipt); r.temporalProof = proof;
                const version = faultVersion; notifyingTemporal = true;
                try {
                    if (typeof observe !== 'function') fault('RETIREMENT_MISSING_RECEIVER');
                    else {
                        const returned = observe(event, proof);
                        if (returned !== null && ['object', 'function'].includes(typeof returned)) fault('RETIREMENT_ASYNC_RECEIVER');
                    }
                } catch (_) { receipt.state = 'FAILED'; r.blocked = true; fault('RECEIVER_THROWN'); }
                finally {
                    notifyingTemporal = false;
                    if (receipt.state === 'PENDING') receipt.state = version === faultVersion ? 'FINAL_DELIVERED' : 'UNKNOWN';
                }
            }
            if (!inSelection && typeof observeTransition === 'function') transition([Object.freeze({
                occurrence: handle, origin: r.origin, sourceSlot: null, from: previous, to: reason, reason: 'DISPOSAL'
            })], version);
        }
    }
    function temporal(occurrences, trace) {
        if (notifyingTransition) fault('REENTRANT_OBSERVATION');
        if (!occurrences || trace.state !== 'COMPLETE' || trace.slots.length !== occurrences.length ||
            new Set(occurrences).size !== occurrences.length ||
            Array.from({ length: occurrences.length }, (_, i) => !Object.hasOwn(trace.slots, i)).some(Boolean)) {
            fault('TEMPORAL_INCOMPLETE'); return null;
        }
        const changes = typeof observeTransition === 'function' ? [] : null, version = faultVersion;
        trace.slots.forEach((outcome, index) => {
            const r = records.get(occurrences[index]);
            if (!r) { fault('MISSING_ORIGIN'); return; }
            if (changes) changes.push(Object.freeze({ occurrence: occurrences[index], origin: r.origin, sourceSlot: index,
                from: r.residence, to: outcome, reason: trace.reasons?.[index] || 'UNKNOWN' }));
            if (['DEDUPLICATED', 'FILTERED', 'CAPACITY_DROPPED'].includes(outcome)) discard([occurrences[index]], outcome, true);
            else r.residence = outcome;
        });
        if (changes) transition(changes, version);
        return { due: trace.due.map(i => occurrences[i]), pending: trace.pending.map(i => occurrences[i]) };
    }
    function liveHandoff(occurrences) {
        if (typeof observeTransition !== 'function') return;
        if (!occurrences) { fault('MISSING_ORIGIN'); return; }
        const version = faultVersion, changes = [];
        for (let index = 0; index < occurrences.length; index++) {
            const r = records.get(occurrences[index]);
            if (!r || r.residence !== 'ACCEPTED') { fault('TEMPORAL_INCOMPLETE'); continue; }
            changes.push(Object.freeze({ occurrence: occurrences[index], origin: r.origin, sourceSlot: index,
                from: r.residence, to: 'DUE', reason: 'LIVE_HANDOFF' }));
            r.residence = 'DUE';
        }
        transition(changes, version);
    }
    function associate(messages, occurrences, lease, resolveLease) {
        if (exhausted) return null;
        let association;
        try { association = resolveLease?.(lease); } catch (_) { /* Unknown remains unknown. */ }
        if (!association || association.document !== document || !occurrences || messages.length !== occurrences.length ||
            new Set(occurrences).size !== occurrences.length) { fault('INVALID_ASSOCIATION'); return null; }
        for (let i = 0; i < occurrences.length; i++) {
            const r = records.get(occurrences[i]);
            if (!r || r.message !== messages[i] || r.association || r.temporalProof) { fault('INVALID_ASSOCIATION'); return null; }
        }
        for (const handle of occurrences) records.get(handle).association = association;
        const handle = Object.freeze({});
        const identity = Object.freeze({ document, targetId: binding.targetId, lifecycle: binding.lifecycle,
            revision: binding.revision, scope: association.scope, pendingOwner: association.pendingOwner,
            messages: Object.freeze(messages.slice()), occurrences: Object.freeze(occurrences.slice()), lease });
        batches.set(handle, identity); batchClaims.set(identity, false); return handle;
    }
    function enableRetirement() {
        if (retirement || acceptanceStarted || origins.size || records.size || delivering) { fault('RETIREMENT_LATE_INSTALL'); return null; }
        const sources = new Map(), consumed = new WeakSet(), items = new WeakMap(), attempts = new WeakMap();
        let busy = false, retiredOccurrences = 0, retiredOrigins = 0;
        const terminalContent = new Set(['EXACT_ID_DUPLICATE', 'DISPLAY_SUPPRESSED', 'MEDIA_SUPPRESSED',
            'LIVE_RESUME_SUPPRESSED', 'VISIBILITY_FILTERED', 'ADMISSION_REJECTED']);
        function blocked() {
            if (busy || delivering || notifyingTemporal || notifyingTransition) { fault('RETIREMENT_REENTRANT'); return true; }
            try {
                if ([...sources.values()].some(source => source.isDelivering())) { fault('RETIREMENT_REENTRANT'); return true; }
            } catch (_) { fault('RETIREMENT_SOURCE_UNKNOWN'); return true; }
            return false;
        }
        function state(r) {
            return r.obligations || (r.obligations = { content: null, temporalTerminal: false, item: null, sequence: 0, removed: false,
                attempt: null, selected: null, confirmed: false, commit: null, commitProof: null, native: false,
                noRender: false, rejected: false, done: false });
        }
        function fail(r, reason) { if (r) r.blocked = true; fault(reason); return false; }
        function releaseOrigin(entry) {
            if (entry.remaining !== 0 || !entry.audit || entry.blocked || !origins.has(entry)) return false;
            if (retiredOrigins === Number.MAX_SAFE_INTEGER) return fail(null, 'RETIREMENT_COUNTER_OVERFLOW');
            origins.delete(entry); originEntries.delete(entry.origin); acceptedOrigins.delete(entry.origin.ticket); retiredOrigins++;
            return true;
        }
        function reconcile(o) {
            if (o.attempt && o.noRender && o.rejected && !o.commit) {
                attempts.delete(o.attempt); o.attempt = null; o.noRender = false; o.rejected = false;
            }
            o.done = Boolean(o.temporalTerminal || o.content === 'TERMINAL' || (o.content === 'ADMITTED' && o.removed &&
                (!o.attempt || (o.confirmed && o.commit && o.native))));
        }
        function consume(kind, proof) {
            if (blocked()) return false;
            let receipt;
            try {
                receipt = kind === 'temporal' ? temporalProofs.get(proof) : sources.get(kind)?.recognize(proof);
            } catch (_) { return fail(null, 'RETIREMENT_SOURCE_UNKNOWN'); }
            if (!receipt) return fail(null, 'RETIREMENT_FORGED_PROOF');
            if (receipt.state !== 'FINAL_DELIVERED') return fail(null, 'RETIREMENT_UNFINALIZED_PROOF');
            if (consumed.has(proof)) return fail(null, 'RETIREMENT_REUSED_PROOF');
            busy = true;
            let subject = null;
            try {
                let r, o;
                if (kind === 'audit' && receipt.kind === 'AUDIT') {
                    const e = receipt.event, entry = originEntries.get(e.acceptedOrigin);
                    if (!entry || e.ticket !== entry.origin.ticket || e.owner !== owner || e.document !== document ||
                        e.binding !== entry.origin.binding || e.authorityBinding !== entry.origin.authorityBinding ||
                        e.outcome !== 'ACCEPTED' || e.coverage !== 'COMPLETE' || e.parser?.state !== 'COMPLETE' ||
                        e.parser.normalizedOutputs !== entry.outputCount || e.occurrences?.length !== entry.outputCount || entry.audit)
                        return fail(null, 'RETIREMENT_AUDIT_UNKNOWN');
                    for (let i = 0; i < e.occurrences.length; i++) {
                        const original = records.get(e.occurrences[i]);
                        if (!original || original.entry !== entry || original.position !== i) return fail(null, 'RETIREMENT_AUDIT_UNKNOWN');
                    }
                    entry.audit = true; consumed.add(proof); releaseOrigin(entry); return true;
                }
                if (kind === 'content' && receipt.kind === 'CONTENT') {
                    const e = receipt.event, identity = receipt.identity;
                    r = records.get(e.occurrence);
                    subject = r;
                    if (!r || !r.association || !batchClaims.has(identity) || batchClaims.get(identity) !== true ||
                        !identity.occurrences.includes(e.occurrence) || identity.scope !== r.association.scope ||
                        identity.pendingOwner !== r.association.pendingOwner) return fail(r, 'RETIREMENT_ASSOCIATION_UNKNOWN');
                    o = state(r);
                    if (o.content) return fail(r, 'RETIREMENT_DUPLICATE');
                    if (terminalContent.has(e.disposition) && e.item === null) o.content = 'TERMINAL';
                    else if (e.disposition === 'ADMITTED' && e.item && !items.has(e.item)) {
                        o.content = 'ADMITTED'; o.item = e.item; items.set(e.item, r);
                    } else return fail(r, 'RETIREMENT_CONTENT_UNKNOWN');
                } else if (kind === 'item' && receipt.kind === 'ITEM') {
                    const e = receipt.event; r = items.get(e.item);
                    subject = r;
                    if (!r || !records.has(r.handle)) return fail(r, 'RETIREMENT_ITEM_UNKNOWN');
                    o = state(r);
                    if (receipt.sequence !== o.sequence + 1) return fail(r, 'RETIREMENT_ITEM_GAP');
                    if (e.type === 'SELECTED') o.selected = e.attempt;
                    else if (e.type === 'SELECTION_INVALIDATED') {
                        if (o.selected !== e.attempt) return fail(r, 'RETIREMENT_ATTEMPT_UNKNOWN');
                        o.selected = null;
                    } else if (e.type === 'LAUNCH_REQUESTED') {
                        if (!e.attempt || o.selected !== e.attempt || (o.attempt && o.attempt !== e.attempt)) return fail(r, 'RETIREMENT_ATTEMPT_UNKNOWN');
                        o.attempt = e.attempt; attempts.set(e.attempt, r);
                    } else if (e.type === 'LAUNCH_REJECTED') {
                        if (o.attempt !== e.attempt || o.commit) return fail(r, 'RETIREMENT_ATTEMPT_UNKNOWN');
                        o.rejected = true;
                    } else if (e.type === 'ITEM_REMOVED') {
                        if (o.removed) return fail(r, 'RETIREMENT_DUPLICATE');
                        if (!['PRUNE_STALE', 'HARD_COUNT', 'SATURATION', 'STRUCTURAL', 'PENDING_OWNER', 'CONFIRMED_LAUNCH'].includes(e.source)) return fail(r, 'RETIREMENT_ITEM_UNKNOWN');
                        if (e.source === 'CONFIRMED_LAUNCH' && o.attempt !== e.attempt) return fail(r, 'RETIREMENT_ATTEMPT_UNKNOWN');
                        o.removed = true;
                    } else if (e.type === 'LAUNCH_CONFIRMED') {
                        if (!o.removed || o.attempt !== e.attempt || o.noRender) return fail(r, 'RETIREMENT_ATTEMPT_UNKNOWN');
                        o.confirmed = true;
                    } else return fail(r, 'RETIREMENT_ITEM_UNKNOWN');
                    o.sequence = receipt.sequence;
                } else if (kind === 'renderer' && /^RENDER_/.test(receipt.kind)) {
                    const id = receipt.identity; r = attempts.get(id?.attempt);
                    subject = r;
                    if (!r || !r.association || id.scope !== r.association.scope || id.pendingOwner !== r.association.pendingOwner)
                        return fail(r, 'RETIREMENT_RENDERER_UNKNOWN');
                    o = state(r);
                    if (receipt.kind === 'RENDER_COMMIT') {
                        if (o.commit || !id.token) return fail(r, 'RETIREMENT_DUPLICATE');
                        o.commit = id; o.commitProof = proof;
                    } else if (receipt.kind === 'RENDER_TERMINAL') {
                        if (o.native || id !== o.commit || receipt.commitProof !== o.commitProof || receipt.cleanup !== true ||
                            !['FINISHED', 'REJECTED'].includes(receipt.settlement)) return fail(r, 'RETIREMENT_NATIVE_UNKNOWN');
                        o.native = true;
                    } else if (receipt.kind === 'RENDER_RESULT') {
                        if (!receipt.created && ['drop', 'defer'].includes(receipt.status) && !o.commit) o.noRender = true;
                        else if (!receipt.created || receipt.status !== 'rendered') return fail(r, 'RETIREMENT_RENDERER_UNKNOWN');
                    } else return fail(r, 'RETIREMENT_RENDERER_UNKNOWN');
                } else if (kind === 'temporal' && receipt.kind === 'TEMPORAL') {
                    r = records.get(receipt.event.occurrence);
                    subject = r;
                    if (!r || r.association || r.temporalProof !== proof) return fail(r, 'RETIREMENT_TEMPORAL_UNKNOWN');
                    o = state(r); o.temporalTerminal = true;
                } else return fail(null, 'RETIREMENT_SOURCE_UNKNOWN');
                reconcile(o); consumed.add(proof); return true;
            } catch (_) { return fail(subject, 'RETIREMENT_METADATA_FAILED'); }
            finally { busy = false; }
        }
        retirement = Object.freeze({
            bindSource(kind, source) {
                if (blocked()) return false;
                try {
                    if (!['audit', 'content', 'item', 'renderer'].includes(kind) || sources.has(kind) ||
                        typeof source?.recognize !== 'function' || typeof source?.isDelivering !== 'function') return fail(null, 'RETIREMENT_SOURCE_UNKNOWN');
                    sources.set(kind, Object.freeze({ recognize: source.recognize, isDelivering: source.isDelivering })); return true;
                } catch (_) { return fail(null, 'RETIREMENT_SOURCE_UNKNOWN'); }
            },
            consume,
            retire(handle) {
                if (blocked()) return false;
                const r = records.get(handle);
                if (!r) return fail(null, 'RETIREMENT_UNKNOWN_RECORD');
                const o = state(r);
                if (r.blocked || r.entry.blocked || !r.entry.audit || !o.done) return false;
                if (retiredOccurrences === Number.MAX_SAFE_INTEGER) return fail(r, 'RETIREMENT_COUNTER_OVERFLOW');
                records.delete(handle); if (o.item) items.delete(o.item); if (o.attempt) attempts.delete(o.attempt);
                r.entry.remaining--; retiredOccurrences++; releaseOrigin(r.entry); return true;
            },
            obligations(handle) {
                const r = records.get(handle); if (!r) return null;
                const o = state(r);
                return Object.freeze({ audit: r.entry.audit, associated: Boolean(r.association), content: o.content, temporalTerminal: o.temporalTerminal,
                    pending: Boolean(o.item) && !o.removed, attempt: Boolean(o.attempt), committed: Boolean(o.commit),
                    native: o.native, complete: o.done && r.entry.audit && !r.blocked && !r.entry.blocked });
            },
            status: () => Object.freeze({ state: faults.size ? 'UNKNOWN' : 'OBSERVING', retiredOccurrences, retiredOrigins }),
            recognizeTemporalProof(proof) { const r = temporalProofs.get(proof); return r ? Object.freeze({ ...r }) : null; }
        });
        return retirement;
    }
    function deliver(callback) {
        if (delivering) { fault('REENTRANT_DELIVERY'); return callback(); }
        delivering = true;
        try { return callback(); } finally { delivering = false; }
    }
    return Object.freeze({ accept, temporal, liveHandoff, discard, associate, lookup, deliver, fault, enableRetirement,
        recognizeTransitionProof(proof) { const r = transitionProofs.get(proof); return r ? Object.freeze({ ...r }) : null; },
        proofCoverage: () => Object.freeze({ transition: transitionCount, temporal: temporalCount }),
        acceptedOrigin: ticket => acceptedOrigins.get(ticket) || null,
        isDelivering: () => delivering,
        isExhausted: () => exhausted,
        recognizeBatch: handle => batches.get(handle) || null,
        claimBatch(identity) {
            if (!batchClaims.has(identity) || batchClaims.get(identity)) { fault('INVALID_OR_REUSED_BATCH'); return false; }
            batchClaims.set(identity, true); return true;
        },
        status: () => Object.freeze({ state: faults.size ? 'UNKNOWN' : 'OBSERVING',
            faults: Object.freeze([...faults]), origins: origins.size, occurrences: records.size, exhausted,
            unauditedOrigins: [...origins].filter(entry => !entry.audit).length,
            dispositions: Object.freeze({ ...dispositions }) }) });
}
module.exports = Object.freeze({ createOccurrenceProvenance });
