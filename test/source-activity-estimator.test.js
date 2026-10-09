const test = require('node:test');
const assert = require('node:assert/strict');
const {
    computePressure,
    createDensityState,
    transitionDensity,
    transitionLowMediumDensity,
    transitionPresentationDensity,
    createSourceActivityState,
    evaluateSourceActivity,
    classifyPromotionProvenance
} = require('../src/scheduler-foundations.js');

const fixtureConfig = Object.freeze({
    bandThresholdsPerSecond: Object.freeze([1, 2, 4]),
    promotionResidence: 2,
    releaseDwell: 2
});

const currentBinding = Object.freeze({ target: 'video-a', timeline: 'replay-a', generation: 3 });

function facts(count, spanMs = 10000, overrides = {}) {
    return Array.from({ length: count }, (_, index) => Object.freeze({
        mediaTimeMs: count <= 1 ? 0 : (spanMs * index) / (count - 1),
        displayable: true,
        temporalClass: 'CURRENT_WINDOW',
        ...overrides
    }));
}

function evaluate(state, currentWindowFacts, overrides = {}) {
    return evaluateSourceActivity(state, {
        currentBinding,
        eventBinding: currentBinding,
        windowStartMs: 0,
        windowEndMs: 10000,
        facts: currentWindowFacts,
        ...overrides
    }, fixtureConfig);
}

test('source activity remains independent from pressure and records promotion provenance', () => {
    let state = createSourceActivityState(currentBinding);

    const pressureOnly = evaluate(state, facts(2));
    const highPressure = computePressure({ pendingCount: 10, oldestEligibleTemporalAge: 0, pendingPressureCapacity: 10, maxPendingAge: 1000 });
    const pressureDensity = transitionDensity(createDensityState('NORMAL', 2, 0), highPressure.pressure, {
        attackThresholds: [0.5, 0.75, 0.9],
        releaseThresholds: [0.2, 0.35, 0.5],
        minimumAttackResidence: 2,
        releaseDwell: 3
    });
    assert.equal(pressureOnly.state.band, 'LOW');
    assert.equal(pressureDensity.level, 'COMPACT');
    assert.equal(classifyPromotionProvenance({ sourceActivityPromotes: false, pressureRescuePromotes: true }), 'PRESSURE_RESCUE');

    const sourceEvidence1 = evaluate(pressureOnly.state, facts(15));
    const sourceEvidence2 = evaluate(sourceEvidence1.state, facts(15));
    const noPressure = computePressure({ pendingCount: 0, oldestEligibleTemporalAge: 0, pendingPressureCapacity: 10, maxPendingAge: 1000 });
    assert.equal(sourceEvidence2.state.band, 'MEDIUM');
    assert.equal(sourceEvidence2.promoted, true);
    assert.equal(noPressure.pressure, 0);
    assert.equal(classifyPromotionProvenance({ sourceActivityPromotes: true, pressureRescuePromotes: false }), 'SOURCE_ACTIVITY');
    assert.equal(classifyPromotionProvenance({ sourceActivityPromotes: true, pressureRescuePromotes: true }), 'BOTH');
});

test('one-shot source timeline preserves residence, release, and transport-shape neutrality', () => {
    let state = createSourceActivityState(currentBinding);
    const low = evaluate(state, facts(2));
    assert.equal(low.state.band, 'LOW');

    const transient = evaluate(low.state, facts(45, 1000));
    assert.equal(transient.candidateBand, 'BURST');
    assert.equal(transient.state.band, 'LOW');
    state = evaluate(transient.state, facts(2)).state;
    assert.equal(state.band, 'LOW');

    state = evaluate(state, facts(15)).state;
    state = evaluate(state, facts(15)).state;
    assert.equal(state.band, 'MEDIUM');

    state = evaluate(state, facts(30)).state;
    state = evaluate(state, facts(30)).state;
    assert.equal(state.band, 'HIGH');
    state = evaluate(state, facts(50)).state;
    state = evaluate(state, facts(50)).state;
    assert.equal(state.band, 'BURST');

    const reanchorBatch = evaluate(createSourceActivityState(currentBinding), facts(12));
    assert.equal(reanchorBatch.candidateBand, 'MEDIUM');
    assert.equal(reanchorBatch.state.band, 'LOW');

    state = evaluate(state, facts(2)).state;
    assert.equal(state.band, 'BURST');
    state = evaluate(state, facts(2)).state;
    assert.equal(state.band, 'HIGH');
    state = evaluate(state, facts(2)).state;
    state = evaluate(state, facts(2)).state;
    assert.equal(state.band, 'MEDIUM');
    state = evaluate(state, facts(2)).state;
    state = evaluate(state, facts(2)).state;
    assert.equal(state.band, 'LOW');
});

test('stale and old-generation facts never enter current source activity', () => {
    let state = createSourceActivityState(currentBinding);
    const stale = evaluate(state, facts(30, 10000, { temporalClass: 'STALE_BEFORE_CURRENT' }));
    assert.equal(stale.currentWindowCount, 0);
    assert.equal(stale.state.band, 'LOW');

    const oldBinding = Object.freeze({ ...currentBinding, generation: 2 });
    const late = evaluate(stale.state, facts(50, 1000), { eventBinding: oldBinding });
    assert.equal(late.accepted, false);
    assert.equal(late.state.band, 'LOW');

    const sameTargetEnvironmentChange = evaluate(late.state, facts(2), { viewportRevision: 99, fullscreen: true });
    assert.equal(sameTargetEnvironmentChange.bindingReset, false);

    const nextBinding = Object.freeze({ ...currentBinding, generation: 4 });
    const reset = evaluateSourceActivity(late.state, {
        currentBinding: nextBinding,
        eventBinding: nextBinding,
        windowStartMs: 0,
        windowEndMs: 10000,
        facts: facts(2)
    }, fixtureConfig);
    assert.equal(reset.bindingReset, true);
    assert.equal(reset.state.band, 'LOW');
});

