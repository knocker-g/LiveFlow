(function (global) {
    const foundations = typeof module !== 'undefined' && module.exports
        ? require('./scheduler-foundations.js')
        : global.LiveFlowSchedulerFoundations;

    const STATES = Object.freeze({ IDLE: 'IDLE', ARMED: 'ARMED', EVALUATING: 'EVALUATING' });
    const privateSchedulers = new WeakMap();
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
        observe,
        onEvaluationExit,
        mayArm,
        prepareLaunch
    } = {}) {
        const itemObserver = privateSchedulers.get(queue);
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
        let closing = false, nextArm = null;

        function notify(event) {
            if (typeof observe !== 'function') return;
            try { observe(Object.freeze(event)); } catch {}
        }

        function queueDepth() {
            return queue.snapshot().length;
        }

        function arm(delay) {
            if (closing || (typeof mayArm === 'function' && !mayArm())) { nextArm = delay; return false; }
            if (state !== STATES.IDLE || queueDepth() === 0 || !Number.isFinite(delay) || delay < 0) return false;
            state = STATES.ARMED;
            armedGeneration = generation();
            timerHandle = scheduleOneShot(onTimer, delay);
            notify({ type: 'ARMED', state, pendingCount: queueDepth() });
            return true;
        }

        function enqueue(item) {
            if (itemObserver) itemObserver.assertMutable();
            const wasEmpty = queueDepth() === 0;
            if (!queue.enqueue(item)) return false;
            if (wasEmpty && state === STATES.IDLE) arm(0);
            return true;
        }

        function finish(result, nextDelay) {
            lastResult = Object.freeze(result);
            state = STATES.IDLE;
            if (typeof prepareLaunch === 'function' || (typeof onEvaluationExit === 'function' && onEvaluationExit())) nextArm = nextDelay;
            else if (queueDepth() > 0 && Number.isFinite(nextDelay) && nextDelay >= 0) arm(nextDelay);
            return lastResult;
        }

        function evaluateOpportunity(expectedGeneration = generation()) {
            if (itemObserver) itemObserver.assertMutable();
            if (closing) return Object.freeze({ outcome: OUTCOMES.REENTRANT, launched: 0 });
            if (state === STATES.EVALUATING) return Object.freeze({ outcome: OUTCOMES.REENTRANT, launched: 0 });
            if (state !== STATES.ARMED || timerHandle !== null) return Object.freeze({ outcome: OUTCOMES.NOT_ARMED, launched: 0 });
            let transaction = null, transactionConfirmed = false, primaryThrown = false;
            try {
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
                policy,
                onDiscard: removal => notify({ type: 'STRUCTURAL_DROPPED', state, ...removal })
            });
            const nextDelay = pacing?.interval;
            if (itemObserver && selection) itemObserver.deliverItem(selection.item, 'SELECTED', 'SCHEDULER', selection.token);

            if (generation() !== expectedGeneration) {
                if (itemObserver && selection) itemObserver.deliverItem(selection.item, 'SELECTION_INVALIDATED', 'SCHEDULER', selection.token, 'GENERATION');
                notify({ type: 'GENERATION_INVALIDATED', state, pendingCount: queueDepth() });
                return finish({ outcome: OUTCOMES.INVALIDATED, launched: 0, staleDropped }, nextDelay);
            }
            if (geometryRevision() !== initialGeometryRevision) {
                if (itemObserver && selection) itemObserver.deliverItem(selection.item, 'SELECTION_INVALIDATED', 'SCHEDULER', selection.token, 'GEOMETRY');
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
            // New private terminal intent invalidates work before launch. The
            // original token remains untouched until this evaluation exits.
            if (typeof mayArm === 'function' && !mayArm(true))
                return finish({ outcome: OUTCOMES.INVALIDATED, launched: 0, staleDropped }, nextDelay);
            notify({ type: 'LAUNCH_ATTEMPTED', state, pendingCount: queueDepth() });
            if (itemObserver) itemObserver.deliverItem(selection.item, 'LAUNCH_REQUESTED', 'SCHEDULER', selection.token);
            let launched;
            try {
                if (typeof prepareLaunch === 'function') {
                    transaction = prepareLaunch(selection.item);
                    launched = transaction && ['start','abort','isCurrent','markQueueConfirmed'].every(key =>
                        typeof transaction[key] === 'function') ? transaction.start() : false;
                } else launched = launch(selection.item);
            }
            catch (error) {
                if (itemObserver) itemObserver.deliverItem(selection.item, 'LAUNCH_THROWN', 'SCHEDULER', selection.token);
                throw error;
            }
            if (launched !== true) {
                if (itemObserver) itemObserver.deliverItem(selection.item, 'LAUNCH_REJECTED', 'SCHEDULER', selection.token);
                notify({ type: 'LAUNCH_REJECTED', state, pendingCount: queueDepth() });
                notify({ type: 'SELECTION_NONE', state, pendingCount: queueDepth() });
                return finish({ outcome: OUTCOMES.NO_SELECTION, launched: 0, staleDropped }, nextDelay);
            }
            let confirmed;
            if (transaction && transaction.isCurrent() !== true)
                return finish({ outcome: OUTCOMES.INVALIDATED, launched: 0, staleDropped }, nextDelay);
            try { confirmed = queue.confirmSuccessfulLaunch(selection.token); }
            catch (error) {
                if (itemObserver) itemObserver.deliverItem(selection.item, 'LAUNCH_CONFIRMATION_THROWN', 'SCHEDULER', selection.token);
                throw error;
            }
            if (!confirmed) {
                if (itemObserver) itemObserver.deliverItem(selection.item, 'LAUNCH_CONFIRMATION_REJECTED', 'SCHEDULER', selection.token);
                notify({ type: 'SELECTION_NONE', state, pendingCount: queueDepth() });
                return finish({ outcome: OUTCOMES.NO_SELECTION, launched: 0, staleDropped }, nextDelay);
            }
            transactionConfirmed = true;
            if (transaction) transaction.markQueueConfirmed();
            if (itemObserver) itemObserver.deliverItem(selection.item, 'LAUNCH_CONFIRMED', 'SCHEDULER', selection.token);
            notify({ type: 'LAUNCH_COMMITTED', state, pendingCount: queueDepth() });
            return finish({ outcome: OUTCOMES.LAUNCHED, launched: 1, staleDropped }, nextDelay);
            } catch (error) {
                primaryThrown = true;
                if (itemObserver) itemObserver.sourceFault();
                throw error;
            } finally {
                if (typeof prepareLaunch === 'function' || (typeof onEvaluationExit === 'function' && onEvaluationExit())) {
                    closing = true;
                    state = STATES.IDLE;
                    try { if (transaction && !transactionConfirmed) transaction.abort(); }
                    catch (error) { if (!primaryThrown) throw error; }
                    finally { closing = false; }
                    resumeArm();
                }
            }
        }

        function onTimer() {
            if (itemObserver) itemObserver.assertMutable();
            if (state !== STATES.ARMED) return;
            const expectedGeneration = armedGeneration;
            timerHandle = null;
            evaluateOpportunity(expectedGeneration);
        }

        function stop() {
            if (itemObserver) itemObserver.assertMutable();
            if (timerHandle !== null) cancelOneShot(timerHandle);
            timerHandle = null;
            state = STATES.IDLE;
            nextArm = null;
        }

        function resumeArm() {
            if (closing || nextArm === null || (typeof mayArm === 'function' && !mayArm())) return false;
            const delay = nextArm; nextArm = null;
            return arm(delay);
        }

        return Object.freeze({
            enqueue,
            stop,
            evaluateOpportunity,
            resumeArm,
            status: () => Object.freeze({ state, armed: timerHandle !== null, lastResult, density: density.level,
                densityProvenance, sourceActivityBand })
        });
    }

    const api = { STATES, OUTCOMES, createScheduler };
    function createPrivateScheduler(options, observer) {
        privateSchedulers.set(options.queue, observer);
        return createScheduler(options);
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { ...api, createPrivateScheduler };
    global.LiveFlowSchedulerStateMachine = api;
})(typeof window !== 'undefined' ? window : globalThis);
