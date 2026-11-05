'use strict';

// Dormant in-process evidence composition. No Product ownership or public API.
function createTenStageCollector({ core, ownerPort, retirement }) {
    const stageNames = ['parser', 'classification', 'temporal', 'dueBridge', 'future', 'bridge', 'pending', 'scheduler', 'launch', 'renderer'];
    const keys = ['receivedActions', 'parsed', 'parseFailed', 'parserRetained', 'displayable', 'invalid', 'unsupported',
        'classificationRetained', 'dueClassified', 'futureClassified', 'beforeStartFiltered', 'temporalInvalid',
        'exactIdDeduped', 'temporalDiscarded', 'temporalRetained', 'dueBridged', 'dueDropped', 'dueRetained',
        'futurePromoted', 'capacityDropped', 'futureQueued', 'enqueued', 'bridgeDeduped', 'bridgeFiltered',
        'lifecycleDiscarded', 'generationDiscarded', 'bridgeAdmissionRejected', 'bridgeRetained',
        'schedulerEligible', 'pendingExplicitDrop', 'pendingRetained', 'selected', 'staleDropped',
        'schedulerExplicitDrop', 'schedulerRetained', 'launched', 'launchRejected', 'launchRetained',
        'displayed', 'rendererDropped', 'rendererRetained'];
    const empty = () => Object.fromEntries(keys.map(key => [key, 0]));
    const sources = new Map(), queued = [], queuedProofs = new WeakSet(), consumed = new WeakSet();
    // Fixed metadata buffer derived from the existing 64-origin/1024-occurrence
    // domain and ten collectors; repeated undrained events can still exhaust it.
    const proofCapacity = 64 + 1024 * stageNames.length;
    const records = new Map(), items = new WeakMap(), attempts = new WeakMap(), audited = new WeakSet();
    const scopeTotals = new WeakMap(), knownScopes = new WeakSet();
    const folded = empty(), parser = { receivedActions: 0, parsed: 0, parseFailed: 0, parserRetained: 0 };
    const faults = new Set();
    const observedProofs = Object.fromEntries(['audit', 'transition', 'temporal', 'content', 'item', 'evaluation', 'renderer'].map(k => [k, 0]));
    let busy = false, responses = 0, outerActions = 0, observedPromotions = 0, retired = 0;
    let lifetime = null;
    function noteLifetime(r, kind, proof) {
        if (!lifetime) return;
        try {
            let e = lifetime.records.get(r);
            if (!e) { e = {}; lifetime.records.set(r, e); }
            e[kind] = proof;
        } catch (_) { lifetime.fault = true; }
    }
    const required = ['audit', 'transition', 'temporal', 'content', 'item', 'evaluation', 'renderer'];
    const terminalContent = new Set(['EXACT_ID_DUPLICATE', 'DISPLAY_SUPPRESSED', 'MEDIA_SUPPRESSED',
        'LIVE_RESUME_SUPPRESSED', 'VISIBILITY_FILTERED', 'ADMISSION_REJECTED']);
    const fixedFaults = new Set(['COUNTER_OVERFLOW', 'SOURCE_INVALID', 'REENTRANT', 'PROOF_INVALID', 'DUPLICATE_PROOF',
        'PROOF_BUFFER_OVERFLOW', 'OCCURRENCE_OVERFLOW', 'ORIGIN_MISSING', 'AUDIT_INCOMPLETE', 'AUDIT_IDENTITY',
        'RETIREMENT_AUDIT', 'TRANSITION_KIND', 'TRANSITION_IDENTITY', 'TRANSITION_UNKNOWN', 'FILTER_REASON_UNKNOWN',
        'CONTENT_IDENTITY', 'CONTENT_UNKNOWN', 'RETIREMENT_CONTENT', 'ITEM_IDENTITY', 'ITEM_MISSING',
        'RETIREMENT_ITEM', 'RENDERER_IDENTITY', 'RETIREMENT_RENDERER', 'NATIVE_UNKNOWN', 'PENDING_DELIVERY',
        'SOURCE_UNKNOWN', 'PROOF_UNFINALIZED_OR_FOREIGN', 'RETIREMENT_TEMPORAL', 'EVALUATION_UNKNOWN',
        'TRANSITION_MISSING', 'CONTENT_PROOF_MISSING', 'AUDIT_PROOF_MISSING', 'RETIREMENT_FAILED']);
    for (const kind of ['audit', 'transition', 'temporal', 'content', 'item', 'evaluation', 'renderer'])
        for (const prefix of ['SOURCE_FAULT_', 'SOURCE_NOTIFICATION_MISSING_', 'SOURCE_UNKNOWN_']) fixedFaults.add(prefix + kind);
    const fault = reason => { faults.add(fixedFaults.has(reason) ? reason : 'COLLECTOR_FAILED'); };
    function plus(target, key, amount) {
        if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(target[key] + amount)) { fault('COUNTER_OVERFLOW'); return; }
        target[key] += amount;
    }
    function add(target, vector) { for (const key of keys) plus(target, key, vector[key]); }
    function bindSource(kind, source) {
        if (busy || sources.has(kind) || !required.includes(kind) || typeof source?.recognize !== 'function' ||
            typeof source?.isDelivering !== 'function' || typeof source?.status !== 'function' ||
            typeof source?.coverage !== 'function') { fault('SOURCE_INVALID'); return false; }
        sources.set(kind, Object.freeze({ ...source })); return true;
    }
    bindSource('audit', { recognize: ownerPort.recognizeAuditProof, isDelivering: ownerPort.isProofDelivering, status: ownerPort.observationStatus, coverage: () => ownerPort.proofCoverage().audit });
    bindSource('transition', { recognize: ownerPort.recognizeTemporalTransitionProof, isDelivering: ownerPort.isProofDelivering, status: ownerPort.observationStatus, coverage: () => ownerPort.proofCoverage().transition });
    bindSource('temporal', { recognize: retirement.recognizeTemporalProof, isDelivering: ownerPort.isProofDelivering, status: ownerPort.observationStatus, coverage: () => ownerPort.proofCoverage().temporal });
    function observe(kind, proof) {
        // Called while proof is PENDING. Receiver return is never an ACK.
        if (busy) { fault('REENTRANT'); return; }
        if (!required.includes(kind) || !proof || typeof proof !== 'object') { fault('PROOF_INVALID'); return; }
        if (queuedProofs.has(proof) || consumed.has(proof)) { fault('DUPLICATE_PROOF'); return; }
        if (queued.length >= proofCapacity) { fault('PROOF_BUFFER_OVERFLOW'); return; }
        queuedProofs.add(proof); queued.push({ kind, proof });
    }
    function original(handle) {
        let r = records.get(handle);
        if (r) return r;
        const source = ownerPort.recognizeOccurrence(handle);
        if (!source || records.size >= 1024) { fault(source ? 'OCCURRENCE_OVERFLOW' : 'ORIGIN_MISSING'); return null; }
        r = { handle, origin: source.origin, position: source.position, audited: false,
            temporal: 'ACCEPTED', reason: null, association: null, content: null, item: null,
            removed: null, attempt: null, confirmed: false, commit: null, native: false };
        records.set(handle, r); return r;
    }
    function audit(receipt, proof) {
        const e = receipt.event;
        if (receipt.kind !== 'AUDIT' || e.outcome !== 'ACCEPTED' || e.coverage !== 'COMPLETE' ||
            e.parser?.state !== 'COMPLETE' || !e.parser.projection || !Array.isArray(e.occurrences) ||
            audited.has(e.ticket) || e.parser.normalizedOutputs !== e.occurrences.length || e.parser.unknownTail !== false)
            throw Error('AUDIT_INCOMPLETE');
        const originals = e.occurrences.map(original);
        if (originals.some((r, index) => !r || r.origin.ticket !== e.ticket || r.origin !== e.acceptedOrigin ||
            r.origin.document !== e.document || r.origin.owner !== e.owner || r.position !== index || r.audited)) throw Error('AUDIT_IDENTITY');
        if (!retirement.consume('audit', proof)) throw Error('RETIREMENT_AUDIT');
        for (const key of Object.keys(parser)) plus(parser, key, e.parser.projection[key]);
        if (!Number.isSafeInteger(responses + 1) || !Number.isSafeInteger(outerActions + e.parser.outerActionCount)) throw Error('COUNTER_OVERFLOW');
        responses++; outerActions += e.parser.outerActionCount; audited.add(e.ticket);
        for (const r of originals) { r.audited = true; noteLifetime(r, 'audit', proof); }
        if (lifetime) {
            const d = lifetime.domain;
            if (d && (d.owner !== e.owner || d.document !== e.document || d.binding !== e.binding)) lifetime.fault = true;
            else if (!d) lifetime.domain = Object.freeze({ owner: e.owner, document: e.document, binding: e.binding });
        }
    }
    function transition(receipt) {
        if (receipt.kind !== 'TEMPORAL_TRANSITION') throw Error('TRANSITION_KIND');
        const seen = new Set();
        for (const c of receipt.event.changes) {
            const r = original(c.occurrence);
            if (!r || seen.has(c.occurrence) || r.origin !== c.origin || r.origin.owner !== receipt.event.owner ||
                r.origin.document !== receipt.event.document || r.temporal !== c.from) throw Error('TRANSITION_IDENTITY');
            seen.add(c.occurrence);
            if (!['FUTURE', 'DUE', 'FILTERED', 'DEDUPLICATED', 'CAPACITY_DROPPED', 'TEMPORAL_REPLACED', 'OWNER_TERMINAL'].includes(c.to)) throw Error('TRANSITION_UNKNOWN');
            if (c.to === 'FILTERED' && !['BEFORE_START', 'INVALID'].includes(c.reason)) throw Error('FILTER_REASON_UNKNOWN');
            if (c.from === 'FUTURE' && c.to === 'DUE') {
                if (!Number.isSafeInteger(observedPromotions + 1)) throw Error('COUNTER_OVERFLOW');
                observedPromotions++;
            }
            r.temporal = c.to; r.reason = c.reason;
        }
    }
    function content(receipt, proof) {
        const e = receipt.event, identity = receipt.identity, r = records.get(e.occurrence);
        const source = ownerPort.recognizeOccurrence(e.occurrence);
        if (receipt.kind !== 'CONTENT' || !r || !r.audited || !source || source.association === 'KNOWN_UNASSIGNED' ||
            identity.scope !== source.association.scope || identity.pendingOwner !== source.association.pendingOwner ||
            !identity.occurrences.includes(e.occurrence) || r.content || r.temporal !== 'DUE') throw Error('CONTENT_IDENTITY');
        if (!terminalContent.has(e.disposition) && e.disposition !== 'ADMITTED') throw Error('CONTENT_UNKNOWN');
        if (!retirement.consume('content', proof)) throw Error('RETIREMENT_CONTENT');
        r.association = source.association; r.content = e.disposition;
        noteLifetime(r, 'content', proof);
        if (lifetime) {
            let s = lifetime.scopes.get(r.association.scope);
            if (!s) {
                s = { association: r.association, lease: identity.lease, associated: 0, retired: 0, safe: true };
                lifetime.scopes.set(r.association.scope, s);
            }
            if (s.association.pendingOwner !== r.association.pendingOwner || !Number.isSafeInteger(s.associated + 1)) lifetime.fault = true;
            else s.associated++;
        }
        knownScopes.add(r.association.scope);
        if (e.disposition === 'ADMITTED') {
            if (!e.item || items.has(e.item)) throw Error('ITEM_IDENTITY');
            r.item = e.item; items.set(e.item, r);
        }
    }
    function item(receipt, proof) {
        const e = receipt.event, r = items.get(e.item);
        if (receipt.kind !== 'ITEM' || !r) throw Error('ITEM_MISSING');
        if (!retirement.consume('item', proof)) throw Error('RETIREMENT_ITEM');
        if (e.type === 'LAUNCH_REQUESTED') {
            r.attempt = e.attempt; attempts.set(e.attempt, r);
            noteLifetime(r, 'request', proof);
        }
        if (e.type === 'LAUNCH_REJECTED') noteLifetime(r, 'rejected', proof);
        if (e.type === 'ITEM_REMOVED') { r.removed = e.source; noteLifetime(r, 'removed', proof); }
        if (e.type === 'LAUNCH_CONFIRMED') { r.confirmed = true; noteLifetime(r, 'confirmed', proof); }
    }
    function renderer(receipt, proof) {
        const id = receipt.identity, r = attempts.get(id?.attempt);
        if (!r || id.scope !== r.association.scope || id.pendingOwner !== r.association.pendingOwner) throw Error('RENDERER_IDENTITY');
        if (!retirement.consume('renderer', proof)) throw Error('RETIREMENT_RENDERER');
        noteLifetime(r, receipt.kind, proof);
        if (receipt.kind === 'RENDER_COMMIT') r.commit = id;
        if (receipt.kind === 'RENDER_TERMINAL') {
            if (id !== r.commit || receipt.cleanup !== true || !['FINISHED', 'REJECTED'].includes(receipt.settlement)) throw Error('NATIVE_UNKNOWN');
            r.native = true;
        }
    }
    function drain() {
        if (busy) { fault('REENTRANT'); return; }
        try { if ([...sources.values()].some(s => s.isDelivering())) { fault('PENDING_DELIVERY'); return; } }
        catch (_) { fault('SOURCE_UNKNOWN'); return; }
        busy = true;
        try {
            const batch = queued.splice(0);
            // Audits can arrive after Content callbacks from the same real READ.
            // Only metadata consumption is dependency-ordered, never Product work.
            const order = { audit: 0, transition: 1, content: 2 };
            batch.sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
            for (const { kind, proof } of batch) {
                queuedProofs.delete(proof);
                try {
                    const receipt = sources.get(kind)?.recognize(proof);
                    if (!receipt || receipt.state !== 'FINAL_DELIVERED' || consumed.has(proof)) throw Error('PROOF_UNFINALIZED_OR_FOREIGN');
                    consumed.add(proof);
                    plus(observedProofs, kind, 1);
                    if (kind === 'audit') audit(receipt, proof);
                    else if (kind === 'transition') transition(receipt);
                    else if (kind === 'content') content(receipt, proof);
                    else if (kind === 'item') item(receipt, proof);
                    else if (kind === 'renderer') renderer(receipt, proof);
                    else if (kind === 'temporal') {
                        if (!retirement.consume('temporal', proof)) throw Error('RETIREMENT_TEMPORAL');
                        const r = records.get(receipt.event.occurrence);
                        if (r) noteLifetime(r, 'temporal', proof);
                    }
                    else if (kind === 'evaluation') {
                        if (receipt.kind !== 'EVALUATION' || !items.has(receipt.event.item) || receipt.event.outcome === 'THREW') throw Error('EVALUATION_UNKNOWN');
                        // Evaluation/GEOMETRY_UNKNOWN is not queue removal.
                    }
                } catch (error) { fault(error?.message || 'COLLECTOR_FAILED'); }
            }
        } finally { busy = false; }
    }
    function vector(r) {
        const c = empty();
        // Same stock-oriented projection as the existing replayAccountingStatus:
        // promoted occurrences are now due, not both cumulative future and due.
        if (r.temporal === 'DUE') { c.dueClassified = 1; c[r.content ? 'dueBridged' : 'dueRetained'] = 1; }
        else if (r.temporal === 'FUTURE') { c.futureClassified = 1; c.futureQueued = 1; }
        else if (r.temporal === 'CAPACITY_DROPPED') { c.futureClassified = 1; c.capacityDropped = 1; }
        else if (r.temporal === 'FILTERED') c[r.reason === 'INVALID' ? 'temporalInvalid' : 'beforeStartFiltered'] = 1;
        else if (r.temporal === 'DEDUPLICATED') c.exactIdDeduped = 1;
        else if (['TEMPORAL_REPLACED', 'OWNER_TERMINAL'].includes(r.temporal)) c.temporalDiscarded = 1;
        else c.temporalRetained = 1;
        if (r.content === 'EXACT_ID_DUPLICATE') c.bridgeDeduped = 1;
        else if (r.content === 'ADMISSION_REJECTED') c.bridgeAdmissionRejected = 1;
        else if (r.content && r.content !== 'ADMITTED') c.bridgeFiltered = 1;
        else if (r.content === 'ADMITTED') {
            c.enqueued = 1; c.schedulerEligible = 1;
            if (r.confirmed) { c.selected = 1; c.launched = 1; c[r.commit ? 'displayed' : 'rendererRetained'] = 1; }
            else if (r.removed) c[r.removed === 'PRUNE_STALE' ? 'staleDropped' : 'schedulerExplicitDrop'] = 1;
            else c.schedulerRetained = 1;
        }
        return c;
    }
    function snapshot(scope) {
        drain();
        const missing = required.filter(k => !sources.has(k));
        for (const [kind, source] of sources) {
            try {
                if (source.status()?.state !== 'OBSERVING') fault('SOURCE_FAULT_' + kind);
                if (source.coverage() !== observedProofs[kind]) fault('SOURCE_NOTIFICATION_MISSING_' + kind);
            }
            catch (_) { fault('SOURCE_UNKNOWN_' + kind); }
        }
        const partial = scope !== undefined, counts = empty();
        const base = partial ? scopeTotals.get(scope) : folded;
        if (base) add(counts, base);
        let unassigned = 0, activeNative = 0, unresolved = 0;
        for (const r of records.values()) {
            const source = ownerPort.recognizeOccurrence(r.handle);
            if (!source || source.residence !== r.temporal) fault('TRANSITION_MISSING');
            if (!r.content && source?.association !== 'KNOWN_UNASSIGNED') fault('CONTENT_PROOF_MISSING');
            if (partial && r.association?.scope !== scope) continue;
            add(counts, vector(r));
            if (!r.association) unassigned++;
            if (r.commit && !r.native) activeNative++;
            if (!retirement.obligations(r.handle)?.complete) unresolved++;
            if (partial) { plus(counts, 'receivedActions', 1); plus(counts, 'parsed', 1); plus(counts, 'displayable', 1); }
        }
        if (!partial) { Object.assign(counts, parser); counts.displayable = parser.parsed; }
        if (ownerPort.observationStatus().unauditedOrigins !== 0) fault('AUDIT_PROOF_MISSING');
        const coverage = !missing.length && !faults.size && responses > 0 && (!partial || knownScopes.has(scope));
        // Never call the zero-defaulting canonical helper for missing coverage.
        const ledger = coverage ? core.computeReplayAccountingLedger(counts) : null;
        const stages = Object.freeze(Object.fromEntries(stageNames.map(name => [name, Object.freeze({
            coverage: coverage ? partial ? 'PARTIAL_PROJECTION' : 'COMPLETE' : 'UNKNOWN', equation: ledger?.stages[name] || null
        })])));
        return Object.freeze({ kind: partial ? 'SCOPE_PARTIAL_PROJECTION' : 'OWNER_DOCUMENT_CANDIDATE',
            status: coverage && ledger.valid ? partial ? 'PARTIAL' : 'CONSERVED' : 'INCOMPLETE', stages,
            ledger, observedCounts: Object.freeze(counts), missingSources: Object.freeze(missing), faults: Object.freeze([...faults]),
            acceptedResponses: responses, outerActions, observedFuturePromotions: observedPromotions,
            unassigned, unresolved, activeNative, retainedDiagnosticRecords: records.size, retired,
            scopeClosure: 'NOT_IMPLEMENTED' });
    }
    function retireComplete() {
        drain();
        if (busy) { fault('REENTRANT'); return 0; }
        let count = 0;
        for (const r of records.values()) {
            if (!retirement.obligations(r.handle)?.complete) continue;
            const terminalCertified = lifetime ? verifyLifetime(r) : false;
            if (!retirement.retire(r.handle)) { fault('RETIREMENT_FAILED'); continue; }
            if (lifetime) {
                if (!terminalCertified) lifetime.fault = true;
                if (r.association) {
                    const s = lifetime.scopes.get(r.association.scope);
                    if (!s || !terminalCertified || !Number.isSafeInteger(s.retired + 1)) lifetime.fault = true;
                    else s.retired++;
                }
            }
            const c = vector(r); add(folded, c);
            if (r.association) {
                const total = scopeTotals.get(r.association.scope) || empty();
                add(total, c); plus(total, 'receivedActions', 1); plus(total, 'parsed', 1); plus(total, 'displayable', 1);
                scopeTotals.set(r.association.scope, total);
            }
            records.delete(r.handle); if (r.item) items.delete(r.item); if (r.attempt) attempts.delete(r.attempt);
            if (retired < Number.MAX_SAFE_INTEGER) retired++; else fault('COUNTER_OVERFLOW');
            count++;
        }
        return count;
    }
    function finalized(kind, proof) {
        if (!proof) return null;
        try {
            const value = sources.get(kind)?.recognize(proof);
            return value?.state === 'FINAL_DELIVERED' ? value : null;
        } catch (_) { return null; }
    }
    function verifyLifetime(r) {
        if (!lifetime || !retirement.obligations(r.handle)?.complete) return false;
        const e = lifetime.records.get(r), audit = finalized('audit', e?.audit);
        if (audit?.event.acceptedOrigin !== r.origin || audit.event.ticket !== r.origin.ticket ||
            audit.event.occurrences[r.position] !== r.handle) return false;
        if (!r.association) {
            const t = finalized('temporal', e.temporal);
            return t?.event.occurrence === r.handle && t.event.origin === r.origin;
        }
        const c = finalized('content', e.content);
        if (c?.event.occurrence !== r.handle || c.identity.scope !== r.association.scope ||
            c.identity.pendingOwner !== r.association.pendingOwner) return false;
        if (terminalContent.has(c.event.disposition)) return c.event.item === null;
        const removed = finalized('item', e.removed);
        if (c.event.item !== r.item || removed?.event.item !== r.item || removed.event.type !== 'ITEM_REMOVED') return false;
        const request = finalized('item', e.request);
        if (!request) return !r.commit && removed.event.source !== 'CONFIRMED_LAUNCH';
        const attempt = request.event.attempt, result = finalized('renderer', e.RENDER_RESULT);
        if (request.event.item !== r.item || result?.identity.attempt !== attempt) return false;
        if (!result.created) {
            const rejected = finalized('item', e.rejected);
            return !r.commit && ['drop', 'defer'].includes(result.status) &&
                rejected?.event.item === r.item && rejected.event.attempt === attempt;
        }
        const confirm = finalized('item', e.confirmed), commit = finalized('renderer', e.RENDER_COMMIT);
        const native = finalized('renderer', e.RENDER_TERMINAL);
        return removed.event.source === 'CONFIRMED_LAUNCH' && confirm?.event.item === r.item &&
            confirm.event.attempt === attempt && commit?.identity === r.commit &&
            commit.identity.attempt === attempt && commit.identity.scope === r.association.scope &&
            commit.identity.pendingOwner === r.association.pendingOwner && native?.identity === commit.identity &&
            native.commitProof === e.RENDER_COMMIT && native.cleanup === true && ['FINISHED','REJECTED'].includes(native.settlement);
    }
    function connectLifetime() {
        // Historical aggregates cannot be retrofitted into terminal certificates.
        if (lifetime || busy || responses || retired || records.size || queued.length) return null;
        lifetime = { domain: null, fault: false, records: new WeakMap(), scopes: new WeakMap(), candidates: new WeakSet() };
        function read(scope, partial) {
            const projection = partial ? snapshot(scope) : snapshot();
            const s = partial ? lifetime.scopes.get(scope) : null;
            let live = 0, unresolved = 0;
            for (const r of records.values()) {
                if (partial && r.association?.scope !== scope) continue;
                live++; if (!verifyLifetime(r)) unresolved++;
            }
            const known = Boolean(lifetime.domain) && (!partial || Boolean(s));
            const covered = projection.status === (partial ? 'PARTIAL' : 'CONSERVED') && !lifetime.fault;
            const partition = !partial || (s && s.safe && s.associated === live + s.retired);
            const candidate = Object.freeze({ kind: partial ? 'SCOPE' : 'OWNER', domain: lifetime.domain,
                scope: partial ? scope : null, lease: s?.lease || null, association: s?.association || null,
                known, covered, terminalComplete: known && covered && partition && unresolved === 0,
                unresolved, projection });
            lifetime.candidates.add(candidate); return candidate;
        }
        return Object.freeze({ owner: () => read(null, false), scope: scope => read(scope, true),
            isDelivering() {
                try { return busy || [...sources.values()].some(s => s.isDelivering()); } catch (_) { return true; }
            },
            recognize: value => lifetime.candidates.has(value) ? value : null });
    }
    return Object.freeze({ bindSource, observe, snapshot, retireComplete, connectLifetime,
        wasConsumed: proof => consumed.has(proof),
        retainsItem: item => items.has(item),
        isDelivering: () => [...sources.values()].some(source => source.isDelivering()) });
}
module.exports = Object.freeze({ createTenStageCollector });
