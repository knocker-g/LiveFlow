'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fixtures/acquisition-harness');
const { createRenderer } = require('../src/youtube-chat');
const { fixture, settle } = load('renderer-lifecycle-seam.test.js', ['fixture', 'settle']);
const { harness } = load('g13-owner-product-lease.test.js', ['harness']);
const pending = require('../src/pending-selection');
const machine = require('../src/scheduler-state-machine');
const { setup } = load('g13-deferred-terminal.test.js', ['setup']);

async function environment(options = {}) {
    const owner = harness(); await owner.start(); await owner.answer();
    const lease = owner.lease();
    const f = fixture({ observed: options.observed === true, onCommit: options.onCommit,
        animationMode: options.animationMode || 'never', rendererFactory(dependencies) {
        return createRenderer({ ...dependencies,
            isProductCurrent: value => owner.h.owner.isProductPresentationCurrent(value),
            resolveProductLease: value => owner.view.resolveProductLease(value) });
    } });
    f.state.phase3Runtime = owner.s.runtime();
    const prepare = (value = lease, diagnosticLease = null) => f.renderer.prepareDanmaku(f.message, f.state.rendererGeneration,
        f.video, f.proof(), f.state.runtimeSettings, diagnosticLease, value);
    return { owner, lease, f, prepare };
}

test('pre-L1 stale/forged/diagnostic lease never creates visible or native work', async () => {
    const e = await environment(); assert.equal(typeof e.f.renderer.prepareDanmaku, 'function');
    assert.equal(e.prepare({}), null);
    assert.equal(e.prepare(e.owner.view.lease(e.owner.scope)), null);
    const tx = e.prepare(); assert.ok(tx); e.owner.h.owner.cancel();
    assert.equal(tx.start(), false); assert.equal(tx.status().started, false);
    assert.equal(e.f.animations.length, 0); assert.equal(e.f.state.activeDanmaku.size, 0);
});

test('post-L1 visibility callback invalidation remains started-aborted, no animate', async () => {
    const e = await environment(); let tx, visibility = 0;
    const create = e.f.dependencies.document.createElement;
    e.f.dependencies.document.createElement = tag => {
        const node = create(tag); let value;
        Object.defineProperty(node.style, 'visibility', { configurable: true, get: () => value, set(v) {
            value = v; if (v === 'visible' && node.className.includes('liveflow-danmaku') && tx) {
                visibility++; assert.equal(tx.status().started, true); e.owner.h.owner.cancel();
            }
        } }); return node;
    };
    tx = e.prepare(); assert.equal(tx.start(), false);
    assert.equal(visibility, 1); assert.equal(tx.status().started, true); assert.equal(tx.status().aborted, true);
    assert.equal(e.f.animations.length, 0); assert.equal(tx.status().queueConfirmed, false);
});

test('animate effect then throw keeps original exception and UNKNOWN original obligation', async () => {
    const e = await environment(), primary = {}, association = e.owner.view.resolveProductLease(e.lease);
    const tx = e.prepare(), create = e.f.dependencies.document.createElement;
    let effects = 0;
    e.f.dependencies.document.createElement = tag => { const n = create(tag); n.animate = () => { effects++; throw primary; }; return n; };
    assert.throws(() => tx.start(), error => error === primary);
    assert.equal(effects, 1); assert.equal(tx.status().started, true);
    assert.equal(tx.status().native, 'UNKNOWN'); assert.equal(tx.status().settledAndCleaned, false);
    const record = [...e.f.state.activeDanmaku.values()][0]; assert.ok(record);
    assert.equal(record.productAttempt.scope, association.scope);
    assert.equal(record.productAttempt.productLease, e.lease);
    e.f.renderer.cleanupOverlay(); assert.equal(e.f.state.activeDanmaku.size, 1);
    assert.equal(tx.status().native, 'UNKNOWN');
});

