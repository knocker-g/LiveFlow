const test = require('node:test');
const assert = require('node:assert/strict');
const {
    SEMANTIC_CLASSES,
    classifySemanticClass,
    createPendingItem,
    createSpecialPreferencePolicy,
    createFifoPolicy,
    createPendingQueue
} = require('../src/pending-selection.js');

function item(id, enqueuedAt, rendererType = 'liveChatTextMessageRenderer', footprint = { width: 100, height: 24 }) {
    return createPendingItem({ id, enqueuedAt, rendererType, payload: { id }, footprint });
}

function fill(queue, values) {
    values.forEach((value) => assert.equal(queue.enqueue(value), true));
}

function evaluate(queue, overrides = {}) {
    return queue.evaluate({
        scanDepth: 3,
        cohortMaximumItems: 3,
        cohortMaximumSpan: 50,
        isSafe: () => true,
        policy: createSpecialPreferencePolicy(),
        ...overrides
    });
}

test('semantic classification is limited to Super Chat and Super Sticker', () => {
    assert.equal(classifySemanticClass({ rendererType: 'liveChatPaidMessageRenderer' }), SEMANTIC_CLASSES.SPECIAL);
    assert.equal(classifySemanticClass({ rendererType: 'liveChatPaidStickerRenderer' }), SEMANTIC_CLASSES.SPECIAL);
    assert.equal(classifySemanticClass({ rendererType: 'liveChatMembershipItemRenderer', authorRole: 'OWNER' }), SEMANTIC_CLASSES.NORMAL);
});

test('FIFO policy selects the oldest safe candidate', () => {
    const queue = createPendingQueue();
    fill(queue, [item('a', 0), item('b', 1), item('c', 2)]);
    const selected = evaluate(queue, { policy: createFifoPolicy() });
    assert.equal(selected.item.id, 'a');
});

test('blocked head stays in place while bounded bypass selects a safe item', () => {
    const queue = createPendingQueue();
    fill(queue, [item('blocked', 0), item('safe', 1), item('later', 2)]);
    const selected = evaluate(queue, { isSafe: (candidate) => candidate.id !== 'blocked', policy: createFifoPolicy() });
    assert.equal(selected.item.id, 'safe');
    assert.deepEqual(queue.snapshot().map(({ id }) => id), ['blocked', 'safe', 'later']);
    assert.equal(queue.confirmSuccessfulLaunch(selected.token), true);
    assert.deepEqual(queue.snapshot().map(({ id }) => id), ['blocked', 'later']);
});

test('selector never inspects beyond SCAN_DEPTH', () => {
    const queue = createPendingQueue();
    fill(queue, Array.from({ length: 20 }, (_, index) => item(index, index)));
    let inspections = 0;
    const selected = evaluate(queue, { scanDepth: 4, isSafe: () => { inspections += 1; return false; } });
    assert.equal(selected, null);
    assert.equal(inspections, 4);
});

test('failed selection and failed confirmation do not advance successful sequence', () => {
    const queue = createPendingQueue();
    fill(queue, [item('a', 0), item('b', 1)]);
    assert.equal(evaluate(queue, { isSafe: () => false }), null);
    assert.equal(queue.successfulLaunchSequence(), 0);
    assert.equal(queue.confirmSuccessfulLaunch({}), false);
    assert.equal(queue.successfulLaunchSequence(), 0);
    const selected = evaluate(queue);
    assert.equal(queue.confirmSuccessfulLaunch(selected.token), true);
    assert.equal(queue.successfulLaunchSequence(), 1);
});

test('SPECIAL preference applies only within the bounded temporal cohort', () => {
    const queue = createPendingQueue();
    fill(queue, [
        item('normal-head', 0),
        item('special-near', 10, 'liveChatPaidMessageRenderer'),
        item('normal-near', 20),
        item('special-outside', 200, 'liveChatPaidStickerRenderer')
    ]);
    assert.equal(evaluate(queue, { scanDepth: 4 }).item.id, 'special-near');

    const outsideQueue = createPendingQueue();
    fill(outsideQueue, [item('normal', 0), item('outside-special', 200, 'liveChatPaidMessageRenderer')]);
    assert.equal(evaluate(outsideQueue, { scanDepth: 2, cohortMaximumItems: 1 }).item.id, 'normal');
});

