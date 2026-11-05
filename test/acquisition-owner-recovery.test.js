'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { fixture } = require('./fixtures/native-facts-dom.js');
const { createLiveAcquisitionOwner: createOwner } = require('../src/acquisition-owner.js');
const { createBootstrapCourier } = require('../src/bootstrap-coordinator.js');
const cp = require('../src/replay-control-plane-core.js');
const core = require('../src/chat-read-core.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
function payload(offsets, next = 'seq1', seek = 'seek1') {
    const continuations = [{ liveChatReplayContinuationData: { continuation: next, timeUntilLastMessageMsec: 1000 } }];
    if (seek) continuations.push({ playerSeekContinuationData: { continuation: seek } });
    return { continuationContents: { liveChatContinuation: { continuations, actions: offsets.map((offset, i) => ({
        replayChatItemAction: { videoOffsetTimeMsec: String(offset), actions: [{ addChatItemAction: { item: {
            liveChatTextMessageRenderer: { id: `${next}-${i}`, message: { runs: [{ text: 'fixture' }] } }
        } } }] }
    })) } } };
}
function harness(options = {}) {
    const f = fixture();
    if (options.childURL) f.value(f.child).url = options.childURL;
    if (options.position !== undefined) f.value(f.video).position = options.position;
    if (options.unready) f.value(f.video).readyState = 1;
    let now = 0, id = 0, scheduler = 0, active = 0, maxActive = 0;
    const jobs = new Map(), requests = [], batches = [], handles = [], grants = [], injections = [];
    const time = { now: () => now, setTimeout(fn, delay) { const key = ++id; jobs.set(key, { fn, due: now + delay }); return key; },
        clearTimeout: key => jobs.delete(key), fire() {
            for (let steps = 0;; steps++) {
                const job = [...jobs].find(([, v]) => v.due <= now);
                if (!job) break; assert.ok(steps < 30, 'bounded timer work');
                jobs.delete(job[0]); job[1].fn();
            }
        } };
    const control = { ...cp,
        createReplayAuthority(input) {
            const result = cp.createReplayAuthority(options.stale === input.kind ? { ...input, binding: { ...input.binding, revision: 99 } } : input);
            handles.push({ kind: input.kind, authority: result.authority });
            if (options.consume === input.kind && result.authority) cp.transitionAuthority(result.authority, 'CONSUME', input.binding);
            return result;
        },
        authorizeAuthorityRequest(input) {
            const result = cp.authorizeAuthorityRequest(input); grants.push(result);
            if (input.expectedKind === 'REANCHOR' && options.beforeClaim) options.beforeClaim(f);
            return result;
        }
    };
    const config = { document: f.document, route: f.options.route, nativeFacts: f.options, clock: time, timers: time,
        replayAssociationPolicy: options.replayAssociationPolicy,
        readPendingCount: () => options.unknownScheduler ? undefined : scheduler,
        core, control, entropy: bytes => bytes.fill(2), AbortController,
        onBatch: messages => { batches.push(messages); scheduler += messages.length; },
        transport(url, init) {
            assert.equal(grants.filter(x => x.ok).at(-1).grant.diagnostic().state, 'CLAIMED');
            assert.equal(cp.claimAuthorityRequestGrant(grants.filter(x => x.ok).at(-1).grant, 'REANCHOR').ok, false);
            let resolve, reject;
            active++; maxActive = Math.max(maxActive, active);
            const promise = new Promise((a, b) => { resolve = a; reject = b; });
            requests.push({ url, init, resolve, reject });
            return promise.finally(() => active--);
        } };
    const owner = createOwner(config); assert.ok(owner);
    let bridge;
    const extensionId = 'a'.repeat(32), channel = { sender: { id: extensionId, tab: { id: 7 }, frameId: 0, documentId: f.options.route.documentId },
        onDisconnect: { addListener() {}, removeListener() {} }, postMessage: envelope => {
            if (options.loseDelivery) bridge.lost();
            bridge.receive(envelope);
        } };
    const scripting = { executeScript(args) {
        injections.push(args);
        const root = { isConnected: true, data: { currentVideoEndpoint: { watchEndpoint: { videoId: 'target' } },
            contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: { isReplay: true,
                continuations: [{ reloadContinuationData: { continuation: 'bootstrap' } }] } } } } } };
        const document = { querySelector: () => root }; root.ownerDocument = document;
        const result = vm.runInNewContext(`(${args.func.toString()})()`, { document, window: { INNERTUBE_CONTEXT: { hl: 'en' } } });
        return Promise.resolve([{ frameId: 0, documentId: f.options.route.documentId, result }]);
    } };
    return { f, owner, config, time, requests, batches, handles, grants, injections,
        stats: () => ({ maxActive, active }), drain: () => { scheduler = 0; },
        async bootstrap() {
            bridge = owner.openBootstrap(channel); if (!bridge) return false;
            await createBootstrapCourier({ scripting, extensionId, channel, operationId: bridge.operationId,
                consumePermit: bridge.consumePermit }).dispatch(); time.fire(); await flush(); return true;
        },
        lose: () => bridge.lost(),
        async answer(i, body) { requests[i].resolve({ status: 200, json: async () => body }); await flush(); },
        async tick(value = now) { now = value; owner.synchronize(); time.fire(); await flush(); },
        ad(on) { f.value(f.player).classes = new Set(on ? ['ad-showing'] : []); owner.synchronize(); },
        hidden(on) { Object.assign(f.value(f.document), { hidden: on, visibility: on ? 'hidden' : 'visible' }); owner.synchronize(); },
        seeking(on, position) { f.value(f.video).seeking = on; if (position !== undefined) f.value(f.video).position = position; owner.synchronize(); }
    };
}
async function admitted(options) {
    const h = harness(options); await h.bootstrap(); await h.answer(0, payload([0, 500])); return h;
}
function fixedReanchor(request, token, offset) {
    assert.equal(request.url, '/youtubei/v1/live_chat/get_live_chat_replay?prettyPrint=false');
    assert.equal(request.init.method, 'POST'); assert.equal(request.init.credentials, 'omit');
    assert.deepEqual(request.init.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(request.init.body), { context: { client: { hl: 'en' } }, continuation: token,
        currentPlayerState: { playerOffsetMs: offset } });
}

