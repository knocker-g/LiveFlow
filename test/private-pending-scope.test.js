'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pending = require('../src/pending-selection.js');
const { createSchedulerRuntime } = require('../src/scheduler-runtime.js');
const scopeCore = require('../src/diagnostic-scope-core.js');
const { createGeometryAuthority, createSubtitleGeometryAdapter } = require('../src/geometry-adapter.js');
const { createPrivatePendingScope } = require('../src/private-pending-scope.js');
const { createLiveAcquisitionOwner } = require('../src/acquisition-owner.js');
const core = require('../src/chat-read-core.js');
const control = require('../src/replay-control-plane-core.js');
const { fixture } = require('./fixtures/native-facts-dom.js');
const route = { tabId: 7, frameId: 0, documentId: '12345678-1234-1234-1234-123456789abc' };

function harness(options = {}) {
    const document = options.document || {}, callbacks = new Map(), events = [];
    const active = new Map(); let sequence = 0, runtime;
    const binding = Object.freeze({ document, targetId: 'target', lifecycle: 0, revision: 0 });
    const port = createPrivatePendingScope({ document, route, targetId: 'target', lifecycle: 0, revision: 0,
        pending, scopeCore,
        createRuntime(config) {
            const observe = config.observe;
            runtime = createSchedulerRuntime({ ...config, observe(event) {
                if (options.dropObserver && event.type === 'PENDING_OWNER_REMOVED') return;
                observe(options.wrongObserver && event.type === 'PENDING_OWNER_REMOVED' ? { ...event, count: event.count + 1 } : event);
            } });
            if (options.throwRemoval) return { ...runtime, removePendingOwner() { throw Error('unavailable'); } };
            return runtime;
        },
        runtimeOptions: { clock: () => 0, generation: () => 1,
            geometryAdapter: createSubtitleGeometryAdapter({ authority: createGeometryAuthority({ epsilon: 1 }),
                readGeometry: () => ({ state: 'KNOWN_EMPTY', exclusionRegions: [], capabilityAvailable: true }) }),
            scheduleOneShot(fn) { callbacks.set(++sequence, fn); return sequence; },
            cancelOneShot(id) { callbacks.delete(id); },
            candidateProof: () => options.launch ? { candidates: [{ rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 100 } }], activeComments: [] } : null,
            launch(payload) {
                const node = { isConnected: true, remove() { throw Error('active DOM removal'); } };
                const animation = { currentTime: 50, cancel() { throw Error('active animation cancellation'); } };
                active.set(payload.id, { node, animation }); return true;
            },
            observe(event) { events.push(event); if (options.onEvent) options.onEvent(event); },
            config: { maxPendingAge: 1000, maxPendingCount: 20, pendingPressureCapacity: 5,
                scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
                pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: .75 },
                density: { attackThresholds: [.5, .7, .9], releaseThresholds: [.2, .3, .4], minimumAttackResidence: 1, releaseDwell: 3 },
                collisionAllowances: Object.fromEntries(['CONSERVATIVE', 'LIMITED_CATCH_UP', 'BOUNDED_OVERLAP', 'MAXIMUM_READABLE_RESCUE'].map(name => [name, {
                    nominalGap: 20, hardMinimumSeparation: -10, maxCatchUpRatio: .5,
                    maxOverlapDuration: 1, maxOverlapDepthRatio: .2, minimumVisibleFraction: .8
                }])) }
        } });
    assert.ok(port);
    const view = options.ownerConnect ? null : port.connect(binding, route);
    const itemOptions = id => ({ id, enqueuedAt: 0, rendererType: 'liveChatTextMessageRenderer', footprint: {} });
    return { port, view, binding, callbacks, events, active, runtime: () => runtime,
        enqueue: (handle, id) => port.presentation.enqueue(handle, { id }, itemOptions(id)), itemOptions,
        tick() { const [id, fn] = callbacks.entries().next().value; callbacks.delete(id); fn(); } };
}
const last = view => view.status().scopes.at(-1);

test('exact pending owner removal uses real Runtime count and private tally, preserves survivor order and credit', () => {
    const h = harness(), a = h.view.open(); h.enqueue(a, 'a1'); h.enqueue(a, 'a2');
    const op = h.view.retire(a), b = h.view.open(); h.enqueue(b, 'b1'); h.enqueue(b, 'b2');
    const before = h.runtime().queue.snapshot(), timers = [...h.callbacks];
    const r = h.view.remove(op);
    assert.deepEqual(r, { status: 'APPLIED', count: 2, proof: 'VERIFIED' });
    assert.deepEqual(h.runtime().queue.snapshot(), before.slice(2)); assert.deepEqual([...h.callbacks], timers);
    assert.equal(h.runtime().queue.successfulLaunchSequence(), 0);
    const archive = h.view.status().scopes[0];
    assert.equal(archive.removed, 2); assert.equal(archive.observed, 2); assert.equal(archive.pendingProof, 'VERIFIED');
    assert.equal(archive.state, 'INCOMPLETE'); assert.equal(archive.accounting, 'UNKNOWN');
    assert.equal(h.port.presentation.pendingCount(b), 2); assert.equal(h.events.filter(e => e.type === 'PENDING_OWNER_REMOVED').length, 1);
});

