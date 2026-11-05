'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fixtures/acquisition-harness');
const { setup } = load('g13-deferred-terminal.test.js', ['setup']);
const { createPrivatePendingScope } = require('../src/private-pending-scope');
const { createRuntimeSourceRegistry } = require('../src/runtime-source-registry');
const pending = require('../src/pending-selection');
const scopeCore = require('../src/diagnostic-scope-core');
const scheduler = require('../src/scheduler-runtime');
const route = { tabId: 7, frameId: 0, documentId: '12345678-1234-1234-1234-123456789abc' };

function overflow(h) {
    for (let i = 1; i < 64; i++) h.create();
    const source = h.create(); assert.equal(source.tracked, false); return source;
}

test('Scope default LEGACY is fixed before runtime construction; dedicated is explicit', () => {
    const legacy = setup({ legacyDefault: true }), explicit = setup({ terminalPath: 'LEGACY' }), dedicated = setup();
    assert.equal(legacy.settings.productMutationFence.participates(), false);
    assert.equal(explicit.settings.productMutationFence.participates(), false);
    assert.equal(dedicated.settings.productMutationFence.participates(), true);
    assert.equal(dedicated.settings.productMutationFence.active(), false);
    assert.equal(Object.isFrozen(dedicated.settings.productMutationFence), true);
    assert.equal(Reflect.set(dedicated.settings.productMutationFence, 'participates', () => false), false);
    assert.equal(dedicated.settings.productMutationFence.participates(), true);
});

test('invalid terminal contracts fail before Runtime/work creation', () => {
    const reference = setup({ legacyDefault: true }); let creates = 0;
    for (const terminalPath of [null, false, 0, {}, '', 'deferred_private', 'UNKNOWN']) {
        assert.equal(createPrivatePendingScope({ document: {}, route, targetId: 'target', lifecycle: 0, revision: 0,
            pending, scopeCore, terminalPath, runtimeOptions: reference.settings,
            createRuntime(options) { creates++; return scheduler.createSchedulerRuntime(options); } }), null);
    }
    assert.equal(creates, 0);
});

test('legacy default cannot enter dedicated terminal after untracked source replacement', () => {
    const h = setup({ legacyDefault: true, generations: true }), old = overflow(h), scope = h.view.open();
    h.enqueue(scope, 'legacy-old'); const item = old.runtime.queue.snapshot()[0];
    const next = h.create(); assert.equal(next.tracked, false);
    assert.equal(old.runtime.queue.snapshot()[0], item);
    assert.equal(next.runtime.queue.snapshot().length, 0);
    assert.deepEqual(h.view.requestTerminal(scope), { status: 'NOT_APPLIED_UNKNOWN' });
    assert.equal(h.removals, 0); assert.equal(old.runtime.queue.snapshot()[0], item);
    assert.equal(h.settings.productMutationFence.active(), false);
});

test('legacy permits empty uncleared replacement without diagnostic rearm', () => {
    const h = setup({ legacyDefault: true, generations: true }), old = overflow(h);
    assert.equal(old.runtime.replacementReady(), false);
    assert.equal(h.create().tracked, false); assert.equal(h.registry.status().retained, 64);
    assert.equal(h.registry.status().state, 'UNKNOWN');
});

test('dedicated protects queued untracked original before terminal and after omitted-fence call', () => {
    const h = setup({ generations: true }), old = overflow(h), scope = h.view.open(); h.enqueue(scope, 'private-old');
    const item = old.runtime.queue.snapshot()[0], options = { ...h.settings }; delete options.productMutationFence;
    assert.equal(h.settings.productMutationFence.active(), false);
    assert.throws(() => h.create(), /ORIGINAL_RUNTIME_NOT_QUIESCENT/);
    assert.throws(() => h.registry.create(options), /ORIGINAL_RUNTIME_NOT_QUIESCENT/);
    assert.equal(h.runtime.queue.snapshot()[0], item); assert.equal(old.runtime.queue.snapshot()[0], item);
    assert.equal(h.removals, 0); assert.equal(h.registry.status().retained, 64);
});

