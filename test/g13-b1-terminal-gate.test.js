'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { load } = require('./fixtures/acquisition-harness');
const { createContentHandoff } = require('../src/youtube-chat');
const pending = require('../src/pending-selection');
const { setup } = load('content-handoff.test.js', ['setup']);
const { harness: scopeHarness } = load('private-pending-scope.test.js', ['harness']);
const { fixture: production } = require('./fixtures/production-integration');
const manifest = JSON.parse(fs.readFileSync('build/replay-z-production-20261029-final/manifest.json'));

function content(options = {}) {
    const h = setup(), s = scopeHarness(), scope = s.view.open();
    const lease = s.view.productLease(scope), effects = h.c;
    const association = s.view.resolveProductLease(lease);
    const occurrences = new WeakMap(), batches = new WeakMap(), observed = [];
    const entry = {
        isProductInvalidated: value => s.view.resolveProductLease(value) === null,
        recognizeBatch: value => batches.get(value), recognizeOccurrence: value => occurrences.get(value),
        claimBatch: () => true, isCurrent: () => true,
        onDisposition(_identity, event) { observed.push(event.disposition); options.disposition?.(); }
    };
    const deps = { ...effects, state: effects, pending, privateEntry: entry };
    const handoff = createContentHandoff(deps);
    function run(messages, registered = false) {
        messages.forEach(m => { m.messageType ??= 'text'; m.message ??= 'fixture'; });
        if (!registered) return handoff.processLegacySuccess(messages, association.pendingOwner, scope, lease);
        const owner = association.pendingOwner, ticket = {};
        const handles = messages.map(message => {
            const handle = Object.freeze({});
            occurrences.set(handle, { message, origin: { document: effects.window, ticket }, association: { scope, pendingOwner: owner } });
            return handle;
        });
        const handle = Object.freeze({});
        batches.set(handle, Object.freeze({ document: effects.window, targetId: 'target', lifecycle: 0, revision: 0,
            ticket, scope, pendingOwner: owner, messages: Object.freeze(messages.slice()), occurrences: Object.freeze(handles) }));
        assert.equal(handoff.registerBatch(handle), true);
        return handoff.processRegisteredBatch(handle, lease);
    }
    return { h, s, scope, lease, deps, entry, observed, run, handoff,
        invalidate() { s.view.retire(scope); } };
}

for (const registered of [false, true]) test(`genuine Scope retirement denies new history/queue, registered=${registered}`, () => {
    const h = content(); h.invalidate();
    assert.equal(h.run([{ id: 'denied', message: 'fixture' }], registered), undefined);
    assert.equal(h.h.c.currentMessages.length, 0);
    assert.equal(h.h.runtime.queue.snapshot().length, 0);
    assert.equal(h.h.snapshot().effects.some(e => e[0] === 'runtime'), false);
    assert.equal(h.observed.includes('ADMITTED'), false);
});

test('callback retirement retains real history prefix and stops ensure/enqueue', () => {
    const h = content();
    h.h.c.rememberReplayPendingOwner = () => h.invalidate();
    // Dependencies are fixed at construction; create the actual factory with the callback seam.
    const handoff = createContentHandoff({ ...h.deps, rememberReplayPendingOwner: h.h.c.rememberReplayPendingOwner });
    const m = { id: 'prefix', message: 'fixture' };
    assert.equal(handoff.processLegacySuccess([m], undefined, h.scope, h.lease), undefined);
    assert.equal(h.h.c.currentMessages[0], m);
    assert.equal(h.h.snapshot().effects.some(e => e[0] === 'runtime'), false);
    assert.equal(h.h.runtime.queue.snapshot().length, 0);
});

test('nonterminal cleanup alone preserves continuation and original queue identity', () => {
    const h = content(), queue = h.h.runtime.queue;
    const handoff = createContentHandoff({ ...h.deps, rememberReplayPendingOwner: () => h.h.runtime.clear() });
    assert.equal(handoff.processLegacySuccess([{ id: 'valid', message: 'fixture', messageType: 'text' }], undefined, h.scope, h.lease), undefined);
    assert.equal(h.h.runtime.queue, queue); assert.equal(queue.snapshot().length, 1);
    assert.equal(h.s.view.resolveProductLease(h.lease).scope, h.scope);
});

test('original callback throw identity and actual prefix survive; no new suffix', () => {
    const h = content(), error = Object.freeze({ original: true });
    const handoff = createContentHandoff({ ...h.deps, rememberReplayPendingOwner() { h.invalidate(); throw error; } });
    assert.throws(() => handoff.processLegacySuccess([{ id: 'prefix' }], undefined, h.scope, h.lease), e => e === error);
    assert.equal(h.h.c.currentMessages.length, 1); assert.equal(h.h.runtime.queue.snapshot().length, 0);
});

test('clock reentry retirement prevents actual enqueue and restores batch finally', () => {
    const h = content();
    const handoff = createContentHandoff({ ...h.deps, performance: { now() { h.invalidate(); return 1000; } } });
    handoff.processLegacySuccess([{ id: 'clock', message: 'fixture', messageType: 'text' }], undefined, h.scope, h.lease);
    assert.equal(h.h.runtime.queue.snapshot().length, 0);
    assert.equal(h.h.c.replayDiagnosticBatchInProgress, false);
});

