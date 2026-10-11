const test = require('node:test');
const assert = require('node:assert/strict');
const { proveBoundedCollisionSafe } = require('../src/scheduler-foundations.js');
const { CURRENT } = require('../src/phase5-tuning.js');
const allowance = CURRENT.collisionAllowances.MAXIMUM_READABLE_RESCUE;
const active = { x: 210, y: 0, width: 300, height: 32, velocity: 150 };
test('already-overlapping equal-speed trajectories consume their full overlap duration', () => {
    const candidate = { x: 500, y: 16, width: 300, height: 32, velocity: 150 };
    assert.deepEqual(proveBoundedCollisionSafe(candidate, [active], allowance),
        { safe: false, reason: 'EXCESSIVE_OVERLAP_DURATION' });
});
test('initial overlap with opening trajectories consumes only time until separation', () => {
    const candidate = { x: 500, y: 16, width: 300, height: 32, velocity: 130 };
    assert.equal(proveBoundedCollisionSafe(candidate, [active], allowance).safe, true);
    assert.equal(proveBoundedCollisionSafe({ ...candidate, velocity: 148 }, [active], allowance).safe, false);
});