test('stale and hard-count drops are FIFO and ignore semantic class', () => {
    const stale = createPendingQueue();
    fill(stale, [item('old-special', 0, 'liveChatPaidMessageRenderer'), item('old-normal', 1), item('current', 90)]);
    assert.deepEqual(stale.pruneStale(100, 20).map(({ id }) => id), ['old-special', 'old-normal']);

    const bounded = createPendingQueue();
    fill(bounded, [item('special', 0, 'liveChatPaidStickerRenderer'), item('normal', 1), item('new', 2)]);
    assert.deepEqual(bounded.enforceHardCount(2).map(({ id }) => id), ['special']);
});

test('items are neither aggregated nor deduplicated', () => {
    const queue = createPendingQueue();
    fill(queue, [item('same', 0), item('same', 1), item('same', 2)]);
    assert.equal(queue.snapshot().length, 3);
});

test('SPECIAL footprint metadata is preserved without normal-lane compression', () => {
    const footprint = { width: 320, height: 96, measuredKind: 'PAID_STICKER' };
    const special = item('special', 0, 'liveChatPaidStickerRenderer', footprint);
    assert.deepEqual(special.footprint, footprint);
    assert.notEqual(special.footprint.height, 24);
});

test('no safe candidate returns no-selection and preserves queue', () => {
    const queue = createPendingQueue();
    fill(queue, [item('a', 0), item('b', 1)]);
    assert.equal(evaluate(queue, { isSafe: () => false }), null);
    assert.deepEqual(queue.snapshot().map(({ id }) => id), ['a', 'b']);
});

test('rotating stride provides bounded repeated progress without starving blocked-head fixture', () => {
    const queue = createPendingQueue();
    fill(queue, Array.from({ length: 11 }, (_, index) => item(index, index)));
    const launched = [];
    for (let attempt = 0; attempt < 20 && queue.snapshot().length; attempt += 1) {
        const selected = evaluate(queue, {
            scanDepth: 3,
            cohortMaximumItems: 11,
            cohortMaximumSpan: 20,
            isSafe: (candidate) => candidate.id !== 0,
            policy: createFifoPolicy()
        });
        if (!selected) break;
        launched.push(selected.item.id);
        assert.equal(queue.confirmSuccessfulLaunch(selected.token), true);
    }
    assert.deepEqual(new Set(launched), new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    assert.deepEqual(queue.snapshot().map(({ id }) => id), [0]);
    assert.equal(queue.successfulLaunchSequence(), 10);
});

test('bounded bypass cursor escapes an entirely blocked scan without advancing successful sequence', () => {
    const queue = createPendingQueue();
    fill(queue, Array.from({ length: 11 }, (_, index) => item(index, index,
        index === 1 ? 'liveChatPaidMessageRenderer' : 'liveChatTextMessageRenderer')));
    const initiallyBlocked = new Set([0, 5, 10]);
    const first = evaluate(queue, {
        scanDepth: 3,
        cohortMaximumItems: 11,
        cohortMaximumSpan: 20,
        isSafe: (candidate) => !initiallyBlocked.has(candidate.id)
    });
    assert.equal(first, null);
    assert.equal(queue.successfulLaunchSequence(), 0);
    let selected = null;
    for (let attempt = 0; attempt < 11 && !selected; attempt += 1) {
        selected = evaluate(queue, {
            scanDepth: 3,
            cohortMaximumItems: 11,
            cohortMaximumSpan: 20,
            isSafe: (candidate) => !initiallyBlocked.has(candidate.id)
        });
    }
    assert.ok(selected);
    assert.equal(queue.successfulLaunchSequence(), 0);
    assert.equal(queue.confirmSuccessfulLaunch(selected.token), true);
    assert.equal(queue.successfulLaunchSequence(), 1);
});

test('structurally unrepresentable item is removed without masquerading as stale or blocking later items', () => {
    const queue = createPendingQueue();
    queue.enqueue(item('special-impossible', 0, 'liveChatPaidMessageRenderer'));
    queue.enqueue(item('normal', 1));
    const selection = queue.evaluate({
        scanDepth: 2,
        cohortMaximumItems: 2,
        cohortMaximumSpan: 10,
        isSafe: (candidate) => candidate.id === 'special-impossible' ? { discard: true, reason: 'UNREPRESENTABLE_SPECIAL' } : true,
        policy: createFifoPolicy()
    });
    assert.equal(selection.item.id, 'normal');
    assert.deepEqual(queue.snapshot().map(({ id }) => id), ['normal']);
    assert.equal(queue.successfulLaunchSequence(), 0);
});
