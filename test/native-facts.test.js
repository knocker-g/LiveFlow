'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { captureNativeAccess, createNativeFactsAdapter } = require('../src/native-facts.js');
const { classifyChatFramePath } = require('../src/chat-frame-role-core.js');

const { fixture } = require('./fixtures/native-facts-dom.js');

const unknown = result => {
    assert.equal(result.outcome, 'UNKNOWN');
    for (const fact of Object.values(result.facts)) {
        assert.equal(fact.state, 'UNKNOWN'); assert.equal(Object.hasOwn(fact, 'value'), false);
    }
};

test('unique native Document/Watch/video/child and exact route yield typed facts, preserving zero', () => {
    const f = fixture(), adapter = f.make(), r = adapter.readFacts();
    assert.equal(r.outcome, 'KNOWN');
    assert.equal(r.facts.mode.value, 'replay'); assert.equal(r.facts.position.value, 0);
    assert.equal(r.facts.video.value, f.video); assert.equal(r.facts.childDocument.value, f.child);
    assert.equal(r.facts.paused.value, false); assert.equal(r.facts.adActive.value, false);
    assert.equal(r.facts.ready.value, true); assert.equal(Object.isFrozen(r.facts), true);
    assert.deepEqual(f.counts(), { forbidden: 0, reads: 1 });
});

test('Live classification uses the actual child path, independently of historical mode', () => {
    const f = fixture(); f.options.mode = 'live';
    f.value(f.child).url = 'https://www.youtube.com/live_chat?v=target';
    const a = f.make(); assert.equal(a.readFacts().facts.mode.value, 'live');
    assert.equal(a.readFacts({ bootstrapMode: 'replay' }).facts.mode.value, 'live');
});

for (const key of ['watch', 'player', 'video', 'frame']) test(`replacement of held ${key} is terminal without rebind`, () => {
    const f = fixture(), a = f.make(); assert.equal(a.readFacts().outcome, 'KNOWN');
    // Use another genuinely branded, otherwise qualified element.
    const other = key === 'frame' ? new f.realm.HTMLIFrameElement({ document: f.document, child: f.child }) :
        key === 'video' ? new f.realm.HTMLMediaElement({ document: f.document }) : new f.realm.Element({ document: f.document });
    Object.assign(f.value(other), f.value(f[key]));
    const parent = key === 'watch' ? f.document : key === 'video' ? f.player : f.watch;
    const selector = { watch: 'ytd-watch-flexy', player: '#movie_player, .html5-video-player', video: 'video.html5-main-video, video', frame: 'ytd-live-chat-frame iframe' }[key];
    f.value(parent).queries[selector] = [other]; f.value(parent).children.push(other);
    assert.equal(a.readFacts().outcome, 'TERMINAL');
    f.value(parent).queries[selector] = [f[key]];
    assert.equal(a.readFacts().outcome, 'TERMINAL');
});

test('verified held ownership loss is terminal, not a rebindable missing selection', () => {
    const f = fixture(), a = f.make(); a.readFacts();
    f.value(f.video).connected = false;
    assert.equal(a.readFacts().reason, 'OWNER_BINDING_LOST');
    f.value(f.video).connected = true;
    assert.equal(a.readFacts().outcome, 'TERMINAL');
});

test('same-Document target/mode changes terminate and cannot recover when reverted', () => {
    for (const change of ['target', 'mode']) {
        const f = fixture(), a = f.make(); a.readFacts();
        if (change === 'target') f.value(f.document).url = 'https://www.youtube.com/watch?v=other';
        else f.value(f.child).url = 'https://www.youtube.com/live_chat?v=target';
        assert.equal(a.readFacts().outcome, 'TERMINAL');
        f.value(f.document).url = 'https://www.youtube.com/watch?v=target';
        f.value(f.child).url = 'https://www.youtube.com/live_chat_replay?v=target';
        assert.equal(a.readFacts().outcome, 'TERMINAL');
    }
});

