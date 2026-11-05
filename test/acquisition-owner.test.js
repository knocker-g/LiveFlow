const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createLiveAcquisitionOwner } = require('../src/acquisition-owner.js');
const { createBootstrapCourier } = require('../src/bootstrap-coordinator.js');
const core = require('../src/chat-read-core.js');

const documentId = '01234567-89ab-cdef-0123-456789abcdef';
const route = { tabId: 7, frameId: 0, documentId };
const extensionId = 'a'.repeat(32);
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
function fakeClock() {
    let value = 0, id = 0;
    const jobs = new Map();
    return { now: () => value, set: n => { value = n; }, jobs,
        setTimeout(fn, delay) { const key = ++id; jobs.set(key, { fn, due: value + delay }); return key; },
        clearTimeout(key) { jobs.delete(key); },
        fire() {
            let steps = 0;
            for (;;) {
                const next = [...jobs].find(([, job]) => job.due <= value);
                if (!next) break;
                if (++steps > 30) throw Error('unbounded scheduling');
                jobs.delete(next[0]); next[1].fn();
            }
        }
    };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function payload(token = 'next', delay = 1000) {
    return { continuationContents: { liveChatContinuation: { actions: [],
        continuations: [{ timedContinuationData: { continuation: token, timeoutMs: delay } }] } } };
}
const http = body => ({ status: 200, json: async () => body });
function harness(options = {}) {
    const document = {}, video = {}, clock = fakeClock();
    const ownedRoute = options.route || route;
    const facts = { document, video, targetId: 'target', mode: 'live', lifecycle: 1, revision: 1,
        generation: 1, owned: true, capability: true, clockCurrent: true,
        visible: true, ready: true, adActive: false, seeking: false };
    const requests = [], batches = [], injections = [], messages = [], listeners = new Set();
    let extraction;
    const config = { document, route: ownedRoute, readFacts: () => facts, clock, timers: clock, core,
        entropy: bytes => bytes.fill(1), AbortController,
        onBatch: batch => { batches.push(batch); if (options.onBatch) options.onBatch(batch); },
        transport: (url, request) => {
            const d = deferred(); requests.push({ url, request, ...d });
            return options.transport ? options.transport(url, request, d) : d.promise;
        } };
    const owner = createLiveAcquisitionOwner(config);
    const channel = { sender: { id: extensionId, tab: { id: ownedRoute.tabId }, frameId: ownedRoute.frameId, documentId: ownedRoute.documentId },
        onDisconnect: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
        postMessage: raw => { messages.push(raw); return bridge.receive(raw); } };
    let bridge;
    const scripting = { executeScript(args) {
        injections.push(args);
        const renderer = { isReplay: false, continuations: [{ reloadContinuationData: { continuation: 'initial' } }] };
        const data = { currentVideoEndpoint: { watchEndpoint: { videoId: 'target' } }, contents: {
            twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: renderer } } } };
        const root = { data, isConnected: true };
        const doc = { querySelector: () => root }; root.ownerDocument = doc;
        const result = vm.runInNewContext(`(${args.func.toString()})()`,
            { document: doc, window: { INNERTUBE_CONTEXT: { hl: 'en' } } });
        extraction = [{ frameId: ownedRoute.frameId, documentId: ownedRoute.documentId, result }];
        return options.inject ? options.inject(extraction) : Promise.resolve(extraction);
    } };
    function courier(port = channel) {
        if (!bridge) bridge = owner.openBootstrap(channel);
        if (!bridge) return null;
        return createBootstrapCourier({ scripting, extensionId, channel: port,
            operationId: bridge.operationId, consumePermit: bridge.consumePermit });
    }
    return { document, facts, clock, requests, batches, injections, messages, owner, config, channel,
        courier, get bridge() { return bridge; }, get extraction() { return extraction; },
        disconnect() { for (const fn of [...listeners]) fn(); bridge?.lost(); },
        async bootstrap() { const c = courier(); assert.ok(c); await c.dispatch(); return owner.status(); } };
}

