const test = require('node:test');
const assert = require('node:assert/strict');
const { createPendingItem, createPendingQueue, createFifoPolicy } = require('../src/pending-selection.js');
const { STATES, OUTCOMES, createScheduler } = require('../src/scheduler-state-machine.js');

function pending(id, enqueuedAt = 0) {
    return createPendingItem({ id, enqueuedAt, rendererType: 'liveChatTextMessageRenderer', footprint: { width: 100, height: 24 } });
}

function fakeTimer() {
    let nextId = 1;
    const scheduled = [];
    return {
        schedule(callback, delay) {
            const entry = { id: nextId++, callback, delay, cancelled: false };
            scheduled.push(entry);
            return entry.id;
        },
        cancel(id) {
            const entry = scheduled.find((candidate) => candidate.id === id);
            if (entry) entry.cancelled = true;
        },
        fireNext() {
            const entry = scheduled.find((candidate) => !candidate.cancelled && !candidate.fired);
            if (!entry) return false;
            entry.fired = true;
            entry.callback();
            return true;
        },
        scheduled
    };
}

function fixture(overrides = {}) {
    const queue = createPendingQueue();
    const timer = fakeTimer();
    const authority = { now: 100, generation: 1, geometryRevision: 1 };
    const launches = [];
    const config = {
        maxPendingAge: 1000,
        pendingPressureCapacity: 10,
        scanDepth: 3,
        cohortMaximumItems: 3,
        cohortMaximumSpan: 50,
        pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: 0.75 },
        density: { attackThresholds: [0.5, 0.7, 0.9], releaseThresholds: [0.2, 0.3, 0.4], minimumAttackResidence: 1, releaseDwell: 3 },
        ...overrides.config
    };
    let scheduler;
    scheduler = createScheduler({
        queue,
        clock: overrides.clock || (() => authority.now),
        scheduleOneShot: timer.schedule,
        cancelOneShot: timer.cancel,
        generation: () => authority.generation,
        geometryRevision: () => authority.geometryRevision,
        isSafe: overrides.isSafe || (() => true),
        launch: overrides.launch || ((item) => { launches.push(item.id); return true; }),
        policy: createFifoPolicy(),
        config,
        operations: overrides.operations
    });
    return { queue, timer, authority, launches, scheduler };
}

test('initial state is IDLE', () => {
    const { scheduler } = fixture();
    assert.equal(scheduler.status().state, STATES.IDLE);
    assert.deepEqual(scheduler.evaluateOpportunity(), { outcome: OUTCOMES.NOT_ARMED, launched: 0 });
});

test('empty to non-empty arms one immediate opportunity', () => {
    const { scheduler, timer } = fixture();
    assert.equal(scheduler.enqueue(pending('a')), true);
    assert.equal(scheduler.status().state, STATES.ARMED);
    assert.equal(timer.scheduled.length, 1);
    assert.equal(timer.scheduled[0].delay, 0);
});

test('arrival while non-empty and ARMED does not reset, postpone, pull forward, or add timer', () => {
    const { scheduler, timer } = fixture();
    scheduler.enqueue(pending('a'));
    const original = timer.scheduled[0];
    scheduler.enqueue(pending('b'));
    assert.equal(timer.scheduled.length, 1);
    assert.equal(timer.scheduled[0], original);
    assert.equal(original.cancelled, false);
    assert.equal(original.delay, 0);
});

test('timer fire transitions through evaluation, launches at most one, then arms one next timer', () => {
    const { scheduler, timer, launches, queue } = fixture();
    scheduler.enqueue(pending('a'));
    scheduler.enqueue(pending('b'));
    assert.equal(timer.fireNext(), true);
    assert.deepEqual(launches, ['a']);
    assert.equal(queue.snapshot().length, 1);
    assert.equal(scheduler.status().state, STATES.ARMED);
    assert.equal(timer.scheduled.length, 2);
    assert.ok(timer.scheduled[1].delay > 0);
});

test('EVALUATING rejects reentrant opportunity', () => {
    let nested;
    const instance = fixture({ launch: () => { nested = instance.scheduler.evaluateOpportunity(); return true; } });
    instance.scheduler.enqueue(pending('a'));
    instance.timer.fireNext();
    assert.deepEqual(nested, { outcome: OUTCOMES.REENTRANT, launched: 0 });
});

test('blocked opportunities launch zero, accumulate no credit, and next opportunity still launches at most one', () => {
    let blocked = true;
    const instance = fixture({ isSafe: () => !blocked });
    instance.scheduler.enqueue(pending('a'));
    instance.scheduler.enqueue(pending('b'));
    instance.timer.fireNext();
    assert.equal(instance.scheduler.status().lastResult.outcome, OUTCOMES.NO_SELECTION);
    assert.equal(instance.queue.successfulLaunchSequence(), 0);
    blocked = false;
    instance.timer.fireNext();
    assert.equal(instance.launches.length, 1);
    assert.equal(instance.queue.successfulLaunchSequence(), 1);
    assert.equal(instance.queue.snapshot().length, 1);
});

test('generation change invalidates with zero launch and no recursive immediate retry', () => {
    const instance = fixture({ isSafe: () => { instance.authority.generation += 1; return true; } });
    instance.scheduler.enqueue(pending('a'));
    instance.timer.fireNext();
    assert.equal(instance.scheduler.status().lastResult.outcome, OUTCOMES.INVALIDATED);
    assert.deepEqual(instance.launches, []);
    assert.equal(instance.timer.scheduled.length, 2);
    assert.ok(instance.timer.scheduled[1].delay > 0);
});

