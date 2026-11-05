'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/native-facts-dom');
const { load } = require('./fixtures/acquisition-harness');
const { createLiveAcquisitionOwner } = require('../src/acquisition-owner');
const core = require('../src/chat-read-core');
const live = load('acquisition-owner.test.js');
const replay = load('acquisition-owner-recovery.test.js');
const scopeHarness = load('private-pending-scope.test.js', ['harness']).harness;
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
    let h, f, s, view, scope, port;
    const batches = [], observed = [];
    const hooks = options.hooks || {};
    const mode = options.mode || 'live';
    const original = mode === 'live' ? live : replay;
    if (mode === 'live') {
        f = fixture(); f.options.mode = 'live';
        f.value(f.child).url = 'https://www.youtube.com/live_chat' + (options.zero ? '' : '?v=target');
    }
    h = original.harness({
        route: f?.options.route,
        childURL: options.zero ? 'https://www.youtube.com/live_chat_replay' : undefined,
        replayAssociationPolicy: options.replayPolicy,
        configure(config) {
            if (mode === 'live') {
                config.document = f.document; config.route = f.options.route;
                config.nativeFacts = { adapter: f.make() };
            }
            config.liveAssociationPolicy = options.livePolicy;
            s = scopeHarness({ document: config.document, ownerConnect: true });
            config.pendingScopePort = { connect(binding, route) {
                const actual = s.port.connect(binding, route);
                view = { ...actual,
                    open() { scope = actual.open(); hooks.open?.({ f, h, view, scope }); return scope; },
                    lease(value) { const result = actual.lease(value); hooks.diagnosticLease?.({ f, h }); return result; }
                };
                return view;
            } };
            config.onBatch = (messages, actualScope, diagnosticHandle, productLease) => {
                batches.push({ messages, scope: actualScope, diagnosticHandle, productLease });
                hooks.batch?.({ f, h, view, scope });
            };
            if (options.observed) config.provenance = {
                connect(value) { port = value; if (options.fault) value.onFault('RECEIVER_THROWN'); },
                onDisposition(event) { observed.push(event); },
                onTemporalTransition(event) { observed.push(event); hooks.transition?.({ f, h, view }); }
            };
            if (hooks.clock) {
                const now = config.clock.now;
                config.clock = { ...config.clock, now() { const value = now(); hooks.clock({ f, h, view }); return value; } };
            }
            if (hooks.parser) config.core = { ...core, extractChatMessagesFromResponse(payload) {
                const result = core.extractChatMessagesFromResponse(payload); hooks.parser({ f, h, view }); return result;
            } };
        }
    });
    if (mode === 'replay') f = h.f;
    return { h, get f() { return f; }, get view() { return view; }, get scope() { return scope; },
        get port() { return port; }, s, batches, observed,
        async start() { assert.ok(h.owner); await h.bootstrap(); (h.clock || h.time).fire(); await flush(); },
        async answer(index = 0, token = 'next') {
            const body = mode === 'live' ? live.payload(token) : replay.payload([0], token, 'seek-' + token);
            if (mode === 'live') body.continuationContents.liveChatContinuation.actions = [{ addChatItemAction: { item: {
                liveChatTextMessageRenderer: { id: token, message: { runs: [{ text: 'fixture' }] } }
            } } }];
            h.requests[index].resolve({ status: 200, json: async () => body }); await flush();
        },
        lease() { assert.equal(typeof view.productLease, 'function'); return view.productLease(scope); }
    };
}

test('genuine Product lease is cached, opaque, scoped and distinct from diagnostic lease', () => {
    const s = scopeHarness(), v = s.view, a = v.open();
    assert.equal(typeof v.productLease, 'function');
    const p = v.productLease(a), d = v.lease(a);
    assert.ok(p); assert.equal(v.productLease(a), p); assert.equal(Object.isFrozen(p), true);
    assert.deepEqual(Object.keys(p), []); assert.notEqual(p, d);
    assert.equal(v.resolveProductLease(p).scope, a);
    assert.equal(v.resolveProductLease(p).document, s.binding.document);
    assert.equal(v.resolveProductLease(d), null); assert.equal(v.resolveLease(p), null);
    assert.equal(v.resolveProductLease({}), null); assert.equal(v.resolveProductLease({ ...p }), null);
    assert.equal(v.resolveProductLease(v.resolveProductLease(p).pendingOwner), null);
});

