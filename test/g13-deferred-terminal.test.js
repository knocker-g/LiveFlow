'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pending = require('../src/pending-selection');
const scopeCore = require('../src/diagnostic-scope-core');
const scheduler = require('../src/scheduler-runtime');
const geometry = require('../src/geometry-adapter');
const { load } = require('./fixtures/acquisition-harness');
const { createPrivatePendingScope } = require('../src/private-pending-scope');
const { createRuntimeSourceRegistry } = require('../src/runtime-source-registry');
const route = { tabId: 7, frameId: 0, documentId: '12345678-1234-1234-1234-123456789abc' };
const config = load('private-pending-scope.test.js', ['harness']).harness;

// Reuse actual existing runtime configuration, with actual queues/selection and
// no Renderer/native-success simulation: launch denies unless a test says throw.
function setup(options = {}) {
    const reference = config();
    let settings;
    const callbacks = [], events = [], trace = [];
    let runtime, registry, source, removals = 0, api;
    const document = {};
    const port = createPrivatePendingScope({ document, route, targetId: 'target', lifecycle: 0, revision: 0,
        ...(options.legacyDefault ? {} : { terminalPath: Object.hasOwn(options, 'terminalPath')
            ? options.terminalPath : 'DEFERRED_PRIVATE' }),
        pending, scopeCore, runtimeGenerations: options.generations === true,
        readRuntimeCoverage: () => registry.status().state === 'OBSERVING',
        createRuntime(value) {
            settings = value;
            if (options.generations) {
                registry = createRuntimeSourceRegistry({ owner: {}, onProof(...args) { options.proof?.(api, ...args); } });
                runtime = registry.pendingRuntime;
            } else if (options.observed) {
                source = scheduler.createPrivateSchedulerRuntime(value,
                    (...args) => options.evaluation?.(api, ...args), () => options.item?.(api));
                runtime = source.runtime;
            }
            else runtime = scheduler.createSchedulerRuntime(value);
            const original = runtime;
            return Object.freeze({ ...runtime, removePendingOwner(binding) {
                removals++; trace.push('remove');
                options.beforeRemoval?.(api, binding);
                if (options.removeThrow) throw options.removeThrow;
                if (options.removeFail) return { status: 'FAILED', count: null };
                return original.removePendingOwner(binding);
            } });
        },
        runtimeOptions: {
            clock: () => 0, generation: () => 1,
            geometryAdapter: geometry.createSubtitleGeometryAdapter({ authority: geometry.createGeometryAuthority({ epsilon: 1 }),
                readGeometry: () => ({ state: 'KNOWN_EMPTY', exclusionRegions: [], capabilityAvailable: true }) }),
            scheduleOneShot(fn) { trace.push('arm'); callbacks.push(fn); return fn; },
            cancelOneShot(fn) { const i = callbacks.indexOf(fn); if (i >= 0) callbacks.splice(i, 1); },
            candidateProof() { options.evaluate?.(api); return null; },
            launch() { throw Error('unexpected launch'); },
            observe(e) { events.push(e); options.observe?.(api, e); },
            // Exact existing scheduler tuning; no new native outcome.
            config: {
                maxPendingAge: 1000, maxPendingCount: 20, pendingPressureCapacity: 5,
                scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
                pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: .75 },
                density: { attackThresholds: [.5, .7, .9], releaseThresholds: [.2, .3, .4], minimumAttackResidence: 1, releaseDwell: 3 },
                collisionAllowances: Object.fromEntries(['CONSERVATIVE', 'LIMITED_CATCH_UP', 'BOUNDED_OVERLAP', 'MAXIMUM_READABLE_RESCUE'].map(name => [name, {
                    nominalGap: 20, hardMinimumSeparation: -10, maxCatchUpRatio: .5,
                    maxOverlapDuration: 1, maxOverlapDepthRatio: .2, minimumVisibleFraction: .8
                }]))
            }
        } });
    assert.ok(port); assert.equal(reference.runtime().queue.snapshot().length, 0);
    const view = port.connect({ document, targetId: 'target', lifecycle: 0, revision: 0 }, route);
    api = { port, view, runtime, registry, source, callbacks, events, trace,
        get removals() { return removals; }, get settings() { return settings; },
        create() { return registry.create(settings); },
        enqueue(scope, id) { return port.presentation.enqueue(scope, {}, { id, enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer', footprint: {} }); },
        tick() { const fn = callbacks.shift(); assert.equal(typeof fn, 'function'); return fn(); } };
    if (registry) api.create();
    return api;
}

test('new terminal revokes genuine lease immediately and defers actual first removal during evaluation', () => {
    let scope, lease, deferred;
    const h = setup({ evaluate(a) {
        deferred = a.view.requestTerminal(scope);
        assert.equal(a.view.resolveProductLease(lease), null);
        assert.equal(a.port.presentation.enqueue(scope, {}, {}), false);
        assert.equal(a.removals, 0);
        assert.equal(a.runtime.queue.snapshot().length, 1);
        assert.deepEqual(deferred, { status: 'DEFERRED' });
        assert.equal(Object.hasOwn(deferred, 'count'), false);
        assert.equal(Object.hasOwn(deferred, 'proof'), false);
    } });
    scope = h.view.open(); lease = h.view.productLease(scope); h.enqueue(scope, 'a'); h.tick();
    assert.equal(h.removals, 1); assert.equal(h.runtime.queue.snapshot().length, 0);
    assert.equal(h.view.requestTerminal(scope).originalStatus, 'APPLIED');
    assert.equal(h.view.status().scopes[0].state, 'INCOMPLETE');
});

test('old legacy terminal still caches EVALUATING FAILED, never retries', () => {
    let scope, result;
    const h = setup({ evaluate(a) { result = a.view.terminal(scope); } });
    scope = h.view.open(); h.enqueue(scope, 'a'); h.tick();
    assert.equal(result.status, 'FAILED'); assert.equal(h.removals, 1);
    assert.equal(h.view.requestTerminal(scope).originalStatus, 'FAILED');
    assert.equal(h.removals, 1); assert.equal(h.runtime.queue.snapshot().length, 1);
});

test('synchronous quiet terminal performs one actual removal; forged scope stays unknown', () => {
    const h = setup(), scope = h.view.open(); h.enqueue(scope, 'a');
    assert.equal(h.view.requestTerminal({}).status, 'NOT_APPLIED_UNKNOWN');
    assert.equal(h.view.requestTerminal(scope).status, 'APPLIED');
    h.view.drainTerminalRemovals(); h.view.requestTerminal(scope);
    assert.equal(h.removals, 1); assert.equal(h.runtime.queue.successfulLaunchSequence(), 0);
});

test('drain precedes next arm and preserves surviving original Scope order', () => {
    let a, b;
    const h = setup({ evaluate(x) { if (!b) {
        assert.equal(x.view.requestTerminal(a).status, 'DEFERRED');
        b = x.view.open(); x.enqueue(b, 'b');
        x.trace.push('callback-exit');
    } } });
    a = h.view.open(); h.enqueue(a, 'a'); h.trace.length = 0; h.tick();
    assert.deepEqual(h.runtime.queue.snapshot().map(x => x.id), ['b']);
    assert.ok(h.trace.indexOf('callback-exit') < h.trace.indexOf('remove'));
    assert.ok(h.trace.indexOf('remove') < h.trace.indexOf('arm'));
});

test('real removal FAILED is final; no next-arm spin or retry', () => {
    let scope;
    const h = setup({ removeFail: true, evaluate(x) { x.view.requestTerminal(scope); } });
    scope = h.view.open(); h.enqueue(scope, 'a'); h.tick();
    assert.equal(h.view.requestTerminal(scope).originalStatus, 'FAILED');
    h.view.drainTerminalRemovals(); h.view.drainTerminalRemovals();
    assert.equal(h.removals, 1); assert.equal(h.callbacks.length, 0);
    assert.equal(h.runtime.queue.snapshot().length, 1);
});

test('primary evaluation exception wins over cleanup failure with exact identity', () => {
    const primary = {}, cleanup = {}; let scope;
    const h = setup({ removeThrow: cleanup, evaluate(x) { x.view.requestTerminal(scope); throw primary; } });
    scope = h.view.open(); h.enqueue(scope, 'a');
    assert.throws(() => h.tick(), e => e === primary);
    assert.equal(h.removals, 1); assert.equal(h.runtime.mutationQuiescent(), true);
    assert.equal(h.view.requestTerminal(scope).originalStatus, 'FAILED');
    assert.equal(h.callbacks.length, 0);
});

test('cleanup-only exception remains exact and failed obligation is not retried', () => {
    const error = {}; const h = setup({ removeThrow: error }), scope = h.view.open(); h.enqueue(scope, 'a');
    assert.throws(() => h.view.requestTerminal(scope), e => e === error);
    assert.equal(h.view.requestTerminal(scope).originalStatus, 'FAILED'); assert.equal(h.removals, 1);
});

test('receiver callback stays active until it returns, including private diagnostic wrappers', () => {
    let scope, lease, association, originalItem, originalRuntime, proof, deferred;
    let once = false, entries = 0, exits = 0, receiverError, removalWitness;
    const h = setup({ observed: true, evaluation(a, item, outcome, originalProof) {
        entries++; once = true; a.trace.push('receiver-entry'); proof = originalProof;
        // Product intentionally catches diagnostic receiver exceptions. Retain
        // test assertion failures explicitly so that catch cannot hide them.
        try {
            assert.equal(entries, 1); assert.equal(exits, 0);
            assert.equal(a.runtime, originalRuntime); assert.equal(item, originalItem);
            assert.equal(outcome, 'NOT_SAFE');
            assert.equal(a.source.isProofDelivering(), true);
            assert.equal(a.runtime.mutationQuiescent(), false);
            assert.equal(a.source.recognizeEvaluationProof(proof).event.item, originalItem);
            deferred = a.view.requestTerminal(scope);
            assert.deepEqual(deferred, { status: 'DEFERRED' });
            assert.equal(Object.hasOwn(deferred, 'count'), false);
            assert.equal(Object.hasOwn(deferred, 'proof'), false);
            assert.equal(a.view.resolveProductLease(lease), null);
            assert.equal(a.port.presentation.enqueue(scope, {}, {}), false);
            assert.equal(a.view.status().scopes[0].terminal, true);
            assert.notEqual(a.view.status().scopes[0].state, 'CLOSED');
            assert.equal(a.removals, 0);
            assert.equal(a.runtime.queue.snapshot()[0], originalItem);
        } catch (error) { receiverError = error; }
        finally { exits++; a.trace.push('receiver-exit'); }
    }, beforeRemoval(a, binding) {
        removalWitness = { entries, exits, runtime: a.runtime, binding,
            quiescent: a.runtime.mutationQuiescent(), delivering: a.source.isProofDelivering(),
            receipt: a.source.recognizeEvaluationProof(proof), item: a.runtime.queue.snapshot()[0] };
    } });
    scope = h.view.open(); lease = h.view.productLease(scope); association = h.view.resolveProductLease(lease);
    h.enqueue(scope, 'a'); originalRuntime = h.runtime; originalItem = h.runtime.queue.snapshot()[0];
    assert.equal(entries, 0); // enqueue does not invent an item/evaluation event.
    h.trace.length = 0; h.tick();
    assert.equal(receiverError, undefined);
    assert.equal(once, true); assert.equal(entries, 1); assert.equal(exits, 1);
    assert.equal(h.removals, 1); assert.equal(h.runtime.queue.snapshot().length, 0);
    assert.equal(removalWitness.runtime, originalRuntime); assert.equal(removalWitness.item, originalItem);
    assert.equal(removalWitness.entries, 1); assert.equal(removalWitness.exits, 1);
    assert.equal(removalWitness.quiescent, true); assert.equal(removalWitness.delivering, false);
    assert.equal(removalWitness.receipt.state, 'FINAL_DELIVERED');
    assert.equal(removalWitness.receipt.event.item, originalItem);
    assert.equal(pending.samePendingOwner(removalWitness.binding, originalItem.pendingOwner), true);
    assert.equal(removalWitness.binding, association.pendingOwner); assert.equal(association.scope, scope);
    assert.ok(h.trace.indexOf('receiver-exit') < h.trace.indexOf('remove'));
    assert.equal(h.trace.slice(0, h.trace.indexOf('remove')).includes('arm'), false);
    assert.equal(h.callbacks.length, 0); assert.equal(h.runtime.mutationQuiescent(), true);
    assert.equal(h.runtime.queue.successfulLaunchSequence(), 0);
    h.view.drainTerminalRemovals(); assert.equal(h.removals, 1);
    assert.equal(h.view.requestTerminal(scope).originalStatus, 'APPLIED');
});

test('actual nested Runtime A/B stacks defer until both exit, under original attribution', () => {
    let scope, A, B, inB = false;
    const h = setup({ generations: true, evaluate(a) {
        if (inB) {
            assert.equal(a.view.requestTerminal(scope).status, 'DEFERRED');
            assert.equal(a.runtime.mutationQuiescent(), false); assert.equal(a.removals, 0);
        } else { inB = true; a.tick(); assert.equal(a.removals, 0); inB = false; }
    } });
    A = h.registry.pendingRuntime; scope = h.view.open(); h.enqueue(scope, 'A');
    B = h.create().runtime; h.enqueue(scope, 'B'); h.tick();
    assert.equal(h.removals, 1); assert.equal(A.queue.snapshot().length, 0); assert.equal(B.queue.snapshot().length, 0);
    assert.equal(h.registry.status().retained, 2);
});

test('diagnostic overflow does not remove untracked sources from Product operation fence', () => {
    let scope;
    const h = setup({ generations: true, evaluate(a) {
        assert.equal(a.view.requestTerminal(scope).status, 'DEFERRED'); assert.equal(a.removals, 0);
    } });
    for (let i = 1; i < 64; i++) h.create();
    const source = h.create(); assert.equal(source.tracked, false);
    scope = h.view.open(); h.enqueue(scope, 'untracked'); h.tick();
    assert.equal(h.removals, 1); assert.equal(source.runtime.queue.snapshot().length, 0);
    assert.equal(h.registry.status().retained, 64); assert.equal(h.registry.status().state, 'UNKNOWN');
});

test('untracked source with real pending cannot be overwritten; successful clear permits replacement', () => {
    const h = setup({ generations: true }); for (let i = 1; i < 64; i++) h.create();
    const source = h.create(); const scope = h.view.open(); h.enqueue(scope, 'old');
    assert.throws(() => h.create(), /ORIGINAL_RUNTIME_NOT_QUIESCENT/);
    assert.equal(h.runtime.queue.snapshot()[0].id, 'old');
    source.runtime.clear(); assert.notEqual(h.create().runtime, source.runtime);
});

test('collector fault does not fabricate removal proof or block actual quiescent cleanup', () => {
    let scope; const h = setup({ observe() { throw Error('collector fixture'); }, evaluate(a) { a.view.requestTerminal(scope); } });
    scope = h.view.open(); h.enqueue(scope, 'a'); h.tick();
    assert.equal(h.removals, 1); assert.equal(h.runtime.queue.snapshot().length, 0);
    assert.equal(h.view.status().scopes[0].pendingProof, 'INCOMPLETE');
});
