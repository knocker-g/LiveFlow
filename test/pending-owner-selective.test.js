const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const pending = require('../src/pending-selection');
const { createSchedulerRuntime } = require('../src/scheduler-runtime');
const { createGeometryAuthority, createSubtitleGeometryAdapter } = require('../src/geometry-adapter');
const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8').replaceAll('\r\n', '\n');
const owner = stream => Object.freeze({ document: 'DOC', stream, target: 'TARGET', lifecycle: 0, revision: 0 });

function runtime({ onEvent = () => {}, launch = () => true, proof = () => null } = {}) {
    const callbacks = new Map(), events = []; let sequence = 0;
    const r = createSchedulerRuntime({ clock: () => 0, generation: () => 1,
        geometryAdapter: createSubtitleGeometryAdapter({ authority: createGeometryAuthority({ epsilon: 1 }),
            readGeometry: () => ({ state: 'KNOWN_EMPTY', exclusionRegions: [], capabilityAvailable: true }) }),
        scheduleOneShot(fn) { callbacks.set(++sequence, fn); return sequence; },
        cancelOneShot(id) { callbacks.delete(id); }, candidateProof: proof, launch,
        observe(e) { events.push(e); onEvent(e, r); },
        config: { maxPendingAge: 1000, maxPendingCount: 10, pendingPressureCapacity: 5,
            scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
            pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: .75 },
            density: { attackThresholds: [.5, .7, .9], releaseThresholds: [.2, .3, .4], minimumAttackResidence: 1, releaseDwell: 3 },
            collisionAllowances: { CONSERVATIVE: {} } } });
    function enqueue(id, binding) {
        assert.equal(r.enqueue({ pendingOwner: binding }, { id, enqueuedAt: 0,
            rendererType: 'liveChatTextMessageRenderer', footprint: {} }), true);
    }
    return { r, events, callbacks, enqueue, tick() {
        const [id, fn] = callbacks.entries().next().value; callbacks.delete(id); fn();
    } };
}

async function realScenario() {
    const filename = path.resolve('test/pending-clear-production-integration.test.js');
    const source = fs.readFileSync(filename, 'utf8').split("test('INFRA")[0];
    const c = vm.createContext({ require: createRequire(filename), structuredClone, AbortController });
    vm.runInContext(source + '\nrealScenario = fixture;', c);
    return c.realScenario(false); // Exercise Step 1 independently of Step 2 failure cleanup.
}

test('owner propagates through actual transport/Content; replacement rotates; mixed removal preserves survivors and active', async () => {
    const s = await realScenario(), c = s.c, t = c.transportFixture;
    const initial = c.phase3Runtime.queue.snapshot().at(-1);
    const a = initial.pendingOwner;
    assert.ok(a); assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(initial.payload.pendingOwner));
    assert.equal(a.stream, c.ownerBeforeReanchor.stream + 1); // Actual accepted reanchor replacement.
    assert.notEqual(a, initial.payload.pendingOwner); assert.equal(pending.samePendingOwner(a, initial.payload.pendingOwner), true);
    assert.equal(c.phase3Runtime.removePendingOwner(a).status, 'APPLIED');
    assert.equal(c.phase3Runtime.status().pendingCount, 2); // Earlier transported owner survives.
    c.phase3Runtime.clear(); t.flush(); // Explicit fixture preparation, not Product CLEAR integration.
    function batch(ids) { c.postReadResult({ ok: true, revision: 0,
        messages: ids.map(id => ({ id, messageType: 'text' })) }, 0); t.flush(); }
    batch(['a1', 'a2']);
    // Execute the real READ_START_RESET policy fragment (no READ/request execution).
    const start = main.indexOf('            const preserveSequentialPending =');
    const end = main.indexOf("            if (requestAuthorityKind === 'BOOTSTRAP')", start);
    c.video = c.getCurrentMainVideo(); c.requestAuthorityKind = 'BOOTSTRAP';
    vm.runInContext('{' + main.slice(start, end) + '}', c);
    batch(['b1', 'b2']);
    const all = c.phase3Runtime.queue.snapshot(), survivors = all.slice(2), b = survivors[0].pendingOwner;
    assert.notEqual(a.stream, b.stream);
    assert.equal(all[0].pendingOwner.stream, a.stream); // Append/ordinary batch retained the owner.
    const active = { animation: { cancel() { throw Error('active must survive'); } }, trajectory: Object.freeze({ x: 100 }) };
    c.activeDanmaku.set('active', active);
    const result = c.phase3Runtime.removePendingOwner(a);
    assert.equal(result.status, 'APPLIED'); assert.equal(result.count, 2);
    assert.deepEqual(c.phase3Runtime.queue.snapshot(), survivors);
    assert.equal(c.phase3Runtime.queue.snapshot()[0], survivors[0]);
    assert.equal(c.phase3Runtime.queue.snapshot()[1], survivors[1]);
    assert.equal(c.activeDanmaku.get('active'), active); assert.equal(c.phase3Runtime.status().armed, true);
    assert.equal(c.phase3Runtime.removePendingOwner(a).count, 0);
    assert.equal(c.replayDiagnosticIncomplete, true); // Scope reconciliation explicitly waits for Step 2.
    assert.deepEqual(Array.from(s.requests), ['REANCHOR']);
});

