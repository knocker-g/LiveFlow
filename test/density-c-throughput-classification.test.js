const test = require('node:test');
const assert = require('node:assert/strict');
const results = require('../docs/density-c-throughput-classification.json');
const checkpoint = require('../docs/density-c-results.json');
// Validate captured discriminator, without rerunning already accepted safety fixtures.
test('discriminator preserves B/C checkpoint and exclusive per-comment attribution', () => {
    for (const r of results) {
        for (const [name, captured] of [['B', r.b], ['C', r.c]]) {
            assert.deepEqual(captured, checkpoint.find(c => c.name === name).runs.find(run => run.shape === r.shape));
        }
        assert.equal(new Set(r.rows.map(row => row.id)).size, r.bOnly);
        assert.equal(Object.values(r.classified).reduce((a, b) => a + b, 0), r.bOnly);
        assert.equal(r.b.launches - r.c.launches, r.bOnly - r.cOnly);
        assert.equal(r.safeBaseSelectionFailure, 0);
        assert.equal(r.missedSafeBaseEvaluation, 0);
        assert.ok(r.rows.every(row => row.recoveredByRanking === (row.cause === 'RANKING_RECOVERED')));
    }
});
test('one ranking-only intervention improves accounting without claiming retained overlap', () => {
    for (const r of results) {
        assert.ok(r.corrected.launches > r.c.launches);
        assert.ok(r.corrected.drops.CAPACITY_DROPPED < r.c.drops.CAPACITY_DROPPED);
        assert.equal(r.corrected.lostUnaccounted, 0);
        assert.equal(r.corrected.pending, 0);
        assert.equal(r.corrected.drops.EMERGENCY_PENDING_DROPPED, 0);
        assert.equal(r.corrected.specialLaunches, r.c.specialLaunches);
        assert.deepEqual(r.corrected.sourceShape, r.c.sourceShape);
        assert.equal(r.corrected.normalOverlap.crossRowVerticalPx, 0);
    }
});
