const test = require('node:test');
const assert = require('node:assert/strict');
const {
    computePressure,
    computePacing,
    createDensityState,
    transitionDensity,
    getDensityVisualPolicy,
    rotatingModularStride,
    proveCollisionSafe,
    proveBoundedCollisionSafe,
    isOutsideHardExclusions,
    computeSpecialSingleLineFit,
    temporalCohort,
    simulateClosedLoop
} = require('../src/scheduler-foundations.js');

const boundedAllowance = Object.freeze({
    nominalGap: 80,
    hardMinimumSeparation: -30,
    maxCatchUpRatio: 0.5,
    maxOverlapDuration: 1,
    maxOverlapDepthRatio: 0.3,
    minimumVisibleFraction: 0.7
});

const densityConfig = Object.freeze({
    attackThresholds: [0.45, 0.7, 0.9],
    releaseThresholds: [0.2, 0.35, 0.5],
    minimumAttackResidence: 2,
    releaseDwell: 4
});

const simulationConfig = Object.freeze({
    pendingPressureCapacity: 12,
    maxPendingCount: 48,
    maxPendingAge: 2400,
    scanDepth: 5,
    pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: 0.75 },
    density: densityConfig
});

function arrivals(count, shape = 'NORMAL') {
    return Array.from({ length: count }, (_, index) => ({ shape, index }));
}

function simulate(arrivalsAt, overrides = {}, blockedUntil) {
    return simulateClosedLoop({
        steps: overrides.steps || 100,
        stepDuration: 100,
        arrivalsAt,
        blockedUntil,
        config: { ...simulationConfig, ...overrides.config }
    });
}

test('pressure separates capacity, temporal age, and hard safety count', () => {
    assert.deepEqual(computePressure({ pendingCount: 5, oldestEligibleTemporalAge: 20, pendingPressureCapacity: 10, maxPendingAge: 100 }), { Qc: 0.5, Qa: 0.2, pressure: 0.5 });
    assert.deepEqual(computePressure({ pendingCount: 50, oldestEligibleTemporalAge: 200, pendingPressureCapacity: 10, maxPendingAge: 100 }), { Qc: 1, Qa: 1, pressure: 1 });
    assert.equal(computePressure({ pendingCount: 1, oldestEligibleTemporalAge: 0, pendingPressureCapacity: 0, maxPendingAge: 1 }), null);
});

test('pacing is bounded, preserves user authority, and exposes no launch credit', () => {
    assert.deepEqual(computePacing({ pressure: 0, userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: 0.75 }), { rescueIntensity: 0, interval: 400, credit: 0 });
    assert.deepEqual(computePacing({ pressure: 1, userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: 0.75 }), { rescueIntensity: 1, interval: 100, credit: 0 });
});

test('density attacks and releases one level at a time with slow release dwell', () => {
    let state = createDensityState('NORMAL', 2, 0);
    state = transitionDensity(state, 1, densityConfig);
    assert.equal(state.level, 'COMPACT');
    state = transitionDensity(state, 1, densityConfig);
    assert.equal(state.level, 'COMPACT');
    state = transitionDensity(state, 1, densityConfig);
    assert.equal(state.level, 'DENSE');
    for (let index = 0; index < 3; index += 1) state = transitionDensity(state, 0, densityConfig);
    assert.equal(state.level, 'DENSE');
    state = transitionDensity(state, 0, densityConfig);
    assert.equal(state.level, 'COMPACT');
});

test('density visual policy expands lane band and collision allowance monotonically without geometry mutation', () => {
    const levels = ['NORMAL', 'COMPACT', 'DENSE', 'MAX_READABLE'].map(getDensityVisualPolicy);
    assert.deepEqual(levels.map(({ expansionLevel }) => expansionLevel), [0, 1, 2, 3]);
    assert.deepEqual(levels.map(({ laneBandClass }) => laneBandClass), ['UPPER', 'UPPER_TO_MID', 'BROAD', 'FULL_SAFE']);
    assert.deepEqual(levels.map(({ collisionAllowanceClass }) => collisionAllowanceClass),
        ['CONSERVATIVE', 'LIMITED_CATCH_UP', 'BOUNDED_OVERLAP', 'MAXIMUM_READABLE_RESCUE']);
    const displayed = Object.freeze({ x: 10, velocity: 20 });
    getDensityVisualPolicy('NORMAL');
    getDensityVisualPolicy('MAX_READABLE');
    assert.deepEqual(displayed, { x: 10, velocity: 20 });
    assert.equal(getDensityVisualPolicy('UNKNOWN'), null);
});

test('rotating modular stride is bounded and covers every candidate across successful launches', () => {
    const visited = new Set();
    for (let sequence = 0; sequence < 11; sequence += 1) {
        const indexes = rotatingModularStride(11, 3, sequence);
        assert.equal(indexes.length, 3);
        assert.equal(new Set(indexes).size, indexes.length);
        indexes.forEach((index) => visited.add(index));
    }
    assert.equal(visited.size, 11);
    assert.deepEqual(rotatingModularStride(100, 4, 0).length, 4);
    assert.equal(rotatingModularStride(1000000, 4, 999999).length, 4);
});