test('typed native WAIT preserves unused prepermit; UNKNOWN never falls back to flat facts', async () => {
    const h = harness({ unready: true }); assert.equal(await h.bootstrap(), false);
    assert.equal(h.owner.status().permit, 'UNUSED'); assert.equal(h.injections.length, 0);
    h.f.value(h.f.video).readyState = 4; assert.equal(await h.bootstrap(), true);
    await h.answer(0, payload([0]));
    h.config.readFacts = () => ({ owned: true }); // Cannot become a runtime fallback.
    h.f.value(h.f.child).url = 'https://www.youtube.com/live_chat_replay';
    await h.tick(1000);
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.requests.length, 1);
});

test('real native SEEK history queues one original REANCHOR and fresh Sequential handoff', async () => {
    const h = await admitted(); h.seeking(true); h.seeking(true); h.seeking(false, 20);
    await h.tick(); assert.equal(h.requests.length, 2); assert.equal(h.owner.status().lastReanchor, 'SEEK');
    assert.equal(h.owner.status().seekEpoch, 1); fixedReanchor(h.requests[1], 'seek1', 20000);
    await h.answer(1, payload([20000, 20500], 'fresh', 'seek2')); await h.tick();
    assert.equal(h.requests.length, 3); assert.equal(h.owner.status().replayPhase, 'READING');
    assert.equal(JSON.parse(h.requests[2].init.body).continuation, 'fresh'); assert.equal(h.injections.length, 1);
    assert.equal(h.stats().maxActive, 1);
});

test('INITIAL_ALIGNMENT remains one-shot with actual native facts and common executor', async () => {
    const h = harness({ position: 30 }); await h.bootstrap(); await h.answer(0, payload([0], 'old', 'seek1'));
    await h.tick(); assert.equal(h.owner.status().lastReanchor, 'INITIAL_ALIGNMENT');
    assert.equal(h.batches.length, 0); fixedReanchor(h.requests[1], 'seek1', 30000);
    await h.answer(1, payload([30000], 'fresh', 'seek2')); await h.tick();
    assert.equal(h.requests.length, 3); assert.equal(h.owner.status().alignmentUsed, true);
});