test('Product lease revokes at retire, remains invalid across new Scope and foreign issuer', () => {
    const s = scopeHarness(), a = s.view.open();
    assert.equal(typeof s.view.productLease, 'function');
    const p = s.view.productLease(a), operation = s.view.retire(a);
    assert.ok(operation); assert.equal(s.view.resolveProductLease(p), null);
    const b = s.view.open(), q = s.view.productLease(b);
    assert.ok(q); assert.notEqual(p, q); assert.equal(s.view.resolveProductLease(p), null);
    const other = scopeHarness(); other.view.open();
    assert.equal(other.view.resolveProductLease(q), null);
    assert.equal(s.view.productLease(a), null);
});

test('diagnostic fault does not confer or revoke actual Product membership', () => {
    const s = scopeHarness(), a = s.view.open();
    assert.equal(typeof s.view.productLease, 'function');
    const p = s.view.productLease(a), d = s.view.lease(a);
    assert.equal(s.view.open(), null); // actual existing diagnostic collectorFault seam
    assert.equal(s.view.status().collectorFault, true);
    assert.equal(s.view.resolveLease(d), null);
    assert.equal(s.view.resolveProductLease(p).scope, a);
    assert.equal(s.view.productLease(a), p);
    s.view.retire(a); assert.equal(s.view.resolveProductLease(p), null);
});

test('lifetime diagnostic original-lease resolver rejects Product token namespace', () => {
    const s = scopeHarness(), lifetime = s.view.connectLifetime(() => null), a = s.view.open();
    assert.equal(typeof s.view.productLease, 'function');
    const p = s.view.productLease(a), d = s.view.lease(a);
    assert.ok(lifetime.recognizeOriginalLease(d));
    assert.equal(lifetime.recognizeOriginalLease(p), null);
});

