const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createLiveAcquisitionOwner: createOwner } = require('../src/acquisition-owner.js');
const { createBootstrapCourier } = require('../src/bootstrap-coordinator.js');
const cp = require('../src/replay-control-plane-core.js');
const core = require('../src/chat-read-core.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const route = { tabId: 1, frameId: 0, documentId: '01234567-89ab-cdef-0123-456789abcdef' };
const extensionId = 'a'.repeat(32);
function clock() {
    let now = 0, id = 0; const jobs = new Map();
    return { now: () => now, set: n => { now = n; }, jobs,
        setTimeout(fn, delay) { const k = ++id; jobs.set(k, { fn, due: now + delay }); return k; },
        clearTimeout(k) { jobs.delete(k); },
        fire() { let steps = 0; for (;;) { const job = [...jobs].find(([, v]) => v.due <= now);
            if (!job) return; if (++steps > 30) throw Error('unbounded wake'); jobs.delete(job[0]); job[1].fn(); } } };
}
function payload(offsets, next = 'seq1', seek = null) {
    const continuations = [{ liveChatReplayContinuationData: { continuation: next, timeUntilLastMessageMsec: 1000 } }];
    if (seek) continuations.push({ playerSeekContinuationData: { continuation: seek } });
    return { continuationContents: { liveChatContinuation: { continuations,
        actions: offsets.map((offset, i) => ({ replayChatItemAction: { videoOffsetTimeMsec: String(offset), actions: [
            { addChatItemAction: { item: { liveChatTextMessageRenderer: { id: `${next}-${i}`, message: { runs: [{ text: 'fixture' }] } } } } }
        ] } })) } } };
}
const http = body => ({ status: 200, json: async () => body });
function harness(options = {}) {
    const time = clock(), document = {}, facts = { document, video: {}, targetId: 'target', mode: 'replay',
        lifecycle: 1, revision: 1, generation: 1, owned: true, capability: true, clockCurrent: true,
        visible: true, ready: true, adActive: false, seeking: false, paused: false, ended: false,
        currentTime: options.currentTime || 0, duration: 600, playbackRate: 1, schedulerPendingCount: 0 };
    if (options.failReadTimer) { const original = time.setTimeout; time.setTimeout = (fn, delay) => {
        if (delay === 0) throw Error('timer unavailable'); return original(fn, delay);
    }; }
    const requests = [], creations = [], authorizations = [], batches = [], injections = [];
    const control = { ...cp,
        createReplayAuthority(input) {
            const original = cp.createReplayAuthority(options.stale && input.kind === 'BOOTSTRAP'
                ? { ...input, binding: { ...input.binding, revision: 99 } } : input);
            creations.push({ kind: input.kind, authority: original.authority });
            if (options.consume === input.kind && original.authority) cp.transitionAuthority(original.authority, 'CONSUME', input.binding);
            return original;
        },
        authorizeAuthorityRequest(input) { const value = cp.authorizeAuthorityRequest(input); authorizations.push(value); return value; }
    };
    const config = { document, route, readFacts: () => facts, clock: time, timers: time, core, control,
        entropy: bytes => bytes.fill(1), AbortController,
        transport: (url, init) => { const d = deferred(); requests.push({ url, init, ...d });
            const authorized = authorizations.filter(a => a.ok).at(-1);
            assert.ok(authorized); assert.equal(authorized.grant.diagnostic().state, 'CLAIMED');
            return d.promise;
        },
        onBatch: messages => { batches.push(messages); if (options.trackScheduler) facts.schedulerPendingCount += messages.length; } };
    const owner = createOwner(config), channel = { sender: { id: extensionId, tab: { id: 1 }, frameId: 0, documentId: route.documentId },
        onDisconnect: { addListener() {}, removeListener() {} }, postMessage: raw => bridge.receive(raw) };
    const bridge = owner.openBootstrap(channel);
    const scripting = { executeScript(args) {
        injections.push(args);
        const root = { isConnected: true, data: { currentVideoEndpoint: { watchEndpoint: { videoId: 'target' } }, contents: {
            twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: { isReplay: true,
                continuations: [{ reloadContinuationData: { continuation: 'initial' } }] } } } } } };
        const doc = { querySelector: () => root }; root.ownerDocument = doc;
        const result = vm.runInNewContext(`(${args.func.toString()})()`, { document: doc, window: { INNERTUBE_CONTEXT: { hl: 'en' } } });
        const values = [{ frameId: 0, documentId: route.documentId, result }];
        return options.inject ? options.inject(values) : Promise.resolve(values);
    } };
    return { owner, config, facts, time, requests, creations, authorizations, batches, injections,
        async bootstrap() { await createBootstrapCourier({ scripting, extensionId, channel, operationId: bridge.operationId,
            consumePermit: bridge.consumePermit }).dispatch(); time.fire(); },
        async answer(index, body) { requests[index].resolve(http(body)); await flush(); },
        async advance(now) { time.set(now); owner.synchronize(); time.fire(); await flush(); } };
}