for (const readinessFirst of [true, false]) test(`AD exit/readiness order (${readinessFirst}) recovers once from current facts`, async () => {
    const h = await admitted(); h.ad(true); h.ad(true);
    assert.equal(h.owner.status().suspendedReason, 'AD');
    h.f.value(h.f.video).readyState = 1;
    if (readinessFirst) {
        h.f.value(h.f.video).readyState = 4; h.owner.synchronize({ type: 'AD_EXIT' });
        assert.equal(h.requests.length, 1); h.ad(false);
    } else { h.ad(false); assert.equal(h.requests.length, 1); h.f.value(h.f.video).readyState = 4; }
    await h.tick(); assert.equal(h.requests.length, 2); assert.equal(h.owner.status().lastReanchor, 'AD_EXIT');
    h.owner.synchronize({ type: 'AD_EXIT' }); await h.tick(); assert.equal(h.requests.length, 2);
    await h.answer(1, payload([0, 500], 'fresh', 'seek2')); await h.tick();
    assert.equal(h.requests.length, 3); assert.equal(h.owner.status().replayPhase, 'READING');
});

test('completed FOREGROUND clears active lifetime; next ordinary AD preserves new unused Authority', async () => {
    const h = await admitted(); h.hidden(true); h.hidden(true); h.hidden(false); await h.tick();
    assert.equal(h.owner.status().lastReanchor, 'FOREGROUND'); assert.equal(h.owner.status().foregroundActive, true);
    await h.answer(1, payload([0, 500], 'fresh', 'seek2'));
    assert.equal(h.owner.status().foregroundActive, false); assert.equal(h.owner.status().foregroundResult, 'SUCCESS');
    h.ad(true); h.ad(false); await h.tick();
    assert.equal(h.owner.status().lastReanchor, 'AD_EXIT'); assert.equal(h.requests.length, 3);
    fixedReanchor(h.requests[2], 'seek2', 0);
});

test('AD during active FOREGROUND aborts; no grant restoration or stale response handoff', async () => {
    const h = await admitted(); h.hidden(true); h.hidden(false); await h.tick(); h.ad(true);
    assert.equal(h.requests[1].init.signal.aborted, true); assert.equal(h.owner.status().foregroundActive, false);
    h.ad(false); await h.tick(); assert.equal(h.requests.length, 2);
    await h.answer(1, payload([0], 'late', 'late-seek')); await h.tick();
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.requests.length, 2);
    assert.equal(h.handles.some(x => x.kind === 'SEQUENTIAL' && x.authority.diagnostic().authorityState === 'OBSERVED_UNUSED'), false);
});

test('MEDIA_PLAY only resumes MEDIA_PAUSED; duplicates and forged AD/HIDDEN play are inert', async () => {
    const h = await admitted(); h.f.value(h.f.video).paused = true; h.owner.synchronize();
    assert.equal(h.owner.status().suspendedReason, 'MEDIA_PAUSED');
    h.f.value(h.f.video).paused = false; h.owner.synchronize(); h.owner.synchronize();
    assert.equal(h.owner.status().replayPhase, 'READING'); assert.equal(h.requests.length, 1);
    h.ad(true); h.owner.synchronize({ type: 'play', paused: false });
    assert.equal(h.owner.status().suspendedReason, 'AD');
    h.hidden(true); h.owner.synchronize({ type: 'play', visible: true });
    assert.equal(h.owner.status().suspendedReason, 'HIDDEN'); assert.equal(h.requests.length, 1);
});

test('COVERAGE_HOLE retains bounded pending, merges repair and recomputes fresh progression', async () => {
    const h = harness(); await h.bootstrap(); await h.answer(0, payload([0, 60000]));
    assert.equal(h.owner.status().pending, 1); h.drain(); await h.tick();
    assert.equal(h.owner.status().lastReanchor, 'COVERAGE_HOLE'); fixedReanchor(h.requests[1], 'seek1', 0);
    assert.equal(h.owner.status().pending, 1);
    await h.answer(1, payload([0, 500], 'fresh', 'seek2')); await h.tick();
    assert.equal(h.owner.status().pending, 2); assert.equal(h.owner.status().temporalReplaced, 0);
    assert.equal(h.owner.status().replayPhase, 'READING'); assert.equal(h.requests.length, 3);
});

test('unknown Scheduler cannot authorize repair; NO_PROGRESS spends one coverage episode', async () => {
    const unknown = harness({ unknownScheduler: true }); await unknown.bootstrap(); await unknown.answer(0, payload([0, 60000]));
    await unknown.tick(); assert.equal(unknown.requests.length, 1);
    const h = harness(); await h.bootstrap(); await h.answer(0, payload([0, 60000])); h.drain(); await h.tick();
    await h.answer(1, payload([70000], 'fresh', 'seek2')); await h.tick();
    assert.equal(h.owner.status().coverageEpisodeSpent, true);
    assert.equal(h.requests.filter(r => JSON.parse(r.init.body).currentPlayerState).length, 1);
});

