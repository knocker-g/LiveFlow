'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { load } = require('./fixtures/acquisition-harness');
const { setup } = load('g13-deferred-terminal.test.js', ['setup']);
const { environment } = load('g13-renderer-transaction.test.js', ['environment']);
const { fixture } = require('./fixtures/production-integration');
const manifest = JSON.parse(fs.readFileSync('build/replay-z-production-20261029-final/manifest.json'));

test('fixture qualification: actual original Runtime evaluation enters and exits its issuer fence', () => {
    let entries = 0;
    const h = setup({ evaluate(a) {
        entries++; assert.equal(a.runtime.status().state, 'EVALUATING');
        assert.equal(a.runtime.mutationQuiescent(), false);
        assert.equal(a.settings.productMutationFence.quiescent(), false);
    } });
    const scope = h.view.open(); h.enqueue(scope, 'original'); h.tick();
    assert.equal(entries, 1); assert.equal(h.runtime.mutationQuiescent(), true);
    assert.equal(h.settings.productMutationFence.quiescent(), true);
});

test('T1/T2 nonterminal cleanup defers physical removal during actual evaluation', () => {
    let scope, lease, result, physical = 0;
    const h = setup({ beforeRemoval() { physical++; }, evaluate(a) {
        const item = a.runtime.queue.snapshot()[0];
        result = a.view.withPresentationCleanup(lease, () => {
            assert.equal(a.view.presentationWorkAllowed(lease), false);
            assert.equal(a.runtime.queue.snapshot()[0], item);
        });
        assert.equal(result.status, 'DEFERRED'); assert.equal(Object.hasOwn(result, 'count'), false);
        assert.equal(physical, 0); assert.equal(a.runtime.queue.snapshot()[0], item);
        assert.ok(a.view.resolveProductLease(lease));
    } });
    scope = h.view.open(); lease = h.view.productLease(scope); h.enqueue(scope, 'original'); h.tick();
    assert.equal(physical, 1); assert.equal(h.runtime.queue.snapshot().length, 0);
    assert.equal(h.view.presentationCleanupStatus(lease).status, 'APPLIED');
    assert.equal(h.view.presentationWorkAllowed(lease), true);
    assert.equal(h.runtime.queue.successfulLaunchSequence(), 0);
});

