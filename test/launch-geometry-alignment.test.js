const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDensityLaneCandidates } = require('../src/geometry-adapter.js');
const { CURRENT } = require('../src/phase5-tuning.js');
const { calculateDanmakuMotion } = require('../src/overlay-core.js');
const { proveBoundedCollisionSafe } = require('../src/scheduler-foundations.js');

test('candidate starts at the same viewport CSS x as the right-entry renderer motion', () => {
    const videoRect = { x: 100, y: 50, width: 960, height: 320 };
    const generated = generateDensityLaneCandidates({ videoRect, renderedWidth: 300, renderedHeight: 32,
        actualVelocity: 150, footprint: {}, lineHeight: 32, laneGap: 0,
        densityPolicy: { density: 'MAX_READABLE', laneBandClass: 'FULL_SAFE' },
        laneBandFractions: CURRENT.laneBandFractions, interleavedAnchorStride: CURRENT.interleavedAnchorStride,
        exclusionRegions: [], special: false });
    const motion = calculateDanmakuMotion({ overlayWidth: 960, commentWidth: 300, speed: 150, startTimeMs: 0 });
    for (const c of generated.candidates) {
        assert.equal(c.rectangle.x, videoRect.x + motion.startX);
        assert.equal(c.rectangle.exitX, videoRect.x);
        assert.equal(c.rectangle.width, 300);
    }
    assert.equal(videoRect.x + motion.endX, -200);
});

test('finite future collision proof is invariant under viewport translation', () => {
    const a = { x: 500, y: 0, width: 300, height: 32, velocity: 150, exitX: 0 };
    const c = { x: 940, y: 16, width: 300, height: 32, velocity: 180, exitX: 0 };
    const shifted = r => ({ ...r, x: r.x + 100, y: r.y + 50, exitX: 100 });
    const allowance = CURRENT.collisionAllowances.MAXIMUM_READABLE_RESCUE;
    assert.equal(proveBoundedCollisionSafe(c, [a], allowance).safe, true);
    assert.deepEqual(proveBoundedCollisionSafe(shifted(c), [shifted(a)], allowance), proveBoundedCollisionSafe(c, [a], allowance));
});