test('geometry revision change invalidates with zero launch and normal delayed rearm', () => {
    const instance = fixture({ isSafe: () => { instance.authority.geometryRevision += 1; return true; } });
    instance.scheduler.enqueue(pending('a'));
    instance.timer.fireNext();
    assert.equal(instance.scheduler.status().lastResult.outcome, OUTCOMES.INVALIDATED);
    assert.deepEqual(instance.launches, []);
    assert.ok(instance.timer.scheduled[1].delay > 0);
});

test('stale prune precedes pressure and selection', () => {
    const trace = [];
    const instance = fixture({
        config: { maxPendingAge: 10 },
        operations: {
            computePressure(input) {
                trace.push(`pressure:${input.pendingCount}`);
                return { Qc: 0, Qa: 0, pressure: 0 };
            },
            computePacing() { return { rescueIntensity: 0, interval: 400, credit: 0 }; },
            transitionDensity(state) { return state; }
        },
        isSafe(item) { trace.push(`select:${item.id}`); return true; }
    });
    instance.scheduler.enqueue(pending('stale', 0));
    instance.scheduler.enqueue(pending('current', 100));
    instance.timer.fireNext();
    assert.deepEqual(trace, ['pressure:1', 'select:current']);
    assert.equal(instance.scheduler.status().lastResult.staleDropped, 1);
});

test('authoritative clock is snapshotted exactly once per opportunity', () => {
    let reads = 0;
    const instance = fixture({ clock: () => { reads += 1; return 100; } });
    instance.scheduler.enqueue(pending('a'));
    instance.timer.fireNext();
    assert.equal(reads, 1);
});

test('no-selection remains stable with one outstanding one-shot timer', () => {
    const instance = fixture({ isSafe: () => false });
    instance.scheduler.enqueue(pending('a'));
    instance.timer.fireNext();
    assert.equal(instance.scheduler.status().state, STATES.ARMED);
    assert.equal(instance.timer.scheduled.filter((entry) => !entry.cancelled && !entry.fired).length, 1);
    assert.equal(instance.queue.successfulLaunchSequence(), 0);
});

test('stop cancels the single armed timer without evaluating', () => {
    const instance = fixture();
    instance.scheduler.enqueue(pending('a'));
    instance.scheduler.stop();
    assert.equal(instance.scheduler.status().state, STATES.IDLE);
    assert.equal(instance.timer.scheduled[0].cancelled, true);
    assert.deepEqual(instance.launches, []);
});

test('optional observer reports only fixed scheduler events without changing scheduling', () => {
    const events = [];
    const instance = fixture({
        isSafe: () => false,
        operations: undefined
    });
    const observed = createScheduler({
        queue: createPendingQueue(),
        clock: () => 100,
        scheduleOneShot: instance.timer.schedule,
        cancelOneShot: instance.timer.cancel,
        generation: () => 1,
        geometryRevision: () => 1,
        isSafe: () => false,
        launch: () => true,
        policy: createFifoPolicy(),
        config: {
            maxPendingAge: 1000, pendingPressureCapacity: 10, scanDepth: 3,
            cohortMaximumItems: 3, cohortMaximumSpan: 50,
            pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: 0.75 },
            density: { attackThresholds: [0.5, 0.7, 0.9], releaseThresholds: [0.2, 0.3, 0.4], minimumAttackResidence: 1, releaseDwell: 3 }
        },
        observe: (event) => events.push(event)
    });
    observed.enqueue(pending('a', 100));
    instance.timer.fireNext();
    assert.deepEqual(events.map(({ type }) => type), ['ARMED', 'EVALUATING', 'SELECTION_NONE', 'ARMED']);
    assert.equal(observed.status().state, STATES.ARMED);
    assert.ok(events.every((event) => !Object.hasOwn(event, 'item') && !Object.hasOwn(event, 'id')));
});

test('launch accounting separates selection attempt from renderer rejection without exposing item data', () => {
    const events = [];
    const timer = fakeTimer();
    const scheduler = createScheduler({
        queue: createPendingQueue(), clock: () => 100, scheduleOneShot: timer.schedule, cancelOneShot: timer.cancel,
        generation: () => 1, geometryRevision: () => 1, isSafe: () => true, launch: () => false,
        policy: createFifoPolicy(),
        config: { maxPendingAge: 1000, pendingPressureCapacity: 10, scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
            pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: 0.75 },
            density: { attackThresholds: [0.5, 0.7, 0.9], releaseThresholds: [0.2, 0.3, 0.4], minimumAttackResidence: 1, releaseDwell: 3 } },
        observe: (event) => events.push(event)
    });
    scheduler.enqueue(pending('private-id', 100));
    timer.fireNext();
    assert.deepEqual(events.map(({ type }) => type),
        ['ARMED', 'EVALUATING', 'LAUNCH_ATTEMPTED', 'LAUNCH_REJECTED', 'SELECTION_NONE', 'ARMED']);
    assert.ok(events.every((event) => !Object.hasOwn(event, 'item') && !Object.hasOwn(event, 'id')));
});
