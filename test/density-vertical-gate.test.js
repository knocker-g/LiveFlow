const test = require('node:test');
const assert = require('node:assert/strict');
const { proveBoundedCollisionSafe } = require('../src/scheduler-foundations.js');
const { candidates } = require('./fixtures/final-visual-candidates.js');
const allowance = candidates.find(c => c.name === 'B').config.collisionAllowances.MAXIMUM_READABLE_RESCUE;
const active = { x: 500, y: 0, width: 300, height: 32, velocity: 150 };

test('half-step NORMAL overlap consumes the same horizontal hard floor as same-row overlap', () => {
    for (const y of [0, 16, 31]) {
        const candidate = { x: 776, y, width: 300, height: 32, velocity: 130 };
        assert.equal(proveBoundedCollisionSafe(candidate, [active], allowance).safe, true,
            '-24px shallow overlap opens within1.2s');
        assert.deepEqual(proveBoundedCollisionSafe({ ...candidate, x: 775 }, [active], allowance),
            { safe: false, reason: 'HARD_READABILITY_FLOOR' });
    }
});

test('adjacent-row broad overlap and full overtaking require a hard-safety decision', () => {
    assert.deepEqual(proveBoundedCollisionSafe({ x: 700, y: 16, width: 300, height: 32, velocity: 130 }, [active], allowance),
        { safe: false, reason: 'HARD_READABILITY_FLOOR' });
    assert.deepEqual(proveBoundedCollisionSafe({ x: 900, y: 16, width: 300, height: 32, velocity: 250 }, [active], allowance),
        { safe: false, reason: 'HARD_READABILITY_FLOOR' });
    assert.equal(proveBoundedCollisionSafe({ x: 700, y: 32, width: 300, height: 32, velocity: 130 }, [active], allowance).safe, true,
        'non-intersecting rows are independent; this is exactly the current binary boundary');
});