test('dedicated rejects empty uncleared source; actual successful clear permits replacement without obligation transfer', () => {
    const h = setup({ generations: true }), old = overflow(h);
    assert.throws(() => h.create(), /ORIGINAL_RUNTIME_NOT_QUIESCENT/);
    old.runtime.clear(); const next = h.create(); assert.notEqual(next.runtime, old.runtime);
    assert.equal(old.runtime.queue.snapshot().length, 0); assert.equal(next.runtime.queue.snapshot().length, 0);
    assert.equal(old.runtime.queue.successfulLaunchSequence(), 0); assert.equal(next.runtime.queue.successfulLaunchSequence(), 0);
});

test('dedicated A/B preserve exact original queues and source attribution until terminal removal', () => {
    const h = setup({ generations: true }), scope = h.view.open(); h.enqueue(scope, 'A');
    const itemA = h.runtime.queue.snapshot()[0]; const B = h.create(); h.enqueue(scope, 'B');
    const itemB = B.runtime.queue.snapshot()[0];
    assert.notEqual(itemA, itemB); assert.deepEqual(h.runtime.queue.snapshot(), [itemA, itemB]);
    assert.equal(h.view.requestTerminal(scope).count, 2); assert.equal(h.removals, 1);
    assert.equal(B.runtime.queue.snapshot().length, 0); assert.equal(h.registry.status().retained, 2);
});

test('active genuine Scope operation blocks cleared untracked replacement before terminal', () => {
    const h = setup({ generations: true }), old = overflow(h), scope = h.view.open(); old.runtime.clear();
    let reads = 0;
    assert.equal(h.port.presentation.enqueue(scope, { get marker() {
        reads++; assert.equal(h.settings.productMutationFence.active(), false);
        assert.equal(h.settings.productMutationFence.quiescent(), false);
        assert.throws(() => h.create(), /ORIGINAL_RUNTIME_NOT_QUIESCENT/); return true;
    } }, { id: 'active', enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer', footprint: {} }), true);
    assert.equal(reads, 1); assert.equal(old.runtime.queue.snapshot()[0].id, 'active');
});

test('unknown actual shared-stack state cannot be replaced as quiet', () => {
    const h = setup({ generations: true }), old = overflow(h); old.runtime.clear();
    h.settings.productMutationFence.leave(); // Actual issuer underflow => UNKNOWN, not synthetic quiet.
    assert.equal(h.settings.productMutationFence.quiescent(), false);
    assert.throws(() => h.create(), /ORIGINAL_RUNTIME_NOT_QUIESCENT/);
    assert.equal(h.runtime.mutationQuiescent(), true); // Local read alone is insufficient.
    assert.equal(old.runtime.queue.snapshot().length, 0);
});

test('legacy cannot late-promote to private, nor dedicated downgrade through another Scope fence', () => {
    const legacy = setup({ legacyDefault: true, generations: true }), dedicated = setup({ generations: true });
    assert.throws(() => legacy.registry.create({ ...legacy.settings, productMutationFence: dedicated.settings.productMutationFence }),
        /ORIGINAL_PRODUCT_(PATH|FENCE)_MISMATCH/);
    assert.throws(() => dedicated.registry.create({ ...dedicated.settings, productMutationFence: legacy.settings.productMutationFence }),
        /ORIGINAL_PRODUCT_(PATH|FENCE)_MISMATCH/);
    assert.equal(legacy.settings.productMutationFence.participates(), false);
    assert.equal(dedicated.settings.productMutationFence.participates(), true);
});

test('unknown participation is rejected before source allocation', () => {
    const h = setup(), registry = createRuntimeSourceRegistry({ owner: {}, onProof() {} });
    for (const fence of [{}, { participates: () => undefined }, { participates: () => 'DEFERRED_PRIVATE' }])
        assert.throws(() => registry.create({ ...h.settings, productMutationFence: fence }), /ORIGINAL_PRODUCT_PARTICIPATION_UNKNOWN/);
    assert.equal(registry.status().retained, 0); assert.equal(registry.pendingRuntime.queue.snapshot().length, 0);
});
