const test = require('node:test');
const assert = require('node:assert/strict');
const { prove, C } = require('../src/normal-overlap-policy.js');
const { proveBoundedCollisionSafe: strict } = require('../src/scheduler-foundations.js');
const { candidates } = require('./fixtures/final-visual-candidates.js');
const allowance = candidates.find(c => c.name === 'B').config.collisionAllowances.MAXIMUM_READABLE_RESCUE;
const box = overrides => ({ x: 1000, y: 16, width: 300, height: 32, velocity: 175,
    exitX: 0, surfaceRight: 1000, semanticClass: 'NORMAL', ...overrides });
const active = box({ x: 580, y: 0, velocity: 150 });

test('C permits a finite shallow crossing beyond24px but retains deep/SPECIAL/unknown strict protection', () => {
    assert.equal(strict(box(), [active], allowance).reason, 'HARD_READABILITY_FLOOR');
    assert.equal(prove(box(), [Object.freeze(active)], allowance).safe, true);
    for (const changes of [{ y: 0 }, { height: 16, y: 12 }, { semanticClass: 'SPECIAL' }, { semanticClass: undefined }]) {
        const a = { ...active, ...changes };
        if (changes.y === 0) assert.equal(prove(box({ y: 0 }), [a], allowance).safe, false);
        else assert.equal(prove(box(), [a], allowance).safe, false);
    }
});

test('C rejects equal-speed sustained overlap, full passing, concurrency and invalid policy', () => {
    assert.equal(prove(box({ x: 500, velocity: 150 }), [box({ x: 230, y: 0, velocity: 150 })], allowance).safe, false);
    assert.equal(prove(box({ velocity: 250 }), [active], allowance).safe, false);
    assert.equal(prove(box(), [active, { ...active }, { ...active, y: 32 }], allowance).safe, false);
    assert.equal(prove(box(), [active], allowance, { ...C, maximumDuration: NaN }).safe, false);
});

test('C aggregate budget also protects an existing active from an added neighbour', () => {
    const c = box({ width: 600 });
    const a = box({ x: 558.1818181818, y: 0, velocity: 145.4545454545 });
    const b = box({ x: 215.4545454545, y: 32, velocity: 81.8181818182 });
    assert.equal(prove(c, [a], allowance).safe, true);
    assert.equal(prove(c, [b], allowance).safe, true);
    assert.equal(prove(c, [a, b], allowance).reason, 'AGGREGATE_OVERLAP_DURATION');
});

test('C visible clipping and viewport translation are finite and semantic-scope safe', () => {
    const translate = r => ({ ...r, x: r.x + 250, y: r.y + 80, exitX: 250, surfaceRight: 1250 });
    assert.deepEqual(prove(translate(box()), [translate(active)], allowance), prove(box(), [active], allowance));
    assert.equal(prove(box({ surfaceRight: undefined }), [active], allowance).safe, false);
    assert.deepEqual(prove(box({ semanticClass: 'SPECIAL' }), [active], allowance), strict(box({ semanticClass: 'SPECIAL' }), [active], allowance));
});


test('C retains elapsed occlusion history across launches and departed neighbours', () => {
    const c = box({ x: 776, velocity: 130, snapshotAt: 10, occlusionHistoryKnown: true });
    const a = box({ x: 500, y: 0, velocity: 150, occlusionHistoryKnown: true });
    assert.equal(prove(c, [a], allowance).safe, true);
    assert.equal(prove(c, [{ ...a, occlusionEpisodes: [[9, 10.1]] }], allowance).reason, 'AGGREGATE_OVERLAP_DURATION');
    assert.equal(prove(c, [{ ...a, occlusionEpisodes: [[9, NaN]] }], allowance).reason, 'INVALID_OVERLAP_GEOMETRY');
});


test('strict lower-density and SPECIAL launches preserve existing NORMAL episode budgets', () => {
    const c = box({ x: 776, velocity: 130, snapshotAt: 10, occlusionHistoryKnown: true });
    const a = box({ x: 500, y: 0, velocity: 150, occlusionHistoryKnown: true, occlusionEpisodes: [[9, 10.1]] });
    assert.equal(strict(c, [a], allowance).safe, true);
    assert.equal(prove(c, [a], allowance, C, false).reason, 'AGGREGATE_OVERLAP_DURATION');
    assert.equal(prove({ ...c, semanticClass: 'SPECIAL' }, [a], allowance).reason, 'AGGREGATE_OVERLAP_DURATION');
    const { historyKnown } = require('../src/normal-overlap-policy.js');
    assert.equal(historyKnown({ ...a, occlusionHistoryKnown: false }, [c]), false);
    assert.equal(historyKnown({ ...a, occlusionHistoryKnown: false }, []), true);
});