test('real owner permit integrates actual M1a/M1b once across concurrent/duplicate dispatch', async () => {
    const d = deferred(), h = harness({ inject: () => d.promise });
    const a = h.courier(), b = h.courier(); const first = a.dispatch(), duplicate = b.dispatch();
    await flush(); assert.equal(h.injections.length, 1); assert.equal(h.owner.status().permit, 'CONSUMED');
    assert.equal((await duplicate).status, 'DROPPED');
    d.resolve(h.extraction); await first;
    assert.equal(h.owner.status().bootstrap, 'ACCEPTED'); assert.equal(h.messages.length, 1);
    await a.dispatch(); assert.equal(h.injections.length, 1);
    assert.equal(h.bridge.receive(h.messages[0]), false);
    assert.equal(h.owner.openBootstrap({}), null);
    assert.equal(createLiveAcquisitionOwner(h.config), null);
    assert.deepEqual(Object.keys(h.injections[0]), ['target', 'world', 'func']);
});

test('owner deadline 4999 succeeds; exactly5000 and beyond fail, including late ACK', async () => {
    for (const at of [4999, 5000, 5001]) {
        const d = deferred(), h = harness({ inject: () => d.promise });
        const pending = h.courier().dispatch(); await flush();
        h.clock.set(at); d.resolve(h.extraction); await pending;
        assert.equal(h.owner.status().bootstrap, at < 5000 ? 'ACCEPTED' : 'FAILED');
        assert.equal(h.requests.length, 0);
        if (at >= 5000) {
            assert.equal(h.owner.status().reason, 'DEADLINE_EXPIRED');
            assert.equal(h.owner.openBootstrap({}), null); assert.equal(h.clock.jobs.size, 0);
        }
    }
    const d = deferred(), h = harness({ inject: () => d.promise });
    const p = h.courier().dispatch(); await flush(); h.clock.set(5000); h.clock.fire();
    assert.equal(h.owner.status().bootstrap, 'FAILED');
    d.resolve(h.extraction); await p; assert.equal(h.owner.status().bootstrap, 'FAILED');
});

test('receipt before deadline but actual owner validation finishes at5000: reject', async () => {
    const d = deferred(), h = harness({ inject: () => d.promise });
    h.courier().dispatch(); await flush(); h.clock.set(4999);
    const raw = { version: 1, operationId: h.bridge.operationId, route, result: {
        status: 'OK', source: 'C1', targetId: 'target', mode: 'live', continuation: 'initial',
        context: { client: new Proxy({ hl: 'en' }, { getOwnPropertyDescriptor(target, key) {
            h.clock.set(5000); return Object.getOwnPropertyDescriptor(target, key);
        } }) } } };
    assert.equal(h.bridge.receive(raw), false); assert.equal(h.owner.status().reason, 'DEADLINE_EXPIRED');
    d.resolve(h.extraction); await flush(); assert.equal(h.owner.status().bootstrap, 'FAILED');
});

test('worker loss and restarted courier cannot replenish real permit', async () => {
    const d = deferred(), h = harness({ inject: () => d.promise });
    const p = h.courier().dispatch(); await flush(); h.disconnect();
    assert.equal(h.owner.status().reason, 'DELIVERY_LOST');
    const restarted = h.courier({ ...h.channel }); await restarted.dispatch();
    d.resolve(h.extraction); await p;
    assert.equal(h.injections.length, 1); assert.equal(h.requests.length, 0); assert.equal(h.messages.length, 0);
    assert.equal(h.owner.openBootstrap({}), null);
});

test('pre-permit readiness/AD/visibility WAIT consumes no opportunity or deadline', async () => {
    for (const [key, value] of [['visible', false], ['ready', false], ['adActive', true]]) {
        const h = harness(); h.facts[key] = value;
        assert.equal(h.courier(), null); assert.equal(h.owner.status().permit, 'UNUSED');
        assert.equal(h.clock.jobs.size, 0); assert.equal(h.injections.length, 0);
        h.clock.set(9000); h.facts[key] = !value;
        await h.bootstrap(); assert.equal(h.owner.status().bootstrap, 'ACCEPTED');
    }
});

