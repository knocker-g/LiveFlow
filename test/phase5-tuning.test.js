const test = require('node:test');
const assert = require('node:assert/strict');
const { BASELINE, CURRENT, applyLengthAwareVelocity, rankLanePlacements, rankDensityRescuePlacements, buildSyntheticTuningMatrix } = require('../src/phase5-tuning.js');

test('Phase 5 config expands high-density rescue while preserving NORMAL and hard floor', () => {
    assert.equal(CURRENT.laneBandFractions.UPPER, BASELINE.laneBandFractions.UPPER);
    assert.ok(CURRENT.laneBandFractions.BROAD > BASELINE.laneBandFractions.BROAD);
    assert.equal(CURRENT.laneBandFractions.FULL_SAFE, 1);
    for (const key of Object.keys(CURRENT.collisionAllowances)) {
        assert.equal(CURRENT.collisionAllowances[key].hardMinimumSeparation, BASELINE.collisionAllowances[key].hardMinimumSeparation);
    }
    assert.ok(CURRENT.collisionAllowances.BOUNDED_OVERLAP.maxCatchUpRatio > BASELINE.collisionAllowances.BOUNDED_OVERLAP.maxCatchUpRatio);
    assert.ok(CURRENT.collisionAllowances.MAXIMUM_READABLE_RESCUE.maxOverlapDepthRatio > BASELINE.collisionAllowances.MAXIMUM_READABLE_RESCUE.maxOverlapDepthRatio);
});

test('font grows while tuned lane pitch narrows without line-height clipping', () => {
    assert.ok(CURRENT.fontSize > BASELINE.fontSize);
    assert.ok(CURRENT.lineHeight >= CURRENT.fontSize);
    assert.ok(CURRENT.lineHeight + CURRENT.laneGap < BASELINE.lineHeight + BASELINE.laneGap);
});

test('length-aware velocity is measured-width based, bounded, and launch-time immutable data', () => {
    const widths = [160, 360, 720, 1400];
    const speeds = widths.map((width) => applyLengthAwareVelocity(150, width, 1280, CURRENT.lengthVelocity, CURRENT.maximumSpeed));
    assert.ok(speeds[0] <= speeds[1] && speeds[1] <= speeds[2] && speeds[2] <= speeds[3]);
    assert.ok(speeds.at(-1) > speeds[0]);
    assert.ok(speeds.every((speed) => speed <= CURRENT.maximumSpeed));
    assert.ok(applyLengthAwareVelocity(150, 160, 1280, CURRENT.lengthVelocity, CURRENT.maximumSpeed) > 150);
});

test('lane placement prioritizes safe fill-behind then deterministic phased expansion', () => {
    const candidates = [0, 1, 2].map((anchorIndex) => ({ anchorIndex, rectangle: { x: 1000, width: 100 } }));
    const active = [{ anchorIndex: 1, x: 700, width: 100 }];
    const first = rankLanePlacements(candidates, active, 'stable-id');
    const second = rankLanePlacements(candidates, active, 'stable-id');
    assert.equal(first[0].anchorIndex, 1);
    assert.deepEqual(first, second);
    assert.deepEqual(candidates.map(({ anchorIndex }) => anchorIndex), [0, 1, 2]);
});

test('only DENSE and MAX_READABLE enable interleaved anchors', () => {
    assert.equal(CURRENT.interleavedAnchorStride.NORMAL, 0);
    assert.equal(CURRENT.interleavedAnchorStride.COMPACT, 0);
    assert.ok(CURRENT.interleavedAnchorStride.DENSE > 0);
    assert.equal(CURRENT.interleavedAnchorStride.MAX_READABLE, 1);
});

test('COMPACT rescue exhausts ranked primary fill-behind before deterministic secondary anchors', () => {
    const primary = [0, 2].map((anchorIndex) => ({ anchorIndex, interleaved: false, rectangle: { x: 1000, width: 100 } }));
    const secondary = [{ anchorIndex: 1, interleaved: true, rectangle: { x: 1000, width: 100 } }];
    const active = [{ anchorIndex: 2, x: 700, width: 100 }];
    const ranked = rankDensityRescuePlacements(primary, secondary, [], active, 'stable', 'COMPACT');
    assert.equal(ranked[0].anchorIndex, 2);
    assert.equal(ranked.at(-1).interleaved, true);
    assert.deepEqual(ranked, rankDensityRescuePlacements(primary, secondary, [], active, 'stable', 'COMPACT'));
});