test('returned handle is owned before reentrant finished getter and cancel is not settlement', async () => {
    const e = await environment(), tx = e.prepare(), create = e.f.dependencies.document.createElement;
    let handle, getterCalls = 0;
    e.f.dependencies.document.createElement = tag => { const n = create(tag), animate = n.animate;
        n.animate = (...args) => { handle = animate.apply(n, args); Object.defineProperty(handle, 'finished', { get() {
            getterCalls++; const record = [...e.f.state.activeDanmaku.values()][0];
            assert.equal(record.animation, handle); assert.equal(tx.status().nativeReturned, true);
            e.owner.h.owner.cancel(); return handle.promise;
        } }); return handle; }; return n; };
    assert.equal(tx.start(), false); assert.equal(getterCalls, 1);
    assert.equal(tx.status().aborted, true); assert.equal(tx.status().settledAndCleaned, false);
    assert.equal(e.f.counts().cancelCalls, 1); assert.equal(tx.status().native, 'UNSETTLED');
    handle.resolve(); await settle(); assert.equal(tx.status().settledAndCleaned, true);
    assert.equal(e.f.state.activeDanmaku.size, 0); assert.equal(tx.status().queueConfirmed, false);
});

test('finished getter exception preserves handle and primary despite abort cleanup failure', async () => {
    const e = await environment(), tx = e.prepare(), create = e.f.dependencies.document.createElement, primary = {};
    e.f.dependencies.document.createElement = tag => { const n = create(tag), animate = n.animate;
        n.animate = (...args) => { const a = animate.apply(n, args); Object.defineProperty(a, 'finished', { get() { throw primary; } }); return a; };
        return n; };
    e.f.setRemoveFailure(true);
    assert.throws(() => tx.start(), error => error === primary);
    assert.equal(tx.status().nativeReturned, true); assert.equal(tx.status().native, 'UNKNOWN');
    assert.equal(tx.status().cleanup, 'INCOMPLETE'); assert.equal(tx.status().settledAndCleaned, false);
});

test('actual native settlement can precede real queue confirmation; facts stay independent', async () => {
    const e = await environment(), tx = e.prepare(), queue = e.owner.s.runtime().queue;
    const association = e.owner.view.resolveProductLease(e.lease);
    queue.enqueue(pending.createPendingItem({ id: 'original', enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer',
        footprint: {}, payload: { pendingOwner: association.pendingOwner } }));
    const selection = queue.evaluate({ scanDepth: 1, cohortMaximumItems: 1, cohortMaximumSpan: 0, isSafe: () => true, policy: pending.createFifoPolicy() });
    assert.equal(tx.start(), true); e.f.animations[0].resolve(); await settle();
    assert.equal(tx.status().settledAndCleaned, true); assert.equal(tx.status().queueConfirmed, false);
    assert.equal(queue.successfulLaunchSequence(), 0);
    assert.equal(queue.confirmSuccessfulLaunch(selection.token), true); tx.markQueueConfirmed();
    assert.equal(tx.status().queueConfirmed, true); assert.equal(queue.successfulLaunchSequence(), 1);
});

