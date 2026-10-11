const test = require('node:test');
const assert = require('node:assert/strict');
const { candidates, strokes, run } = require('./fixtures/final-visual-candidates.js');
const { CURRENT } = require('../src/phase5-tuning.js');

test('offline candidates preserve hard floor, NORMAL, SPECIAL fit, velocity and temporal inputs', () => {
    for (const { config } of candidates) {
        assert.equal(config.collisionAllowances.CONSERVATIVE, CURRENT.collisionAllowances.CONSERVATIVE);
        assert.equal(config.lengthVelocity, CURRENT.lengthVelocity);
        assert.equal(config.specialMinimumBodyFontSize, CURRENT.specialMinimumBodyFontSize);
        for (const a of Object.values(config.collisionAllowances)) assert.equal(a.hardMinimumSeparation, -24);
    }
    assert.deepEqual(strokes.map(s => s.widths), [[1.1, .45, .45, .45], [1.4, 1.1, 1.1, 1.1], [1.7, 1.4, 1.4, 1.4]]);
});

test('fixed HIGH/BURST fixtures conserve every ingress and protect subtitle/SPECIAL anchors', () => {
    for (const c of candidates) for (const shape of ['HIGH', 'BURST']) {
        const r = run(c.config, shape);
        assert.equal(r.lostUnaccounted, 0);
        assert.equal(r.pending, 0);
        assert.equal(r.drops.EMERGENCY_PENDING_DROPPED, 0);
        assert.ok(r.sourceShape[shape] > 0);
        assert.ok(r.launchesDetail.every(a => a.y + a.height <= 256));
        assert.ok(r.launchesDetail.filter(a => a.special).every(a => !a.interleaved));
        assert.ok(r.maxHorizontalOverlapPx <= 24);
        assert.ok(r.maxSampledPairOverlapSeconds <= 1.6, 'sampled pair overlap remains within candidate1.4s plus one sample');
    }
});