test('hide before consumption retains unused cursor and resumes without extraction', async () => {
    const h = harness(); await h.bootstrap();
    h.facts.visible = false; h.owner.synchronize(); h.clock.fire();
    assert.equal(h.owner.status().phase, 'HIDDEN'); assert.equal(h.owner.status().cursor, 'UNUSED');
    assert.equal(h.requests.length, 0);
    h.facts.visible = true; h.owner.synchronize(); h.owner.synchronize(); h.clock.fire();
    assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
    assert.equal(h.owner.status().cursor, 'CONSUMED');
});

test('hide in-flight aborts, retains flight lock and rejects late accepted-looking result', async () => {
    const h = harness(); await h.bootstrap(); h.clock.fire();
    assert.equal(h.requests.length, 1);
    h.facts.visible = false; h.owner.synchronize();
    assert.equal(h.requests[0].request.signal.aborted, true); assert.equal(h.owner.status().inFlight, true);
    h.facts.visible = true; h.owner.synchronize(); h.clock.set(10000); h.clock.fire();
    h.requests[0].resolve(http(payload())); await flush();
    assert.equal(h.owner.status().inFlight, false); assert.equal(h.owner.status().accepted, 0);
    assert.equal(h.batches.length, 0); assert.equal(h.requests.length, 1); assert.equal(h.owner.status().phase, 'TERMINAL');
});

test('synchronous dispatch failure and explicit abort never restore spent cursor', async () => {
    const h = harness({ transport: () => { throw Error('dispatch'); } });
    await h.bootstrap(); h.clock.fire(); await flush();
    assert.equal(h.requests.length, 1); assert.equal(h.owner.status().attempts, 1);
    assert.equal(h.owner.status().cursor, 'INVALID'); h.owner.synchronize(); h.clock.fire(); assert.equal(h.requests.length, 1);
    const a = harness(); await a.bootstrap(); a.clock.fire(); a.owner.cancel(); a.owner.cancel();
    assert.equal(a.requests[0].request.signal.aborted, true);
    a.requests[0].reject(Error('AbortError')); await flush();
    assert.equal(a.owner.status().phase, 'TERMINAL'); assert.equal(a.owner.status().accepted, 0);
});

test('actual Live validator/parser/cadence and fixed HTTP contract, maxInFlight1', async () => {
    const h = harness(); await h.bootstrap(); h.clock.fire();
    const first = h.requests[0];
    assert.equal(first.url, '/youtubei/v1/live_chat/get_live_chat?prettyPrint=false');
    assert.equal(first.request.method, 'POST'); assert.equal(first.request.credentials, 'omit');
    assert.deepEqual(first.request.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(first.request.body), { context: { client: { hl: 'en' } }, continuation: 'initial' });
    h.owner.synchronize(); h.clock.fire(); assert.equal(h.requests.length, 1);
    first.resolve(http(payload('second', 0))); await flush();
    assert.equal(h.owner.status().accepted, 1); assert.equal(h.owner.status().cursor, 'UNUSED');
    assert.deepEqual(h.batches, [[]]);
    h.clock.set(999); h.clock.fire(); assert.equal(h.requests.length, 1);
    h.clock.set(1000); h.clock.fire(); assert.equal(h.requests.length, 2);
    assert.equal(JSON.parse(h.requests[1].request.body).continuation, 'second');
    h.owner.cancel(); h.requests[1].resolve(http(payload('third'))); await flush();
    assert.equal(h.owner.status().accepted, 1); assert.equal(h.requests.length, 2);
});