test('aligned Bootstrap -> original Sequential: exact HTTP and consume/claim before fetch', async () => {
    const h = harness(); await h.bootstrap();
    assert.equal(h.requests.length, 1); assert.equal(h.creations[0].authority.diagnostic().authorityState, 'CONSUMED');
    const first = h.requests[0];
    assert.equal(first.url, '/youtubei/v1/live_chat/get_live_chat_replay?prettyPrint=false');
    assert.equal(first.init.method, 'POST'); assert.equal(first.init.credentials, 'omit');
    assert.deepEqual(first.init.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(first.init.body), { context: { client: { hl: 'en' } }, continuation: 'initial' });
    assert.equal(cp.claimAuthorityRequestGrant(h.authorizations[0].grant, 'BOOTSTRAP').ok, false);
    await h.answer(0, payload([0, 500]));
    assert.equal(h.owner.status().replayPhase, 'READING'); assert.equal(h.owner.status().accepted, 1);
    assert.equal(h.owner.status().alignmentUsed, false); assert.equal(h.batches.flat().length, 1);
    await h.advance(999); assert.equal(h.requests.length, 1);
    await h.advance(1000); assert.equal(h.requests.length, 2);
    assert.equal(JSON.parse(h.requests[1].init.body).continuation, 'seq1');
    assert.equal(h.creations.find(c => c.kind === 'SEQUENTIAL').authority.diagnostic().authorityState, 'CONSUMED');
    h.owner.synchronize(); h.time.fire(); assert.equal(h.requests.length, 2);
    assert.equal(h.injections.length, 1);
});

test('OUTSIDE and UNKNOWN Bootstrap use only one INITIAL_ALIGNMENT, old commits0, fresh handoff', async () => {
    for (const offsets of [[0, 1000], []]) {
        const h = harness({ currentTime: 30 }); await h.bootstrap();
        await h.answer(0, payload(offsets, 'old-seq', 'seek1'));
        assert.equal(h.owner.status().accepted, 0); assert.equal(h.batches.length, 0);
        assert.equal(h.creations.filter(c => c.kind === 'SEQUENTIAL').length, 0);
        h.time.fire(); await flush(); assert.equal(h.requests.length, 2);
        assert.equal(h.owner.status().alignmentUsed, true);
        assert.deepEqual(JSON.parse(h.requests[1].init.body), { context: { client: { hl: 'en' } }, continuation: 'seek1',
            currentPlayerState: { playerOffsetMs: 30000 } });
        h.owner.synchronize(); h.time.fire(); assert.equal(h.requests.length, 2);
        await h.answer(1, payload([30000, 30500], 'fresh-seq', 'seek2'));
        assert.equal(h.owner.status().replayPhase, 'READING'); assert.equal(h.owner.status().accepted, 1);
        assert.equal(h.batches.flat().some(m => m.id.startsWith('old-seq')), false);
        h.time.fire(); await flush(); assert.equal(h.requests.length, 3);
        assert.equal(JSON.parse(h.requests[2].init.body).continuation, 'fresh-seq');
        assert.equal(Object.hasOwn(JSON.parse(h.requests[2].init.body), 'currentPlayerState'), false);
        assert.equal(h.injections.length, 1);
    }
});

test('missing/consumed initial alignment Authority and consumed/stale Bootstrap fail closed', async () => {
    for (const options of [{}, { consume: 'REANCHOR' }]) {
        const h = harness({ currentTime: 30, ...options }); await h.bootstrap();
        await h.answer(0, payload([0], 'old', options.consume ? 'seek' : null));
        h.time.set(20000); h.time.fire();
        assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.requests.length, 1);
        assert.equal(h.batches.length, 0); assert.equal(h.owner.status().accepted, 0);
    }
    for (const options of [{ consume: 'BOOTSTRAP' }, { stale: true }]) {
        const h = harness(options); await h.bootstrap(); assert.equal(h.requests.length, 0);
        assert.equal(h.owner.status().phase, 'TERMINAL');
    }
});