test('collision proof is conservative and uses immutable supplied velocities', () => {
    const candidate = { x: 1000, y: 0, width: 100, height: 30, velocity: 200 };
    assert.deepEqual(proveCollisionSafe(candidate, [{ x: 400, y: 40, width: 100, height: 30, velocity: 100 }], 24), { safe: true, reason: 'SAFE' });
    assert.equal(proveCollisionSafe(candidate, [{ x: 850, y: 10, width: 100, height: 30, velocity: 100 }], 60).safe, false);
    assert.equal(proveCollisionSafe(candidate, [{ x: 400, y: 10, width: 100, height: 30, velocity: 50 }], 24).reason, 'TRAJECTORY_COLLISION');
    assert.equal(proveCollisionSafe({ ...candidate, velocity: Number.NaN }, [], 24).reason, 'INVALID_GEOMETRY');
    assert.equal(proveCollisionSafe({ ...candidate, width: 0 }, [], 24).reason, 'INVALID_GEOMETRY');
});

test('bounded collision proof permits nominal-gap consumption only inside every hard bound', () => {
    const candidate = Object.freeze({ x: 300, y: 0, width: 100, height: 30, velocity: 120 });
    const active = Object.freeze({ x: 100, y: 0, width: 100, height: 30, velocity: 100 });
    assert.deepEqual(proveBoundedCollisionSafe(candidate, [active], boundedAllowance), { safe: true, reason: 'SAFE' });
    assert.equal(proveBoundedCollisionSafe({ ...candidate, x: 230 }, [active], { ...boundedAllowance, hardMinimumSeparation: -5 }).reason, 'HARD_READABILITY_FLOOR');
    assert.equal(proveBoundedCollisionSafe(candidate, [active], { ...boundedAllowance, maxCatchUpRatio: 0.2 }).reason, 'EXCESSIVE_CATCH_UP');
    assert.equal(proveBoundedCollisionSafe({ ...candidate, x: 230 }, [active], { ...boundedAllowance, maxOverlapDuration: 0.4 }).reason, 'EXCESSIVE_OVERLAP_DURATION');
    assert.equal(proveBoundedCollisionSafe({ ...candidate, x: 230 }, [active], { ...boundedAllowance, maxOverlapDepthRatio: 0.05 }).reason, 'EXCESSIVE_OVERLAP_DEPTH');
    assert.equal(proveBoundedCollisionSafe({ ...candidate, x: 230 }, [active], { ...boundedAllowance, maxOverlapDepthRatio: 0.5, minimumVisibleFraction: 0.95 }).reason, 'READABILITY_FLOOR');
    assert.equal(proveBoundedCollisionSafe({ ...candidate, velocity: Number.NaN }, [active], boundedAllowance).reason, 'INVALID_GEOMETRY_OR_POLICY');
    assert.equal(candidate.velocity, 120);
    assert.equal(active.velocity, 100);
});

test('SPECIAL collision uses the complete two-line rectangle against Normal and SPECIAL footprints', () => {
    const special = { x: 230, y: 0, width: 180, height: 68, velocity: 120 };
    const normalOnBodyRow = { x: 180, y: 42, width: 100, height: 24, velocity: 100 };
    const specialOnBodyRow = { x: 180, y: 40, width: 180, height: 68, velocity: 100 };
    assert.notEqual(proveBoundedCollisionSafe(special, [normalOnBodyRow], boundedAllowance).reason, 'SAFE');
    assert.notEqual(proveBoundedCollisionSafe(special, [specialOnBodyRow], boundedAllowance).reason, 'SAFE');
    assert.equal(proveBoundedCollisionSafe({ ...special, height: 28 }, [normalOnBodyRow], boundedAllowance).reason, 'SAFE');
});

test('subtitle exclusions remain hard at every density policy', () => {
    const candidate = { x: 100, y: 20, width: 100, height: 30, velocity: 100 };
    const subtitle = [{ x: 0, y: 40, width: 500, height: 40 }];
    for (const level of ['NORMAL', 'COMPACT', 'DENSE', 'MAX_READABLE']) {
        assert.ok(getDensityVisualPolicy(level));
        assert.equal(isOutsideHardExclusions(candidate, subtitle), false);
    }
    assert.equal(isOutsideHardExclusions(candidate, []), true);
    assert.equal(isOutsideHardExclusions(candidate, [{ x: 0, y: 0, width: Number.NaN, height: 10 }]), false);
});

