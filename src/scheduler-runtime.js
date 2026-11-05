(function (global) {
    const foundations = typeof module !== 'undefined' && module.exports ? require('./scheduler-foundations.js') : global.LiveFlowSchedulerFoundations;
    const pending = typeof module !== 'undefined' && module.exports ? require('./pending-selection.js') : global.LiveFlowPendingSelection;
    const machine = typeof module !== 'undefined' && module.exports ? require('./scheduler-state-machine.js') : global.LiveFlowSchedulerStateMachine;
    const geometry = typeof module !== 'undefined' && module.exports ? require('./geometry-adapter.js') : global.LiveFlowGeometryAdapter;
    const normalOverlap = typeof module !== 'undefined' && module.exports ? require('./normal-overlap-policy.js') : global.LiveFlowNormalOverlapPolicy;
    const privateEvaluations = new WeakMap();
    const privateRuntimeSources = new WeakMap();

    function classifyLaunchGapClass(elapsedMsec) {
        if (!Number.isFinite(elapsedMsec) || elapsedMsec < 0) return 'NONE';
        if (elapsedMsec < 500) return 'SHORT';
        if (elapsedMsec <= 1500) return 'NOTICEABLE';
        return 'LONG';
    }

    function classifyLaunchGapCause({ pendingCount, nearestFutureClass = 'NONE', geometryBlocked = false,
        collisionBlocked = false, selectionNone = false, staleOnly = false } = {}) {
        if (geometryBlocked) return 'GEOMETRY';
        if (collisionBlocked) return 'COLLISION_BLOCKED';
        if (selectionNone) return 'SELECTION_NONE';
        if (staleOnly) return 'STALE_ONLY';
        if (Number.isInteger(pendingCount) && pendingCount > 0) return 'PACING';
        if (nearestFutureClass !== 'NONE' && nearestFutureClass !== 'UNKNOWN') return 'WAITING_FOR_FUTURE';
        return 'NO_DUE_COMMENT';
    }

    function createSchedulerRuntime(options = {}) {
        const { clock, scheduleOneShot, cancelOneShot, generation, geometryAdapter,
            sourceActivityBinding, sourceActivityTime, candidateProof, launch, config, observe } = options;
        const evaluationObserver = privateEvaluations.get(options);
        const itemObserver = evaluationObserver?.items || null;
        const fence = options.productMutationFence || null;
        if (options.prepareLaunch !== undefined && (typeof options.prepareLaunch !== 'function' ||
            !fence || typeof fence.participates !== 'function' || fence.participates() !== true)) return null;
        let mutationDepth = 0, productScheduler = null, productCleared = false;
        function productOperation(operation) {
            if (!fence) return operation();
            mutationDepth++; fence.enter();
            let primary, threw = false;
            try { return operation(); }
            catch (error) { primary = error; threw = true; throw error; }
            finally {
                mutationDepth--;
                try { fence.leave(); }
                catch (error) { if (!threw) throw error; }
            }
        }
        // The private diagnostic wrapper uses this same Product stack, outside
        // proof finalization/receiver return. Diagnostic health is never read.
        if (evaluationObserver) evaluationObserver.productOperation = productOperation;
        if (typeof clock !== 'function' || typeof scheduleOneShot !== 'function' || typeof cancelOneShot !== 'function' ||
            typeof generation !== 'function' || (config?.sourceActivity &&
                (typeof sourceActivityBinding !== 'function' || typeof sourceActivityTime !== 'function')) ||
            !geometryAdapter || typeof geometryAdapter.refresh !== 'function' ||
            typeof geometryAdapter.status !== 'function' || typeof candidateProof !== 'function' || typeof launch !== 'function' || !config) return null;
        const queue = itemObserver ? pending.createPrivatePendingQueue(itemObserver) : pending.createPendingQueue();
        const policy = pending.createSpecialPreferencePolicy();
        const launchProofs = new WeakMap();
        const itemDiagnosticState = new WeakMap();
        let physicalSaturationSeen = false;
        let sourceActivityState = null;
        let sourceActivityBindingReset = false;
        let sourceActivityFacts = [];
        let sourceActivityWindow = null;
        let sourceActivityFactsRevision = 0;
        let sourceActivityEvaluationKey = null;
        geometryAdapter.refresh();

        function sameActivityBinding(left, right) {
            return left && right && left.target === right.target && left.timeline === right.timeline &&
                left.generation === right.generation;
        }

        function observeSourceActivity({ eventBinding, mediaTimeMs, windowStartMs, windowEndMs, facts } = {}) {
            if (!config.sourceActivity || typeof sourceActivityBinding !== 'function') return null;
            const currentBinding = sourceActivityBinding();
            const ownershipReset = Boolean(sourceActivityState && !sameActivityBinding(sourceActivityState.binding, currentBinding));
            if (!sourceActivityState || ownershipReset) {
                sourceActivityState = foundations.createSourceActivityState(currentBinding);
                sourceActivityFacts = [];
                sourceActivityWindow = null;
                sourceActivityFactsRevision = 0;
                sourceActivityEvaluationKey = null;
            }
            if (!sourceActivityState) return null;
            const accepted = sameActivityBinding(eventBinding, currentBinding) && Array.isArray(facts) &&
                Number.isFinite(mediaTimeMs);
            if (accepted) {
                sourceActivityFacts.push(...facts.filter((fact) => fact && fact.displayable === true &&
                    fact.temporalClass === 'CURRENT_WINDOW' && Number.isFinite(fact.mediaTimeMs)));
                sourceActivityFacts = sourceActivityFacts.filter((fact) => fact.mediaTimeMs >= windowStartMs &&
                    fact.mediaTimeMs <= windowEndMs);
                sourceActivityWindow = Object.freeze({ currentBinding, eventBinding, mediaTimeMs, windowStartMs, windowEndMs });
                sourceActivityFactsRevision += 1;
            }
            sourceActivityBindingReset = ownershipReset;
            return Object.freeze({ accepted, bindingReset: ownershipReset,
                currentWindowCount: sourceActivityFacts.length });
        }

        function evaluateCurrentSourceActivity() {
            if (!sourceActivityState || !sourceActivityWindow) return sourceActivityState;
            const currentBinding = sourceActivityBinding();
            if (!sameActivityBinding(sourceActivityState.binding, currentBinding)) {
                sourceActivityState = foundations.createSourceActivityState(currentBinding);
                sourceActivityFacts = [];
                sourceActivityWindow = null;
                sourceActivityFactsRevision = 0;
                sourceActivityEvaluationKey = null;
                sourceActivityBindingReset = true;
                if (!sourceActivityState) return null;
                return sourceActivityState;
            }
            const currentMediaTimeMs = sourceActivityTime();
            if (!Number.isFinite(currentMediaTimeMs) || currentMediaTimeMs < sourceActivityWindow.mediaTimeMs) {
                return sourceActivityState;
            }
            const mediaTimeDelta = currentMediaTimeMs - sourceActivityWindow.mediaTimeMs;
            const currentWindow = Object.freeze({
                ...sourceActivityWindow,
                currentBinding,
                windowStartMs: sourceActivityWindow.windowStartMs + mediaTimeDelta,
                windowEndMs: sourceActivityWindow.windowEndMs + mediaTimeDelta
            });
            sourceActivityFacts = sourceActivityFacts.filter((fact) => fact.mediaTimeMs >= currentWindow.windowStartMs &&
                fact.mediaTimeMs <= currentWindow.windowEndMs);
            const evaluationKey = `${currentWindow.windowStartMs}:${currentWindow.windowEndMs}:${sourceActivityFactsRevision}`;
            if (evaluationKey === sourceActivityEvaluationKey) return sourceActivityState;
            sourceActivityEvaluationKey = evaluationKey;
            const evaluated = foundations.evaluateSourceActivity(sourceActivityState, {
                ...currentWindow,
                facts: sourceActivityFacts
            }, config.sourceActivity);
            if (!evaluated) return sourceActivityState;
            sourceActivityState = evaluated.state;
            sourceActivityBindingReset = sourceActivityBindingReset || evaluated.bindingReset;
            notify({ type: 'SOURCE_ACTIVITY_OBSERVED', sourceActivityBand: evaluated.state.band,
                accepted: evaluated.accepted, bindingReset: sourceActivityBindingReset });
            return sourceActivityState;
        }

        function notify(event) {
            if (typeof observe !== 'function') return;
            try { observe(Object.freeze(event)); } catch {}
        }

        function isSafe(item, densityLevel) {
            if (!evaluationObserver) return evaluateItem(item, densityLevel, null);
            const evaluation = { outcome: 'NOT_SAFE' };
            try {
                const result = evaluateItem(item, densityLevel, evaluation);
                if (result === true) evaluation.outcome = 'SAFE';
                else if (result?.discard === true) evaluation.outcome = 'UNREPRESENTABLE_SPECIAL';
                return result;
            } catch (error) {
                evaluation.outcome = 'THREW';
                throw error;
            } finally { evaluationObserver.deliver(item, evaluation.outcome); }
        }

        function evaluateItem(item, densityLevel, evaluation) {
            const itemState = itemDiagnosticState.get(item) || { evaluated: 0, collisionBlocked: false, safeSeen: false, alreadyStaleOnEnqueue: false };
            itemState.evaluated += 1;
            itemDiagnosticState.set(item, itemState);
            const refreshed = geometryAdapter.refresh();
            const geometryState = refreshed.geometry;
            if (geometryState?.state === geometry.GEOMETRY_STATES.UNKNOWN && geometryState.capabilityAvailable !== false) {
                if (evaluation) evaluation.outcome = 'GEOMETRY_UNKNOWN';
                notify({ type: 'GEOMETRY_UNKNOWN' });
                return false;
            }
            const densityPolicy = foundations.getDensityVisualPolicy(densityLevel);
            const allowanceClass = densityPolicy?.collisionAllowanceClass;
            const allowance = allowanceClass ? config.collisionAllowances?.[allowanceClass] : null;
            const proof = candidateProof(item, geometryState, densityPolicy);
            if (proof?.unrepresentableSpecial === true) {
                notify({ type: 'UNREPRESENTABLE_SPECIAL' });
                return Object.freeze({ discard: true, reason: 'UNREPRESENTABLE_SPECIAL' });
            }
            if (!Array.isArray(proof?.candidates) || !Array.isArray(proof.activeComments) || !allowance) {
                const reasonType = {
                    ACTIVE_DANMAKU_HORIZONTAL: 'COLLISION_ACTIVE_DANMAKU',
                    SUBTITLE_EXCLUSION: 'COLLISION_SUBTITLE',
                    CANDIDATE_GEOMETRY_INVALID: 'COLLISION_CANDIDATE_GEOMETRY',
                    NO_USABLE_LANE: 'COLLISION_NO_USABLE_LANE'
                }[proof?.blockedReason] || 'COLLISION_OTHER';
                notify({ type: reasonType });
                notify({ type: 'COLLISION_BLOCKED' });
                if (reasonType === 'COLLISION_ACTIVE_DANMAKU') itemState.collisionBlocked = true;
                return false;
            }
            let subtitleBlocked = 0;
            let collisionBlocked = 0;
            for (const candidate of proof.candidates) {
                if (!foundations.isOutsideHardExclusions({ ...candidate.rectangle, ...(candidate.clearanceRectangle || {}) }, geometryState.exclusionRegions)) {
                    subtitleBlocked += 1;
                    continue;
                }
                const collision = config.normalOverlapPolicy
                    ? normalOverlap.prove(candidate.rectangle, proof.activeComments, allowance, config.normalOverlapPolicy, ['DENSE', 'MAX_READABLE'].includes(densityLevel))
                    : foundations.proveBoundedCollisionSafe(candidate.rectangle, proof.activeComments, allowance);
                if (!collision.safe) {
                    collisionBlocked += 1;
                    continue;
                }
                launchProofs.set(item, Object.freeze({ ...candidate, density: densityLevel, geometryRevision: refreshed.revision }));
                itemState.safeSeen = true;
                return true;
            }
            if (subtitleBlocked === proof.candidates.length) notify({ type: 'COLLISION_SUBTITLE' });
            else if (collisionBlocked > 0) notify({ type: 'COLLISION_ACTIVE_DANMAKU' });
            else notify({ type: 'COLLISION_NO_USABLE_LANE' });
            if (proof.candidates.length > 0) {
                notify({ type: 'COLLISION_BLOCKED' });
                if (collisionBlocked > 0) itemState.collisionBlocked = true;
            }
            if (densityLevel === 'MAX_READABLE' && collisionBlocked === proof.candidates.length && collisionBlocked > 0) {
                physicalSaturationSeen = true;
            }
            return false;
        }

        const createScheduler = itemObserver ? options => machine.createPrivateScheduler(options, itemObserver) : machine.createScheduler;
        const scheduler = createScheduler({
            queue,
            clock,
            scheduleOneShot: fence ? (fn, delay) => scheduleOneShot((...args) => productOperation(() => fn(...args)), delay) : scheduleOneShot,
            cancelOneShot,
            generation,
            geometryRevision: () => geometryAdapter.status().revision,
            isSafe,
            launch: (item) => {
                const proof = launchProofs.get(item) || null;
                launchProofs.delete(item);
                return launch(item.payload, proof) === true;
            },
            ...(typeof options.prepareLaunch === 'function' ? { prepareLaunch(item) {
                const proof = launchProofs.get(item) || null;
                launchProofs.delete(item);
                return options.prepareLaunch(item.payload, proof);
            } } : {}),
            policy,
            config,
            ...(fence ? {
                onEvaluationExit: () => fence.active() ||
                    (typeof fence.presentationBlocked === 'function' && fence.participates() === true),
                mayArm: selection => {
                    if (typeof fence.presentationBlocked === 'function' && fence.participates() === true) {
                        if (fence.presentationBlocked() || !fence.mayArm()) return false;
                        // A selection is already inside its own genuine stack.
                        return selection === true || (mutationDepth === 0 && fence.quiescent());
                    }
                    return !fence.active() || (fence.mayArm() &&
                        (selection === true || (mutationDepth === 0 && fence.quiescent())));
                }
            } : {}),
            operations: {
                transitionDensity(state, pressure, densityConfig) {
                    const currentBinding = typeof sourceActivityBinding === 'function' ? sourceActivityBinding() : null;
                    if (!sourceActivityState && currentBinding) {
                        sourceActivityState = foundations.createSourceActivityState(currentBinding);
                    }
                    if (!sourceActivityState) return foundations.transitionDensity(state, pressure, densityConfig);
                    evaluateCurrentSourceActivity();
                    return foundations.transitionPresentationDensity(state, {
                        sourceActivityBand: sourceActivityState.band,
                        pressure
                    }, densityConfig);
                },
                classifyStale(item) {
                    const state = itemDiagnosticState.get(item);
                    if (state?.alreadyStaleOnEnqueue) return 'ALREADY_STALE_ON_ENQUEUE';
                    if (state?.collisionBlocked) return 'COLLISION_BLOCKED';
                    if (state?.safeSeen) return 'PACING_WAIT';
                    if (!state || state.evaluated === 0) return 'SELECTION_MISS';
                    return 'OTHER';
                },
                relieveSaturation({ density } = {}) {
                    if (density !== 'MAX_READABLE' || physicalSaturationSeen !== true) return Object.freeze([]);
                    physicalSaturationSeen = false;
                    const dropped = itemObserver ? itemObserver.inContext('RUNTIME_SATURATION', () => queue.relieveSaturation(1)) : queue.relieveSaturation(1);
                    for (const item of dropped) itemDiagnosticState.delete(item);
                    if (dropped.length > 0) notify({ type: 'CAPACITY_DROPPED', count: dropped.length,
                        semanticClass: 'NORMAL', reason: 'PHYSICAL_SATURATION' });
                    return dropped;
                }
            },
            observe(event) {
                if (event?.type === 'EVALUATING') physicalSaturationSeen = false;
                notify(event);
            }
        });
        productScheduler = scheduler;

        function enqueue(payload, { id, enqueuedAt, rendererType, footprint } = {}) {
            const item = pending.createPendingItem({ id, enqueuedAt, rendererType, payload, footprint });
            if (item && evaluationObserver?.own) evaluationObserver.own(item);
            if (!item || !scheduler.enqueue(item)) return false;
            itemDiagnosticState.set(item, {
                evaluated: 0,
                collisionBlocked: false,
                safeSeen: false,
                alreadyStaleOnEnqueue: clock() - enqueuedAt > config.maxPendingAge
            });
            const emergencyDropped = itemObserver ? itemObserver.inContext('RUNTIME_CAPACITY', () => queue.enforceHardCount(config.maxPendingCount)) : queue.enforceHardCount(config.maxPendingCount);
            for (const dropped of emergencyDropped) itemDiagnosticState.delete(dropped);
            if (emergencyDropped.length > 0) notify({ type: 'EMERGENCY_PENDING_DROPPED', count: emergencyDropped.length,
                reason: 'MAX_PENDING_COUNT' });
            return true;
        }

        function clear() {
            scheduler.stop();
            const cleared = itemObserver ? itemObserver.inContext('RUNTIME_CLEAR', () => queue.enforceHardCount(0)) : queue.enforceHardCount(0);
            for (const item of cleared) itemDiagnosticState.delete(item);
            if (cleared.length > 0) notify({ type: 'PENDING_CLEARED', count: cleared.length,
                pendingCount: 0, reason: 'LIFECYCLE_SUPPRESSED' });
        }

        function removePendingOwner(binding) {
            // Reentrant mutation during launch/evaluation cannot safely invalidate a selected item.
            if (scheduler.status().state === 'EVALUATING') return Object.freeze({ status: 'FAILED', count: 0 });
            const result = itemObserver ? itemObserver.inContext('RUNTIME_OWNER_REMOVAL', () => queue.removePendingOwner(binding)) : queue.removePendingOwner(binding);
            for (const item of result.removed) { itemDiagnosticState.delete(item); launchProofs.delete(item); }
            if (result.removed.length) {
                if (queue.snapshot().length === 0) scheduler.stop();
                notify({ type: 'PENDING_OWNER_REMOVED', count: result.removed.length,
                    pendingCount: queue.snapshot().length, reason: 'FAIL_CLOSED',
                    pendingOwner: pending.clonePendingOwner(binding) });
            }
            return Object.freeze({ status: result.status, count: result.removed.length });
        }

        const api = {
            enqueue,
            observeSourceActivity,
            clear,
            removePendingOwner,
            markGeometryDirty: geometryAdapter.markDirty,
            status: () => Object.freeze({ ...scheduler.status(), pendingCount: queue.snapshot().length,
                sourceActivityBand: sourceActivityState?.band || 'LOW', sourceActivityBindingReset }),
            queue
        };
        if (!fence) return Object.freeze(api);
        const readOnlyQueue = new Set(['snapshot', 'successfulLaunchSequence']);
        const productQueue = Object.freeze(Object.fromEntries(Object.entries(queue).map(([name, method]) =>
            [name, readOnlyQueue.has(name) ? method : (...args) => productOperation(() => {
                productCleared = false; return method(...args);
            })])));
        return Object.freeze({ ...Object.fromEntries(Object.entries(api).filter(([name]) => name !== 'queue').map(([name, method]) =>
            [name, name === 'status' ? method : (...args) => productOperation(() => {
                productCleared = false;
                const value = method(...args);
                if (name === 'clear') productCleared = true;
                return value;
            })])),
            queue: productQueue,
            mutationQuiescent: () => mutationDepth === 0,
            replacementReady: () => productCleared && mutationDepth === 0 && queue.snapshot().length === 0,
            resumeArms: () => productScheduler.resumeArm() });
    }

    // Extension-private construction only. The browser/global constructor cannot
    // install this observer through a page-visible options field or event API.
    function createPrivateSchedulerRuntime(options, onEvaluation, onItemEvent) {
        const faults = new Set();
        let delivering = false, attempts = 0;
        const observeItems = arguments.length >= 3;
        let itemAttempts = 0, context = 'DIRECT_QUEUE';
        const removedItems = new WeakSet();
        const itemProofs = new WeakMap(), itemSequences = new WeakMap();
        const evaluationProofs = new WeakMap();
        let proofDepth = 0, operationProofs = null;
        const sourceIdentity = Object.freeze({}), ownedItems = new WeakSet(), sealProofs = new WeakMap();
        const activeTimers = new Set();
        let sourceSealed = false, cleared = false, sealProof = null, sealedFaultReceiver = null;
        const sourceOperation = operation => {
            const product = privateEvaluations.get(configured)?.productOperation;
            return product ? product(operation) : operation();
        };
        function afterSeal() {
            faults.add('SOURCE_AFTER_SEAL');
            try { sealedFaultReceiver?.(); } catch (_) { faults.add('SEALED_FAULT_RECEIVER_THROWN'); }
        }
        function proofOperation(operation) {
            const outer = proofDepth === 0;
            if (outer) operationProofs = [];
            proofDepth++;
            let returned = false;
            try { const value = operation(); returned = true; return value; }
            catch (error) { faults.add('SOURCE_THROWN'); throw error; }
            finally {
                proofDepth--;
                if (outer) {
                    for (const receipt of operationProofs) if (receipt.state === 'PENDING')
                        receipt.state = returned && !faults.size ? 'FINAL_DELIVERED' : 'UNKNOWN';
                    operationProofs = null;
                }
            }
        }
        if (typeof onEvaluation !== 'function') faults.add('INVALID_OBSERVER');
        if (observeItems && typeof onItemEvent !== 'function') faults.add('INVALID_ITEM_OBSERVER');
        const items = observeItems ? Object.freeze({
            assertMutable() {
                if (delivering) { faults.add('OBSERVER_REENTRANT'); throw new TypeError('PRIVATE_OBSERVER_REENTRANCY'); }
            },
            sourceFault() { faults.add('SOURCE_THROWN'); },
            inContext(value, operation) {
                const before = context; context = value;
                try { return operation(); }
                catch (error) { faults.add('SOURCE_THROWN'); throw error; }
                finally { context = before; }
            },
            deliverItem(item, type, source, attempt = null, reason = null) {
                if (sourceSealed) { afterSeal(); return; }
                if (delivering) { faults.add('OBSERVER_REENTRANT'); return; }
                if (itemAttempts >= Number.MAX_SAFE_INTEGER) { faults.add('COUNTER_OVERFLOW'); return; }
                itemAttempts++;
                if (type.endsWith('THROWN') || type === 'LAUNCH_CONFIRMATION_REJECTED') faults.add('LAUNCH_INCOMPLETE');
                if (type === 'ITEM_REMOVED') {
                    if (removedItems.has(item)) { faults.add('DUPLICATE_ITEM_REMOVAL'); return; }
                    removedItems.add(item);
                }
                delivering = true;
                const sequence = (itemSequences.get(item) || 0) + 1;
                if (!Number.isSafeInteger(sequence)) { faults.add('COUNTER_OVERFLOW'); delivering = false; return; }
                itemSequences.set(item, sequence);
                const event = Object.freeze({ item, type, source, attempt, reason, operation: context });
                const proof = Object.freeze({}), receipt = { kind: 'ITEM', state: 'PENDING', event, sequence };
                itemProofs.set(proof, receipt);
                if (operationProofs && operationProofs.length < 1024) operationProofs.push(receipt);
                else { receipt.state = 'UNKNOWN'; faults.add('PROOF_BUFFER_EXHAUSTED'); }
                try {
                    if (typeof onItemEvent === 'function') {
                        const returned = onItemEvent(event, proof);
                        if (returned !== null && ['object', 'function'].includes(typeof returned)) { receipt.state = 'UNKNOWN'; faults.add('ITEM_OBSERVER_ASYNC'); }
                    }
                }
                catch (_) { receipt.state = 'FAILED'; faults.add('ITEM_OBSERVER_THROWN'); }
                finally {
                    delivering = false;
                }
            }
        }) : null;
        const configured = { ...options };
        if (observeItems) {
            const schedule = configured.scheduleOneShot;
            const cancel = configured.cancelOneShot;
            configured.scheduleOneShot = (callback, delay) => {
                const token = {};
                activeTimers.add(token);
                try { token.handle = schedule((...args) => {
                    activeTimers.delete(token);
                    if (sourceSealed) afterSeal();
                    return sourceOperation(() => proofOperation(() => callback(...args)));
                }, delay);
                    if (token.handle === null || token.handle === undefined ||
                        [...activeTimers].some(other => other !== token && other.handle === token.handle)) faults.add('TIMER_IDENTITY_UNKNOWN');
                    return token.handle;
                }
                catch (error) { activeTimers.delete(token); throw error; }
            };
            configured.cancelOneShot = handle => {
                const result = cancel(handle);
                for (const token of activeTimers) if (token.handle === handle) activeTimers.delete(token);
                return result;
            };
        }
        privateEvaluations.set(configured, {
            items,
            own: observeItems ? item => ownedItems.add(item) : null,
            deliver(item, outcome) {
                if (sourceSealed) { afterSeal(); return; }
                if (observeItems && outcome === 'THREW') faults.add('SOURCE_THROWN');
                if (delivering) { faults.add('OBSERVER_REENTRANT'); return; }
                if (attempts >= Number.MAX_SAFE_INTEGER) { faults.add('COUNTER_OVERFLOW'); return; }
                attempts++;
                delivering = true;
                const proof = observeItems ? Object.freeze({}) : undefined;
                const receipt = observeItems ? { kind: 'EVALUATION', state: 'PENDING', event: Object.freeze({ item, outcome }) } : null;
                if (receipt) {
                    evaluationProofs.set(proof, receipt);
                    if (operationProofs && operationProofs.length < 1024) operationProofs.push(receipt);
                    else { receipt.state = 'UNKNOWN'; faults.add('PROOF_BUFFER_EXHAUSTED'); }
                }
                try {
                    if (typeof onEvaluation === 'function') {
                        const returned = observeItems ? onEvaluation(item, outcome, proof) : onEvaluation(item, outcome);
                        if (receipt && returned !== null && ['object', 'function'].includes(typeof returned)) { receipt.state = 'UNKNOWN'; faults.add('OBSERVER_ASYNC'); }
                    }
                }
                catch (_) { if (receipt) receipt.state = 'FAILED'; faults.add('OBSERVER_THROWN'); }
                finally { delivering = false; }
            }
        });
        const runtime = createSchedulerRuntime(configured);
        if (!runtime) return null;
        function guard(method, readOnly, name) {
            return (...args) => {
                const invoke = () => {
                if (delivering && !readOnly) {
                    faults.add('OBSERVER_REENTRANT');
                    throw new TypeError('PRIVATE_OBSERVER_REENTRANCY');
                }
                try {
                    if (observeItems && !readOnly) {
                        if (sourceSealed) afterSeal();
                        cleared = false;
                        const value = proofOperation(() => method(...args));
                        if (name === 'clear') cleared = true;
                        return value;
                    }
                    return method(...args);
                }
                catch (error) { if (observeItems) faults.add('SOURCE_THROWN'); throw error; }
                };
                return readOnly ? invoke() : sourceOperation(invoke);
            };
        }
        const queue = Object.freeze(Object.fromEntries(Object.entries(runtime.queue).map(([key, method]) =>
            [key, guard(method, ['snapshot', 'successfulLaunchSequence'].includes(key))])));
        const guarded = Object.freeze(Object.fromEntries(Object.entries(runtime).map(([key, method]) =>
            [key, key === 'queue' ? queue : guard(method, ['status', 'mutationQuiescent', 'replacementReady', 'resumeArms'].includes(key), key)])));
        const source = Object.freeze({ runtime: guarded,
            ...(observeItems ? { sourceIdentity, ownsItem: item => ownedItems.has(item),
                watchSealedFault(receiver) {
                    if (sealedFaultReceiver || sourceSealed || typeof receiver !== 'function') return false;
                    sealedFaultReceiver = receiver; return true;
                },
                seal() {
                    if (sealProof) return sealProof;
                    if (!cleared || delivering || proofDepth || faults.size || activeTimers.size) return null;
                    const state = runtime.status();
                    if (state.state !== 'IDLE' || state.armed || state.pendingCount !== 0) return null;
                    // Irreversible diagnostic issuer seal, not a claim that clear/cancel
                    // settled native renderer work. Original Product methods remain live.
                    sourceSealed = true;
                    sealProof = Object.freeze({});
                    sealProofs.set(sealProof, Object.freeze({ kind: 'RUNTIME_SOURCE_SEAL', state: 'FINAL_DELIVERED',
                        source: sourceIdentity, runtime: guarded, attempts, itemAttempts }));
                    return sealProof;
                },
                recognizeSealProof(proof) { return faults.size ? null : sealProofs.get(proof) || null; },
                lifetimeStatus: () => Object.freeze({ sealed: sourceSealed, cleared, callbacks: activeTimers.size,
                    delivering: delivering || proofDepth > 0, faulted: faults.size > 0 }) } : {}),
            ...(observeItems ? { recognizeProof(proof) {
                const receipt = itemProofs.get(proof);
                return receipt ? Object.freeze({ ...receipt }) : null;
            }, recognizeEvaluationProof(proof) {
                const receipt = evaluationProofs.get(proof); return receipt ? Object.freeze({ ...receipt }) : null;
            }, isProofDelivering: () => delivering || proofDepth > 0 } : {}),
            observationStatus: () => Object.freeze({ state: faults.size ? 'UNKNOWN' : 'OBSERVING',
                attempts, ...(observeItems ? { itemAttempts } : {}), faults: Object.freeze([...faults]) }) });
        if (observeItems) privateRuntimeSources.set(source, sourceIdentity);
        return source;
    }

    const api = { createSchedulerRuntime, classifyLaunchGapClass, classifyLaunchGapCause };
    if (typeof module !== 'undefined' && module.exports) module.exports = { ...api, createPrivateSchedulerRuntime,
        recognizePrivateRuntimeSource: source => privateRuntimeSources.get(source) || null };
    global.LiveFlowSchedulerRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis);