test('HTTP/JSON/validation failures and repeated/returned-to-spent cursor cannot progress', async () => {
    for (const response of [{ status: 403 }, { status: 200, json: async () => { throw Error('bad'); } },
        http({}), http(payload('initial')), http(payload('next', -1))]) {
        const h = harness(); await h.bootstrap(); h.clock.fire(); h.requests[0].resolve(response); await flush();
        assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.owner.status().accepted, 0);
        assert.equal(h.batches.length, 0); assert.equal(h.requests.length, 1);
    }
    const h = harness(); await h.bootstrap(); h.clock.fire();
    h.requests[0].resolve(http(payload('second'))); await flush();
    h.clock.set(1000); h.clock.fire(); h.requests[1].resolve(http(payload('initial'))); await flush();
    assert.equal(h.owner.status().reason, 'CURSOR_REPEATED'); assert.equal(h.owner.status().accepted, 1);
});

test('hide/response race: commit-first retains next, hide-first discards result', async () => {
    const committed = harness(); await committed.bootstrap(); committed.clock.fire();
    committed.requests[0].resolve(http(payload('next', 2000))); await flush();
    committed.facts.visible = false; committed.owner.synchronize();
    assert.equal(committed.owner.status().cursor, 'UNUSED');
    committed.clock.set(1000); committed.facts.visible = true; committed.owner.synchronize(); committed.clock.fire();
    assert.equal(committed.requests.length, 1);
    committed.clock.set(2000); committed.clock.fire(); assert.equal(committed.requests.length, 2);
    const hidden = harness(); await hidden.bootstrap(); hidden.clock.fire();
    hidden.requests[0].resolve({ status: 200, json: async () => { hidden.facts.visible = false; return payload(); } });
    await flush(); assert.equal(hidden.owner.status().accepted, 0); assert.equal(hidden.owner.status().phase, 'TERMINAL');
});

test('hide after response commit but before finally retains the accepted unused next cursor', async () => {
    const h = harness({ onBatch() { h.facts.visible = false; h.owner.synchronize(); } });
    await h.bootstrap(); h.clock.fire(); h.requests[0].resolve(http(payload('next'))); await flush();
    assert.equal(h.owner.status().accepted, 1); assert.equal(h.owner.status().phase, 'HIDDEN');
    assert.equal(h.owner.status().cursor, 'UNUSED'); assert.equal(h.owner.status().inFlight, false);
    h.facts.visible = true; h.owner.synchronize(); h.clock.set(1000); h.clock.fire();
    assert.equal(h.requests.length, 2); assert.equal(JSON.parse(h.requests[1].request.body).continuation, 'next');
    assert.equal(h.injections.length, 1);
});

test('wrong document/target/mode/video/revision/lifecycle/generation invalidate admission and resume', async () => {
    for (const [key, value] of [['document', {}], ['targetId', 'other'], ['mode', 'replay'], ['video', {}],
        ['revision', 2], ['lifecycle', 2], ['generation', 2], ['capability', false], ['clockCurrent', false]]) {
        const d = deferred(), h = harness({ inject: () => d.promise });
        const p = h.courier().dispatch(); await flush(); h.facts[key] = value;
        d.resolve(h.extraction); await p;
        assert.equal(h.owner.status().phase, 'TERMINAL', key); assert.equal(h.requests.length, 0);
        assert.equal(h.owner.openBootstrap({}), null); assert.equal(createLiveAcquisitionOwner(h.config), null);
        const a = harness(); await a.bootstrap(); a.facts.visible = false; a.owner.synchronize();
        a.facts[key] = value; a.facts.visible = true; a.owner.synchronize(); a.clock.fire();
        assert.equal(a.owner.status().phase, 'TERMINAL', key); assert.equal(a.requests.length, 0);
    }
});

test('new independently qualified Document owns a separate opportunity; old cannot restart', async () => {
    const old = harness(); await old.bootstrap(); old.facts.targetId = 'changed'; old.owner.synchronize();
    old.facts.targetId = 'target'; assert.equal(old.owner.synchronize(), false);
    assert.equal(createLiveAcquisitionOwner(old.config), null); assert.equal(old.owner.openBootstrap({}), null);
    const next = harness({ route: { ...route, documentId: '01234567-89ab-cdef-0123-456789abcdee' } });
    await next.bootstrap(); assert.equal(next.owner.status().bootstrap, 'ACCEPTED');
    assert.equal(old.injections.length, 1); assert.equal(next.injections.length, 1);
});