test('ordinary recovery replaces old pending while native rate changes do not grant or seek', async () => {
    const h = await admitted(); h.f.value(h.f.video).rate = 2; h.owner.synchronize();
    assert.equal(h.owner.status().seekEpoch, 0); assert.equal(h.requests.length, 1);
    h.seeking(true); h.seeking(false, 20); await h.tick();
    assert.equal(h.owner.status().pending, 0); assert.equal(h.owner.status().temporalReplaced, 1);
});

test('SEEK preempts coverage request, retains flight lock and never replays a consumed cursor', async () => {
    const h = harness(); await h.bootstrap(); await h.answer(0, payload([0, 60000])); h.drain(); await h.tick();
    h.seeking(true); h.seeking(false, 10); await h.tick();
    assert.equal(h.requests.length, 2); assert.equal(h.requests[1].init.signal.aborted, true);
    await h.answer(1, payload([10000], 'late', 'late-seek')); await h.tick();
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.requests.length, 2); assert.equal(h.stats().maxActive, 1);
});

for (const negative of ['missing', 'stale', 'consumed']) test(`${negative} REANCHOR Authority stays request0 on recovery`, async () => {
    const h = harness(negative === 'missing' ? {} : { [negative === 'stale' ? 'stale' : 'consume']: 'REANCHOR' });
    await h.bootstrap(); await h.answer(0, payload([0, 500], 'seq1', negative === 'missing' ? null : 'seek1'));
    h.ad(true); h.ad(false); await h.tick();
    assert.equal(h.requests.length, 1); assert.equal(h.owner.status().phase, 'TERMINAL');
});

test('actual target/mode/video/child Document binding changes terminate without rearm', async () => {
    for (const change of ['target', 'mode', 'video', 'child']) {
        const h = await admitted();
        if (change === 'target') h.f.value(h.f.document).url = 'https://www.youtube.com/watch?v=other';
        if (change === 'mode') h.f.value(h.f.child).url = 'https://www.youtube.com/live_chat?v=target';
        if (change === 'video') h.f.value(h.f.video).connected = false;
        if (change === 'child') h.f.value(h.f.frame).child = new h.f.realm.Document({ url: h.f.value(h.f.child).url });
        await h.tick(); assert.equal(h.owner.status().phase, 'TERMINAL');
        assert.equal(h.owner.openBootstrap({}), null); assert.equal(h.requests.length, 1); assert.equal(h.injections.length, 1);
    }
});

test('worker loss cannot rearm, no public raw output, no MAIN/Worker HTTP', async () => {
    const h = harness({ loseDelivery: true }); await h.bootstrap(); h.lose(); await h.tick(6000);
    assert.equal(h.owner.openBootstrap({}), null); assert.equal(h.injections.length, 1);
    assert.equal(h.owner.status().reason, 'DELIVERY_LOST'); assert.equal(createOwner(h.config), null);
    assert.equal(h.handles.length, 0);
    const status = JSON.stringify(h.owner.status());
    assert.doesNotMatch(status, /continuation|context|seek1|documentId|hl/);
    assert.equal(h.f.counts().forbidden, 0);
    assert.equal(h.requests.length, 0);
});

test('native currentness is rechecked after authorization, before original grant claim', async () => {
    const h = await admitted({ beforeClaim: f => { f.value(f.child).url = 'https://www.youtube.com/live_chat_replay'; } });
    h.ad(true); h.ad(false); await h.tick();
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.requests.length, 1);
    assert.notEqual(h.grants.filter(x => x.ok).at(-1).grant.diagnostic().state, 'CLAIMED');
});

test('actual child replacement during response parsing creates no fresh Sequential or commit', async () => {
    const h = await admitted(); h.ad(true); h.ad(false); await h.tick();
    h.requests[1].resolve({ status: 200, json: async () => {
        h.f.value(h.f.frame).child = new h.f.realm.Document({ url: h.f.value(h.f.child).url });
        return payload([0], 'forbidden', 'forbidden-seek');
    } });
    await flush(); await h.tick();
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.owner.status().accepted, 1);
    assert.equal(h.handles.filter(x => x.kind === 'SEQUENTIAL').length, 1); assert.equal(h.requests.length, 2);
});