test('actual start policy preserves Sequential handoff and retires reset/seek/lifecycle owner', async () => {
    const s = await realScenario(), c = s.c, a = c.ensureReplayPendingOwner();
    const start = main.indexOf('            const preserveSequentialPending =');
    const end = main.indexOf("            if (requestAuthorityKind === 'BOOTSTRAP')", start);
    c.video = c.getCurrentMainVideo(); c.requestAuthorityKind = 'SEQUENTIAL';
    c.replayAwaitingFirstFreshSequentialResponse = true;
    vm.runInContext('{' + main.slice(start, end) + '}', c);
    assert.equal(c.ensureReplayPendingOwner(), a);
    c.replayAwaitingFirstFreshSequentialResponse = false; c.replaySequentialResumeHandoff = true;
    vm.runInContext('{' + main.slice(start, end) + '}', c);
    assert.equal(c.ensureReplayPendingOwner(), a);
    c.replaySequentialResumeHandoff = false;
    vm.runInContext('{' + main.slice(start, end) + '}', c);
    const b = c.ensureReplayPendingOwner(); assert.equal(b.stream, a.stream + 1);
    c.stopReadLoop('seek'); assert.equal(c.replayPendingOwner, null);
    const afterSeek = c.ensureReplayPendingOwner(); assert.equal(afterSeek.stream, b.stream + 1);
    c.resetReplayGapOriginDiagnostic = () => {}; c.abortReplayPlayerSeekDiagnostic = () => {};
    let previous = afterSeek;
    for (const reason of ['navigation', 'visibility-hidden', 'ad-enter', 'pagehide']) {
        c.stopReadLoop(reason); assert.equal(c.replayPendingOwner, null);
        const next = c.ensureReplayPendingOwner(); assert.equal(next.stream, previous.stream + 1);
        assert.equal(next.document, previous.document); previous = next;
    }
});

test('actual coverage-hole append keeps owner while replacement rotates it', async () => {
    const s = await realScenario(), c = s.c;
    const start = main.indexOf("                const priorPending = intent.reason === 'COVERAGE_HOLE'");
    const end = main.indexOf('                observeReplayTemporalPendingMerge', start);
    assert.ok(start >= 0 && end > start);
    const a = c.ensureReplayPendingOwner(), retained = c.replayPending[0];
    c.intent = { reason: 'COVERAGE_HOLE' }; c.playerOffsetMs = 5000;
    c.result = { messages: [{ id: 'repair', replayOffsetMsec: 9000 }] };
    vm.runInContext('{' + main.slice(start, end) + '}', c);
    assert.equal(c.ensureReplayPendingOwner(), a); assert.equal(c.replayPending[0], retained);
    assert.equal(c.replayPending.length, 2);
    c.intent = { reason: 'FOREGROUND' };
    vm.runInContext('{' + main.slice(start, end) + '}', c);
    assert.equal(c.ensureReplayPendingOwner().stream, a.stream + 1);
    assert.equal(c.replayPending.length, 1);
});

test('private queue removal invalidates selection token without spending credit or changing survivors', () => {
    const q = pending.createPendingQueue();
    for (let i = 1; i <= 3; i++) q.enqueue(pending.createPendingItem({ id: i, enqueuedAt: 0, footprint: {},
        payload: { pendingOwner: owner(i === 1 ? 1 : 2) } }));
    const before = q.snapshot(), selected = q.evaluate({ scanDepth: 3, cohortMaximumItems: 3,
        cohortMaximumSpan: 50, isSafe: () => true, policy: { select: candidates => candidates.find(c => c.item.id === 2) } });
    assert.equal(selected.item.id, 2); // Selected survivor, not the removed entry.
    assert.equal(q.removePendingOwner(owner(1)).removed.length, 1);
    assert.equal(q.confirmSuccessfulLaunch(selected.token), false); assert.equal(q.successfulLaunchSequence(), 0);
    assert.deepEqual(q.snapshot(), before.slice(1));
    const fresh = q.evaluate({ scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
        isSafe: () => true, policy: pending.createFifoPolicy() });
    assert.equal(q.confirmSuccessfulLaunch(fresh.token), true); assert.equal(q.successfulLaunchSequence(), 1);
});

