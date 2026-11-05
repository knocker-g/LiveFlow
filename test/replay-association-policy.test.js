'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('../src/replay-control-plane-core.js');
const { load } = require('./fixtures/acquisition-harness.js');
const { harness, payload } = load('acquisition-owner-recovery.test.js', ['harness', 'payload']);
const { createLiveAcquisitionOwner } = require('../src/acquisition-owner.js');
const { createNativeFactsAdapter } = require('../src/native-facts.js');
const { fixture } = require('./fixtures/native-facts-dom.js');

function context(validate = () => true) {
    const binding = Object.freeze({ lifecycleId: 0, revision: 0, targetId: 'target', generation: 0 });
    const owner = Object.freeze({});
    const policy = cp.createOwnerPolicyContext({ owner, binding, validate });
    const registry = cp.createConsumedAuthorityRegistry(policy);
    const make = token => cp.createReplayAuthority({ kind: 'SEQUENTIAL', opaqueToken: token, binding,
        provenance: 'SEQUENTIAL_RESPONSE', policyContext: policy }).authority;
    return { owner, binding, policy, registry, make,
        authorize(authority, consumedRegistry = registry) { return cp.authorizeAuthorityRequest({ authority,
            expectedKind: 'SEQUENTIAL', currentBinding: binding, consumedRegistry }); } };
}

test('raw CP cannot detach a gated original Authority from its owner context/registry', () => {
    const a = context(), b = context(), authority = a.make('first');
    assert.equal(a.authorize(authority, b.registry).ok, false);
    assert.equal(a.authorize(authority, cp.createConsumedAuthorityRegistry()).ok, false);
    const legacy = cp.createReplayAuthority({ kind: 'SEQUENTIAL', opaqueToken: 'legacy', binding: a.binding, provenance: 'x' }).authority;
    assert.equal(a.authorize(legacy).ok, false);
    assert.equal(cp.createOwnerPolicyContext({ owner: a.owner, binding: a.binding, validate: () => true }), null);
    assert.equal(cp.createReplayAuthority({ kind: 'SEQUENTIAL', opaqueToken: 'forged', binding: a.binding,
        provenance: 'x', policyContext: {} }).ok, false);
    assert.equal(a.authorize(authority).ok, true);
});

test('stored grant claim reobserves original policy; denial is irreversible and cannot refund Authority', () => {
    let allowed = true;
    const a = context(() => allowed), authority = a.make('once');
    const result = a.authorize(authority); assert.equal(result.ok, true);
    allowed = false;
    assert.equal(cp.claimAuthorityRequestGrant(result.grant, 'SEQUENTIAL').ok, false);
    allowed = true;
    assert.equal(cp.claimAuthorityRequestGrant(result.grant, 'SEQUENTIAL').ok, false);
    assert.equal(a.authorize(authority).ok, false);
    assert.equal(cp.isOwnerPolicyContextCurrent(a.policy), false);
    assert.equal(cp.invalidateAuthority(a.make('after-fault')).ok, false);
});

test('missing/copy/foreign contexts, receiver throw and policy reentry deny; cleanup remains independent', () => {
    let fail = false;
    const a = context(() => { if (fail) throw Error('private receiver'); return true; });
    const authority = a.make('fault'); fail = true;
    assert.equal(a.authorize(authority).ok, false);
    assert.equal(cp.invalidateAuthority(authority).ok, true);
    const b = context(); const handle = b.make('reentry');
    let entered = false, original;
    const c = context(() => { if (original && !entered) { entered = true; c.authorize(original); } return true; });
    original = c.make('original');
    assert.equal(c.authorize(original).ok, false);
    assert.equal(cp.claimAuthorityRequestGrant({ ...handle }, 'SEQUENTIAL').ok, false);
    cp.invalidateOwnerPolicyContext(b.policy);
    assert.equal(cp.invalidateAuthority(handle).ok, true);
});

function replayZ(options = {}) {
    return harness({ childURL: 'https://www.youtube.com/live_chat_replay', ...options });
}