test('SPECIAL single-line fit is bounded, never wraps or ellipsizes, and fails structurally below readable size', () => {
    const fit = computeSpecialSingleLineFit({ headerNaturalWidth: 150, bodyNaturalWidth: 300, maximumWidth: 400, baseBodyFontSize: 20, minimumBodyFontSize: 12 });
    assert.equal(fit.result, 'FIT');
    const scaled = computeSpecialSingleLineFit({ headerNaturalWidth: 150, bodyNaturalWidth: 600, maximumWidth: 400, baseBodyFontSize: 20, minimumBodyFontSize: 12 });
    assert.equal(scaled.result, 'SCALED');
    assert.ok(scaled.bodyFontSize >= 12 && scaled.bodyFontSize < 20);
    const minimumFit = computeSpecialSingleLineFit({ headerNaturalWidth: 150, bodyNaturalWidth: 500, maximumWidth: 300, baseBodyFontSize: 20, minimumBodyFontSize: 12 });
    assert.equal(minimumFit.result, 'SCALED');
    assert.equal(minimumFit.bodyFontSize, 12);
    const impossible = computeSpecialSingleLineFit({ headerNaturalWidth: 150, bodyNaturalWidth: 1000, maximumWidth: 300, baseBodyFontSize: 20, minimumBodyFontSize: 12 });
    assert.equal(impossible.result, 'UNREPRESENTABLE_SPECIAL');
    for (const result of [fit, scaled, minimumFit, impossible]) {
        assert.equal(result.headerLines, 1);
        assert.equal(result.bodyLines, 1);
        assert.equal(result.wrap, false);
        assert.equal(result.ellipsis, false);
        assert.equal(result.logicalLaneSpan, 1);
        assert.equal(result.footprintAuthority, 'POST_STYLE_TWO_LINE_RECTANGLE');
    }
});

test('temporal cohort is stable, FIFO, bounded by count and time, and semantically neutral', () => {
    const items = [
        { id: 'normal-a', enqueuedAt: 0, kind: 'NORMAL' },
        { id: 'special', enqueuedAt: 10, kind: 'SPECIAL' },
        { id: 'normal-b', enqueuedAt: 20, kind: 'NORMAL' },
        { id: 'later', enqueuedAt: 200, kind: 'SPECIAL' }
    ];
    assert.deepEqual(temporalCohort(items, { maximumItems: 3, maximumSpan: 50 }).map(({ item }) => item.id), ['normal-a', 'special', 'normal-b']);
});

test('synthetic sustainable load stays bounded without unnecessary density escalation', () => {
    const result = simulate((step) => step % 5 === 0 ? arrivals(1) : []);
    assert.ok(result.peakQueueDepth <= 1);
    assert.equal(result.finalDensity, 'NORMAL');
    assert.equal(result.emergencyDropCount, 0);
});

test('synthetic slightly-over-capacity load raises rescue without using emergency drop as flow control', () => {
    const result = simulate((step) => step % 2 === 0 ? arrivals(1) : [], { steps: 140 });
    assert.ok(result.maximumRescueIntensity > 0);
    assert.equal(result.emergencyDropCount, 0);
    assert.ok(result.peakQueueDepth < simulationConfig.maxPendingCount);
});

test('synthetic short burst is rescued and returns toward NORMAL', () => {
    const result = simulate((step) => step === 5 ? arrivals(12) : [], { steps: 120 });
    assert.ok(result.maximumObservedPressure >= 0.9);
    assert.equal(result.currentQueueDepth, 0);
    assert.equal(result.finalDensity, 'NORMAL');
});

test('synthetic long burst remains hard-bounded and distinguishes emergency from normal rescue', () => {
    const result = simulate((step) => step < 60 ? arrivals(4) : [], { steps: 150 });
    assert.ok(result.peakQueueDepth <= simulationConfig.maxPendingCount);
    assert.ok(result.emergencyDropCount > 0);
    assert.ok(result.successfulLaunchCount > 0);
});

test('synthetic burst then silence drains without rapid density oscillation', () => {
    const result = simulate((step) => step < 20 ? arrivals(2) : [], { steps: 150 });
    assert.equal(result.currentQueueDepth, 0);
    assert.equal(result.finalDensity, 'NORMAL');
    assert.ok(result.densityTransitions < 12);
});

test('synthetic collision-heavy workload makes bounded traversal progress without starvation', () => {
    const result = simulate(
        (step) => step < 25 ? arrivals(1) : [],
        { steps: 200, config: { maxPendingAge: 10000 } },
        (item, now) => item.index % 3 === 0 && now < 1500 ? 1500 : -Infinity
    );
    assert.equal(result.successfulLaunchCount, 25);
    assert.equal(result.currentQueueDepth, 0);
    assert.equal(result.staleDropCount, 0);
    assert.ok(result.maximumLaunchedWait <= 10000);
});

test('synthetic alternating high and low load recovers and avoids rapid density oscillation', () => {
    const result = simulate((step) => step < 160 && Math.floor(step / 10) % 2 === 0 ? arrivals(2) : [], { steps: 260 });
    assert.ok(result.maximumRescueIntensity > 0);
    assert.ok(result.densityTransitions < 30);
    assert.ok(result.peakQueueDepth <= simulationConfig.maxPendingCount);
    assert.equal(result.currentQueueDepth, 0);
    assert.equal(result.finalDensity, 'NORMAL');
});

test('synthetic mixed-shaped workload remains stable without semantic priority', () => {
    const result = simulate((step) => step < 35 ? arrivals(1, step % 2 ? 'FUTURE_SPECIAL_SHAPE' : 'NORMAL') : [], { steps: 140 });
    assert.equal(result.currentQueueDepth, 0);
    assert.equal(result.emergencyDropCount, 0);
    assert.ok(result.successfulLaunchCount > 0);
});
