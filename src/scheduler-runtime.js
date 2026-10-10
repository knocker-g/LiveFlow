(function (global) {
    const foundations = typeof module !== 'undefined' && module.exports ? require('./scheduler-foundations.js') : global.LiveFlowSchedulerFoundations;
    const pending = typeof module !== 'undefined' && module.exports ? require('./pending-selection.js') : global.LiveFlowPendingSelection;
    const machine = typeof module !== 'undefined' && module.exports ? require('./scheduler-state-machine.js') : global.LiveFlowSchedulerStateMachine;
    const geometry = typeof module !== 'undefined' && module.exports ? require('./geometry-adapter.js') : global.LiveFlowGeometryAdapter;

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

    function createSchedulerRuntime({
        clock, scheduleOneShot, cancelOneShot, generation, geometryAdapter,
        sourceActivityBinding, candidateProof, launch, config, observe
    } = {}) {
        if (typeof clock !== 'function' || typeof scheduleOneShot !== 'function' || typeof cancelOneShot !== 'function' ||
            typeof generation !== 'function' || (config?.sourceActivity && typeof sourceActivityBinding !== 'function') ||
            !geometryAdapter || typeof geometryAdapter.refresh !== 'function' ||
            typeof geometryAdapter.status !== 'function' || typeof candidateProof !== 'function' || typeof launch !== 'function' || !config) return null;
        const queue = pending.createPendingQueue();
        const policy = pending.createSpecialPreferencePolicy();
        const launchProofs = new WeakMap();
        const itemDiagnosticState = new WeakMap();
        let physicalSaturationSeen = false;
        let sourceActivityState = null;
        let sourceActivityBindingReset = false;
        let sourceActivityFacts = [];
        let sourceActivityWindow = null;
        geometryAdapter.refresh();

        function sameActivityBinding(left, right) {
            return left && right && left.target === right.target && left.timeline === right.timeline &&
                left.generation === right.generation;
        }

        function observeSourceActivity({ eventBinding, windowStartMs, windowEndMs, facts } = {}) {
            if (!config.sourceActivity || typeof sourceActivityBinding !== 'function') return null;
            const currentBinding = sourceActivityBinding();
            const ownershipReset = Boolean(sourceActivityState && !sameActivityBinding(sourceActivityState.binding, currentBinding));
            if (!sourceActivityState || ownershipReset) {
                sourceActivityState = foundations.createSourceActivityState(currentBinding);
                sourceActivityFacts = [];
            }
            if (!sourceActivityState) return null;
            if (sameActivityBinding(eventBinding, currentBinding) && Array.isArray(facts)) {
                sourceActivityFacts.push(...facts.filter((fact) => fact && fact.displayable === true &&
                    fact.temporalClass === 'CURRENT_WINDOW' && Number.isFinite(fact.mediaTimeMs)));
            }
            sourceActivityFacts = sourceActivityFacts.filter((fact) => fact.mediaTimeMs >= windowStartMs &&
                fact.mediaTimeMs <= windowEndMs);
            sourceActivityWindow = Object.freeze({ currentBinding, eventBinding, windowStartMs, windowEndMs });
            sourceActivityBindingReset = ownershipReset;
            return Object.freeze({ accepted: sameActivityBinding(eventBinding, currentBinding), bindingReset: ownershipReset,
                currentWindowCount: sourceActivityFacts.length });
        }

        function evaluateCurrentSourceActivity() {
            if (!sourceActivityState || !sourceActivityWindow) return sourceActivityState;
            const currentBinding = sourceActivityBinding();
            if (!sameActivityBinding(sourceActivityState.binding, currentBinding)) {
                sourceActivityState = foundations.createSourceActivityState(currentBinding);
                sourceActivityFacts = [];
                sourceActivityBindingReset = true;
                if (!sourceActivityState) return null;
            }
            const evaluated = foundations.evaluateSourceActivity(sourceActivityState, {
                ...sourceActivityWindow,
                currentBinding,
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
            const itemState = itemDiagnosticState.get(item) || { evaluated: 0, collisionBlocked: false, safeSeen: false, alreadyStaleOnEnqueue: false };
            itemState.evaluated += 1;
            itemDiagnosticState.set(item, itemState);
            const refreshed = geometryAdapter.refresh();
            const geometryState = refreshed.geometry;
            if (geometryState?.state === geometry.GEOMETRY_STATES.UNKNOWN && geometryState.capabilityAvailable !== false) {
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
                if (!foundations.isOutsideHardExclusions(candidate.rectangle, geometryState.exclusionRegions)) {
                    subtitleBlocked += 1;
                    continue;
                }
                const collision = foundations.proveBoundedCollisionSafe(candidate.rectangle, proof.activeComments, allowance);
                if (!collision.safe) {
                    collisionBlocked += 1;
                    continue;
                }
                launchProofs.set(item, Object.freeze({ ...candidate, density: densityLevel }));
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

        const scheduler = machine.createScheduler({
            queue,
            clock,
            scheduleOneShot,
            cancelOneShot,
            generation,
            geometryRevision: () => geometryAdapter.status().revision,
            isSafe,
            launch: (item) => {
                const proof = launchProofs.get(item) || null;
                launchProofs.delete(item);
                return launch(item.payload, proof) === true;
            },
            policy,
            config,
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
                    const dropped = queue.relieveSaturation(1);
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

        function enqueue(payload, { id, enqueuedAt, rendererType, footprint } = {}) {
            const item = pending.createPendingItem({ id, enqueuedAt, rendererType, payload, footprint });
            if (!item || !scheduler.enqueue(item)) return false;
            itemDiagnosticState.set(item, {
                evaluated: 0,
                collisionBlocked: false,
                safeSeen: false,
                alreadyStaleOnEnqueue: clock() - enqueuedAt > config.maxPendingAge
            });
            const emergencyDropped = queue.enforceHardCount(config.maxPendingCount);
            for (const dropped of emergencyDropped) itemDiagnosticState.delete(dropped);
            if (emergencyDropped.length > 0) notify({ type: 'EMERGENCY_PENDING_DROPPED', count: emergencyDropped.length,
                reason: 'MAX_PENDING_COUNT' });
            return true;
        }

        function clear() {
            scheduler.stop();
            queue.enforceHardCount(0);
        }

        return Object.freeze({
            enqueue,
            observeSourceActivity,
            clear,
            markGeometryDirty: geometryAdapter.markDirty,
            status: () => Object.freeze({ ...scheduler.status(), pendingCount: queue.snapshot().length,
                sourceActivityBand: sourceActivityState?.band || 'LOW', sourceActivityBindingReset }),
            queue
        });
    }

    const api = { createSchedulerRuntime, classifyLaunchGapClass, classifyLaunchGapCause };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowSchedulerRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis);