test('failed/stale alignment never creates Sequential or another READ', async () => {
    for (const stale of [false, true]) {
        const h = harness({ currentTime: 30 }); await h.bootstrap();
        await h.answer(0, payload([0], 'old', 'seek')); h.time.fire(); await flush();
        if (stale) h.facts.revision++;
        await h.answer(1, payload(stale ? [30000] : [0], 'not-fresh'));
        h.time.set(20000); h.owner.synchronize(); h.time.fire();
        assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.requests.length, 2);
        assert.equal(h.creations.filter(c => c.kind === 'SEQUENTIAL').length, 0); assert.equal(h.batches.length, 0);
    }
});

test('fresh alignment Sequential handoff precedes read-ahead defer even for sparse future response', async () => {
    const h = harness({ currentTime: 30 }); await h.bootstrap();
    await h.answer(0, payload([0], 'old', 'seek')); h.time.fire(); await flush();
    await h.answer(1, payload([60000], 'fresh'));
    h.time.fire(); await flush();
    assert.equal(h.requests.length, 3);
    assert.equal(JSON.parse(h.requests[2].init.body).continuation, 'fresh');
    assert.equal(h.owner.status().readAheadDeferred, false);
});

test('invalid Replay response, repeated token, Abort and timeout stay terminal', async () => {
    for (const body of [{}, payload([0], 'initial')]) {
        const h = harness(); await h.bootstrap(); await h.answer(0, body);
        assert.equal(h.owner.status().phase, 'TERMINAL'); h.time.set(100000); h.time.fire(); assert.equal(h.requests.length, 1);
    }
    for (const cancel of [true, false]) {
        const h = harness(); await h.bootstrap();
        if (cancel) h.owner.cancel(); else { h.time.set(15000); h.time.fire(); }
        assert.equal(h.requests[0].init.signal.aborted, true); assert.equal(h.owner.status().inFlight, true);
        await h.answer(0, payload([0], 'late', 'seek'));
        assert.equal(h.owner.status().accepted, 0); assert.equal(h.owner.status().inFlight, false);
        assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
    }
});

test('actual temporal selection bounds capacity, preserves due/future, normal resume precedence', async () => {
    const h = harness({ trackScheduler: true }); await h.bootstrap();
    await h.answer(0, payload([0, ...Array.from({ length: 110 }, (_, i) => 1000 + i * 1000)]));
    assert.equal(h.owner.status().pending, 100); assert.equal(h.owner.status().temporalDropped, 10);
    assert.equal(h.owner.status().replayPhase, 'BUFFER_PAUSED'); assert.equal(h.batches.flat().length, 1);
    h.facts.currentTime = 60; await h.advance(1000);
    assert.ok(h.owner.status().pending <= 50); assert.equal(h.requests.length, 2);
    assert.equal(h.owner.status().earlyResumeBudgetUsed, 0);
    assert.equal(h.creations.filter(c => c.kind === 'BOOTSTRAP').length, 1);
});

test('early resume consumes saved original once per runway depletion, then pauses again', async () => {
    const h = harness({ trackScheduler: true }); await h.bootstrap();
    const offsets = [0, ...Array.from({ length: 30 }, (_, i) => (i + 1) * 1000),
        ...Array.from({ length: 70 }, (_, i) => 80000 + i * 100)];
    await h.answer(0, payload(offsets));
    h.facts.currentTime = 30.1; await h.advance(1000);
    assert.equal(h.owner.status().pending, 70); assert.equal(h.requests.length, 1);
    h.facts.schedulerPendingCount = 0; await h.advance(1000);
    assert.equal(h.requests.length, 2); assert.equal(h.owner.status().earlyResumeBudgetUsed, 1);
    await h.answer(1, payload([90000], 'seq2'));
    assert.equal(h.owner.status().replayPhase, 'BUFFER_PAUSED'); assert.equal(h.owner.status().pending, 71);
    await h.advance(10000); h.owner.synchronize(); h.time.fire();
    assert.equal(h.requests.length, 2); assert.equal(h.injections.length, 1);
});