test('actual Scheduler failed confirmation aborts original native attempt without credit', async () => {
    const e = await environment(), tx = e.prepare(), queue = e.owner.s.runtime().queue, jobs = [];
    const settings = setup().settings; let once = 0;
    const originalStart = tx.start;
    const wrapped = { ...tx, start() { once++; const result = originalStart(); queue.enforceHardCount(0); return result; } };
    const s = machine.createScheduler({ queue, clock: () => 0, generation: () => 1, geometryRevision: () => 1,
        scheduleOneShot(fn) { jobs.push(fn); return fn; }, cancelOneShot() {},
        isSafe: () => true, launch() { throw Error('legacy bypass'); }, prepareLaunch: () => wrapped,
        config: settings.config, policy: pending.createFifoPolicy() });
    s.enqueue(pending.createPendingItem({ id: 'a', enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer', footprint: {}, payload: {} }));
    jobs.shift()();
    assert.equal(once, 1); assert.equal(queue.successfulLaunchSequence(), 0);
    assert.equal(tx.status().queueConfirmed, false); assert.equal(tx.status().aborted, true);
    assert.equal(e.f.counts().cancelCalls, 1); assert.equal(tx.status().settledAndCleaned, false);
});

test('original finished.then getter throw preserves one read, handle, exception and UNKNOWN', async () => {
    const e = await environment(), tx = e.prepare(), primary = {}, create = e.f.dependencies.document.createElement;
    let reads = 0;
    e.f.dependencies.document.createElement = tag => { const n = create(tag), animate = n.animate;
        n.animate = (...args) => { const a = animate.apply(n, args); Object.defineProperty(a.promise, 'then', { get() { reads++; throw primary; } }); return a; };
        return n; };
    assert.throws(() => tx.start(), error => error === primary);
    assert.equal(reads, 1); assert.equal(e.f.animations[0].reads, 1);
    assert.equal(tx.status().nativeReturned, true); assert.equal(tx.status().native, 'UNKNOWN');
    assert.equal(tx.status().settledAndCleaned, false);
});

test('original finished.then getter reentry aborts once; actual late native settlement stays original', async () => {
    const e = await environment(), tx = e.prepare(), create = e.f.dependencies.document.createElement;
    let reads = 0;
    e.f.dependencies.document.createElement = tag => { const n = create(tag), animate = n.animate;
        n.animate = (...args) => { const a = animate.apply(n, args); Object.defineProperty(a.promise, 'then', { get() {
            reads++; e.owner.h.owner.cancel(); return Promise.prototype.then;
        } }); return a; }; return n; };
    assert.equal(tx.start(), false); assert.equal(reads, 1); assert.equal(tx.status().aborted, true);
    assert.equal(e.f.counts().cancelCalls, 1); assert.equal(tx.status().settledAndCleaned, false);
    e.f.animations[0].resolve(); await settle(); assert.equal(tx.status().settledAndCleaned, true);
});

test('old native settlement never transfers cleanup into a different genuine Scope/Runtime', async () => {
    const e = await environment(), other = await environment(), tx = e.prepare();
    const originalRuntime = e.f.state.phase3Runtime, originalScope = e.owner.scope;
    assert.equal(tx.start(), true);
    const record = [...e.f.state.activeDanmaku.values()][0];
    assert.equal(record.productAttempt.runtime, originalRuntime); assert.equal(record.productAttempt.scope, originalScope);
    const nextRuntime = other.owner.s.runtime(); e.f.state.phase3Runtime = nextRuntime;
    other.owner.s.port.presentation.enqueue(other.owner.scope, {}, { id: 'new-owner', enqueuedAt: 0,
        rendererType: 'liveChatTextMessageRenderer', footprint: {} });
    const survivor = nextRuntime.queue.snapshot()[0]; assert.ok(survivor);
    tx.abort(); assert.equal(tx.status().settledAndCleaned, false);
    e.f.animations[0].resolve(); await settle();
    assert.equal(tx.status().settledAndCleaned, true); assert.equal(nextRuntime.queue.snapshot()[0], survivor);
    assert.equal(record.productAttempt.runtime, originalRuntime); assert.equal(record.productAttempt.scope, originalScope);
});

test('actual Runtime prepare adapter consumes genuine Owner/Scope payload and confirms original queue once', async () => {
    const { createSchedulerRuntime } = require('../src/scheduler-runtime');
    const { createPrivatePendingScope } = require('../src/private-pending-scope');
    const native = require('./fixtures/native-facts-dom').fixture();
    const scopeCore = require('../src/diagnostic-scope-core');
    const live = load('acquisition-owner.test.js');
    native.options.mode = 'live'; native.value(native.child).url = 'https://www.youtube.com/live_chat?v=target';
    let h, view, scope, port, runtime, transaction;
    const jobs = [], settings = setup().settings;
    const f = fixture({ observed: false, animationMode: 'never', rendererFactory: d => createRenderer({ ...d,
        isProductCurrent: token => h.owner.isProductPresentationCurrent(token),
        resolveProductLease: token => view.resolveProductLease(token) }) });
    h = live.harness({ route: native.options.route, configure(config) {
        config.document = native.document; config.nativeFacts = { adapter: native.make() };
        port = createPrivatePendingScope({ document: config.document, route: config.route, targetId: 'target', lifecycle: 0, revision: 0,
            terminalPath: 'DEFERRED_PRIVATE', pending, scopeCore,
            createRuntime(options) { runtime = createSchedulerRuntime(options); f.state.phase3Runtime = runtime; return runtime; },
            runtimeOptions: { ...settings, clock: () => 1000, generation: () => f.state.rendererGeneration,
                scheduleOneShot(fn) { jobs.push(fn); return fn; }, cancelOneShot(fn) { const i = jobs.indexOf(fn); if (i >= 0) jobs.splice(i, 1); },
                candidateProof: (item, geometry, policy) => f.renderer.getCandidateProof(item, geometry, policy),
                prepareLaunch(payload, proof) {
                    transaction = f.renderer.prepareDanmaku(payload.message, f.state.rendererGeneration, f.video, proof,
                        f.state.runtimeSettings, null, payload.productLease); return transaction;
                }, launch() { throw Error('legacy bypass'); } } });
        assert.ok(port);
        config.pendingScopePort = { connect(...args) { view = port.connect(...args); return view; } };
        config.onBatch = (_messages, originalScope) => { scope = originalScope; };
    } });
    await h.bootstrap(); h.clock.fire();
    const body = live.payload();
    body.continuationContents.liveChatContinuation.actions = [{ addChatItemAction: { item: {
        liveChatTextMessageRenderer: { id: 'actual', message: { runs: [{ text: 'fixture' }] } }
    } } }];
    h.requests[0].resolve({ status: 200, json: async () => body });
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(scope, 'actual accepted response produced the original Scope');
    const token = view.productLease(scope); assert.ok(token);
    assert.equal(port.presentation.enqueue(scope, { message: f.message, productLease: token }, { id: 'actual', enqueuedAt: 1000,
        rendererType: 'liveChatTextMessageRenderer', footprint: { width: 120, height: 32 } }), true);
    const originalItem = runtime.queue.snapshot()[0]; assert.ok(originalItem);
    jobs.shift()();
    assert.ok(transaction); assert.equal(transaction.status().queueConfirmed, true);
    assert.equal(runtime.queue.successfulLaunchSequence(), 1); assert.equal(runtime.queue.snapshot().length, 0);
    const resource = [...f.state.activeDanmaku.values()][0];
    assert.equal(resource.productAttempt.runtime, runtime); assert.equal(resource.productAttempt.scope, scope);
    assert.equal(h.requests.length, 1);
    f.animations[0].resolve(); await settle(); assert.equal(transaction.status().settledAndCleaned, true);
});

test('existing original commit/terminal observations reconcile true native cleanup on transaction path', async () => {
    const e = await environment({ observed: true }), queue = e.owner.s.runtime().queue;
    const association = e.owner.view.resolveProductLease(e.lease);
    queue.enqueue(pending.createPendingItem({ id: 'observed', enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer',
        footprint: {}, payload: { pendingOwner: association.pendingOwner } }));
    const selection = queue.evaluate({ scanDepth: 1, cohortMaximumItems: 1, cohortMaximumSpan: 0, isSafe: () => true, policy: pending.createFifoPolicy() });
    const diagnostic = e.f.lease(association.scope, association.pendingOwner, selection.token);
    const tx = e.prepare(e.lease, diagnostic.value); assert.equal(tx.start(), true);
    assert.equal(e.f.events[0][0], 'commit'); assert.equal(e.f.events[0][1].scope, association.scope);
    assert.equal(e.f.events[0][1].attempt, selection.token);
    e.f.animations[0].resolve(); await settle();
    assert.equal(tx.status().settledAndCleaned, true); assert.equal(e.f.events[1][0], 'terminal');
    assert.equal(e.f.events[1][1], e.f.events[0][1]); assert.equal(e.f.events[1][2], 'FINISHED');
    assert.equal(e.f.renderer.observationStatus().unresolved, 0);
});

test('commit observer reentry sees original native handle and abort cannot manufacture settlement', async () => {
    let e, tx, sawHandle = false;
    e = await environment({ observed: true, onCommit() {
        sawHandle = [...e.f.state.activeDanmaku.values()][0].animation === e.f.animations[0];
        e.owner.h.owner.cancel();
    } });
    const association = e.owner.view.resolveProductLease(e.lease), queue = e.owner.s.runtime().queue;
    queue.enqueue(pending.createPendingItem({ id: 'callback', enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer',
        footprint: {}, payload: { pendingOwner: association.pendingOwner } }));
    const selection = queue.evaluate({ scanDepth: 1, cohortMaximumItems: 1, cohortMaximumSpan: 0, isSafe: () => true, policy: pending.createFifoPolicy() });
    tx = e.prepare(e.lease, e.f.lease(association.scope, association.pendingOwner, selection.token).value);
    assert.equal(tx.start(), false); assert.equal(sawHandle, true); assert.equal(tx.status().started, true);
    assert.equal(tx.status().nativeReturned, true); assert.equal(tx.status().aborted, true);
    assert.equal(tx.status().settledAndCleaned, false); assert.equal(tx.status().queueConfirmed, false);
    e.f.animations[0].resolve(); await settle(); assert.equal(tx.status().settledAndCleaned, true);
});