test('actual pending helper invalidates survivor selection nonce, without spending launch credit', () => {
    const h = harness(), a = h.view.open(); h.enqueue(a, 'a'); const op = h.view.retire(a);
    const b = h.view.open(); h.enqueue(b, 'b');
    const q = h.runtime().queue, selection = q.evaluate({ scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
        isSafe: () => true, policy: { select: candidates => candidates.find(c => c.item.id === 'b') } });
    assert.equal(h.view.remove(op).count, 1); assert.equal(q.confirmSuccessfulLaunch(selection.token), false);
    assert.equal(q.successfulLaunchSequence(), 0); assert.equal(q.snapshot()[0].id, 'b');
});

test('exact binding includes target/lifecycle/revision; supplied payload cannot forge pending owner', () => {
    const h = harness(), a = h.view.open();
    assert.equal(h.port.presentation.enqueue(a, { id: 'a', pendingOwner: { document: 'forged' } }, h.itemOptions('a')), true);
    const binding = h.runtime().queue.snapshot()[0].pendingOwner;
    for (const key of ['document', 'target', 'lifecycle', 'revision']) {
        const other = { ...binding, [key]: typeof binding[key] === 'number' ? binding[key] + 1 : 'other' };
        h.runtime().enqueue({ pendingOwner: other }, h.itemOptions(key));
    }
    const survivors = h.runtime().queue.snapshot().slice(1);
    assert.equal(h.view.terminal(a).count, 1); assert.deepEqual(h.runtime().queue.snapshot(), survivors);
});

test('zero removal preserves the outstanding survivor selection nonce', () => {
    const h = harness(), a = h.view.open(), op = h.view.retire(a), b = h.view.open(); h.enqueue(b, 'b');
    const q = h.runtime().queue, selected = q.evaluate({ scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
        isSafe: () => true, policy: pending.createFifoPolicy() });
    assert.equal(h.view.remove(op).count, 0); assert.equal(q.confirmSuccessfulLaunch(selected.token), true);
});

test('empty stale/not-found is explicitly zero, never a positive removal or complete Accounting', () => {
    const h = harness(), a = h.view.open(), r = h.view.terminal(a);
    assert.deepEqual(r, { status: 'STALE_OR_NOT_FOUND', count: 0, proof: 'EMPTY_VERIFIED' });
    assert.equal(last(h.view).removed, 0); assert.equal(last(h.view).observed, 0);
    assert.equal(last(h.view).state, 'INCOMPLETE'); assert.equal(h.events.filter(e => e.type === 'PENDING_OWNER_REMOVED').length, 0);
});

test('duplicate and same-operation reentrant removal are idempotent, tally counted once', () => {
    let duplicate; const h = harness({ onEvent(e) { if (e.type === 'PENDING_OWNER_REMOVED') duplicate = h.view.remove(op); } });
    const a = h.view.open(); h.enqueue(a, 'a'); const op = h.view.retire(a);
    assert.equal(h.view.remove(op).count, 1); assert.equal(duplicate.status, 'IN_PROGRESS');
    const again = h.view.terminal(a); assert.equal(again.status, 'DUPLICATE');
    assert.equal(again.count, 0); assert.equal(again.originalCount, 1); assert.equal(last(h.view).observed, 1);
    assert.equal(h.runtime().status().pendingCount, 0); assert.equal(h.callbacks.size, 0);
});

test('another reentrant operation fails once without mutating its pending or retrying implicitly', () => {
    let failure; const h = harness({ onEvent(e) { if (e.type === 'PENDING_OWNER_REMOVED') failure = h.view.remove(second); } });
    const a = h.view.open(); h.enqueue(a, 'a'); const first = h.view.retire(a);
    const b = h.view.open(); h.enqueue(b, 'b'); const second = h.view.retire(b);
    assert.equal(h.view.remove(first).count, 1); assert.equal(failure.status, 'FAILED');
    assert.equal(h.view.remove(second).status, 'DUPLICATE'); assert.equal(h.runtime().queue.snapshot()[0].id, 'b');
    assert.equal(h.view.status().scopes[1].pendingProof, 'INCOMPLETE');
});