test('strict policy never silently enables zero-v, even with otherwise ready native media', () => {
    const h = harness();
    h.f.value(h.f.child).url = 'https://www.youtube.com/live_chat_replay';
    assert.equal(h.owner.openBootstrap({}), null);
    assert.equal(h.requests.length, 0); assert.equal(h.injections.length, 0);
});

test('ACCEPTED_Z cannot be requested through unrecognized flat facts', () => {
    assert.equal(createLiveAcquisitionOwner({ document: {}, replayAssociationPolicy: 'ACCEPTED_Z' }), null);
});

test('native Replay zero-v stays unverified on READY and WAIT; transition to Live is terminal', () => {
    const f = fixture(); f.value(f.child).url = 'https://www.youtube.com/live_chat_replay';
    const a = createNativeFactsAdapter(f.options);
    assert.equal(a.readFacts().childAssociationEvidence.childTargetIdentity, 'UNVERIFIED');
    f.value(f.video).readyState = 1;
    assert.equal(a.readFacts().readiness, 'WAIT');
    f.value(f.child).url = 'https://www.youtube.com/live_chat';
    const changed = a.readFacts();
    assert.equal(changed.outcome, 'TERMINAL');
    assert.equal(changed.reason, 'MODE_CHANGED');
});

const acceptedZ = options => replayZ({ replayAssociationPolicy: 'ACCEPTED_Z', ...options });

test('real zero-v Owner has one extraction, original consumed grants and legal Sequential/SEEK progression', async () => {
    const h = acceptedZ();
    await h.bootstrap(); assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
    await h.answer(0, payload([0, 500]));
    assert.equal(h.owner.status().bootstrap, 'ACCEPTED');
    h.seeking(true, 10); h.seeking(false, 10); await h.tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.owner.status().lastReanchor, 'SEEK');
    await h.answer(1, payload([10000, 10500], 'after-seek', 'next-seek'));
    assert.equal(h.injections.length, 1);
    assert.equal(h.owner.status().phase === 'TERMINAL', false);
    assert.equal(h.stats().maxActive, 1);
    assert.equal(h.requests[1].init.credentials, 'omit');
});

for (const query of ['?v=', '?v=target&v=target', '?v=wrong']) test(`ACCEPTED_Z never downgrades invalid v ${query}`, async () => {
    const h = acceptedZ(); // Observe invalid input before the original permit.
    h.f.value(h.f.child).url = 'https://www.youtube.com/live_chat_replay' + query;
    assert.equal(await h.bootstrap(), false);
    assert.equal(h.requests.length, 0); assert.equal(h.injections.length, 0);
});

for (const capability of Object.values(cp.CapabilityName)) for (const unavailable of ['UNKNOWN', 'UNSUPPORTED'])
test(`valid Z cannot replace ${capability} ${unavailable}`, async () => {
    const h = acceptedZ();
    h.config.control.createCapabilitySnapshot = input => cp.createCapabilitySnapshot({ ...input,
        capabilities: { ...input.capabilities, [capability]: unavailable } });
    await h.bootstrap();
    if (h.requests.length) {
        await h.answer(0, payload([0]));
        await h.tick(2000);
    }
    // reanchorRead is required only when recovery is requested; it cannot issue a recovery READ.
    if (capability === 'reanchorRead' && h.owner.status().phase !== 'TERMINAL') {
        h.seeking(true, 10); h.seeking(false, 10); await h.tick();
    }
    assert.ok(h.requests.length <= 1);
    assert.equal(h.owner.status().phase, 'TERMINAL');
    assert.equal(h.injections.length <= 1, true);
});

