'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const native = require('../src/native-facts');
const { fixture } = require('./fixtures/native-facts-dom');
const baseline = require('../.playwright-mcp/g13-p1-20261104-native-before.js');

function setup(mode = 'live', query = '', api = native) {
    const f = fixture();
    f.options.mode = mode;
    f.value(f.child).url = 'https://www.youtube.com/' + (mode === 'live' ? 'live_chat' : 'live_chat_replay') + query;
    const a = api.createNativeFactsAdapter(f.options);
    return { f, a, sample: () => a.readFacts() };
}
const admit = (h, s, replay = 'STRICT_V', live) => native.inspectNativeAdmission(h.a, s, replay, live);

test('Live V retains strict verified association and exact original native references', () => {
    const h = setup('live', '?v=target'), s = h.sample();
    assert.equal(s.outcome, 'KNOWN');
    assert.equal(s.childAssociationEvidence.state, 'V_MATCH');
    assert.equal(s.childAssociationEvidence.childTargetIdentity, 'URL_V_MATCH');
    assert.equal(s.facts.document.value, h.f.document);
    assert.equal(s.facts.video.value, h.f.video);
    assert.equal(s.facts.childDocument.value, h.f.child);
    assert.ok(admit(h, s));
    assert.equal(h.f.counts().forbidden, 0);
});