for (const zero of [false, true]) test(`actual Native Live ${zero ? 'ZERO' : 'V'} Owner, one permit/READ and genuine batch lease`, async () => {
    const s = harness({ zero, livePolicy: zero ? 'ACCEPTED_LIVE_ZERO_V' : undefined });
    await s.start();
    assert.equal(s.h.requests.length, 1); assert.equal(s.h.injections.length, 1);
    assert.equal(s.h.owner.status().permit, 'CONSUMED');
    await s.answer(); assert.equal(s.batches.length, 1);
    const p = s.batches[0].productLease;
    assert.ok(p); assert.equal(s.view.resolveProductLease(p).scope, s.scope);
    assert.equal(s.h.owner.isProductPresentationCurrent(p), true);
    assert.equal(s.h.owner.isProductPresentationCurrent({}), false);
    assert.equal(s.h.owner.isProductPresentationCurrent(s.view.lease(s.scope)), false);
    if (zero) {
        const sample = s.h.config.nativeFacts.adapter.readFacts();
        assert.equal(sample.childAssociationEvidence.state, 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED');
        assert.equal(sample.childAssociationEvidence.childTargetIdentity, 'UNVERIFIED');
    }
    s.h.owner.cancel();
    assert.equal(s.view.resolveProductLease(p), null);
    assert.equal(s.h.owner.isProductPresentationCurrent(p), false);
});

for (const policy of [undefined, 'STRICT_V', 'ACCEPTED_Z', 'UNKNOWN']) test(`Live ZERO Owner refuses missing/mismatched policy ${policy}`, () => {
    const s = harness({ zero: true, livePolicy: policy });
    assert.equal(s.h.owner, null); assert.equal(s.h.requests.length, 0); assert.equal(s.h.injections.length, 0);
});

for (const zero of [false, true]) test(`Replay ${zero ? 'Z' : 'V'} preserves original policy and Product lease`, async () => {
    const s = harness({ mode: 'replay', zero, replayPolicy: zero ? 'ACCEPTED_Z' : 'STRICT_V' });
    await s.start(); await s.answer();
    assert.equal(s.h.requests.length, 1); assert.equal(s.h.injections.length, 1);
    assert.equal(s.h.owner.isProductPresentationCurrent(s.batches[0].productLease), true);
    s.h.owner.cancel();
});

for (const change of ['child', 'target', 'mode', 'scope', 'terminal']) test(`original Product callback rejects ${change} loss, no generation resurrection`, async () => {
    const s = harness({ zero: true, livePolicy: 'ACCEPTED_LIVE_ZERO_V' });
    await s.start(); await s.answer(); const p = s.batches[0].productLease;
    assert.equal(s.h.owner.isProductPresentationCurrent(p), true);
    if (change === 'child') s.f.value(s.f.frame).child = new s.f.realm.Document({ url: s.f.value(s.f.child).url });
    if (change === 'target') s.f.value(s.f.document).url = 'https://www.youtube.com/watch?v=other';
    if (change === 'mode') s.f.value(s.f.child).url = 'https://www.youtube.com/live_chat_replay';
    if (change === 'scope') { s.view.retire(s.scope); const next = s.view.open(); assert.equal(s.h.owner.isProductPresentationCurrent(s.view.productLease(next)), false); }
    if (change === 'terminal') s.h.owner.cancel();
    assert.equal(s.h.owner.isProductPresentationCurrent(p), false);
    s.f.value(s.f.frame).child = s.f.child;
    s.f.value(s.f.document).url = 'https://www.youtube.com/watch?v=target';
    s.f.value(s.f.child).url = 'https://www.youtube.com/live_chat';
    assert.equal(s.h.owner.isProductPresentationCurrent(p), false);
    assert.equal(s.h.requests.length, 1); assert.equal(s.h.injections.length, 1);
});

test('foreign original Owner token is not accepted for same scalar target', async () => {
    const a = harness(), b = harness(); await a.start(); await b.start(); await a.answer(); await b.answer();
    assert.equal(a.h.owner.isProductPresentationCurrent(b.batches[0].productLease), false);
    assert.equal(b.h.owner.isProductPresentationCurrent(a.batches[0].productLease), false);
    a.h.owner.cancel(); b.h.owner.cancel();
});

for (const observed of [false, true]) test(`Product currentness independent of diagnostic missing/fault (${observed})`, async () => {
    const s = harness({ observed, fault: observed }); await s.start(); await s.answer();
    const p = s.batches[0].productLease;
    if (observed) assert.equal(s.port.observationStatus().state, 'UNKNOWN');
    assert.equal(s.h.owner.isProductPresentationCurrent(p), true);
    s.h.owner.cancel(); assert.equal(s.h.owner.isProductPresentationCurrent(p), false);
});

test('actual origin64 saturation keeps same genuine Product lease and normal Live cursor progression', async () => {
    const s = harness({ observed: true }); await s.start();
    let original;
    for (let i = 0; i < 65; i++) {
        assert.equal(s.h.requests.length, i + 1);
        await s.answer(i, 'next-' + i);
        const p = s.batches[i].productLease;
        if (!i) original = p;
        assert.equal(p, original); assert.equal(s.h.owner.isProductPresentationCurrent(p), true);
        if (i < 64) { s.h.clock.set((i + 1) * 1000); s.h.owner.synchronize(); s.h.clock.fire(); await flush(); }
    }
    assert.equal(s.port.observationStatus().exhausted, true);
    assert.equal(s.port.observationStatus().state, 'UNKNOWN');
    assert.equal(s.batches[64].diagnosticHandle, null);
    assert.equal(s.h.injections.length, 1);
    s.h.owner.cancel();
});

for (const boundary of ['clock', 'parser', 'transition', 'open', 'diagnosticLease', 'batch']) test(`actual ${boundary} reentry cannot resurrect Owner or hand off later work`, async () => {
    let armed = false;
    const hooks = { [boundary]({ f }) { if (armed) f.value(f.frame).child = new f.realm.Document({ url: f.value(f.child).url }); } };
    const s = harness({ observed: ['transition','open','diagnosticLease'].includes(boundary), hooks });
    await s.start(); armed = true; await s.answer();
    assert.equal(s.h.owner.status().phase, 'TERMINAL');
    assert.equal(s.h.owner.status().cursor, 'INVALID');
    assert.equal(s.batches.length, boundary === 'batch' ? 1 : 0);
    assert.equal(s.h.requests.length, 1); assert.equal(s.h.injections.length, 1);
    if (s.scope) assert.equal(s.view.productLease(s.scope), null);
});

test('scope.open callback cancellation retires actual opened Scope despite assignment reentry', async () => {
    const s = harness({ observed: true, hooks: { open({ h }) { h.owner.cancel(); } } });
    await s.start(); await s.answer();
    assert.equal(s.h.owner.status().phase, 'TERMINAL');
    assert.equal(s.batches.length, 0);
    assert.equal(s.view.productLease(s.scope), null);
    assert.equal(s.view.status().scopes.at(-1).terminal, true);
});

test('late original READ response after cancellation cannot publish or open a replacement Scope', async () => {
    const s = harness(); await s.start(); const old = s.scope, p = s.lease(); s.h.owner.cancel(); await s.answer();
    assert.equal(s.batches.length, 0); assert.equal(s.view.resolveProductLease(p), null);
    assert.equal(s.scope, old); assert.equal(s.h.owner.openBootstrap(s.h.channel), null);
    assert.equal(s.h.requests.length, 1); assert.equal(s.h.injections.length, 1);
});

test('original permit input exception identity and consume prefix remain unchanged', () => {
    const s = harness(), channel = s.h.channel, bridge = s.h.owner.openBootstrap(channel), error = {};
    assert.ok(bridge);
    let reads = 0;
    const request = { get operationId() { reads++; throw error; } };
    assert.throws(() => bridge.consumePermit(request), e => e === error);
    assert.equal(reads, 1); assert.equal(s.h.owner.status().permit, 'UNUSED');
    s.h.owner.cancel();
});

test('Product currentness reentry through original clock is bounded and default deny', async () => {
    let armed = false, nested;
    const s = harness({ hooks: { clock({ h, view, scope }) {
        if (armed) { armed = false; nested = h.owner.isProductPresentationCurrent(view.productLease(scope)); }
    } } });
    await s.start(); await s.answer(); armed = true;
    assert.equal(s.h.owner.isProductPresentationCurrent(s.batches[0].productLease), true);
    assert.equal(nested, false);
    s.h.owner.cancel();
});

test('final acceptance clock callback invalidation cannot commit a fresh cursor or Scope', async () => {
    let armed = false, reads = 0;
    const s = harness({ observed: true, hooks: { clock({ f }) {
        if (armed && ++reads === 4) f.value(f.frame).child = new f.realm.Document({ url: f.value(f.child).url });
    } } });
    await s.start(); armed = true; await s.answer();
    // Response-currentness after transport, JSON, parser, then original acceptedAt time().
    assert.equal(reads, 4);
    assert.equal(s.h.owner.status().phase, 'TERMINAL');
    assert.equal(s.h.owner.status().accepted, 0);
    assert.equal(s.h.owner.status().cursor, 'INVALID');
    assert.equal(s.batches.length, 0);
    assert.equal(s.scope, undefined);
    assert.equal(s.h.requests.length, 1);
});

test('Owner captures Live policy and original adapter, never mutable caller config', async () => {
    const s = harness({ zero: true, livePolicy: 'ACCEPTED_LIVE_ZERO_V' });
    s.h.config.liveAssociationPolicy = 'STRICT_V';
    s.h.config.nativeFacts.adapter = {};
    await s.start(); await s.answer();
    assert.equal(s.h.owner.isProductPresentationCurrent(s.batches[0].productLease), true);
    s.h.owner.cancel();
});

test('unchanged Production composition still rejects Live ZERO before Owner/EXTRACT/READ', async () => {
    const { fixture: production } = require('./fixtures/production-integration');
    const h = production(require('../manifest.json'), { mode: 'live' });
    h.f.value(h.f.child).url = 'https://www.youtube.com/live_chat'; await h.start();
    assert.equal(h.bridge.inspect().owner, 'NONE'); assert.equal(h.requests.length, 0); assert.equal(h.injections.length, 0);
});
