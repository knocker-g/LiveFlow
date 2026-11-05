'use strict';

(function () {
// Dormant extension-private composition. Dependencies are the actual existing
// pending-selection, scheduler-runtime and diagnostic-scope-core implementations.
// No browser listener, public ACK parser or renderer teardown is registered here.
function createPrivatePendingScope({ document, route, targetId, lifecycle, revision,
    pending, scopeCore, createRuntime, runtimeOptions, runtimeGenerations = false, readRuntimeCoverage,
    terminalPath = 'LEGACY' }) {
    let documentId;
    if (!['LEGACY', 'DEFERRED_PRIVATE'].includes(terminalPath) ||
        !document || typeof document !== 'object' || !route || route.frameId !== 0 ||
        !Number.isSafeInteger(route.tabId) || route.tabId < 0 || typeof route.documentId !== 'string' ||
        !(documentId = route.documentId,
            /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(documentId) ||
            (typeof documentId === 'string' && /^[0-9A-Fa-f]{32}$/.test(documentId) && !/^0{32}$/.test(documentId))) ||
        ![lifecycle, revision].every(n => Number.isSafeInteger(n) && n >= 0) ||
        typeof targetId !== 'string' || typeof pending?.clonePendingOwner !== 'function' ||
        typeof pending.samePendingOwner !== 'function' || typeof scopeCore?.createScopes !== 'function' ||
        typeof createRuntime !== 'function') return null;
    const original = Object.freeze({ document, documentId: route.documentId, tabId: route.tabId,
        targetId, lifecycle, revision, terminalPath });
    const records = new Map(), operations = new Map();
    let runtime, scopes = null, connected = false, stream = 0, current = null, applying = null, collectorFault = false;
    let lifetimeReader = null;
    let productDepth = 0, productTerminal = false, draining = false, resuming = false, mutationUnknown = false, receiving = false;
    const productMutationFence = Object.freeze({
        // Immutable original producer choice, established before createRuntime.
        // This is not terminal-time activation or diagnostic participation.
        participates: () => original.terminalPath === 'DEFERRED_PRIVATE',
        enter() { if (!Number.isSafeInteger(++productDepth)) mutationUnknown = true; },
        leave() {
            if (productDepth < 1) { mutationUnknown = true; return; }
            productDepth--;
            if (productDepth || draining || resuming || mutationUnknown) return;
            let firstError, failed = false;
            // A presentation clear may itself cause a genuine terminal request.
            // The second terminal pass visits only unattempted queued work.
            for (const drain of [drainTerminalRemovals, drainPresentationClears, drainTerminalRemovals]) {
                try { drain(); } catch (error) { if (!failed) { firstError = error; failed = true; } }
            }
            if (failed) throw firstError;
            if (typeof runtime?.resumeArms === 'function') {
                resuming = true;
                try { runtime.resumeArms(); }
                finally { resuming = false; }
            }
        },
        active: () => productTerminal,
        quiescent: () => productDepth === 0 && !mutationUnknown,
        presentationBlocked: () => mutationUnknown || [...records.values()].some(record =>
            record.presentationClear && !['APPLIED', 'STALE_OR_NOT_FOUND', 'SUPERSEDED_BY_TERMINAL'].includes(record.presentationClear.result?.status)),
        mayArm: () => !mutationUnknown && !draining && ![...operations.values()].some(op =>
            op.queued || (op.product && op.result && !['APPLIED', 'STALE_OR_NOT_FOUND'].includes(op.result.status)))
    });
    const countValid = n => Number.isSafeInteger(n) && n >= 0;
    const sameItems = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);
    function observe(event) {
        if (event.type === 'PENDING_OWNER_REMOVED') {
            if (!applying || !pending.samePendingOwner(event.pendingOwner, applying.record.binding) ||
                event.reason !== 'FAIL_CLOSED' || !countValid(event.count) || event.count < 1 || (!runtimeGenerations && applying.events !== 0)) {
                collectorFault = true;
            } else { applying.events++; applying.observed += event.count; if (!countValid(applying.observed)) collectorFault = true; }
        }
        try { if (typeof runtimeOptions?.observe === 'function') runtimeOptions.observe(event); }
        catch { collectorFault = true; }
    }
    try { runtime = createRuntime({ ...runtimeOptions, observe, productMutationFence }); }
    catch { return null; }
    if (!runtime || typeof runtime.removePendingOwner !== 'function' || !runtime.queue ||
        typeof runtime.queue.snapshot !== 'function' || typeof runtime.status !== 'function') return null;

    function matching(items, binding) { return items.filter(item => pending.samePendingOwner(item.pendingOwner, binding)); }
    function scopeEvent(record, kind) {
        scopes.receive({ diagnosticScopeEpoch: record.epoch, pageLifecycleGeneration: original.lifecycle,
            diagnosticSequence: ++record.sequence, diagnosticTerminal: kind === 'TERMINAL', kind });
    }
    function open() {
        if (arguments.length || !connected || current || records.size >= 64) { collectorFault = true; return null; }
        const binding = pending.clonePendingOwner({ document: original.documentId, target: original.targetId,
            lifecycle: original.lifecycle, revision: original.revision, stream: ++stream });
        if (!binding) { collectorFault = true; return null; }
        const handle = Object.freeze({});
        const record = { binding, terminalPath: original.terminalPath, epoch: 0, sequence: 0, terminal: false, operation: null,
            proof: 'UNKNOWN', removed: 0, observed: 0, removalReady: false, accounting: null };
        if (!scopes) {
            scopes = scopeCore.createScopes(original.lifecycle, record, () => {}, {
                maximumBuffered: 64, maximumArchives: 8,
                // M3a proves pending removal only. No fabricated ten-stage
                // ledger can make this terminal archive CLOSED before M3b.
                closureReady: r => r.sealed === true || (r.removalReady && r.accounting !== null && !collectorFault),
                closureValid: r => r.sealed === true || (r.removalReady && r.accounting?.valid === true && !collectorFault)
            });
        } else record.epoch = scopes.open(original.lifecycle, record);
        records.set(handle, record); current = handle; scopeEvent(record, 'OPEN');
        return handle;
    }
    function retire(handle) {
        const record = records.get(handle);
        if (!record) return null;
        if (record.operation) return record.operation;
        if (operations.size >= 64) { collectorFault = true; return null; }
        const token = Object.freeze({});
        record.terminal = true; record.operation = token;
        if (current === handle) current = null;
        operations.set(token, { record, result: null, events: 0, observed: 0, running: false });
        return token;
    }
    function remove(token, privateRemoval = false) {
        const operation = operations.get(token);
        if (!operation) return Object.freeze({ status: 'NOT_APPLIED_UNKNOWN', count: 0, proof: 'UNKNOWN' });
        if (operation.result) return Object.freeze({ status: 'DUPLICATE', originalStatus: operation.result.status,
            count: 0, originalCount: operation.result.count, proof: operation.result.proof });
        if (operation.running) return Object.freeze({ status: 'IN_PROGRESS', count: 0, proof: 'UNKNOWN' });
        if (applying) {
            operation.result = Object.freeze({ status: 'FAILED', count: 0, proof: 'INCOMPLETE' });
            operation.record.proof = 'INCOMPLETE';
            scopeEvent(operation.record, 'TERMINAL');
            return operation.result;
        }
        const record = operation.record;
        let result = { status: 'FAILED', count: null }, proof = 'INCOMPLETE', cleanupError, cleanupThrew = false;
        operation.running = true; applying = operation;
        try {
            const before = runtime.queue.snapshot(), selected = matching(before, record.binding);
            const credit = runtime.queue.successfulLaunchSequence();
            result = runtime.removePendingOwner(record.binding);
            const after = runtime.queue.snapshot(), expected = before.filter(item => !selected.includes(item));
            const positive = result?.status === 'APPLIED' && result.count > 0 && result.count === selected.length &&
                (runtimeGenerations ? operation.events > 0 : operation.events === 1) && operation.observed === result.count;
            const empty = result?.status === 'STALE_OR_NOT_FOUND' && result.count === 0 && selected.length === 0 &&
                operation.events === 0 && operation.observed === 0;
            if (runtimeGenerations && (typeof readRuntimeCoverage !== 'function' || readRuntimeCoverage() !== true)) collectorFault = true;
            if (countValid(result?.count) && (positive || empty) && !collectorFault &&
                matching(after, record.binding).length === 0 && sameItems(after, expected) &&
                runtime.queue.successfulLaunchSequence() === credit) {
                proof = positive ? 'VERIFIED' : 'EMPTY_VERIFIED';
                record.removalReady = true; record.removed = result.count; record.observed = operation.observed;
            }
        } catch (error) { collectorFault = true; result = { status: 'FAILED', count: null };
            cleanupError = error; cleanupThrew = true; }
        finally { applying = null; operation.running = false; }
        operation.result = Object.freeze({ status: typeof result?.status === 'string' ? result.status : 'FAILED',
            count: countValid(result?.count) ? result.count : null, proof });
        record.removed = operation.result.count; record.observed = operation.observed;
        record.proof = proof;
        scopeEvent(record, 'TERMINAL'); scopes.reconcile();
        if (privateRemoval && cleanupThrew) throw cleanupError;
        return operation.result;
    }
    function terminal(handle) { const token = retire(handle); return remove(token); }
    function requestTerminal(handle) {
        if (original.terminalPath !== 'DEFERRED_PRIVATE') return Object.freeze({ status: 'NOT_APPLIED_UNKNOWN' });
        productTerminal = true;
        const token = retire(handle), operation = operations.get(token);
        if (!operation) return Object.freeze({ status: 'NOT_APPLIED_UNKNOWN' });
        if (operation.result || operation.running) return remove(token);
        operation.product = true; operation.queued = true;
        if (productDepth || draining || mutationUnknown || typeof runtime.mutationQuiescent !== 'function' ||
            !runtime.mutationQuiescent()) return Object.freeze({ status: 'DEFERRED' });
        drainTerminalRemovals();
        return operation.result || Object.freeze({ status: 'DEFERRED' });
    }
    function drainTerminalRemovals() {
        if (!productTerminal || productDepth || draining || mutationUnknown ||
            typeof runtime?.mutationQuiescent !== 'function' || !runtime.mutationQuiescent()) return;
        draining = true;
        let firstError, threw = false;
        try {
            // One forward pass in creation order over the existing bounded Map.
            // Reentrant appended intents remain bounded by retire's 64 limit.
            // No recursive rescan; a failed physical attempt remains final.
            for (const [token, operation] of operations) {
                if (!operation.queued || operation.result || operation.running) continue;
                operation.queued = false; operation.physicalAttempted = true;
                try { remove(token, true); }
                catch (error) { if (!threw) { firstError = error; threw = true; } }
            }
        } finally { draining = false; }
        if (threw) throw firstError;
    }
    function status() {
        const state = scopes?.status();
        return Object.freeze({ collectorFault, accounting: lifetimeReader ? 'PRIVATE_SCOPE_PROOF' : 'UNKNOWN',
            incomplete: lifetimeReader ? !state || state.incomplete || collectorFault : true,
            discardedIncomplete: state?.discardedIncomplete || 0,
            scopes: Object.freeze((state?.scopes || []).map(s => Object.freeze({ epoch: s.epoch, lifecycle: s.lifecycle,
                stream: s.value.binding.stream, state: s.state, terminal: s.value.terminal,
                pendingProof: s.value.proof, removed: s.value.removed, observed: s.value.observed,
                accounting: lifetimeReader && s.value.sealed === true ? 'PRIVATE_COMPLETE' : 'UNKNOWN' }))) });
    }
    const leases = new WeakMap();
    function lease(handle) {
        const record = records.get(handle);
        if (!record || record.terminal || current !== handle || collectorFault) return null;
        const value = Object.freeze({});
        leases.set(value, { record, association: Object.freeze({ document: original.document,
            scope: handle, pendingOwner: record.binding }) });
        return value;
    }
    function resolveLease(value) {
        const entry = leases.get(value);
        return entry && entry.kind !== 'PRODUCT' && !entry.record.terminal && records.get(current) === entry.record && !collectorFault
            ? entry.association : null;
    }
    function productLease(handle) {
        const record = records.get(handle);
        if (!connected || !record || record.terminal || current !== handle) return null;
        if (!record.productLease) {
            const value = Object.freeze({});
            leases.set(value, { kind: 'PRODUCT', record, association: Object.freeze({
                document: original.document, scope: handle, pendingOwner: record.binding }) });
            record.productLease = value;
        }
        return record.productLease;
    }
    function resolveProductLease(value) {
        const entry = leases.get(value);
        return connected && entry?.kind === 'PRODUCT' && !entry.record.terminal &&
            current === entry.association.scope && records.get(current) === entry.record
            ? entry.association : null;
    }
    function presentationWorkAllowed(value) {
        return Boolean(resolveProductLease(value)) && !productMutationFence.presentationBlocked();
    }
    function withProductReceiver(value, operation) {
        if (receiving || typeof operation !== 'function' || !presentationWorkAllowed(value)) return;
        receiving = true;
        productMutationFence.enter();
        let threw = false;
        try { return operation(); }
        catch (error) { threw = true; throw error; }
        finally { receiving = false; try { productMutationFence.leave(); } catch (error) { if (!threw) throw error; } }
    }
    function presentationCleanupStatus(value) {
        const entry = leases.get(value), operation = entry?.kind === 'PRODUCT' && entry.record.presentationClear;
        return operation?.result || Object.freeze({ status: operation ? 'DEFERRED' : 'NOT_APPLIED_UNKNOWN' });
    }
    function withPresentationCleanup(value, visualCleanup) {
        const association = resolveProductLease(value), record = association && records.get(association.scope);
        if (original.terminalPath !== 'DEFERRED_PRIVATE' || !record || typeof visualCleanup !== 'function')
            return Object.freeze({ status: 'NOT_APPLIED_UNKNOWN' });
        const previous = record.presentationClear;
        if (previous && (!previous.result || previous.result.status === 'FAILED')) return presentationCleanupStatus(value);
        const operation = { running: false, ready: false, attempted: false, result: null };
        record.presentationClear = operation;
        productMutationFence.enter();
        let threw = false;
        try { visualCleanup(); operation.ready = true; }
        catch (error) { threw = true; operation.result = Object.freeze({ status: 'FAILED' }); throw error; }
        finally { try { productMutationFence.leave(); } catch (error) { if (!threw) throw error; } }
        return presentationCleanupStatus(value);
    }
    function drainPresentationClears() {
        if (productDepth || draining || resuming || mutationUnknown ||
            typeof runtime?.mutationQuiescent !== 'function' || !runtime.mutationQuiescent()) return;
        draining = true;
        let firstError, threw = false;
        try {
            for (const record of records.values()) {
                const operation = record.presentationClear;
                if (!operation || operation.result || !operation.ready || operation.running || operation.attempted) continue;
                if (record.terminal) {
                    operation.result = Object.freeze({ status: 'SUPERSEDED_BY_TERMINAL' }); continue;
                }
                operation.running = true; operation.attempted = true;
                try {
                    const result = runtime.removePendingOwner(record.binding);
                    operation.result = ['APPLIED', 'STALE_OR_NOT_FOUND'].includes(result?.status) &&
                        Number.isSafeInteger(result.count) && result.count >= 0
                        ? Object.freeze({ status: result.status, count: result.count }) : Object.freeze({ status: 'FAILED' });
                } catch (error) {
                    operation.result = Object.freeze({ status: 'FAILED' });
                    if (!threw) { firstError = error; threw = true; }
                } finally { operation.running = false; }
            }
        } finally { draining = false; }
        if (threw) throw firstError;
    }
    function connectLifetime(recognize) {
        if (lifetimeReader || records.size || operations.size || typeof recognize !== 'function') return null;
        lifetimeReader = recognize;
        function inspect(handle) {
            const record = records.get(handle);
            if (!record) return null;
            const state = scopes.status(), operation = operations.get(record.operation);
            return Object.freeze({ original, scope: handle, pendingOwner: record.binding, terminal: record.terminal,
                retained: state.scopes.some(s => s.epoch === record.epoch), sourceFault: collectorFault,
                pendingProof: operation?.result || null, pendingFinalized: operation?.running === false && applying === null,
                removalReady: record.removalReady, sealed: record.certificate || null });
        }
        return Object.freeze({ inspect,
            list: () => Object.freeze([...records.keys()]),
            archiveStatus() {
                if (!scopes) return Object.freeze({ discardedIncomplete: 0, sourceFault: collectorFault });
                const count = scopes.status().discardedIncomplete;
                const known = Number.isSafeInteger(count) && count >= 0;
                return Object.freeze({ discardedIncomplete: known ? count : null, sourceFault: collectorFault || !known });
            },
            recognizeOriginalLease(value) {
                const entry = leases.get(value);
                return entry?.kind !== 'PRODUCT' ? entry?.association || null : null;
            },
            commit(handle, certificate) {
                const record = records.get(handle), source = inspect(handle);
                if (!record || !source?.retained) return false;
                if (record.sealed) return record.certificate === certificate;
                let evidence;
                try { evidence = lifetimeReader(certificate); } catch (_) { return false; }
                if (!evidence || evidence.scope !== handle || evidence.document !== original.document ||
                    evidence.pendingOwner !== record.binding || evidence.valid !== true || !record.terminal ||
                    !record.removalReady || !source.pendingFinalized || collectorFault ||
                    !['VERIFIED','EMPTY_VERIFIED'].includes(source.pendingProof?.proof)) return false;
                record.accounting = Object.freeze({ valid: true, certificate });
                scopes.reconcile();
                if (!scopes.status().scopes.some(s => s.epoch === record.epoch && s.state === 'CLOSED')) return false;
                record.sealed = true; record.certificate = certificate;
                return true;
            }
        });
    }
    const view = Object.freeze({ open, retire, remove, terminal, status, lease, resolveLease,
        productLease, resolveProductLease, connectLifetime, requestTerminal, drainTerminalRemovals,
        presentationWorkAllowed, withProductReceiver, withPresentationCleanup, presentationCleanupStatus });
    return Object.freeze({
        connect(binding, browserRoute) {
            if (connected || !binding || binding.document !== original.document || binding.targetId !== original.targetId ||
                binding.lifecycle !== original.lifecycle || binding.revision !== original.revision ||
                !browserRoute || browserRoute.documentId !== original.documentId || browserRoute.tabId !== original.tabId || browserRoute.frameId !== 0) return null;
            connected = true; return view;
        },
        presentation: Object.freeze({
            enqueue(handle, payload, options) {
                const record = records.get(handle);
                if (!record || record.terminal || current !== handle || productMutationFence.presentationBlocked()) return false;
                productMutationFence.enter();
                let threw = false;
                try { return runtime.enqueue({ ...payload, pendingOwner: record.binding }, options); }
                catch (error) { threw = true; throw error; }
                finally { try { productMutationFence.leave(); } catch (error) { if (!threw) throw error; } }
            },
            pendingCount(handle) {
                const record = records.get(handle);
                if (!record || collectorFault) return null;
                try {
                    const items = runtime.queue.snapshot();
                    if (items.some(item => !pending.clonePendingOwner(item.pendingOwner))) return null;
                    return matching(items, record.binding).length;
                } catch { return null; }
            }
        })
    });
}

if (typeof module !== 'undefined' && module.exports) module.exports = Object.freeze({ createPrivatePendingScope });
})();