test('diagnostic collector fault does not revoke genuine Product membership', () => {
    const h = content(); assert.equal(h.s.view.open(), null);
    assert.equal(h.s.view.status().collectorFault, true);
    h.run([{ id: 'diagnostic-fault' }]);
    assert.equal(h.h.runtime.queue.snapshot().length, 1);
});

test('real Bridge forwards actual Product token; terminal state, not cleanup/seal, closes boundary', async () => {
    let observed;
    const h = production(manifest, { onBatch(value) { observed = value; } });
    await h.start(); await h.answer();
    assert.ok(observed?.productLease);
    assert.equal(h.bridge.privateEntry.isProductInvalidated(observed.productLease), false);
    h.renderer.cleanupOverlay();
    assert.equal(h.bridge.privateEntry.isProductInvalidated(observed.productLease), false);
    h.bridge.retire();
    assert.equal(h.bridge.inspect().owner, 'TERMINAL');
    assert.equal(h.bridge.privateEntry.isProductInvalidated(observed.productLease), true);
    assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
});

test('registered denial preserves finally disposition order without invented admission', () => {
    const order = [], h = content({ disposition() { order.push('disposition'); } });
    const message = { messageType: 'text', message: 'fixture', get id() {
        order.push('original-getter'); h.invalidate(); return 'retired';
    } };
    assert.equal(h.run([message], true), undefined);
    order.push('returned');
    assert.equal(h.h.runtime.queue.snapshot().length, 0);
    assert.equal(h.h.c.currentMessages.length, 0);
    assert.deepEqual(h.observed, ['UNKNOWN']);
    assert.equal(order.at(-2), 'disposition'); assert.equal(order.at(-1), 'returned');
    assert.equal(h.handoff.isProofDelivering(), false);
});

test('actual diagnostic queue snapshot reentry cannot bypass the last enqueue gate', () => {
    const h = content(), snapshot = h.h.runtime.queue.snapshot;
    let calls = 0;
    h.deps.ensurePhase3Runtime = () => ({ ...h.h.runtime,
        queue: { ...h.h.runtime.queue, snapshot() { calls++; h.invalidate(); return snapshot(); } } });
    const custom = createContentHandoff(h.deps);
    // Use the same real registration producer fixtures through a fresh Content instance.
    const m = { id: 'snapshot', messageType: 'text', message: 'fixture' }, ticket = {}, occurrence = {}, handle = {};
    const association = h.s.view.resolveProductLease(h.lease);
    const identity = Object.freeze({ document: h.h.c.window, targetId: 'target', lifecycle: 0, revision: 0,
        ticket, scope: h.scope, pendingOwner: association.pendingOwner, messages: Object.freeze([m]), occurrences: Object.freeze([occurrence]) });
    h.entry.recognizeBatch = value => value === handle ? identity : null;
    h.entry.recognizeOccurrence = value => value === occurrence ? { message: m,
        origin: { document: identity.document, ticket }, association } : null;
    assert.equal(custom.registerBatch(handle), true);
    custom.processRegisteredBatch(handle, h.lease);
    assert.ok(calls > 0); assert.equal(snapshot().length, 0);
    assert.equal(h.observed.includes('ADMITTED'), false);
});

test('actual Owner observer rejects cancel without falsely terminalizing current Owner', async () => {
    const { harness } = load('g13-owner-product-lease.test.js', ['harness']);
    const observations = [];
    const h = harness({ mode: 'replay', observed: true, hooks: { transition({ h }) {
        const before = h.owner.status().phase, returned = h.owner.cancel();
        observations.push({ before, returned, after: h.owner.status().phase });
    } } });
    await h.start(); await h.answer();
    assert.ok(observations.length > 0);
    for (const value of observations) {
        assert.equal(value.returned, false); assert.equal(value.after, value.before);
        assert.notEqual(value.after, 'TERMINAL');
    }
});

test('valid nonterminal Product path preserves pre-B1 getter/order/return/queue trace', () => {
    const Module = require('node:module');
    const filename = require.resolve('../src/youtube-chat');
    const before = new Module(filename, module);
    before.filename = filename; before.paths = Module._nodeModulePaths(require('node:path').dirname(filename));
    before._compile(fs.readFileSync('.playwright-mcp/g13-p5-b1-20261105-src_youtube-chat.js.before', 'utf8'), filename);
    const results = [];
    for (const factory of [before.exports.createContentHandoff, createContentHandoff]) {
        const h = content(), reads = [];
        const m = { messageType: 'text', message: 'fixture', get id() { reads.push('id'); return 'equivalent'; } };
        const handoff = factory(h.deps);
        const returned = handoff.processLegacySuccess([m], undefined, h.scope, h.lease);
        const getterTrace = reads.slice();
        results.push({ returned, getterTrace, trace: h.h.snapshot() });
    }
    assert.equal(results[0].returned, undefined); assert.equal(results[1].returned, undefined);
    assert.deepEqual(results[1].getterTrace, results[0].getterTrace);
    assert.deepEqual(results[1].trace, results[0].trace);
});