test('forged public payloads and Display toggles do not control acquisition', async () => {
    const h = harness(); await h.bootstrap(); h.clock.fire();
    for (const type of ['READ', 'STOP', 'RESUME', 'AD_ENTER', 'AD_EXIT', 'NAVIGATION', 'pagehide']) {
        h.owner.synchronize({ type, generation: 99, targetId: 'forged', visible: false, adActive: true });
        assert.equal(h.owner.status().phase, 'READING'); assert.equal(h.requests.length, 1);
    }
    h.facts.display = false; h.owner.synchronize(); assert.equal(h.requests[0].request.signal.aborted, false);
    h.requests[0].resolve(http(payload())); await flush(); h.clock.set(1000); h.clock.fire();
    assert.equal(h.requests.length, 2); assert.equal(h.injections.length, 1);
    const exposed = JSON.stringify(h.owner.status());
    assert.equal(exposed.includes('initial'), false); assert.equal(exposed.includes('context'), false);
});

test('backward/unknown owner clock and error packets terminate without grants', async () => {
    const d = deferred(), h = harness({ inject: () => d.promise });
    h.clock.set(10); const p = h.courier().dispatch(); await flush(); h.clock.set(9); d.resolve(h.extraction); await p;
    assert.equal(h.owner.status().reason, 'CLOCK_INVALID'); assert.equal(h.requests.length, 0);
    const error = harness({ inject: values => [{ ...values[0], result: { status: 'ERROR', code: 'INVALID_CONTEXT' } }] });
    await error.bootstrap(); assert.equal(error.owner.status().phase, 'TERMINAL'); assert.equal(error.requests.length, 0);
    const invalid = harness(); invalid.clock.now = () => NaN;
    await invalid.bootstrap(); assert.equal(invalid.owner.status().phase, 'TERMINAL');
    assert.equal(invalid.injections.length, 0); assert.equal(invalid.requests.length, 0);
});

test('owner import is dormant and registers no global owner, listeners, timers or transport', () => {
    const deny = () => { throw Error('runtime on import'); };
    const context = { module: { exports: {} }, require: name => {
        assert.ok(['./bootstrap-contract.js', './native-facts.js'].includes(name)); return require('../src/' + name.slice(2));
    }, window: new Proxy({}, { get: deny, set: deny }), chrome: new Proxy({}, { get: deny }),
    fetch: deny, setTimeout: deny, addEventListener: deny };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/acquisition-owner.js'), 'utf8'), context);
    assert.deepEqual(Object.keys(context.module.exports), ['createLiveAcquisitionOwner']);
    assert.equal(Object.hasOwn(context, 'createLiveAcquisitionOwner'), false);
});

test('Document claim, permit and admission CAS resist private dependency reentrancy', async () => {
    const original = harness(); original.owner.cancel();
    const doc = {}, nested = [];
    const config = { ...original.config, document: doc };
    config.readFacts = () => {
        nested.push(createLiveAcquisitionOwner(config));
        return { ...original.facts, document: doc };
    };
    assert.ok(createLiveAcquisitionOwner(config)); assert.deepEqual(nested, [null]);

    const d = deferred(), h = harness({ inject: () => d.promise });
    h.courier(); const realNow = h.clock.now; let recurse = true, granted = 0;
    const request = { operationId: h.bridge.operationId, route };
    h.clock.now = () => {
        if (recurse) { recurse = false; if (h.bridge.consumePermit(request) === true) granted++; }
        return realNow();
    };
    if (h.bridge.consumePermit(request) === true) granted++;
    assert.equal(granted, 1);
    assert.equal(h.clock.jobs.size, 1);
    const packet = { version: 1, operationId: h.bridge.operationId, route,
        result: { status: 'OK', source: 'C1', targetId: 'target', mode: 'live', continuation: 'first', context: { client: { hl: 'en' } } } };
    let winner = null;
    h.clock.now = () => {
        if (winner === null) { winner = false; winner = h.bridge.receive(packet); }
        return realNow();
    };
    assert.equal(h.bridge.receive({ ...packet, result: { ...packet.result, continuation: 'loser' } }), false);
    assert.equal(winner, true); assert.equal(h.owner.status().bootstrap, 'ACCEPTED');
    h.clock.now = realNow; h.clock.fire();
    assert.equal(JSON.parse(h.requests[0].request.body).continuation, 'first');
});