test('actual child Document replacement terminates even with stable apparent WindowProxy', () => {
    const f = fixture(), a = f.make(); a.readFacts();
    f.value(f.frame).child = new f.realm.Document({ url: f.value(f.child).url });
    assert.equal(a.readFacts().reason, 'CHILD_REPLACED');
    assert.equal(f.counts().forbidden, 0); // Never reads contentWindow.
});

test('ambiguous Watch/player/video and multiple or overflowing frames never elect first', () => {
    for (const [parent, selector, child] of [['document', 'ytd-watch-flexy', 'watch'], ['watch', '#movie_player, .html5-video-player', 'player'],
        ['player', 'video.html5-main-video, video', 'video'], ['watch', 'ytd-live-chat-frame iframe', 'frame']]) {
        for (const count of [2, 9]) {
            const f = fixture(); f.value(f[parent]).queries[selector] = Array(count).fill(f[child]);
            unknown(f.make().readFacts()); assert.equal(f.counts().reads, 0);
        }
    }
});

test('inaccessible, cross-origin, blank and unsupported actual child Documents are UNKNOWN', () => {
    for (const url of ['https://youtube.com/live_chat_replay?v=target', 'http://www.youtube.com/live_chat_replay?v=target',
        'about:blank', 'about:srcdoc', 'https://www.youtube.com/other?v=target']) {
        const f = fixture(); f.value(f.child).url = url; unknown(f.make().readFacts());
    }
    for (const denied of [false, true]) {
        const f = fixture(); f.value(f.frame).child = null; f.value(f.frame).denied = denied;
        unknown(f.make().readFacts());
    }
});

test('child v must occur exactly once, nonempty and match original and top target', () => {
    for (const query of ['?v=', '?v=other', '?v=target&v=target', '?v=target&v=other']) {
        const f = fixture(); f.value(f.child).url = 'https://www.youtube.com/live_chat_replay' + query;
        unknown(f.make().readFacts());
    }
});

test('zero-v Replay is a distinct original native sample, never child target KNOWN', () => {
    const { inspectNativeAdmission } = require('../src/native-facts.js');
    const f = fixture(); f.value(f.child).url = 'https://www.youtube.com/live_chat_replay';
    const adapter = f.make(), sample = adapter.readFacts();
    assert.equal(sample.outcome, 'STRUCTURALLY_ASSOCIATED_TARGET_UNVERIFIED');
    assert.equal(sample.childAssociationEvidence.childTargetIdentity, 'UNVERIFIED');
    assert.equal(sample.parentTargetEvidence.basis, 'ORIGINAL_TOP_ROUTE_MATCH');
    assert.equal(inspectNativeAdmission(adapter, sample, 'STRICT_V'), null);
    assert.ok(inspectNativeAdmission(adapter, sample, 'ACCEPTED_Z'));
    assert.equal(inspectNativeAdmission(adapter, { ...sample }, 'ACCEPTED_Z'), null);
    assert.equal(inspectNativeAdmission(f.make(), sample, 'ACCEPTED_Z'), null);
    f.value(f.child).url = 'https://www.youtube.com/live_chat';
    const changed = adapter.readFacts();
    assert.equal(changed.outcome, 'TERMINAL');
    assert.equal(changed.reason, 'MODE_CHANGED');
    for (const fact of Object.values(changed.facts)) {
        assert.equal(fact.state, 'UNKNOWN');
        assert.equal(Object.hasOwn(fact, 'value'), false);
    }
    assert.equal(inspectNativeAdmission(adapter, changed, 'ACCEPTED_Z', 'ACCEPTED_LIVE_ZERO_V'), null);
});

test('unknown/malformed native media facts never default to Boolean or zero', () => {
    for (const [key, value] of [['readyState', undefined], ['ended', undefined], ['seeking', 0], ['paused', null],
        ['position', NaN], ['position', -1], ['rate', undefined], ['rate', 0]]) {
        const f = fixture(); f.value(f.video)[key] = value; unknown(f.make().readFacts());
    }
});

