'use strict';

// Dormant diagnostic lifetime only. Never authorizes or cancels Product work.
function createPrivateLifetime({ collector, ownerPort, pendingView }) {
    if (typeof collector?.connectLifetime !== 'function' || typeof ownerPort?.readLifetime !== 'function' ||
        typeof pendingView?.connectLifetime !== 'function') return null;
    const evidence = collector.connectLifetime();
    if (!evidence) return null;
    const certificates = new WeakMap(), closedScopes = new WeakMap();
    let ownerClosed = null, busy = false, fault = false;
    const readCertificate = certificate => certificates.get(certificate) || null;
    const pending = pendingView.connectLifetime(readCertificate);
    if (!pending) return null;
    const state = (kind, value, reason, extra = {}) => Object.freeze({ kind, state: value, reason, ...extra });
    function ownerSource(domain) {
        let source;
        try { source = ownerPort.readLifetime(); } catch (_) { return null; }
        if (!source || !domain || typeof source.phase !== 'string' || source.phase.length === 0 ||
            source.owner !== domain.owner || source.document !== domain.document ||
            source.binding !== domain.binding || !['inFlight','delivering','readTimerPending','deadlinePending','bootstrapPending','pendingFault',
                'pendingDelivery','terminalizing','terminalFinalized']
                .every(key => typeof source[key] === 'boolean')) return null;
        return source;
    }
    function clearStock(projection) {
        return projection.ledger?.valid === true && projection.ledger.lostUnaccounted === 0 && projection.ledger.overflowUnaccounted === 0 &&
            ['temporalRetained','dueRetained','futureQueued','bridgeRetained','pendingRetained',
                'schedulerRetained','launchRetained','rendererRetained'].every(key => projection.observedCounts[key] === 0);
    }
    function scope(handle) {
        const source = pending.inspect(handle);
        if (!source) return state('SCOPE', 'UNKNOWN', 'UNRECOGNIZED_SCOPE');
        const closed = closedScopes.get(handle);
        if (!source.retained) return state('SCOPE', closed ? 'EVICTED_CLOSED' : 'EVICTED_INCOMPLETE', 'ARCHIVE_EVICTED',
            { scope: handle, certificate: closed?.certificate || null });
        if (closed) return closed;
        if (busy || evidence.isDelivering()) return state('SCOPE', 'WAITING', 'SOURCE_DELIVERY_PENDING', { scope: handle });
        busy = true;
        try {
            const candidate = evidence.scope(handle);
            if (evidence.recognize(candidate) !== candidate || !candidate.known || !candidate.covered || fault || source.sourceFault)
                return state('SCOPE', 'INCOMPLETE', 'SOURCE_EVIDENCE_INCOMPLETE', { scope: handle });
            const original = pending.recognizeOriginalLease(candidate.lease);
            const lifecycle = ownerSource(candidate.domain);
            if (!lifecycle || original !== candidate.association || original.scope !== handle ||
                original.document !== source.original.document || original.pendingOwner !== source.pendingOwner ||
                candidate.domain.document !== source.original.document ||
                candidate.domain.binding.targetId !== source.original.targetId ||
                candidate.domain.binding.lifecycle !== source.original.lifecycle ||
                candidate.domain.binding.revision !== source.original.revision)
                return state('SCOPE', 'INCOMPLETE', 'ORIGINAL_BINDING_UNKNOWN', { scope: handle });
            if (lifecycle.pendingFault) return state('SCOPE', 'INCOMPLETE', 'OWNER_PENDING_FAULT', { scope: handle });
            if (lifecycle.pendingDelivery || lifecycle.terminalizing)
                return state('SCOPE', 'WAITING', 'SOURCE_FINALIZATION_PENDING', { scope: handle });
            if (lifecycle.phase === 'TERMINAL' && !lifecycle.terminalFinalized)
                return state('SCOPE', 'INCOMPLETE', 'OWNER_TERMINAL_FAILURE', { scope: handle });
            if (!source.terminal) return state('SCOPE', 'OPEN', 'SCOPE_NOT_TERMINAL', { scope: handle });
            if (!source.pendingFinalized || !source.pendingProof)
                return state('SCOPE', 'WAITING', 'PENDING_REMOVAL_UNRESOLVED', { scope: handle });
            if (!source.removalReady || !['VERIFIED','EMPTY_VERIFIED'].includes(source.pendingProof.proof))
                return state('SCOPE', 'INCOMPLETE', 'PENDING_REMOVAL_INCOMPLETE', { scope: handle });
            if (!candidate.terminalComplete || !clearStock(candidate.projection))
                return state('SCOPE', 'WAITING', 'ORIGINAL_TERMINAL_OBLIGATIONS_REMAIN', { scope: handle, unresolved: candidate.unresolved });
            const certificate = Object.freeze({});
            certificates.set(certificate, Object.freeze({ scope: handle, document: original.document,
                pendingOwner: original.pendingOwner, owner: candidate.domain.owner, valid: true,
                sourceCandidate: candidate, pendingProof: source.pendingProof }));
            if (!pending.commit(handle, certificate)) return state('SCOPE', 'INCOMPLETE', 'SOURCE_CLOSE_REJECTED', { scope: handle });
            const closedState = state('SCOPE', 'CLOSED', 'SOURCE_QUALIFIED_COMPLETE', { scope: handle, certificate,
                pendingProof: source.pendingProof.proof, ledger: candidate.projection.ledger });
            closedScopes.set(handle, closedState); return closedState;
        } catch (_) { fault = true; return state('SCOPE', 'INCOMPLETE', 'LIFETIME_FAULT', { scope: handle }); }
        finally { busy = false; }
    }
    function owner() {
        if (ownerClosed) return ownerClosed;
        if (busy || evidence.isDelivering()) return state('OWNER', 'WAITING', 'SOURCE_DELIVERY_PENDING');
        try {
            const candidate = evidence.owner(), lifecycle = ownerSource(candidate.domain);
            if (evidence.recognize(candidate) !== candidate || !lifecycle) return state('OWNER', 'INCOMPLETE', 'OWNER_BINDING_UNKNOWN');
            if (lifecycle.phase === 'TERMINAL' &&
                (lifecycle.inFlight || lifecycle.delivering || lifecycle.readTimerPending || lifecycle.deadlinePending || lifecycle.bootstrapPending ||
                    lifecycle.pendingDelivery || lifecycle.terminalizing))
                return state('OWNER', 'WAITING', 'OWNER_FINALIZATION_PENDING');
            if (lifecycle.phase === 'TERMINAL' && !lifecycle.terminalFinalized) return state('OWNER', 'INCOMPLETE', 'OWNER_TERMINAL_FAILURE');
            if (fault || lifecycle.pendingFault || !candidate.covered) return state('OWNER', 'INCOMPLETE', 'OWNER_EVIDENCE_INCOMPLETE');
            const archive = pending.archiveStatus();
            if (archive.sourceFault || archive.discardedIncomplete !== 0) return state('OWNER', 'INCOMPLETE', 'INCOMPLETE_ARCHIVE_HISTORY');
            if (lifecycle.phase !== 'TERMINAL') return state('OWNER', lifecycle.inFlight ? 'WAITING' : 'OPEN', 'OWNER_NOT_TERMINAL');
            for (const handle of pending.list()) {
                const original = scope(handle);
                if (!['CLOSED','EVICTED_CLOSED'].includes(original.state))
                    return state('OWNER', original.state === 'INCOMPLETE' || original.state === 'EVICTED_INCOMPLETE' ? 'INCOMPLETE' : 'WAITING', 'ORIGINAL_SCOPE_UNRESOLVED');
            }
            if (!candidate.terminalComplete || !clearStock(candidate.projection)) return state('OWNER', 'WAITING', 'OWNER_TERMINAL_OBLIGATIONS_REMAIN');
            const certificate = Object.freeze({});
            certificates.set(certificate, Object.freeze({ owner: candidate.domain.owner, document: candidate.domain.document,
                scope: null, pendingOwner: null, valid: true, sourceCandidate: candidate }));
            ownerClosed = state('OWNER', 'CLOSED', 'SOURCE_QUALIFIED_COMPLETE', { certificate, ledger: candidate.projection.ledger });
            return ownerClosed;
        } catch (_) { fault = true; return state('OWNER', 'INCOMPLETE', 'LIFETIME_FAULT'); }
    }
    function archives() {
        const entries = pending.list().filter(handle => pending.inspect(handle)?.retained).map(scope);
        const history = pending.archiveStatus();
        return Object.freeze({ entries: Object.freeze(entries), discardedIncomplete: history.discardedIncomplete,
            incomplete: fault || history.sourceFault || history.discardedIncomplete > 0 });
    }
    return Object.freeze({ scope, owner, archives, recognizeCertificate: readCertificate });
}
module.exports = Object.freeze({ createPrivateLifetime });