test('unknown ownership refuses mutation and cannot produce conserved terminal closure', () => {
    const h = harness(), a = h.view.open(); h.enqueue(a, 'a');
    h.runtime().enqueue({}, h.itemOptions('unowned'));
    assert.equal(h.port.presentation.pendingCount(a), null);
    const before = h.runtime().queue.snapshot(), r = h.view.terminal(a);
    assert.equal(r.status, 'NOT_APPLIED_UNKNOWN'); assert.equal(r.proof, 'INCOMPLETE');
    assert.deepEqual(h.runtime().queue.snapshot(), before); assert.equal(last(h.view).state, 'INCOMPLETE');
});

test('real EVALUATING scheduler cannot remove pending or close scope', () => {
    let result; const h = harness({ onEvent(e) { if (e.type === 'EVALUATING') result = h.view.terminal(a); } });
    const a = h.view.open(); h.enqueue(a, 'a'); h.tick();
    assert.equal(result.status, 'FAILED'); assert.equal(result.count, 0); assert.equal(result.proof, 'INCOMPLETE');
    assert.equal(h.runtime().status().pendingCount, 1); assert.equal(last(h.view).state, 'INCOMPLETE');
});

for (const defect of ['dropObserver', 'wrongObserver', 'throwRemoval']) test(`${defect} cannot fabricate matching cleanup proof`, () => {
    const h = harness({ [defect]: true }), a = h.view.open(); h.enqueue(a, 'a');
    const r = h.view.terminal(a); assert.equal(r.proof, 'INCOMPLETE'); assert.equal(last(h.view).state, 'INCOMPLETE');
    if (defect === 'wrongObserver') { assert.equal(last(h.view).removed, 1); assert.equal(last(h.view).observed, 2); }
    if (defect === 'throwRemoval') assert.equal(r.count, null);
});

test('active DOM and animation survive actual scheduler launch followed by pending-only removal', () => {
    const h = harness({ launch: true }), a = h.view.open(); h.enqueue(a, 'active'); h.tick();
    assert.equal(h.active.size, 1); const active = h.active.get('active');
    h.enqueue(a, 'pending'); const credit = h.runtime().queue.successfulLaunchSequence();
    assert.equal(h.view.terminal(a).count, 1);
    assert.equal(h.active.get('active'), active); assert.equal(active.node.isConnected, true); assert.equal(active.animation.currentTime, 50);
    assert.equal(h.runtime().queue.successfulLaunchSequence(), credit);
});

test('Document/lifecycle/revision/target/route mismatch cannot bind private owner or close another scope', () => {
    for (const key of ['document', 'lifecycle', 'revision', 'targetId']) {
        const h = harness({ ownerConnect: true });
        assert.equal(h.port.connect({ ...h.binding, [key]: key === 'document' ? {} : 'wrong' }, route), null);
        assert.ok(h.port.connect(h.binding, route)); assert.equal(h.port.connect(h.binding, route), null);
    }
    const h = harness({ ownerConnect: true });
    assert.equal(h.port.connect(h.binding, { ...route, documentId: '87654321-1234-1234-1234-123456789abc' }), null);
});

test('delayed old terminal operation removes only old scope while new pending remains', () => {
    const h = harness(), a = h.view.open(); h.enqueue(a, 'a'); const old = h.view.retire(a);
    const b = h.view.open(); h.enqueue(b, 'b'); const recent = h.view.retire(b);
    assert.equal(h.view.remove(recent).count, 1); assert.equal(h.view.status().scopes[0].pendingProof, 'UNKNOWN');
    assert.equal(h.view.remove(old).count, 1);
    assert.equal(h.view.status().scopes[0].removed, 1); assert.equal(h.view.status().scopes[1].removed, 1);
    assert.equal(h.enqueue(a, 'late'), false); assert.equal(h.enqueue(b, 'late'), false);
});

test('forged public CLEAR/SCOPE/ACK and reconstructed handle cannot supply closure authority', () => {
    const h = harness(), a = h.view.open(); h.enqueue(a, 'a');
    for (const type of ['PENDING_ONLY_CLEAR', 'PIPELINE', 'SCOPE', 'ACK']) {
        assert.equal(h.view.remove({ type, count: 1, status: 'APPLIED' }).status, 'NOT_APPLIED_UNKNOWN');
        assert.equal(h.view.retire(JSON.parse(JSON.stringify(a))), null);
    }
    assert.equal(typeof h.view.receive, 'undefined'); assert.equal(typeof h.port.observe, 'undefined');
    assert.equal(h.runtime().status().pendingCount, 1); assert.equal(last(h.view).pendingProof, 'UNKNOWN');
});

test('bounded scope archives and operation records retain incomplete evidence, never reset history', () => {
    const h = harness();
    for (let i = 0; i < 64; i++) { const a = h.view.open(); assert.ok(a); h.view.terminal(a); }
    assert.equal(h.view.open(), null); const state = h.view.status();
    assert.equal(state.scopes.length, 9); assert.ok(state.discardedIncomplete > 0); assert.equal(state.incomplete, true);
});