test('original private channel cannot be replaced by a reentrant reservation', () => {
    const seed = harness(); seed.owner.cancel();
    const doc = {}; let owner, inner, reenter = false;
    const config = { ...seed.config, document: doc, readFacts: () => {
        if (reenter) { reenter = false; inner = owner.openBootstrap({ original: true }); }
        return { ...seed.facts, document: doc };
    } };
    owner = createLiveAcquisitionOwner(config); reenter = true;
    assert.equal(owner.openBootstrap({ replacement: true }), null); assert.ok(inner);
    assert.equal(inner.consumePermit({ operationId: inner.operationId, route }), true);
    assert.equal(owner.openBootstrap({}), null); owner.cancel();
});

test('cancellation reentering owner clock cannot consume another cursor or attempt READ', async () => {
    const h = harness(); await h.bootstrap();
    const now = h.clock.now; let calls = 0;
    h.clock.now = () => { if (++calls === 2) h.owner.cancel(); return now(); };
    h.clock.fire(); await flush();
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.owner.status().attempts, 0);
    assert.equal(h.requests.length, 0); assert.equal(h.owner.status().cursor, 'INVALID');
});

test('owner independently rejects mismatched private envelope and unsupported bootstrap mode', async () => {
    for (const change of [raw => { raw.operationId = '2'.repeat(32); },
        raw => { raw.route = { ...route, documentId: '01234567-89ab-cdef-0123-456789abcdee' }; },
        raw => { raw.result.mode = 'replay'; }, raw => { raw.result.targetId = 'other'; },
        raw => { raw.result = { status: 'ERROR', stage: 'OWNER', code: 'DEADLINE_EXPIRED' }; }]) {
        const d = deferred(), h = harness({ inject: () => d.promise });
        const pending = h.courier().dispatch(); await flush();
        const raw = { version: 1, operationId: h.bridge.operationId, route: { ...route },
            result: { status: 'OK', source: 'C1', targetId: 'target', mode: 'live', continuation: 'initial', context: { client: { hl: 'en' } } } };
        change(raw); assert.equal(h.bridge.receive(raw), false); assert.equal(h.owner.status().phase, 'TERMINAL');
        d.resolve(h.extraction); await pending;
        assert.equal(h.owner.status().bootstrap, 'FAILED'); assert.equal(h.requests.length, 0);
    }
});

test('parsing then invalidation cannot emit batch or next cursor; existing normalized messages preserved', async () => {
    const h = harness(); await h.bootstrap(); h.clock.fire();
    const body = payload('next', 2500);
    body.continuationContents.liveChatContinuation.actions = [{ addChatItemAction: { item: {
        liveChatTextMessageRenderer: { id: 'synthetic', authorName: { simpleText: 'fixture' }, message: { runs: [{ text: 'fixture' }] } }
    } } }];
    h.requests[0].resolve(http(body)); await flush();
    assert.equal(h.batches[0][0].id, 'synthetic'); assert.equal(h.batches[0][0].messageType, 'text');
    assert.equal(Object.hasOwn(h.batches[0][0], 'replayOffsetMsec'), true);
    h.clock.set(2499); h.clock.fire(); assert.equal(h.requests.length, 1);
    const invalidated = harness(); await invalidated.bootstrap(); invalidated.clock.fire();
    const response = payload();
    Object.defineProperty(response.continuationContents.liveChatContinuation, 'actions', { get() {
        invalidated.facts.revision++; return [];
    } });
    invalidated.requests[0].resolve(http(response)); await flush();
    assert.equal(invalidated.batches.length, 0); assert.equal(invalidated.owner.status().accepted, 0);
    assert.equal(invalidated.owner.status().phase, 'TERMINAL');
});
