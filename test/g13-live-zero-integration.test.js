'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture } = require('./fixtures/production-integration');
const native = require('../src/native-facts');
const manifest = JSON.parse(fs.readFileSync('build/replay-z-production-20261029-final/manifest.json'));

function production(mode = 'live', zero = true, options = {}) {
    const h = fixture(manifest, { ...options, mode });
    h.f.value(h.f.child).url = `https://www.youtube.com/${mode === 'live' ? 'live_chat' : 'live_chat_replay'}${zero ? '' : '?v=target'}`;
    return h;
}

for (const mode of ['live', 'replay']) for (const zero of [true, false]) {
    for (const legacyFallback of [false, true]) test(`Production ${mode} ${zero ? 'ZERO' : 'V'} genuine handoff legacy=${legacyFallback}`, async () => {
        let batch;
        const h = production(mode, zero, { legacyFallback, animationMode: 'never', onBatch(v) { batch = v; } });
        const adapter = native.createNativeFactsAdapter({ ...h.f.options, mode });
        const sample = adapter.readFacts();
        if (zero) {
            assert.equal(sample.childAssociationEvidence.childTargetIdentity, 'UNVERIFIED');
            assert.equal(sample.childAssociationEvidence.state, mode === 'live' ? 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED' : 'Z_STRUCTURAL_UNVERIFIED');
        } else assert.equal(sample.childAssociationEvidence.state, 'V_MATCH');
        await h.start();
        assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
        assert.equal(h.injections[0].target.documentIds[0], h.f.options.route.documentId);
        assert.equal(h.injections[0].world, 'MAIN');
        if (mode === 'live') await h.answer(0, h.livePayload()); else await h.answer();
        assert.ok(batch.productLease);
        const association = h.bridge.privateEntry.resolveProductLease(batch.productLease);
        assert.equal(association.scope, batch.scope); assert.equal(association.document, h.f.document);
        assert.equal(h.bridge.privateEntry.isProductCurrent(batch.productLease), true);
        assert.equal(h.bridge.privateEntry.isProductCurrent({}), false);
        assert.equal(h.runtime.queue.snapshot()[0].payload.productLease, batch.productLease);
        h.launch(); assert.equal(h.r.animations.length, 1);
        const attempt = [...h.r.state.activeDanmaku.values()][0].productAttempt;
        assert.equal(attempt.scope, batch.scope); assert.equal(attempt.productLease, batch.productLease);
        assert.equal(attempt.queueConfirmed, true); assert.equal(attempt.native, 'UNSETTLED');
        assert.equal(h.runtime.queue.successfulLaunchSequence(), 1);
        h.bridge.retire();
        assert.equal(h.bridge.privateEntry.isProductCurrent(batch.productLease), false);
        assert.equal(attempt.native, 'UNSETTLED');
        await h.settle(); assert.equal(attempt.native, 'FINISHED');
        assert.equal(h.r.state.activeDanmaku.size, 0);
        assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
    });
}

test('Production Live ZERO consumes one cursor, no duplicate initial extraction or concurrent READ', async () => {
    const h = production(); await h.start();
    await h.tick(0); assert.equal(h.requests.length, 1);
    await h.answer(0, h.livePayload('next'));
    await h.tick(999); assert.equal(h.requests.length, 1);
    await h.tick(1000); assert.equal(h.requests.length, 2);
    await h.tick(1000); assert.equal(h.requests.length, 2);
    h.f.value(h.f.frame).child = new h.f.realm.Document({ url: 'https://www.youtube.com/live_chat' });
    await h.answer(1, h.livePayload('stale-next'));
    assert.equal(h.bridge.inspect().owner, 'TERMINAL');
    assert.equal(h.injections.length, 1); assert.equal(h.requests.length, 2);
    await h.tick(3000); assert.equal(h.requests.length, 2);
});

for (const query of ['?v=', '?v=wrong', '?v=target&v=target']) test(`Live malformed association denied ${query}`, async () => {
    const h = production(); h.f.value(h.f.child).url += query; await h.start();
    assert.equal(h.injections.length, 0); assert.equal(h.requests.length, 0);
    assert.equal(h.runtime, null);
});

for (const legacyFallback of [false, true]) test(`Live ZERO stale child before visible effect legacy=${legacyFallback}`, async () => {
    let batch;
    const h = production('live', true, { legacyFallback, onBatch(v) { batch = v; } });
    await h.start(); h.bridge.rendererObserver.onFault(); await h.answer(0, h.livePayload());
    const create = h.r.dependencies.document.createElement; let swapped = 0;
    h.r.dependencies.document.createElement = tag => {
        const node = create(tag), bounds = node.getBoundingClientRect;
        node.getBoundingClientRect = (...args) => {
            if (!swapped && [...h.r.state.activeDanmaku.values()].some(r => r.node === node && r.productAttempt)) {
                swapped++; h.f.value(h.f.frame).child = new h.f.realm.Document({ url: 'https://www.youtube.com/live_chat' });
            }
            return bounds.apply(node, args);
        }; return node;
    };
    h.launch(); assert.equal(swapped, 1); assert.equal(h.r.animations.length, 0);
    assert.equal(h.runtime.queue.successfulLaunchSequence(), 0);
    assert.equal(h.bridge.privateEntry.isProductCurrent(batch.productLease), false);
    assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
});

test('Live ZERO native effect then throw preserves original UNKNOWN and exception', async () => {
    let batch;
    const h = production('live', true, { onBatch(v) { batch = v; }, animationMode: 'never' });
    await h.start(); await h.answer(0, h.livePayload());
    const runtime = h.runtime, primary = {}, create = h.r.dependencies.document.createElement;
    let effects = 0;
    h.r.dependencies.document.createElement = tag => {
        const node = create(tag), animate = node.animate;
        node.animate = (...args) => {
            animate.apply(node, args); effects++;
            assert.equal(h.bridge.cleanupPresentation(h.renderer).status, 'DEFERRED');
            throw primary;
        }; return node;
    };
    assert.throws(() => h.launch(), e => e === primary);
    assert.equal(effects, 1); assert.equal(runtime.mutationQuiescent(), true);
    const attempt = [...h.r.state.activeDanmaku.values()][0].productAttempt;
    assert.equal(attempt.productLease, batch.productLease); assert.equal(attempt.scope, batch.scope);
    assert.equal(attempt.native, 'UNKNOWN'); assert.equal(attempt.nativeReturned, false);
    assert.equal(attempt.queueConfirmed, false); assert.equal(runtime.queue.successfulLaunchSequence(), 0);
    h.bridge.retire(); assert.equal(attempt.native, 'UNKNOWN');
    assert.equal(h.r.state.activeDanmaku.size, 1);
});

for (const at of [4999, 5000]) test(`Live ZERO Bootstrap deadline ${at}`, async () => {
    const h = production('live', true, { deferredInjection: true }); await h.start();
    assert.equal(h.injections.length, 1); assert.equal(h.requests.length, 0);
    await h.tick(at); h.finishInjection(); await h.flush(); h.fire(); await h.flush();
    assert.equal(h.requests.length, at === 4999 ? 1 : 0);
    assert.equal(h.injections.length, 1);
});

test('Live ZERO media and geometry observations use the same explicit admission policy', async () => {
    const h = production();
    const bounds = h.realm.Element.prototype.getBoundingClientRect; let offset = 0;
    h.realm.Element.prototype.getBoundingClientRect = function () {
        const r = bounds.call(this); return { ...r, left: r.left + offset, right: r.right + offset };
    };
    await h.start();
    assert.equal(h.bridge.mediaChanged(), false); assert.equal(h.bridge.geometryChanged(), false);
    h.f.value(h.r.video).rate = 2; offset = 10;
    assert.equal(h.bridge.mediaChanged(), true); assert.equal(h.bridge.geometryChanged(), true);
    assert.equal(h.bridge.mediaChanged(), false); assert.equal(h.bridge.geometryChanged(), false);
    h.f.value(h.f.frame).child = new h.f.realm.Document({ url: 'https://www.youtube.com/live_chat' });
    assert.equal(h.bridge.mediaChanged(), false); assert.equal(h.bridge.geometryChanged(), false);
    assert.equal(h.bridge.inspect().owner, 'TERMINAL');
    assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
});