test('Runtime actual count/reason and timer ownership are preserved for selective and duplicate removal', () => {
    const h = runtime(); h.enqueue('a', owner(1)); h.enqueue('b', owner(2)); h.enqueue('c', owner(2));
    const armed = [...h.callbacks.entries()];
    assert.deepEqual(h.r.removePendingOwner(owner(1)), { status: 'APPLIED', count: 1 });
    assert.deepEqual([...h.callbacks.entries()], armed); assert.equal(h.r.status().armed, true);
    let e = h.events.filter(e => e.type === 'PENDING_OWNER_REMOVED');
    assert.equal(e.length, 1); assert.equal(e[0].count, 1); assert.equal(e[0].reason, 'FAIL_CLOSED');
    assert.equal(e[0].pendingCount, 2); assert.ok(Object.isFrozen(e[0].pendingOwner));
    assert.equal(h.r.removePendingOwner(owner(1)).count, 0);
    assert.equal(h.r.queue.successfulLaunchSequence(), 0);
    assert.equal(h.r.removePendingOwner(owner(2)).count, 2);
    assert.equal(h.r.status().state, 'IDLE'); assert.equal(h.callbacks.size, 0);
    e = h.events.filter(e => e.type === 'PENDING_OWNER_REMOVED'); assert.equal(e.length, 2);
});

test('unknown ownership and reentrant evaluation never mutate queue', () => {
    const unknown = runtime(); unknown.enqueue('known', owner(1)); unknown.enqueue('unknown', null);
    const before = unknown.r.queue.snapshot();
    assert.equal(unknown.r.removePendingOwner(owner(1)).status, 'NOT_APPLIED_UNKNOWN');
    assert.deepEqual(unknown.r.queue.snapshot(), before);
    let result;
    const evaluating = runtime({ onEvent(e, r) { if (e.type === 'EVALUATING') result = r.removePendingOwner(owner(1)); } });
    evaluating.enqueue('a', owner(1)); evaluating.tick();
    assert.deepEqual(result, { status: 'FAILED', count: 0 });
    assert.equal(evaluating.r.status().pendingCount, 1); assert.equal(evaluating.r.status().armed, true);
});

test('entry owner is a validated immutable copy independent of acquisition/renderer/diagnostic generations', () => {
    const binding = { ...owner(1) }, payload = { pendingOwner: binding, generation: 77, acquisitionGeneration: 99, diagnosticEpoch: 123 };
    const q = pending.createPendingQueue(); q.enqueue(pending.createPendingItem({ id: 'a', enqueuedAt: 0, footprint: {}, payload }));
    binding.stream = 10; payload.pendingOwner = owner(20);
    assert.equal(q.snapshot()[0].pendingOwner.stream, 1);
    assert.equal(q.removePendingOwner(owner(1)).removed.length, 1);
    assert.equal(pending.clonePendingOwner({ ...owner(1), stream: NaN }), null);
});

test('MAIN document identity is minted once and stream issuance is monotone without Authority input', () => {
    const start = main.indexOf('    function ensureReplayPendingOwner(');
    const end = main.indexOf('\n    }\n', start);
    let minted = 0;
    function document(id) {
        const c = vm.createContext({ window: { crypto: { randomUUID() { minted++; return id; } } },
            replayPendingOwner: null, replayPendingOwnerSequence: 0, replayPendingOwnerDocument: null,
            replayPendingOwners: new Map(), replayPipelineDiagnostic: {}, diagnosticScopes: { currentEpoch: () => 0 },
            pageState: { targetIdentity: 'TARGET' }, pageLifecycleGeneration: 0, pageRevision: 0 });
        vm.runInContext(main.slice(start, end + 7), c); return c;
    }
    const c = document('DOCUMENT_ONE'), a = c.ensureReplayPendingOwner();
    assert.equal(c.ensureReplayPendingOwner(), a); assert.equal(minted, 1);
    c.replayPendingOwner = null; const b = c.ensureReplayPendingOwner();
    assert.equal(b.stream, 2); assert.equal(a.document, b.document); assert.equal(minted, 1);
    const other = document('DOCUMENT_TWO').ensureReplayPendingOwner();
    assert.notEqual(other.document, a.document); assert.equal(minted, 2);
});

test('actual accepted Bootstrap and Sequential merge path retains the same pending stream owner', () => {
    const filename = path.resolve('test/temporal-occurrence-accounting.test.js');
    const prefix = fs.readFileSync(filename, 'utf8').split("test('actual accepted response merge")[0];
    const outer = vm.createContext({ require: createRequire(filename), AbortController });
    vm.runInContext(prefix + '\nmakeTemporal = temporalHarness;', outer);
    const h = outer.makeTemporal();
    h.c.requestAuthorityKind = 'BOOTSTRAP'; h.accept([{ id: 'bootstrap', replayOffsetMsec: 8000 }]);
    const a = h.c.replayPendingOwner; assert.ok(a); assert.equal(a.stream, 1);
    h.c.requestAuthorityKind = 'SEQUENTIAL'; h.accept([{ id: 'sequential', replayOffsetMsec: 9000 }]);
    assert.equal(h.c.replayPendingOwner, a); assert.equal(h.c.replayPending.length, 2);
    assert.equal(h.status().stages.temporal.valid, true); assert.equal(h.count('HTTP'), 0);
});