for (const boundary of ['json', 'parser', 'beforeClaim', 'setup']) test(`Z loss at ${boundary} cannot commit or dispatch stale work`, async () => {
    const mutate = f => { f.value(f.child).url = 'https://www.youtube.com/live_chat'; };
    const h = acceptedZ({ beforeClaim: boundary === 'beforeClaim' ? mutate : undefined });
    await h.bootstrap();
    if (boundary === 'json') {
        h.requests[0].resolve({ status: 200, json: async () => { mutate(h.f); return payload([0]); } });
        await new Promise(resolve => setImmediate(resolve));
    } else if (boundary === 'parser') {
        const original = h.config.core.extractReplayChatMessagesFromResponse;
        const core = { ...h.config.core, extractReplayChatMessagesFromResponse(value) { const messages = original(value); mutate(h.f); return messages; } };
        // config.core is original module object; modifying only a per-test function, then restore exactly.
        h.config.core.extractReplayChatMessagesFromResponse = core.extractReplayChatMessagesFromResponse;
        try { await h.answer(0, payload([0])); }
        finally { h.config.core.extractReplayChatMessagesFromResponse = original; }
    } else {
        await h.answer(0, payload([0]));
        if (boundary === 'setup') {
            const old = h.config.core.buildLiveChatReadRequest;
            h.config.core.buildLiveChatReadRequest = (...args) => { const result = old(...args); mutate(h.f); return result; };
            try { h.seeking(true, 10); h.seeking(false, 10); await h.tick(); }
            finally { h.config.core.buildLiveChatReadRequest = old; }
        } else { h.seeking(true, 10); h.seeking(false, 10); await h.tick(); }
    }
    assert.equal(h.owner.status().phase, 'TERMINAL');
    assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
});

test('future-only zero-v stock cannot publish after child Document replacement, no new extraction', async () => {
    const h = acceptedZ(); await h.bootstrap();
    await h.answer(0, payload([1000, 2000]));
    const before = h.batches.length;
    h.f.value(h.f.frame).child = new h.f.realm.Document({ url: 'https://www.youtube.com/live_chat_replay' });
    h.f.value(h.f.video).position = 2;
    await h.tick();
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.batches.length, before);
    assert.equal(h.injections.length, 1); assert.equal(h.owner.openBootstrap({}), null);
});

test('real Temporal transition observer cannot publish Due after reentrant source invalidation', async () => {
    let armed = false, observations = 0, h;
    h = acceptedZ({ configure(config) {
        config.provenance = { connect() {}, onParserAudit() {}, onDisposition() {},
            onTemporalTransition() {
                observations++;
                if (armed) h.f.value(h.f.child).url = 'https://www.youtube.com/live_chat';
            } };
    } });
    await h.bootstrap(); await h.answer(0, payload([1000, 2000]));
    const before = h.batches.length, oldObservations = observations;
    armed = true; h.f.value(h.f.video).position = 1; await h.tick();
    assert.ok(observations > oldObservations, 'actual single-pass Temporal observer was invoked');
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.batches.length, before);
    assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
});

test('same-ref indistinguishable zero-v child is an accepted integrity limitation, not an identity proof', async () => {
    const h = acceptedZ(); await h.bootstrap();
    // No native observable changes: the adapter cannot claim to know semantic child content.
    const adapter = createNativeFactsAdapter(h.f.options);
    const sample = adapter.readFacts();
    assert.equal(sample.childAssociationEvidence.childTargetIdentity, 'UNVERIFIED');
    assert.equal(sample.outcome, 'STRUCTURALLY_ASSOCIATED_TARGET_UNVERIFIED');
    await h.answer(0, payload([0])); assert.equal(h.owner.status().accepted, 1);
    h.owner.cancel(); assert.equal(h.owner.openBootstrap({}), null);
});

test('final Replay association/capability validation crossing5000 cannot admit the original Bootstrap', async () => {
    let now = 0, pendingChecks = 0, h;
    h = acceptedZ({ configure(config) {
        config.clock = { now: () => now };
        const schedule = config.timers.setTimeout;
        config.timers = { ...config.timers, setTimeout(fn, delay) {
            const result = schedule(fn, delay); if (delay === 5000) now = 4999; return result;
        } };
        config.control.createCapabilitySnapshot = input => {
            if (h?.owner.status().bootstrap === 'PENDING' && ++pendingChecks === 2) now = 5000;
            return cp.createCapabilitySnapshot(input);
        };
    } });
    await h.bootstrap();
    assert.equal(h.owner.status().bootstrap, 'FAILED');
    assert.equal(h.owner.status().reason, 'DEADLINE_EXPIRED');
    assert.equal(h.requests.length, 0); assert.equal(h.injections.length, 1);
});