test('queued AD recovery followed by actual SEEK uses the unused original once for latest offset', async () => {
    const h = await admitted(); h.ad(true); h.ad(false);
    h.seeking(true); h.seeking(false, 20); await h.tick();
    assert.equal(h.owner.status().lastReanchor, 'SEEK'); assert.equal(h.requests.length, 2);
    fixedReanchor(h.requests[1], 'seek1', 20000);
});

test('foreground supersedes queued coverage before consumption, with no second opportunity', async () => {
    const h = harness(); await h.bootstrap(); await h.answer(0, payload([0, 60000])); h.drain(); h.owner.synchronize();
    assert.equal(h.owner.status().recovery, 'COVERAGE_HOLE');
    h.hidden(true); h.hidden(false); await h.tick();
    assert.equal(h.owner.status().lastReanchor, 'FOREGROUND'); assert.equal(h.requests.length, 2);
    fixedReanchor(h.requests[1], 'seek1', 0);
});

test('hide aborts Sequential; late finalizer releases only its ticket before foreground recovery', async () => {
    const h = await admitted(); await h.tick(1000); assert.equal(h.requests.length, 2);
    h.hidden(true); h.hidden(false); await h.tick();
    assert.equal(h.requests.length, 2); assert.equal(h.owner.status().inFlight, true);
    assert.equal(h.requests[1].init.signal.aborted, true);
    h.requests[1].reject(new Error('AbortError')); await flush(); await h.tick();
    assert.equal(h.requests.length, 3); assert.equal(h.owner.status().lastReanchor, 'FOREGROUND');
    assert.equal(h.owner.status().accepted, 1); assert.equal(h.stats().maxActive, 1);
    fixedReanchor(h.requests[2], 'seek1', 0);
});

test('native temporal due/future capacity and normal saved-Sequential resume stay bounded', async () => {
    const h = harness(); await h.bootstrap();
    await h.answer(0, payload([0, ...Array.from({ length: 102 }, (_, i) => (i + 1) * 1000)]));
    assert.equal(h.owner.status().pending, 100); assert.equal(h.owner.status().temporalDropped, 2);
    assert.equal(h.owner.status().replayPhase, 'BUFFER_PAUSED');
    h.f.value(h.f.video).position = 60; await h.tick(1000);
    assert.equal(h.owner.status().pending, 40); assert.equal(h.requests.length, 2);
    assert.equal(JSON.parse(h.requests[1].init.body).continuation, 'seq1');
    assert.equal(Object.hasOwn(JSON.parse(h.requests[1].init.body), 'currentPlayerState'), false);
});

test('native currentness loss during resource setup cannot dispatch after terminality', async () => {
    const h = await admitted(), original = h.time.setTimeout;
    h.time.setTimeout = (fn, delay) => {
        if (delay === 15000) h.owner.cancel();
        return original(fn, delay);
    };
    h.ad(true); h.ad(false); await h.tick();
    assert.equal(h.owner.status().phase, 'TERMINAL'); assert.equal(h.requests.length, 1);
});

test('sparse ordinary REANCHOR response hands off fresh Sequential before coverage repair', async () => {
    const h = await admitted(); h.drain(); h.seeking(true); h.seeking(false, 20); await h.tick();
    await h.answer(1, payload([80000], 'fresh', 'seek2')); await h.tick();
    assert.equal(h.requests.length, 3); assert.equal(JSON.parse(h.requests[2].init.body).continuation, 'fresh');
    assert.equal(Object.hasOwn(JSON.parse(h.requests[2].init.body), 'currentPlayerState'), false);
    assert.equal(h.owner.status().lastReanchor, 'SEEK');
});

test('native early resume keeps the original one-advance runway episode budget', async () => {
    const h = harness(); await h.bootstrap();
    await h.answer(0, payload([0, ...Array.from({ length: 30 }, (_, i) => (i + 1) * 1000),
        ...Array.from({ length: 70 }, (_, i) => 80000 + i * 100)]));
    h.f.value(h.f.video).position = 30.1; await h.tick(1000);
    assert.equal(h.owner.status().pending, 70); assert.equal(h.requests.length, 1);
    h.drain(); await h.tick(); assert.equal(h.requests.length, 2);
    assert.equal(h.owner.status().earlyResumeBudgetUsed, 1);
    await h.answer(1, payload([90000], 'seq2', 'seek2')); await h.tick(10000);
    assert.equal(h.owner.status().replayPhase, 'BUFFER_PAUSED'); assert.equal(h.requests.length, 2);
});
