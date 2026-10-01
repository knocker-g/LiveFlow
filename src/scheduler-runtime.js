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
        candidateProof, launch, config, observe
    } = {}) {
        if (typeof clock !== 'function' || typeof scheduleOneShot !== 'function' || typeof cancelOneShot !== 'function' ||
            typeof generation !== 'function' || !geometryAdapter || typeof geometryAdapter.refresh !== 'function' ||
            typeof geometryAdapter.status !== 'function' || typeof candidateProof !== 'function' || typeof launch !== 'function' || !config) return null;
        const queue = pending.createPendingQueue();
        const policy = pending.createSpecialPreferencePolicy();
        const launchProofs = new WeakMap();
        const itemDiagnosticState = new WeakMap();
        geometryAdapter.refresh();

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
                classifyStale(item) {
                    const state = itemDiagnosticState.get(item);
                    if (state?.alreadyStaleOnEnqueue) return 'ALREADY_STALE_ON_ENQUEUE';
                    if (state?.collisionBlocked) return 'COLLISION_BLOCKED';
                    if (state?.safeSeen) return 'PACING_WAIT';
                    if (!state || state.evaluated === 0) return 'SELECTION_MISS';
                    return 'OTHER';
                }
            },
            observe: notify
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
            queue.enforceHardCount(config.maxPendingCount);
            return true;
        }

        function clear() {
            scheduler.stop();
            queue.enforceHardCount(0);
        }

        return Object.freeze({
            enqueue,
            clear,
            markGeometryDirty: geometryAdapter.markDirty,
            status: () => Object.freeze({ ...scheduler.status(), pendingCount: queue.snapshot().length }),
            queue
        });
    }

    const api = { createSchedulerRuntime, classifyLaunchGapClass, classifyLaunchGapCause };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowSchedulerRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis);