test('module import is inert and exposes no page-visible API or cleanup/network listener', () => {
    const context = vm.createContext({ module: { exports: {} } });
    const source = fs.readFileSync(require.resolve('../src/private-pending-scope.js'), 'utf8');
    vm.runInContext(source, context); assert.deepEqual(Object.keys(context), ['module']);
    assert.deepEqual(Object.keys(context.module.exports), ['createPrivatePendingScope']);
    assert.doesNotMatch(source, /postMessage\s*\(|addEventListener\s*\(|fetch\s*\(|XMLHttpRequest|runtime\.clear\s*\(/);
});

test('malformed private port remains an explicit Scope fault without invented status or counts', () => {
    const f = fixture();
    const owner = createLiveAcquisitionOwner({ document: f.document, route, nativeFacts: f.options,
        clock: { now: () => 0 }, timers: { setTimeout() { throw Error('unexpected timer'); }, clearTimeout() {} },
        core, control, entropy: bytes => bytes.fill(1), AbortController, onBatch() {}, transport() { throw Error('unexpected READ'); },
        pendingScopePort: { connect: () => ({}) } });
    assert.ok(owner); assert.equal(owner.status().pendingScopeFault, true);
    assert.equal(owner.status().pendingScopes, null); assert.equal(owner.status().permit, 'UNUSED');
});

for (const mode of ['replay', 'live']) test(`actual ${mode} owner terminal preserves separate pending domains and cannot resurrect`, async () => {
    const f = fixture(), h = harness({ document: f.document, ownerConnect: true });
    f.options.mode = mode;
    f.value(f.child).url = `https://www.youtube.com/${mode === 'replay' ? 'live_chat_replay' : 'live_chat'}?v=target`;
    const jobs = new Map(); let id = 0, requests = 0, answer;
    const time = { now: () => 0, setTimeout(fn, delay) { const k = ++id; jobs.set(k, { fn, delay }); return k; }, clearTimeout: k => jobs.delete(k) };
    const batches = [];
    const owner = createLiveAcquisitionOwner({ document: f.document, route, nativeFacts: f.options,
        clock: time, timers: time, core, control, entropy: bytes => bytes.fill(1), AbortController,
        pendingScopePort: h.port,
        transport() { requests++; return new Promise(resolve => { answer = resolve; }); },
        onBatch(messages, scope) { batches.push(messages); for (const message of messages) assert.equal(h.enqueue(scope, message.id), true); } });
    assert.ok(owner);
    const bridge = owner.openBootstrap({});
    assert.equal(bridge.consumePermit({ operationId: bridge.operationId, route }), true);
    assert.equal(bridge.receive({ version: 1, operationId: bridge.operationId, route,
        result: { status: 'OK', source: 'C1', targetId: 'target', mode, continuation: 'initial', context: { client: { hl: 'en' } } } }), true);
    const [key, job] = [...jobs].find(([, v]) => v.delay === 0); jobs.delete(key); job.fn();
    answer({ status: 200, json: async () => ({ continuationContents: { liveChatContinuation: {
        continuations: [mode === 'replay' ? { liveChatReplayContinuationData: { continuation: 'seq', timeUntilLastMessageMsec: 1000 } } :
            { timedContinuationData: { continuation: 'seq', timeoutMs: 1000 } }],
        actions: mode === 'replay' ? [0, 5000].map((offset, i) => ({ replayChatItemAction: { videoOffsetTimeMsec: String(offset),
            actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'item' + i, message: { runs: [{ text: 'fixture' }] } } } } }] } }))
            : [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'item0', message: { runs: [{ text: 'fixture' }] } } } } }]
    } } }) });
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'replay') assert.equal(owner.status().pending, 1);
    assert.equal(h.runtime().status().pendingCount, 1);
    assert.equal(batches.flat().length, 1); owner.cancel(); owner.cancel();
    const state = owner.status(); if (mode === 'replay') assert.equal(state.pending, 0);
    assert.equal(h.runtime().status().pendingCount, 0);
    assert.equal(state.pendingScopes.scopes[0].removed, 1); assert.equal(state.pendingScopes.scopes[0].observed, 1);
    assert.equal(state.pendingScopes.scopes[0].state, 'INCOMPLETE'); assert.equal(state.pendingScopes.accounting, 'UNKNOWN');
    assert.equal(requests, 1); assert.equal(owner.openBootstrap({}), null);
    assert.equal(createLiveAcquisitionOwner({ document: f.document }), null);
    assert.doesNotMatch(JSON.stringify(state.pendingScopes), /initial|continuation|context|authority|documentId/);
});