test('COMPACT rescue preserves primary and secondary priority before expanded lanes', () => {
    const primary = [{ anchorIndex: 0, rectangle: { x: 1000, width: 100 } }];
    const secondary = [{ anchorIndex: 1, interleaved: true, rectangle: { x: 1000, width: 100 } }];
    const expansion = [{ anchorIndex: 4, expanded: true, rectangle: { x: 1000, width: 100 } }];
    const ranked = rankDensityRescuePlacements(primary, secondary, expansion, [], 'stable', 'COMPACT');
    assert.deepEqual(ranked.map(({ anchorIndex }) => anchorIndex), [0, 1, 4]);
});

test('COMPACT bounded horizontal rescue grows without interleaving or changing NORMAL hard floor', () => {
    const before = {
        ...CURRENT,
        interleavedAnchorStride: { ...CURRENT.interleavedAnchorStride, COMPACT: 0 },
        collisionAllowances: { ...CURRENT.collisionAllowances,
            LIMITED_CATCH_UP: { nominalGap: 20, hardMinimumSeparation: -24, maxCatchUpRatio: 0.6,
                maxOverlapDuration: 0.5, maxOverlapDepthRatio: 0.2, minimumVisibleFraction: 0.8 } }
    };
    const oldMedium = buildSyntheticTuningMatrix(before).scenarios.find(({ name }) => name === 'medium');
    const newMedium = buildSyntheticTuningMatrix(CURRENT).scenarios.find(({ name }) => name === 'medium');
    assert.ok(newMedium.launchCount > oldMedium.launchCount);
    assert.ok(newMedium.staleDropCount <= oldMedium.staleDropCount);
    assert.ok(newMedium.collisionBlockedCount <= oldMedium.collisionBlockedCount);
    assert.equal(newMedium.interleavedLaneUsage, 0);
    assert.equal(CURRENT.laneBandFractions.UPPER, before.laneBandFractions.UPPER);
    assert.equal(CURRENT.collisionAllowances.CONSERVATIVE, before.collisionAllowances.CONSERVATIVE);
    assert.equal(CURRENT.collisionAllowances.LIMITED_CATCH_UP.hardMinimumSeparation, before.collisionAllowances.LIMITED_CATCH_UP.hardMinimumSeparation);
});

test('SPECIAL representability range expands but remains bounded by readable minimum', () => {
    assert.ok(CURRENT.specialMaximumWidthFraction > BASELINE.specialMaximumWidthFraction);
    assert.ok(CURRENT.specialMaximumWidthPx > BASELINE.specialMaximumWidthPx);
    assert.ok(CURRENT.specialMinimumBodyFontSize < BASELINE.specialMinimumBodyFontSize);
    assert.ok(CURRENT.specialMinimumBodyFontSize > 0);
});

test('synthetic matrix improves high/burst rescue, lane spread, occupancy, and SPECIAL representation', () => {
    const before = buildSyntheticTuningMatrix(BASELINE);
    const after = buildSyntheticTuningMatrix(CURRENT);
    for (const name of ['high', 'burst']) {
        const oldRow = before.scenarios.find((row) => row.name === name);
        const newRow = after.scenarios.find((row) => row.name === name);
        assert.ok(newRow.launchCount >= oldRow.launchCount);
        assert.ok(newRow.collisionBlockedCount <= oldRow.collisionBlockedCount);
        assert.ok(newRow.laneUsageSpread >= oldRow.laneUsageSpread);
        assert.ok(newRow.interleavedLaneUsage > oldRow.interleavedLaneUsage);
    }
    const oldMedium = before.scenarios.find((row) => row.name === 'medium');
    const newMedium = after.scenarios.find((row) => row.name === 'medium');
    assert.ok(newMedium.fillBehindSuccessCount >= oldMedium.fillBehindSuccessCount);
    assert.ok(newMedium.verticalExpansionCount <= oldMedium.verticalExpansionCount);
    assert.ok(after.occupancy.long.relativeOccupancy < before.occupancy.long.relativeOccupancy);
    assert.ok(after.occupancy.veryLong.relativeOccupancy < before.occupancy.veryLong.relativeOccupancy);
    assert.ok(after.unrepresentableSpecialCount < before.unrepresentableSpecialCount);
    assert.ok(after.longNormalLaunchRate > before.longNormalLaunchRate);
    assert.ok(after.longSpecialLaunchRate > before.longSpecialLaunchRate);
    assert.deepEqual(Object.keys(after.longDropCauses), ['UNREPRESENTABLE', 'STALE', 'COLLISION_BLOCKED', 'NO_SAFE_LANE', 'OTHER']);
});

test('Production tuning module is pure and contains no browser scheduling or network mechanism', () => {
    const source = require('node:fs').readFileSync(require.resolve('../src/phase5-tuning.js'), 'utf8');
    assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|setInterval|requestAnimationFrame|setTimeout/);
});