test('Live ZERO has dedicated immutable UNVERIFIED type and independent parent evidence', () => {
    const h = setup(), s = h.sample();
    assert.equal(s.outcome, 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED');
    assert.equal(s.childAssociationEvidence.state, 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED');
    assert.equal(s.childAssociationEvidence.childTargetIdentity, 'UNVERIFIED');
    assert.equal(s.parentTargetEvidence.state, 'KNOWN');
    assert.equal(s.parentTargetEvidence.basis, 'ORIGINAL_TOP_ROUTE_MATCH');
    assert.equal(s.facts.mode.value, 'live');
    assert.equal(s.readiness, 'READY');
    assert.equal(Object.isFrozen(s), true);
    assert.equal(Object.isFrozen(s.childAssociationEvidence), true);
    assert.equal(h.f.counts().forbidden, 0);
    assert.equal(h.f.counts().reads, 1);
});

for (const policy of [undefined, 'STRICT_V', 'ACCEPTED_Z', 'UNKNOWN', null, true, {}]) {
    test(`Live ZERO denies absent/incorrect Live policy ${typeof policy}:${String(policy)}`, () => {
        const h = setup(), s = h.sample();
        assert.equal(s.outcome, 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED');
        assert.equal(admit(h, s, 'ACCEPTED_Z', policy), null);
    });
}

test('explicit Live policy admits only original source-qualified Live ZERO sample', () => {
    const h = setup(), s = h.sample();
    const accepted = admit(h, s, 'STRICT_V', 'ACCEPTED_LIVE_ZERO_V');
    assert.ok(accepted);
    assert.equal(accepted.parentTargetEvidence, s.parentTargetEvidence);
    assert.equal(accepted.childAssociationEvidence, s.childAssociationEvidence);
    assert.equal(accepted.childAssociationEvidence.childTargetIdentity, 'UNVERIFIED');
    assert.equal(admit(h, { ...s }, 'STRICT_V', 'ACCEPTED_LIVE_ZERO_V'), null);
    assert.equal(native.inspectNativeAdmission(h.f.make(), s, 'STRICT_V', 'ACCEPTED_LIVE_ZERO_V'), null);
});

test('Live policy does not invoke coercion/getters on policy objects', () => {
    const h = setup(), s = h.sample();
    const hostile = new Proxy({}, { get() { throw Error('policy object read'); } });
    assert.equal(admit(h, s, 'STRICT_V', hostile), null);
});

test('Replay V/Z retain original types and require independent Replay policy', () => {
    const v = setup('replay', '?v=target'), sv = v.sample();
    assert.equal(sv.outcome, 'KNOWN');
    assert.equal(sv.childAssociationEvidence.state, 'V_MATCH');
    assert.ok(admit(v, sv));
    const z = setup('replay'), sz = z.sample();
    assert.equal(sz.outcome, 'STRUCTURALLY_ASSOCIATED_TARGET_UNVERIFIED');
    assert.equal(sz.childAssociationEvidence.state, 'Z_STRUCTURAL_UNVERIFIED');
    assert.equal(sz.childAssociationEvidence.childTargetIdentity, 'UNVERIFIED');
    assert.equal(admit(z, sz, 'STRICT_V', 'ACCEPTED_LIVE_ZERO_V'), null);
    assert.ok(admit(z, sz, 'ACCEPTED_Z'));
    assert.ok(admit(z, sz, 'ACCEPTED_Z', 'STRICT_V'));
});

for (const mode of ['live', 'replay']) for (const query of ['?v=', '?v=other', '?v=target&v=target', '?v=target&v=other']) {
    test(`${mode} X ${query} denies under both accepted policies before media reads`, () => {
        const h = setup(mode, query), s = h.sample();
        assert.equal(s.outcome, 'UNKNOWN');
        assert.equal(s.reason, 'CHILD_TARGET_UNKNOWN');
        assert.equal(admit(h, s, 'ACCEPTED_Z', 'ACCEPTED_LIVE_ZERO_V'), null);
        assert.equal(h.f.counts().reads, 0);
    });
}

for (const url of ['https://other.invalid/live_chat', 'http://www.youtube.com/live_chat', 'about:blank', 'https://www.youtube.com/other']) {
    test(`Live ZERO origin/path ${url} denies`, () => {
        const h = setup(); h.f.value(h.f.child).url = url;
        const s = h.sample();
        assert.equal(s.outcome, 'UNKNOWN');
        assert.equal(admit(h, s, 'ACCEPTED_Z', 'ACCEPTED_LIVE_ZERO_V'), null);
    });
}

for (const defect of ['ambiguous', 'foreign', 'disconnected', 'miniplayer', 'inaccessible']) {
    test(`Live ZERO ownership ${defect} denies`, () => {
        const h = setup(), f = h.f;
        if (defect === 'ambiguous') f.value(f.watch).queries['ytd-live-chat-frame iframe'] = [f.frame, f.frame];
        if (defect === 'foreign') f.value(f.video).document = {};
        if (defect === 'disconnected') f.value(f.video).connected = false;
        if (defect === 'miniplayer') f.value(f.video).miniplayer = f.player;
        if (defect === 'inaccessible') f.value(f.frame).child = null;
        const s = h.sample();
        assert.equal(s.outcome, 'UNKNOWN');
        assert.equal(admit(h, s, 'ACCEPTED_Z', 'ACCEPTED_LIVE_ZERO_V'), null);
    });
}

for (const change of ['child', 'target', 'mode', 'route', 'heldVideo']) {
    test(`qualified Live ZERO ${change} change is sticky terminal, no restore/rebind`, () => {
        const h = setup(), f = h.f;
        assert.ok(admit(h, h.sample(), 'STRICT_V', 'ACCEPTED_LIVE_ZERO_V'));
        if (change === 'child') f.value(f.frame).child = new f.realm.Document({ url: f.value(f.child).url });
        if (change === 'target') f.value(f.document).url = 'https://www.youtube.com/watch?v=other';
        if (change === 'mode') f.value(f.child).url = 'https://www.youtube.com/live_chat_replay';
        if (change === 'route') f.setRoute({ ...f.options.route, documentId: '87654321-1234-1234-1234-123456789abc' });
        if (change === 'heldVideo') f.value(f.video).connected = false;
        const denied = h.sample();
        assert.equal(denied.outcome, 'TERMINAL');
        assert.equal(admit(h, denied, 'ACCEPTED_Z', 'ACCEPTED_LIVE_ZERO_V'), null);
        f.value(f.frame).child = f.child;
        f.value(f.document).url = 'https://www.youtube.com/watch?v=target';
        f.value(f.child).url = 'https://www.youtube.com/live_chat';
        f.value(f.video).connected = true;
        f.setRoute(f.options.route);
        assert.equal(h.sample().outcome, 'TERMINAL');
    });
}

test('Live ZERO WAIT is association-qualified only by explicit policy, no invented READY', () => {
    const h = setup(), f = h.f; f.value(f.video).readyState = 0;
    const s = h.sample();
    assert.equal(s.outcome, 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED');
    assert.equal(s.readiness, 'WAIT');
    assert.equal(s.facts.ready.value, false);
    assert.equal(admit(h, s), null);
    assert.equal(admit(h, s, 'STRICT_V', 'ACCEPTED_LIVE_ZERO_V').readiness, 'WAIT');
    f.value(f.video).readyState = 4;
    assert.equal(h.sample().readiness, 'READY');
});

test('native double sample rejects a torn Live ZERO child URL', () => {
    const h = setup();
    h.f.setHook(() => { h.f.value(h.f.child).url = 'https://www.youtube.com/live_chat?v=target'; });
    const s = h.sample();
    assert.equal(s.outcome, 'TERMINAL');
    assert.equal(s.reason, 'OBSERVATION_CHANGED');
    assert.equal(admit(h, s, 'STRICT_V', 'ACCEPTED_LIVE_ZERO_V'), null);
});

function traced(api, mode, query, defect) {
    const f = fixture(), trace = [];
    f.options.mode = mode;
    f.value(f.child).url = 'https://www.youtube.com/' + (mode === 'live' ? 'live_chat' : 'live_chat_replay') + query;
    const original = f.options.native;
    const primary = {};
    const wrappers = Object.fromEntries(Object.entries(original).map(([key, fn]) => [key, (...args) => {
        trace.push('call:' + key);
        if (key === 'readyState' && defect === 'throw') throw primary;
        return fn(...args);
    }]));
    f.options.native = new Proxy(wrappers, { get(obj, key) { trace.push('get:' + String(key)); return obj[key]; } });
    if (defect === 'malformed') f.value(f.video).rate = undefined;
    if (defect === 'own') Object.defineProperty(f.video, 'readyState', { get() { throw Error('page getter'); } });
    if (defect === 'throw') Object.defineProperty(primary, 'nativeFactsFailure', { get() { trace.push('error:marker'); throw primary; } });
    const a = api.createNativeFactsAdapter(f.options);
    let s;
    if (defect === 'throw') assert.throws(() => a.readFacts(), e => e === primary);
    else s = a.readFacts();
    assert.equal(f.counts().forbidden, 0);
    return { trace, outcome: s?.outcome, reason: s?.reason, readiness: s?.readiness };
}
for (const [mode, query] of [['live', '?v=target'], ['replay', '?v=target'], ['replay', '']]) {
    for (const defect of ['none', 'own', 'malformed', 'throw']) test(`baseline native read/exception equivalence ${mode} ${query || 'Z'} ${defect}`, () => {
        assert.deepEqual(traced(native, mode, query, defect), traced(baseline, mode, query, defect));
    });
}

for (const defect of ['none', 'own', 'malformed', 'throw']) test(`Live ZERO uses original Live V native access sequence and exception boundary: ${defect}`, () => {
    const zero = traced(native, 'live', '', defect);
    const originalV = traced(baseline, 'live', '?v=target', defect);
    assert.deepEqual(zero.trace, originalV.trace);
    if (defect === 'malformed') {
        assert.equal(zero.outcome, 'UNKNOWN');
        assert.equal(zero.reason, 'MEDIA_UNKNOWN');
    }
});

test('reentrant Live ZERO observation latches terminal and does not acquire admission', () => {
    const h = setup();
    let nested;
    h.f.setHook(() => { nested = h.sample(); });
    const outer = h.sample();
    for (const s of [nested, outer, h.sample()]) {
        assert.equal(s.outcome, 'TERMINAL');
        assert.equal(s.reason, 'REENTRANT_OBSERVATION');
        assert.equal(admit(h, s, 'STRICT_V', 'ACCEPTED_LIVE_ZERO_V'), null);
    }
});

test('default inspector remains strict while P6 Production explicitly admits Live ZERO', async () => {
    const h = setup(), s = h.sample();
    assert.equal(s.outcome, 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED');
    // Generic callers retain STRICT_V; only qualified P6 composition selects Live ZERO.
    assert.equal(native.inspectNativeAdmission(h.a, s, 'ACCEPTED_Z'), null);
    const { fixture: production } = require('./fixtures/production-integration');
    const bridge = production(require('../manifest.json'), { mode: 'live' });
    bridge.f.value(bridge.f.child).url = 'https://www.youtube.com/live_chat';
    await bridge.start();
    assert.equal(bridge.connections, 1);
    assert.equal(bridge.bridge.inspect().failed, false);
    assert.equal(bridge.bridge.inspect().owner, 'READING');
    assert.equal(bridge.injections.length, 1);
    assert.equal(bridge.requests.length, 1);
});

test('module remains dormant, no network/message/timer and no new public export', () => {
    const source = fs.readFileSync(require.resolve('../src/native-facts'), 'utf8');
    const context = vm.createContext({ module: { exports: {} } });
    vm.runInContext(source, context);
    assert.deepEqual(Object.keys(context), ['module']);
    assert.deepEqual(Object.keys(context.module.exports), Object.keys(baseline));
    assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|postMessage\s*\(|addEventListener\s*\(|setTimeout\s*\(/);
});
