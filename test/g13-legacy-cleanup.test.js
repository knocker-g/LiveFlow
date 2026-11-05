'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fixtures/acquisition-harness');
const { environment, fixture, settle } = load('g13-renderer-transaction.test.js', ['environment', 'fixture', 'settle']);

test('real legacy cleanup cancels/removes then calls original Map.clear before runtime/root cleanup', () => {
    const f = fixture({ observed: false, animationMode: 'never' }), trace = [];
    assert.equal(f.render().status, 'rendered');
    const [record] = f.state.activeDanmaku.values();
    const cancel = record.animation.cancel, remove = record.node.remove, clear = f.state.activeDanmaku.clear;
    const runtime = f.state.phase3Runtime, runtimeClear = runtime.clear, root = f.state.overlayRoot, rootRemove = root.remove;
    record.animation.cancel = function () { trace.push('cancel'); return cancel.call(this); };
    record.node.remove = function () { trace.push('node'); return remove.call(this); };
    f.state.activeDanmaku.clear = function () { trace.push('map-clear'); return clear.call(this); };
    runtime.clear = function () { trace.push('runtime-clear'); return runtimeClear.call(this); };
    root.remove = function () { trace.push('root'); return rootRemove.call(this); };
    f.renderer.cleanupOverlay();
    assert.deepEqual(trace, ['cancel', 'node', 'map-clear', 'runtime-clear', 'root']);
    assert.equal(record.node.isConnected, false); assert.equal(f.state.activeDanmaku.size, 0);
    assert.equal(f.state.overlayRoot, null); assert.equal(f.state.phase3Runtime, null);
});

test('legacy Map.clear exception preserves original primary identity and actual partial prefix', () => {
    const f = fixture({ observed: false, animationMode: 'never' }), primary = {}, trace = [];
    assert.equal(f.render().status, 'rendered');
    const [record] = f.state.activeDanmaku.values(), remove = record.node.remove, cancel = record.animation.cancel;
    record.animation.cancel = function () { trace.push('cancel'); return cancel.call(this); };
    record.node.remove = function () { trace.push('node'); return remove.call(this); };
    f.state.activeDanmaku.clear = () => { trace.push('map-clear'); throw primary; };
    assert.throws(() => f.renderer.cleanupOverlay(), error => error === primary);
    assert.deepEqual(trace, ['cancel', 'node', 'map-clear']);
    assert.equal(f.state.activeDanmaku.size, 1); assert.equal(f.state.activeDanmaku.values().next().value, record);
    assert.equal(record.node.isConnected, false); assert.equal(f.counts().clears, 0);
    assert.notEqual(f.state.phase3Runtime, null); assert.notEqual(f.state.overlayRoot, null);
});

test('mixed genuine legacy and UNKNOWN Product retain original unknown without any full-map clear', async () => {
    const e = await environment(), primary = {}, association = e.owner.view.resolveProductLease(e.lease);
    const originalRuntime = e.f.state.phase3Runtime, create = e.f.dependencies.document.createElement;
    const tx = e.prepare(); let effects = 0, clearCalls = 0;
    e.f.dependencies.document.createElement = tag => { const n = create(tag); n.animate = () => { effects++; throw primary; }; return n; };
    assert.throws(() => tx.start(), error => error === primary); assert.equal(effects, 1);
    const unknown = [...e.f.state.activeDanmaku.values()][0]; assert.ok(unknown);
    // Establish UNKNOWN first, then create a real legacy entry in the same Map.
    // No second active animation is forced through the fixture collision proof.
    e.f.dependencies.document.createElement = create;
    assert.equal(e.f.render().status, 'rendered');
    const legacy = [...e.f.state.activeDanmaku.values()].find(record => record !== unknown); assert.ok(legacy);
    const clear = e.f.state.activeDanmaku.clear;
    e.f.state.activeDanmaku.clear = function () { clearCalls++; return clear.call(this); };
    e.f.renderer.cleanupOverlay();
    assert.equal(clearCalls, 0); assert.equal(e.f.state.activeDanmaku.size, 1);
    assert.equal(e.f.state.activeDanmaku.values().next().value, unknown);
    assert.equal(legacy.node.isConnected, false); assert.equal(e.f.counts().cancelCalls, 1);
    assert.equal(unknown.productAttempt.scope, association.scope); assert.equal(unknown.productAttempt.runtime, originalRuntime);
    assert.equal(unknown.productAttempt.productLease, e.lease);
    assert.equal(tx.status().started, true); assert.equal(tx.status().nativeReturned, false);
    assert.equal(tx.status().native, 'UNKNOWN'); assert.equal(tx.status().settledAndCleaned, false);
    assert.equal(tx.status().queueConfirmed, false);
    e.f.renderer.cleanupOverlay(); assert.equal(clearCalls, 0); assert.equal(tx.status().native, 'UNKNOWN');
    assert.equal(e.f.state.activeDanmaku.values().next().value, unknown);
});

test('returned unsettled original handle survives teardown and only actual settlement releases its record', async () => {
    const e = await environment(), tx = e.prepare(); assert.equal(tx.start(), true);
    const original = [...e.f.state.activeDanmaku.values()][0], originalRuntime = e.f.state.phase3Runtime;
    let clearCalls = 0; const clear = e.f.state.activeDanmaku.clear;
    e.f.state.activeDanmaku.clear = function () { clearCalls++; return clear.call(this); };
    e.f.renderer.cleanupOverlay();
    assert.equal(clearCalls, 0); assert.equal(e.f.counts().cancelCalls, 1);
    assert.equal(tx.status().native, 'UNSETTLED'); assert.equal(tx.status().settledAndCleaned, false);
    assert.equal(e.f.state.activeDanmaku.values().next().value, original);
    assert.equal(original.animation, e.f.animations[0]); assert.equal(original.productAttempt.runtime, originalRuntime);
    e.f.animations[0].resolve(); await settle();
    assert.equal(e.f.state.activeDanmaku.size, 0); assert.equal(tx.status().settledAndCleaned, true);
    assert.equal(tx.status().queueConfirmed, false); assert.equal(clearCalls, 0);
});

test('unproven productAttempt marker cannot authorize abort or a whole-map clear', async () => {
    const e = await environment(); let counterfeitAborts = 0, clearCalls = 0;
    const fake = { animation: null, node: null, productAttempt: { abort() { counterfeitAborts++; } } };
    const key = Symbol('unproven'); e.f.state.activeDanmaku.set(key, fake);
    const clear = e.f.state.activeDanmaku.clear;
    e.f.state.activeDanmaku.clear = function () { clearCalls++; return clear.call(this); };
    e.f.renderer.cleanupOverlay();
    assert.equal(counterfeitAborts, 0); assert.equal(clearCalls, 0);
    assert.equal(e.f.state.activeDanmaku.get(key), fake);
});