test('T3 receiver cleanup barrier rejects nested presentation with no timer registration', () => {
    const h = setup(), scope = h.view.open(), lease = h.view.productLease(scope);
    const queue = h.runtime.queue;
    let result;
    h.view.withProductReceiver(lease, () => {
        result = h.view.withPresentationCleanup(lease, () => {});
        assert.equal(result.status, 'DEFERRED');
        assert.equal(h.port.presentation.enqueue(scope, {}, { id: 'nested', enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer', footprint: {} }), false);
        assert.equal(h.callbacks.length, 0); assert.equal(h.runtime.queue, queue);
    });
    assert.equal(h.view.presentationCleanupStatus(lease).status, 'STALE_OR_NOT_FOUND');
    assert.equal(h.view.presentationWorkAllowed(lease), true);
    assert.equal(h.enqueue(scope, 'next'), true); assert.equal(h.callbacks.length, 1);
});

test('T4 actual terminal supersedes deferred visual clear at original exit', () => {
    let scope, lease;
    const h = setup({ evaluate(a) {
        assert.equal(a.view.withPresentationCleanup(lease, () => {}).status, 'DEFERRED');
        assert.equal(a.view.requestTerminal(scope).status, 'DEFERRED');
        assert.equal(a.removals, 0);
    } });
    scope = h.view.open(); lease = h.view.productLease(scope); h.enqueue(scope, 'original'); h.tick();
    assert.equal(h.removals, 1); assert.equal(h.runtime.queue.snapshot().length, 0);
    assert.equal(h.view.presentationCleanupStatus(lease).status, 'SUPERSEDED_BY_TERMINAL');
    assert.equal(h.view.resolveProductLease(lease), null);
});

test('T4 failure is final and original primary exception wins over drain failure', () => {
    const primary = {}, cleanup = {}; let scope, lease;
    const h = setup({ removeThrow: cleanup, evaluate(a) {
        a.view.withPresentationCleanup(lease, () => {}); throw primary;
    } });
    scope = h.view.open(); lease = h.view.productLease(scope); h.enqueue(scope, 'original');
    assert.throws(() => h.tick(), e => e === primary);
    assert.equal(h.view.presentationCleanupStatus(lease).status, 'FAILED');
    assert.equal(h.removals, 1);
    assert.equal(h.view.withPresentationCleanup(lease, () => assert.fail('no retry')).status, 'FAILED');
    assert.equal(h.removals, 1); assert.equal(h.view.presentationWorkAllowed(lease), false);
});

test('T5/T6 actual Bridge positive gate and nonterminal cleanup retain Runtime/queue', async () => {
    let token;
    const h = fixture(manifest, { onBatch(v) { token = v.productLease; } });
    await h.start(); await h.answer();
    assert.ok(token); assert.equal(h.bridge.privateEntry.isProductCurrent(token), true);
    assert.equal(h.bridge.privateEntry.isProductCurrent({}), false);
    const runtime = h.runtime, queue = runtime.queue, credit = queue.successfulLaunchSequence();
    const result = h.bridge.cleanupPresentation(h.renderer);
    assert.ok(['APPLIED', 'STALE_OR_NOT_FOUND'].includes(result.status));
    assert.equal(h.r.state.phase3Runtime, runtime); assert.equal(h.runtime.queue, queue);
    assert.equal(queue.successfulLaunchSequence(), credit);
    assert.equal(h.bridge.privateEntry.isProductCurrent(token), true);
    h.bridge.retire(); assert.equal(h.bridge.privateEntry.isProductCurrent(token), false);
    assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
});

test('T7 cleanup before animate throws retains UNKNOWN and exact primary', async () => {
    const e = await environment(), tx = e.prepare(), create = e.f.dependencies.document.createElement, primary = {};
    e.f.dependencies.document.createElement = tag => { const n = create(tag);
        n.animate = () => { e.f.renderer.cleanupOverlay(); throw primary; }; return n; };
    assert.throws(() => tx.start(), error => error === primary);
    assert.equal(tx.status().native, 'UNKNOWN'); assert.equal(tx.status().settledAndCleaned, false);
    assert.equal(e.f.state.activeDanmaku.size, 1);
    const record = [...e.f.state.activeDanmaku.values()][0];
    assert.equal(record.productAttempt.productLease, e.lease);
    assert.equal(record.productAttempt.scope, e.owner.scope);
});

test('T8 duplicate reentrant cleanup coalesces and real receiver finally precedes drain', () => {
    const h = setup(), scope = h.view.open(), lease = h.view.productLease(scope), order = [];
    h.view.withProductReceiver(lease, () => {
        try {
            h.view.withPresentationCleanup(lease, () => {
                order.push('visual');
                assert.equal(h.view.withPresentationCleanup(lease, () => assert.fail('duplicate visual')).status, 'DEFERRED');
            });
        } finally { order.push('receiver-finally'); assert.equal(h.removals, 0); }
    });
    order.push('returned'); assert.deepEqual(order, ['visual', 'receiver-finally', 'returned']);
    assert.equal(h.removals, 1); assert.equal(h.view.resolveProductLease(lease).scope, scope);
});

test('T2/T3 real selected native callback defers clear and cannot arm nested work', async () => {
    let batch;
    const h = fixture(manifest, { animationMode: 'never', onBatch(v) { batch = v; } });
    await h.start(); await h.answer();
    const originalRuntime = h.runtime, originalItem = originalRuntime.queue.snapshot()[0];
    assert.ok(originalItem); const beforeJobs = h.schedulerJobs.length;
    const create = h.r.dependencies.document.createElement;
    let entered = 0, deferred;
    h.r.dependencies.document.createElement = tag => { const n = create(tag), animate = n.animate;
        n.animate = (...args) => {
            entered++; assert.equal(originalRuntime.status().state, 'EVALUATING');
            assert.equal(originalRuntime.queue.snapshot()[0], originalItem);
            deferred = h.bridge.cleanupPresentation(h.renderer);
            assert.equal(deferred.status, 'DEFERRED');
            assert.equal(originalRuntime.queue.snapshot()[0], originalItem);
            const history = h.state.currentMessages.length;
            h.content.processLegacySuccess([{ id: 'nested', messageType: 'text', message: 'fixture' }],
                batch.pendingOwner, batch.scope, batch.productLease);
            assert.equal(h.state.currentMessages.length, history);
            assert.equal(h.schedulerJobs.length, beforeJobs);
            return animate.apply(n, args);
        }; return n; };
    h.launch();
    assert.equal(entered, 1); assert.equal(h.runtime, originalRuntime);
    assert.equal(originalRuntime.queue.snapshot().length, 0);
    assert.equal(originalRuntime.queue.successfulLaunchSequence(), 0);
    assert.equal(h.schedulerJobs.length, beforeJobs);
    assert.equal(h.r.animations.length, 1);
    const record = [...h.r.state.activeDanmaku.values()][0]; assert.ok(record);
    assert.equal(record.productAttempt.productLease, batch.productLease);
    assert.equal(record.productAttempt.scope, batch.scope);
    assert.equal(record.productAttempt.nativeReturned, true);
    assert.equal(record.productAttempt.native, 'UNSETTLED');
    assert.equal(record.productAttempt.aborted, true);
});

for (const legacyFallback of [false, true]) test(`T5 real positive path, legacyFallback=${legacyFallback}, diagnostic fault independent`, async () => {
    let token;
    const h = fixture(manifest, { legacyFallback, onBatch(v) { token = v.productLease; } });
    await h.start(); h.bridge.rendererObserver.onFault(); await h.answer();
    assert.ok(token); assert.equal(h.bridge.privateEntry.isProductCurrent(token), true);
    assert.equal(h.runtime.queue.snapshot()[0].payload.productLease, token);
    h.launch(); assert.equal(h.r.animations.length, 1);
    assert.equal(h.runtime.queue.successfulLaunchSequence(), 1);
    const original = [...h.r.state.activeDanmaku.values()][0];
    assert.equal(original.productAttempt.productLease, token);
    assert.equal(original.productAttempt.queueConfirmed, true);
    const history = h.state.currentMessages.length;
    h.content.processLegacySuccess([{ id: 'missing', messageType: 'text' }], undefined, undefined, undefined);
    assert.equal(h.state.currentMessages.length, history);
});

for (const legacyFallback of [false, true]) {
    for (const boundary of ['handoff', 'pending', 'previsible']) test(`T5 child replacement denies ${boundary}, legacyFallback=${legacyFallback}`, async () => {
        let batch, swapped = 0, created = 0;
        const swap = h => {
            h.f.value(h.f.frame).child = new h.f.realm.Document({ url: h.f.value(h.f.child).url });
            swapped++;
        };
        const h = fixture(manifest, { legacyFallback, onBatch(v) {
            batch = v;
            if (boundary === 'handoff') swap(h);
        } });
        await h.start(); await h.answer();
        assert.ok(batch.productLease);
        if (boundary !== 'handoff') {
            assert.equal(h.runtime.queue.snapshot()[0].payload.productLease, batch.productLease);
            if (boundary === 'pending') swap(h);
            else {
                const create = h.r.dependencies.document.createElement;
                h.r.dependencies.document.createElement = tag => {
                    const node = create(tag);
                    const bounds = node.getBoundingClientRect;
                    node.getBoundingClientRect = (...args) => {
                        if (!swapped && [...h.r.state.activeDanmaku.values()].some(record => record.node === node && record.productAttempt)) {
                            created++; swap(h);
                        }
                        return bounds.apply(node, args);
                    };
                    return node;
                };
            }
            h.launch();
            assert.equal(h.runtime.queue.successfulLaunchSequence(), 0);
        } else assert.equal(h.runtime, null);
        assert.equal(swapped, 1);
        if (boundary === 'previsible') assert.equal(created, 1);
        assert.equal(h.bridge.privateEntry.isProductCurrent(batch.productLease), false);
        assert.equal(h.r.animations.length, 0);
        assert.equal(h.r.state.activeDanmaku.size, 0);
        assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
    });
}

test('T7 actual Bridge selected native effect then throw preserves original UNKNOWN and primary', async () => {
    let batch;
    const h = fixture(manifest, { animationMode: 'never', onBatch(v) { batch = v; } });
    await h.start(); await h.answer();
    const runtime = h.runtime, queue = runtime.queue, item = queue.snapshot()[0], primary = {};
    const create = h.r.dependencies.document.createElement;
    let effects = 0;
    h.r.dependencies.document.createElement = tag => {
        const node = create(tag), animate = node.animate;
        node.animate = (...args) => {
            assert.equal(runtime.status().state, 'EVALUATING');
            assert.equal(queue.snapshot()[0], item);
            animate.apply(node, args); effects++;
            assert.equal(h.bridge.cleanupPresentation(h.renderer).status, 'DEFERRED');
            assert.equal(queue.snapshot()[0], item);
            throw primary;
        };
        return node;
    };
    assert.throws(() => h.launch(), error => error === primary);
    assert.equal(effects, 1); assert.equal(h.r.animations.length, 1);
    assert.equal(h.runtime, runtime); assert.equal(runtime.queue, queue);
    assert.equal(queue.successfulLaunchSequence(), 0);
    assert.equal(runtime.mutationQuiescent(), true);
    assert.equal(queue.snapshot().length, 0);
    const records = [...h.r.state.activeDanmaku.values()]; assert.equal(records.length, 1);
    const attempt = records[0].productAttempt;
    assert.equal(attempt.scope, batch.scope); assert.equal(attempt.productLease, batch.productLease);
    assert.equal(attempt.runtime, runtime); assert.equal(attempt.nativeReturned, false);
    assert.equal(attempt.native, 'UNKNOWN'); assert.equal(attempt.queueConfirmed, false);
    h.bridge.cleanupPresentation(h.renderer);
    assert.equal(h.r.state.activeDanmaku.size, 1);
    assert.equal(attempt.native, 'UNKNOWN'); assert.equal(queue.successfulLaunchSequence(), 0);
    assert.equal(effects, 1); assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
});