test('known loading, hidden, ad and seeking yield WAIT; paused is observed, not acquisition toggle', () => {
    for (const field of ['readyState', 'seeking', 'hidden', 'ad']) {
        const f = fixture();
        if (field === 'hidden') Object.assign(f.value(f.document), { hidden: true, visibility: 'hidden' });
        else if (field === 'ad') f.value(f.player).classes = new Set(['ad-showing']);
        else f.value(f.video)[field] = field === 'readyState' ? 1 : true;
        assert.equal(f.make().readFacts().outcome, 'WAIT');
    }
    const f = fixture(); f.value(f.video).paused = true;
    assert.equal(f.make().readFacts().facts.paused.value, true);
});

test('synthetic role/lifecycle/media/ad payloads have no effect on native observations', () => {
    const f = fixture(), a = f.make();
    const first = a.readFacts();
    const next = a.readFacts({ type: 'AD_EXIT', mode: 'live', generation: 999, targetId: 'other', ready: false });
    assert.deepEqual(next, first); assert.equal(f.counts().forbidden, 0);
});

test('both ad/readiness orders observe actual current facts, retaining no event authorization', () => {
    for (const readinessFirst of [true, false]) {
        const f = fixture(), a = f.make();
        f.value(f.player).classes = new Set(['ad-interrupting']); f.value(f.video).readyState = 1;
        assert.equal(a.readFacts().outcome, 'WAIT');
        if (readinessFirst) f.value(f.video).readyState = 4; else f.value(f.player).classes.clear();
        assert.equal(a.readFacts().outcome, 'WAIT');
        f.value(f.player).classes.clear(); f.value(f.video).readyState = 4;
        assert.equal(a.readFacts().outcome, 'KNOWN');
        f.value(f.video).readyState = 1; assert.equal(a.readFacts().outcome, 'WAIT');
    }
});

test('current Document/route loss during sample and torn containment fail closed', () => {
    for (const change of ['document', 'route', 'containment', 'child']) {
        const f = fixture(), a = f.make();
        f.setHook(() => {
            if (change === 'document') f.setDocument({});
            if (change === 'route') f.setRoute({ ...f.options.route, documentId: '87654321-1234-1234-1234-123456789abc' });
            if (change === 'containment') f.value(f.player).children = [];
            if (change === 'child') f.value(f.frame).child = new f.realm.Document({ url: f.value(f.child).url });
        });
        assert.notEqual(a.readFacts().outcome, 'KNOWN');
    }
});

test('unconnected/foreign/miniplayer elements and unqualified routes fail closed', () => {
    for (const change of ['connected', 'document', 'miniplayer']) {
        const f = fixture(); f.value(f.video)[change] = change === 'connected' ? false : {};
        unknown(f.make().readFacts());
    }
    const f = fixture(); f.options.route.frameId = 1; assert.equal(f.make(), null);
});

test('captured prototype access bypasses hostile own media getters; wrong brands reject', () => {
    const f = fixture();
    Object.defineProperty(f.video, 'readyState', { get() { throw new Error('Page expando invoked'); } });
    assert.equal(f.make().readFacts().outcome, 'KNOWN');
    assert.throws(() => f.options.native.readyState({}), /Illegal receiver/);
});

test('module import is dormant, registers no public API and accesses no browser/network globals', () => {
    const source = fs.readFileSync(require.resolve('../src/native-facts.js'), 'utf8');
    const context = vm.createContext({ module: { exports: {} } });
    const before = Object.keys(context); vm.runInContext(source, context);
    assert.deepEqual(Object.keys(context), before);
    assert.deepEqual(Object.keys(context.module.exports), ['captureNativeAccess', 'createNativeFactsAdapter', 'inspectNativeAdmission', 'recognizeNativeFactsAdapter']);
    assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|postMessage\s*\(|addEventListener\s*\(|setTimeout\s*\(|watch\.data|ytcfg\.get/);
});