test('read-ahead defers unused Sequential and resumes only when player-relative horizon allows', async () => {
    const h = harness(); await h.bootstrap(); await h.answer(0, payload([20000]));
    assert.equal(h.owner.status().readAheadDeferred, true); assert.equal(h.requests.length, 1);
    await h.advance(1000); assert.equal(h.requests.length, 1);
    h.facts.currentTime = 11; await h.advance(1000);
    assert.equal(h.requests.length, 2); assert.equal(h.owner.status().readAheadDeferred, false);
    assert.equal(JSON.parse(h.requests[1].init.body).continuation, 'seq1');
    assert.equal(h.owner.status().alignmentUsed, false);
});

test('same owner lifetime covers Live/Replay; deferred producers and forged commands inactive', async () => {
    const h = harness(); await h.bootstrap();
    assert.equal(createOwner({ ...h.config, readFacts: () => ({ ...h.facts, mode: 'live' }) }), null);
    for (const reason of ['SEEK', 'AD_EXIT', 'FOREGROUND', 'COVERAGE_HOLE']) {
        h.owner.synchronize({ reason, type: 'REANCHOR', playerOffsetMs: 1 });
    }
    assert.equal(h.requests.length, 1); assert.equal(h.owner.status().alignmentUsed, false);
    h.facts.mode = 'live'; h.owner.synchronize();
    await h.answer(0, payload([0], 'late')); assert.equal(h.owner.status().accepted, 0);
    assert.equal(h.owner.openBootstrap({}), null); assert.equal(h.requests.length, 1);
});

test('future pending continues to become due during an in-flight Sequential request', async () => {
    const h = harness(); await h.bootstrap(); await h.answer(0, payload([0, 5000]));
    await h.advance(1000); assert.equal(h.requests.length, 2);
    const bridged = h.batches.flat().length;
    h.facts.currentTime = 5; h.owner.synchronize();
    assert.equal(h.batches.flat().length, bridged + 1); assert.equal(h.owner.status().pending, 0);
    assert.equal(h.owner.status().inFlight, true); assert.equal(h.requests.length, 2);
    h.owner.synchronize(); assert.equal(h.batches.flat().length, bridged + 1);
    h.owner.cancel(); await h.answer(1, payload([5000], 'late'));
    assert.equal(h.owner.status().accepted, 1); assert.equal(h.requests.length, 2);
});

test('unknown Scheduler evidence cannot authorize early resume', async () => {
    const h = harness({ trackScheduler: true }); await h.bootstrap();
    await h.answer(0, payload([0, ...Array.from({ length: 30 }, (_, i) => 1000 + i * 1000),
        ...Array.from({ length: 70 }, (_, i) => 80000 + i * 100)]));
    h.facts.currentTime = 30.1; await h.advance(1000);
    h.facts.schedulerPendingCount = undefined; await h.advance(1000);
    assert.equal(h.requests.length, 1); assert.equal(h.owner.status().earlyResumeBudgetUsed, 0);
});

test('Replay H5 final deadline rejects before creating original Bootstrap Authority', async () => {
    const d = deferred(); let result;
    const h = harness({ inject: values => { result = values; return d.promise; } });
    const pending = h.bootstrap(); await flush();
    h.time.set(5000); h.time.fire(); d.resolve(result); await pending;
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.owner.status().replayPhase, 'STOPPED');
    assert.equal(h.creations.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.injections.length, 1);
});

test('HTTP and JSON failures do not create a fresh chain', async () => {
    for (const response of [{ status: 503 }, { status: 200, json: async () => { throw Error('fixture'); } }]) {
        const h = harness(); await h.bootstrap(); h.requests[0].resolve(response); await flush();
        assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.creations.length, 1);
        assert.equal(h.owner.status().accepted, 0); assert.equal(h.injections.length, 1);
    }
});

test('unavailable owned read timer fails closed without reinjection or READ', async () => {
    const h = harness({ failReadTimer: true }); await h.bootstrap();
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.owner.status().reason, 'TIMER_FAILED');
    h.owner.synchronize(); assert.equal(h.requests.length, 0); assert.equal(h.injections.length, 1);
    assert.equal(h.owner.openBootstrap({}), null);
});