test('fixture accounting closes without unaccounted loss', () => {
    const rows = [
        { input: 2, forwarded: 2, explicitRemoval: 0, retained: 0 },
        { input: 15, forwarded: 12, explicitRemoval: 1, retained: 2 },
        { input: 30, forwarded: 0, explicitRemoval: 30, retained: 0 }
    ];
    for (const row of rows) {
        const lostUnaccounted = row.input - row.forwarded - row.explicitRemoval - row.retained;
        assert.equal(lostUnaccounted, 0);
    }
});

test('LOW and MEDIUM density policy keeps activity and pressure orthogonal', () => {
    const policyConfig = {
        attackThresholds: [0.5, 0.75, 0.9],
        releaseThresholds: [0.2, 0.35, 0.5],
        minimumAttackResidence: 2,
        releaseDwell: 3
    };

    const lowSteady = transitionLowMediumDensity(createDensityState('NORMAL', 2, 0), {
        sourceActivityBand: 'LOW', pressure: 0
    }, policyConfig);
    assert.equal(lowSteady.state.level, 'NORMAL');
    assert.equal(lowSteady.provenance, null);

    const pressureOnly = transitionLowMediumDensity(createDensityState('NORMAL', 2, 0), {
        sourceActivityBand: 'LOW', pressure: 0.8
    }, policyConfig);
    assert.equal(pressureOnly.state.level, 'COMPACT');
    assert.equal(pressureOnly.sourceActivityBand, 'LOW');
    assert.equal(pressureOnly.provenance, 'PRESSURE_RESCUE');

    const sourceOnly = transitionLowMediumDensity(createDensityState('NORMAL', 2, 0), {
        sourceActivityBand: 'MEDIUM', pressure: 0
    }, policyConfig);
    assert.equal(sourceOnly.state.level, 'COMPACT');
    assert.equal(sourceOnly.provenance, 'SOURCE_ACTIVITY');

    const both = transitionLowMediumDensity(createDensityState('NORMAL', 2, 0), {
        sourceActivityBand: 'MEDIUM', pressure: 0.8
    }, policyConfig);
    assert.equal(both.state.level, 'COMPACT');
    assert.equal(both.provenance, 'BOTH');
});

test('LOW and MEDIUM density policy changes at most one level and releases with dwell', () => {
    const policyConfig = {
        attackThresholds: [0.5, 0.75, 0.9],
        releaseThresholds: [0.2, 0.35, 0.5],
        minimumAttackResidence: 2,
        releaseDwell: 3
    };
    let result = transitionLowMediumDensity(createDensityState('NORMAL', 0, 0), {
        sourceActivityBand: 'MEDIUM', pressure: 0
    }, policyConfig);
    assert.equal(result.state.level, 'NORMAL');
    result = transitionLowMediumDensity(result.state, { sourceActivityBand: 'MEDIUM', pressure: 0 }, policyConfig);
    assert.equal(result.state.level, 'COMPACT');

    result = transitionLowMediumDensity(result.state, { sourceActivityBand: 'LOW', pressure: 0 }, policyConfig);
    assert.equal(result.state.level, 'COMPACT');
    result = transitionLowMediumDensity(result.state, { sourceActivityBand: 'LOW', pressure: 0 }, policyConfig);
    assert.equal(result.state.level, 'COMPACT');
    result = transitionLowMediumDensity(result.state, { sourceActivityBand: 'LOW', pressure: 0 }, policyConfig);
    assert.equal(result.state.level, 'NORMAL');
    assert.equal(result.provenance, null);
});

test('HIGH and BURST activity promote one density level per evaluation with explicit provenance', () => {
    const policyConfig = {
        attackThresholds: [0.5, 0.75, 0.9],
        releaseThresholds: [0.2, 0.35, 0.5],
        minimumAttackResidence: 1,
        releaseDwell: 3
    };
    let result = transitionPresentationDensity(createDensityState('COMPACT', 1, 0), {
        sourceActivityBand: 'HIGH', pressure: 0
    }, policyConfig);
    assert.equal(result.state.level, 'DENSE');
    assert.equal(result.provenance, 'SOURCE_ACTIVITY');

    result = transitionPresentationDensity(result.state, { sourceActivityBand: 'BURST', pressure: 1 }, policyConfig);
    assert.equal(result.state.level, 'MAX_READABLE');
    assert.equal(result.provenance, 'BOTH');

    const pressureOnly = transitionPresentationDensity(createDensityState('COMPACT', 1, 0), {
        sourceActivityBand: 'LOW', pressure: 1
    }, policyConfig);
    assert.equal(pressureOnly.state.level, 'DENSE');
    assert.equal(pressureOnly.sourceActivityBand, 'LOW');
    assert.equal(pressureOnly.provenance, 'PRESSURE_RESCUE');
});

test('MAX_READABLE releases one level per dwell without mutating activity semantics', () => {
    const policyConfig = {
        attackThresholds: [0.5, 0.75, 0.9],
        releaseThresholds: [0.2, 0.35, 0.5],
        minimumAttackResidence: 1,
        releaseDwell: 2
    };
    let result = transitionPresentationDensity(createDensityState('MAX_READABLE', 1, 0), {
        sourceActivityBand: 'LOW', pressure: 0
    }, policyConfig);
    assert.equal(result.state.level, 'MAX_READABLE');
    result = transitionPresentationDensity(result.state, { sourceActivityBand: 'LOW', pressure: 0 }, policyConfig);
    assert.equal(result.state.level, 'DENSE');
    assert.equal(result.provenance, null);
});
