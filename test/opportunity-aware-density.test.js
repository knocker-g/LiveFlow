const test = require('node:test');
const assert = require('node:assert/strict');
const { select } = require('./fixtures/opportunity-aware-density');
const { candidateC } = require('./fixtures/final-visual-candidates');
const { pairMetrics } = require('./fixtures/density-d-comparison');
const overlap = require('../src/normal-overlap-policy');
const config = candidateC.config;
const lane = n => ({ lane: n, interleaved: n % 1 !== 0, rectangle: { x: 1000, y: n * 32,
    width: 300, height: 32, velocity: 175, exitX: 0, surfaceRight: 1000, semanticClass: 'NORMAL',
    snapshotAt: 10, occlusionHistoryKnown: true } });
const active = { ...lane(2).rectangle, x: 580, velocity: 150 };
const context = (candidates, active = []) => ({ candidates, active, density: 'MAX_READABLE', config });
test('D retains safe base when half-step would foreclose two currently safe anchors', () => {
    const half = lane(1.5), base1 = lane(1), base2 = lane(2);
    const result = select(context([half, base1, base2]));
    assert.equal(result.candidates[0], base1);
    assert.equal(result.diagnostic.promoted, false);
    assert.equal(result.diagnostic.safeBaseCount, 2);
    assert.deepEqual(new Set(result.candidates), new Set([half, base1, base2]));
});
test('D promotes a proved half-step only when its local loss does not exceed base, or no safe base exists', () => {
    const lanes = [lane(1), lane(1.5), lane(2)], state = context(lanes, [active]);
    const before = JSON.stringify(state);
    const result = select(state);
    assert.equal(result.candidates[0], lanes[1]);
    assert.equal(result.diagnostic.foreclosedBaseCount, 1);
    assert.equal(result.diagnostic.baseCost, 1);
    assert.equal(JSON.stringify(state), before);
    assert.equal(select(context(lanes.slice(1), [active])).candidates[0], lanes[1]);
});
test('D cannot promote an aggregate-duration-rejected half-step and caps experiment input', () => {
    const half = lane(1.5), base = lane(0);
    const aged = { ...active, occlusionHistoryKnown: true, occlusionEpisodes: [[8.9, 15]] };
    const result = select(context([half, base], [aged]));
    assert.equal(result.candidates[0], base);
    assert.ok(result.diagnostic.rejected.some(r => r.reason === 'AGGREGATE_OVERLAP_DURATION'));
    const tooMany = Array.from({ length: 41 }, () => lane(1));
    assert.equal(select(context(tooMany)).diagnostic.fallback, true);
    assert.equal(select({ ...context([half, base]), density: 'NORMAL' }).diagnostic.fallback, true);
});
test('exact overlap metric detects an interval shorter than the old 200ms sampling', () => {
    const b = { ...lane(0).rectangle, initialX: 500, width: 300, velocity: 150, at: 0, special: false };
    const a = { ...lane(.5).rectangle, initialX: 798, width: 300, velocity: 130, at: 0, special: false };
    const m = pairMetrics([b, a]);
    assert.ok(m.verticalDepthPx > 0);
    assert.ok(m.verticalDurationSeconds > 0 && m.verticalDurationSeconds < .2);
    assert.equal(m.verticalAreaPx2, 32);
    assert.ok(m.verticalAreaPx2 > 0);
});
test('D captured comparison conserves accounting and preserves original B/C/C-selection evidence', () => {
    const result = require('../docs/density-d-results.json');
    const old = require('../docs/density-c-throughput-classification.json');
    for (const r of result) {
        for (const [name, key] of [['B', 'b'], ['C', 'c'], ['C-selection', 'corrected']]) {
            const v = r.variants.find(v => v.name === name), previous = old.find(o => o.shape === r.shape)[key];
            for (const field of Object.keys(previous)) assert.deepEqual(v[field], previous[field]);
        }
        const d = r.variants.find(v => v.name === 'D');
        assert.equal(d.lostUnaccounted, 0); assert.equal(d.pending, 0);
        assert.equal(d.drops.EMERGENCY_PENDING_DROPPED, 0);
        assert.deepEqual(d.safety, { safeProofViolation: 0, subtitleViolation: 0, specialViolation: 0 });
        assert.ok(d.selection.maximumForeclosed <= 1);
        assert.ok(d.exactOverlap.verticalDepthPx > 0);
        assert.ok(d.exactOverlap.verticalDurationSeconds <= overlap.C.maximumDuration + 1e-9);
        assert.equal(d.baseLaunches + d.interleaved, d.launches);
        assert.equal(r.variants[0].launches - d.launches, r.lostOpportunities.bOnlyIds.length - r.lostOpportunities.dOnlyIds.length);
    }
});
