(function (global) {
    const foundations = typeof module !== 'undefined' && module.exports
        ? require('./scheduler-foundations.js')
        : global.LiveFlowSchedulerFoundations;

    const STATES = Object.freeze({ IDLE: 'IDLE', ARMED: 'ARMED', EVALUATING: 'EVALUATING' });
    const OUTCOMES = Object.freeze({
        LAUNCHED: 'LAUNCHED',
        NO_SELECTION: 'NO_SELECTION',
        INVALIDATED: 'INVALIDATED',
        REENTRANT: 'REENTRANT',
        NOT_ARMED: 'NOT_ARMED'
    });

    function createScheduler({
        queue,
        clock,
        scheduleOneShot,
        cancelOneShot,
        generation,
        geometryRevision,
        isSafe,
        launch,
        policy,
        config,
        operations = {},
        observe
    } = {}) {
        if (!queue || typeof queue.snapshot !== 'function' || typeof queue.enqueue !== 'function' ||
            typeof queue.pruneStale !== 'function' || typeof queue.evaluate !== 'function' ||
            typeof queue.confirmSuccessfulLaunch !== 'function' || typeof clock !== 'function' ||
            typeof scheduleOneShot !== 'function' || typeof cancelOneShot !== 'function' ||
            typeof generation !== 'function' || typeof geometryRevision !== 'function' ||
            typeof isSafe !== 'function' || typeof launch !== 'function' || !policy || !config) return null;

        const computePressure = operations.computePressure || foundations.computePressure;
        const computePacing = operations.computePacing || foundations.computePacing;
        const transitionDensity = operations.transitionDensity || foundations.transitionDensity;
        let density = foundations.createDensityState('NORMAL', config.density.minimumAttackResidence, 0);
        let state = STATES.IDLE;
        let timerHandle = null;
        let armedGeneration;
        let lastResult = null;
        let densityProvenance = null;
        let sourceActivityBand = 'LOW';

        function notify(event) {
            if (typeof observe !== 'function') return;
            try { observe(Object.freeze(event)); } catch {}
        }

        function queueDepth() {
            return queue.snapshot().length;
        }

        function arm(delay) {
            if (state !== STATES.IDLE || queueDepth() === 0 || !Number.isFinite(delay) || delay < 0) return false;
            state = STATES.ARMED;
            armedGeneration = generation();
            timerHandle = scheduleOneShot(onTimer, delay);
            notify({ type: 'ARMED', state, pendingCount: queueDepth() });
            return true;
        }

        function enqueue(item) {
            const wasEmpty = queueDepth() === 0;
            if (!queue.enqueue(item)) return false;
            if (wasEmpty && state === STATES.IDLE) arm(0);
            return true;
        }

        function finish(result, nextDelay) {
            lastResult = Object.freeze(result);
            state = STATES.IDLE;
            if (queueDepth() > 0 && Number.isFinite(nextDelay) && nextDelay >= 0) arm(nextDelay);
            return lastResult;
        }

        function evaluateOpportunity(expectedGeneration = generation()) {
            if (state === STATES.EVALUATING) return Object.freeze({ outcome: OUTCOMES.REENTRANT, launched: 0 });
            if (state !== STATES.ARMED || timerHandle !== null) return Object.freeze({ outcome: OUTCOMES.NOT_ARMED, launched: 0 });
            state = STATES.EVALUATING;
            notify({ type: 'EVALUATING', state, pendingCount: queueDepth() });
            const now = clock();
            const initialGeometryRevision = geometryRevision();
            const staleItems = queue.pruneStale(now, config.maxPendingAge);
            const staleDropped = staleItems.length;
            if (staleDropped > 0) {
                const staleReasons = { collisionBlocked: 0, pacingWait: 0, selectionMiss: 0, alreadyStaleOnEnqueue: 0, other: 0 };
                for (const item of staleItems) {
                    const reason = typeof operations.classifyStale === 'function' ? operations.classifyStale(item) : 'OTHER';
                    if (reason === 'COLLISION_BLOCKED') staleReasons.collisionBlocked += 1;
                    else if (reason === 'PACING_WAIT') staleReasons.pacingWait += 1;
                    else if (reason === 'SELECTION_MISS') staleReasons.selectionMiss += 1;
                    else if (reason === 'ALREADY_STALE_ON_ENQUEUE') staleReasons.alreadyStaleOnEnqueue += 1;
                    else staleReasons.other += 1;
                }
                notify({ type: 'STALE_PRUNED', state, count: staleDropped, pendingCount: queueDepth(), staleReasons: Object.freeze(staleReasons) });
            }
            const snapshot = queue.snapshot();
            const oldestEligibleTemporalAge = snapshot.length ? Math.max(0, now - snapshot[0].enqueuedAt) : 0;
            const pressure = computePressure({
                pendingCount: snapshot.length,
                oldestEligibleTemporalAge,
                pendingPressureCapacity: config.pendingPressureCapacity,
                maxPendingAge: config.maxPendingAge
            });
            const pacing = pressure && computePacing({ pressure: pressure.pressure, ...config.pacing });
            if (pressure) {
                const densityDecision = transitionDensity(density, pressure.pressure, config.density);
                if (densityDecision?.state) {
                    density = densityDecision.state;
                    densityProvenance = densityDecision.provenance || null;
                    sourceActivityBand = densityDecision.sourceActivityBand || sourceActivityBand;
                } else {
                    density = densityDecision || density;
                    densityProvenance = null;
                }
            }
            const selection = queue.evaluate({
                scanDepth: config.scanDepth,
                cohortMaximumItems: config.cohortMaximumItems,
                cohortMaximumSpan: config.cohortMaximumSpan,
                isSafe: (item) => isSafe(item, density.level),
                policy
            });
            const nextDelay = pacing?.interval;

            if (generation() !== expectedGeneration) {
                notify({ type: 'GENERATION_INVALIDATED', state, pendingCount: queueDepth() });
                return finish({ outcome: OUTCOMES.INVALIDATED, launched: 0, staleDropped }, nextDelay);
            }
            if (geometryRevision() !== initialGeometryRevision) {
                notify({ type: 'GEOMETRY_INVALIDATED', state, pendingCount: queueDepth() });
                return finish({ outcome: OUTCOMES.INVALIDATED, launched: 0, staleDropped }, nextDelay);
            }
            if (!selection) {
                const capacityDropped = typeof operations.relieveSaturation === 'function'
                    ? operations.relieveSaturation({ density: density.level })
                    : Object.freeze([]);
                notify({ type: 'SELECTION_NONE', state, pendingCount: queueDepth() });
                return finish({ outcome: OUTCOMES.NO_SELECTION, launched: 0, staleDropped,
                    capacityDropped: Array.isArray(capacityDropped) ? capacityDropped.length : 0 }, nextDelay);
            }
            notify({ type: 'LAUNCH_ATTEMPTED', state, pendingCount: queueDepth() });
            if (launch(selection.item) !== true) {
                notify({ type: 'LAUNCH_REJECTED', state, pendingCount: queueDepth() });
                notify({ type: 'SELECTION_NONE', state, pendingCount: queueDepth() });
                return finish({ outcome: OUTCOMES.NO_SELECTION, launched: 0, staleDropped }, nextDelay);
            }
            if (!queue.confirmSuccessfulLaunch(selection.token)) {
                notify({ type: 'SELECTION_NONE', state, pendingCount: queueDepth() });
                return finish({ outcome: OUTCOMES.NO_SELECTION, launched: 0, staleDropped }, nextDelay);
            }
            notify({ type: 'LAUNCH_COMMITTED', state, pendingCount: queueDepth() });
            return finish({ outcome: OUTCOMES.LAUNCHED, launched: 1, staleDropped }, nextDelay);
        }

        function onTimer() {
            if (state !== STATES.ARMED) return;
            const expectedGeneration = armedGeneration;
            timerHandle = null;
            evaluateOpportunity(expectedGeneration);
        }

        function stop() {
            if (timerHandle !== null) cancelOneShot(timerHandle);
            timerHandle = null;
            state = STATES.IDLE;
        }

        return Object.freeze({
            enqueue,
            stop,
            evaluateOpportunity,
            status: () => Object.freeze({ state, armed: timerHandle !== null, lastResult, density: density.level,
                densityProvenance, sourceActivityBand })
        });
    }

    const api = { STATES, OUTCOMES, createScheduler };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowSchedulerStateMachine = api;
})(typeof window !== 'undefined' ? window : globalThis);
