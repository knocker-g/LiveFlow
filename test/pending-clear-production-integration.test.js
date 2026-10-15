// Former FAIL-before regression now verifies real CLEAR/ACK integration; INFRA is independently selectable.
// Real: MAIN reanchor/Temporal, Authority Core, postReadResult, message guards,
// Content handleReadResult/scheduleDanmakuBatch, Runtime.enqueue and scope receiver.
// Mocked: network normalized response, DOM/UI/environment readiness, source-activity
// observation, clock/timer driver, geometry/launch, and the unexecuted next-read handoff.
// Legacy setup seeds are removed/accounted, then recreated via real accepted-response transport.
// No browser or cross-world VM proof is claimed.
// The postMessage shim clones/queues payloads; it does not authenticate MAIN-world data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const main = fs.readFileSync(require.resolve('../src/page-state-main'), 'utf8').replaceAll('\r\n', '\n');
const content = fs.readFileSync(require.resolve('../src/youtube-chat'), 'utf8').replaceAll('\r\n', '\n');
function actualFunction(text, name) {
    const start = text.indexOf('    function ' + name + '('), end = text.indexOf('\n    }\n', start);
    assert.ok(start >= 0 && end > start, name); return text.slice(start, end + 7);
}

function installRealTransport(h, c, video, { holdTypes = [], beforeReanchor } = {}) {
    const listeners = [], queue = [], history = [], checkpoints = [];
    const held = new Set(holdTypes), entries = [];
    let sequence = 0;
    video.readyState = 4;
    c.window.LiveFlowPendingSelection = require('../src/pending-selection');
    c.ownerBeforeReanchor = c.ensureReplayPendingOwner();
    const player = { classList: { contains: () => false } };
    Object.assign(c, {
        acceptingReadResults: true, currentPageRevision: 0, currentMessages: [], MAX_MESSAGES: 500,
        phase3RuntimeVideo: video, runtimeSettings: Object.freeze({}), phase5Tuning: { lineHeight: 20 },
        performance: { now: () => 0 }, overlayCore: require('../src/overlay-core'),
        getCurrentMainMedia: () => ({ video, player }), isEffectiveDisplayActive: () => true,
        // DOM setup is outside this fixture. Return the inherited REAL Scheduler Runtime.
        ensurePhase3Runtime: () => c.phase3Runtime,
        ensureSubtitleGeometryObservers() {}, ensurePlaybackContextObserver() {},
        observeLivePresentationBatch() {}, observeCurrentWindowSourceActivity() {}, setReadIndicatorState() {}
    });
    // Controlled asynchronous postMessage shim, not direct enqueue. Clone at publication time.
    c.window.postMessage = (data, origin) => {
        assert.equal(origin, c.window.location.origin);
        const packet = { id: ++sequence, data: structuredClone(data) };
        queue.push(packet); history.push({ action: 'published', id: packet.id, type: data.type,
            terminal: data.diagnosticTerminal === true });
    };
    c.window.addEventListener = (type, listener) => { assert.equal(type, 'message'); listeners.push(listener); };
    for (const d of main.matchAll(/^    const ([A-Z_]+_TYPE) = ('[^']+');$/gm)) {
        c[d[1]] = vm.runInNewContext(d[2]); // Original Product message type constants.
    }
    vm.runInContext(actualFunction(main, 'postReadResult') + '\n' +
        ['rememberReplayPendingOwner', 'handlePendingOnlyClear', 'handleReadResult', 'scheduleDanmakuBatch']
            .map(n => actualFunction(content, n)).join('\n'), c);
    const begin = main.indexOf("    window.addEventListener('message', (event) => {");
    const end = main.indexOf("\n    window.addEventListener('yt-navigate-finish'", begin);
    assert.ok(begin >= 0 && end > begin);
    vm.runInContext(main.slice(begin, end), c); // Original MAIN source/origin/type guards.
    for (const name of ['handleReplayDiagnosticScopeOpen', 'handleReadResult', 'handlePendingOnlyClear']) {
        const registration = `    window.addEventListener('message', ${name});`;
        assert.ok(content.includes(registration)); vm.runInContext(registration, c);
    }
    const post = c.postReadResult, handle = c.handleReadResult, schedule = c.scheduleDanmakuBatch;
    const enqueue = c.phase3Runtime.enqueue, counts = { post: 0, handle: 0, schedule: 0, enqueue: 0 };
    // Transparent call-through spies; production functions, arguments and receivers remain intact.
    c.postReadResult = function (...args) { counts.post++; return Reflect.apply(post, this, args); };
    const index = listeners.indexOf(handle); assert.ok(index >= 0);
    listeners[index] = function (...args) { counts.handle++; return Reflect.apply(handle, this, args); };
    c.scheduleDanmakuBatch = function (...args) { counts.schedule++; return Reflect.apply(schedule, this, args); };
    c.phase3Runtime = Object.freeze({ ...c.phase3Runtime, enqueue(...args) {
        counts.enqueue++; const result = Reflect.apply(enqueue, this, args);
        if (result) entries.push(c.phase3Runtime.queue.snapshot().at(-1)); return result;
    } });
    function deliver(packet, overrides = {}) {
        const event = { source: c.window, origin: c.window.location.origin, data: structuredClone(packet.data), ...overrides };
        history.push({ action: 'delivered', id: packet.id, type: packet.data.type,
            terminal: packet.data.diagnosticTerminal === true });
        for (const listener of listeners) listener(event);
    }
    function flush() {
        let n = 0;
        let index;
        while ((index = queue.findIndex(p => !held.has(p.data.type))) >= 0) {
            assert.ok(++n <= 128, 'bounded transport drain'); deliver(queue.splice(index, 1)[0]);
        }
    }
    function take(predicate) {
        const index = queue.findIndex(p => predicate(p.data));
        assert.ok(index >= 0, 'packet exists'); return queue.splice(index, 1)[0];
    }
    function capture(label) {
        const snapshot = { label, temporal: c.replayPending.length, scheduler: c.phase3Runtime.status().pendingCount,
            accounting: structuredClone(c.replayAccountingStatus()) };
        checkpoints.push(snapshot); return snapshot;
    }
    h.flush = flush;
    c.transportFixture = { queue, history, checkpoints, counts, entries, held, deliver, flush, take, capture };
    // Replace legacy direct-enqueue seeds with actual accepted/transported batches.
    // Existing legacy entries are removed and accounted through the original Runtime event.
    c.phase3Runtime.clear(); flush();
    h.accept([{ id: 'seed-a', messageType: 'text', replayOffsetMsec: 5000 },
        { id: 'seed-b', messageType: 'text', replayOffsetMsec: 5000 }], true);
    flush();
    for (const key of Object.keys(counts)) counts[key] = 0;
    c.transportFixture.seedMessageCount = c.currentMessages.length;
    if (beforeReanchor) beforeReanchor(c);
}

async function fixture(repeated = true, options = {}) {
    const filename = path.resolve('test/reanchor-repeated-cleanup.test.js');
    let prefix = fs.readFileSync(filename, 'utf8').replaceAll('\r\n', '\n').split('\ntest(')[0];
    const start = prefix.indexOf('    // Existing transport adapter boundary:');
    const end = prefix.indexOf('    c.startReadLoop =', start);
    assert.ok(start >= 0 && end > start);
    prefix = prefix.slice(0, start) + '    installRealTransport(h, c, video);\n' + prefix.slice(end);
    assert.ok(!prefix.includes('c.postReadResult = result =>'));
    // The network fixture supplies normalized messages. Unlike the old adapter,
    // real Content correctly filters messages without a supported messageType.
    prefix = prefix.replace("{ id: 'due', replayOffsetMsec:", "{ id: 'due', messageType: 'text', replayOffsetMsec:")
        .replace("{ id: 'future', replayOffsetMsec:", "{ id: 'future', messageType: 'text', replayOffsetMsec:");
    const context = vm.createContext({ require: createRequire(filename), AbortController,
        installRealTransport: (h, c, v) => installRealTransport(h, c, v, options) });
    vm.runInContext(prefix + '\nrunScenario = scenario;', context);
    return context.runScenario(repeated);
}

test('INFRA real MAIN transport reaches Content handlers and Runtime', async () => {
    const s = await fixture(), t = s.c.transportFixture;
    assert.equal(s.authorizations.at(-1).reason, 'AUTHORITY_REPEATED');
    assert.equal(s.c.replayProductionControlState.phase, 'STOPPED');
    assert.deepEqual(Array.from(s.requests), ['REANCHOR']); assert.equal(s.microtasks.length, 0);
    assert.equal(t.counts.post, 1); assert.equal(t.counts.schedule, 1); assert.equal(t.counts.enqueue, 1);
    assert.ok(t.counts.handle > 0);
    const publication = t.history.find(e => e.action === 'published' && e.type === s.c.READ_RESPONSE_TYPE);
    assert.ok(publication);
    assert.ok(t.history.some(e => e.action === 'delivered' && e.id === publication.id));
    const payload = t.entries.at(-1).payload;
    assert.equal(payload.message.id, 'due'); assert.equal(payload.video, s.c.getCurrentMainVideo());
    assert.equal(payload.generation, s.c.rendererGeneration);
    assert.equal(s.c.currentMessages.length, t.seedMessageCount + 1);
    assert.equal(s.c.replayPending.length, 0); assert.equal(s.c.phase3Runtime.status().pendingCount, 0);
    const a = t.capture('after-cleanup').accounting;
    assert.ok(Object.values(a.stages).every(x => x.valid));
    assert.equal(a.lostUnaccounted, 0); assert.equal(a.overflowUnaccounted, 0); assert.equal(t.queue.length, 0);
});

test('INFRA actual routing and currentness guards reject foreign stale and inactive batches', async () => {
    const s = await fixture(), c = s.c, t = c.transportFixture, before = t.counts.enqueue;
    function packet(id, fields = {}) {
        return { id: 100 + id, data: { source: 'liveflow-page-state', type: c.READ_RESPONSE_TYPE,
            ok: true, pageRevision: 0, pageLifecycleGeneration: 0, messages: [{ id: 'guard-' + id }], ...fields } };
    }
    t.deliver(packet(1), { source: {} }); t.deliver(packet(2), { origin: 'https://invalid.example' });
    t.deliver(packet(3, { source: 'wrong' })); t.deliver(packet(4, { type: 'wrong' }));
    t.deliver(packet(5, { pageRevision: 1 })); t.deliver(packet(6, { pageLifecycleGeneration: 1 }));
    c.acceptingReadResults = false; t.deliver(packet(7)); c.acceptingReadResults = true;
    assert.equal(t.counts.enqueue, before); assert.equal(c.currentMessages.length, t.seedMessageCount + 1);
    const a = JSON.stringify(c.replayAccountingStatus());
    const diagnostic = { id: 200, data: { source: 'liveflow-content-script', type: c.REPLAY_PIPELINE_DIAGNOSTIC_TYPE,
        diagnosticScopeEpoch: 0, diagnosticSequence: 999, pageLifecycleGeneration: 0 } };
    t.deliver(diagnostic, { source: {} }); t.deliver(diagnostic, { origin: 'https://invalid.example' });
    assert.equal(JSON.stringify(c.replayAccountingStatus()), a);
});

test('INFRA fresh unused continuation preserves successful handoff without extra READ', async () => {
    const s = await fixture(false), t = s.c.transportFixture;
    assert.equal(s.outcome, true); assert.equal(s.authorizations.at(-1).ok, true);
    assert.equal(s.c.replayProductionControlState.phase, 'READING'); assert.equal(s.microtasks.length, 1);
    assert.deepEqual(Array.from(s.requests), ['REANCHOR']);
    assert.equal(t.counts.schedule, 1); assert.equal(t.counts.enqueue, 1);
    assert.equal(s.c.phase3Runtime.status().pendingCount, 3); assert.equal(s.c.replayAccountingStatus().lostUnaccounted, 0);
});

test('INFRA terminal packets can be withheld reordered and replayed independently', async () => {
    const s = await fixture(false), c = s.c, t = c.transportFixture;
    c.publishReplayScopeSnapshot();
    const ordinary = t.take(d => d.type === c.REPLAY_PIPELINE_DIAGNOSTIC_TYPE && !d.diagnosticTerminal);
    c.closeReplayDiagnosticScope(); const terminal = t.take(d => d.diagnosticTerminal === true);
    assert.ok(terminal.data.diagnosticSequence > ordinary.data.diagnosticSequence);
    const frozen = structuredClone(terminal.data);
    t.deliver(terminal); assert.equal(c.replayAccountingStatus().diagnosticScope.incomplete, true);
    t.deliver(ordinary); const a = c.replayAccountingStatus();
    assert.equal(a.diagnosticScope.scopes[0].state, 'INCOMPLETE'); // Real pending must prevent closure.
    const saved = JSON.stringify(a); t.deliver(terminal);
    assert.equal(JSON.stringify(c.replayAccountingStatus()), saved); assert.deepEqual(terminal.data, frozen);
    // take/deliver/capture also support future typed ACK scheduling. No invented ACK handler.
});

test('PRODUCT formerly FAIL-before STOPPED CLEAR reaches both actual pending owners', async (context) => {
    const s = await fixture();
    assert.equal(s.authorizations.at(-1).reason, 'AUTHORITY_REPEATED');
    assert.equal(s.c.replayProductionControlState.phase, 'STOPPED');
    assert.deepEqual(Array.from(s.requests), ['REANCHOR']);
    assert.deepEqual({ temporal: s.c.replayPending.length, scheduler: s.c.phase3Runtime.status().pendingCount },
        { temporal: 0, scheduler: 0 }, 'Product must apply CLEAR to both actual pending owners');
    const a = s.c.replayAccountingStatus();
    assert.equal(a.lostUnaccounted, 0);
    assert.equal(a.overflowUnaccounted, 0);
    assert.equal(a.accountingComplete, true);
    assert.ok(Object.values(a.stages).every(stage => stage.valid));
    const operations = [...s.c.replayPendingClearOperations.values()];
    assert.equal(operations.length, 2);
    assert.ok(operations.every(op => op.resolved && op.proof.count === op.ack.count));
    const schedulerActualRemoval = operations.reduce((sum, op) => sum + op.proof.count, 0);
    assert.equal(schedulerActualRemoval, 3);
    assert.equal(s.c.replayPipelineDiagnostic.temporalRemovalReasons.FAIL_CLOSED, 1);
    context.diagnostic('RECOVERY_ACCOUNTING ' + JSON.stringify({ temporalActualRemoval: 1,
        schedulerActualRemoval, operationCount: operations.length, pendingOperations: a.pendingClear.pendingOperations,
        stages: a.stages, lostUnaccounted: a.lostUnaccounted, overflowUnaccounted: a.overflowUnaccounted }));
    assert.ok(s.c.transportFixture.history.some(p => p.action === 'delivered' && p.type === 'LIVEFLOW_PENDING_ONLY_CLEAR_ACK'));
});

test('STEP2 typed ACK is observed independently of balanced counters', async () => {
    const s = await fixture();
    assert.ok(s.c.transportFixture.history.some(p => p.action === 'delivered' && p.type === 'LIVEFLOW_PENDING_ONLY_CLEAR_ACK'));
});

const CLEAR = 'LIVEFLOW_PENDING_ONLY_CLEAR', ACK = 'LIVEFLOW_PENDING_ONLY_CLEAR_ACK';
test('STEP2 mixed owners remove separately and preserve active plus survivor arming', async () => {
    const s = await fixture(true, { holdTypes: [CLEAR] }), c = s.c, t = c.transportFixture;
    const commands = [t.take(d => d.type === CLEAR), t.take(d => d.type === CLEAR)];
    const survivor = c.phase3Runtime.queue.snapshot().at(-1);
    const active = { animation: { cancel() { throw Error('active cancelled'); } }, trajectory: Object.freeze({ x: 100 }) };
    c.activeDanmaku.set('active', active);
    t.deliver(commands[0]); t.flush();
    assert.equal(c.phase3Runtime.status().pendingCount, 1);
    assert.equal(c.phase3Runtime.queue.snapshot()[0], survivor);
    assert.equal(c.phase3Runtime.status().armed, true); assert.equal(c.replayAccountingStatus().accountingComplete, false);
    t.deliver(commands[1]); t.flush();
    const a = c.replayAccountingStatus();
    assert.equal(c.phase3Runtime.status().pendingCount, 0); assert.equal(c.phase3Runtime.status().armed, false);
    assert.equal(c.activeDanmaku.get('active'), active);
    assert.equal(c.replayPipelineDiagnostic.temporalRemovalReasons.FAIL_CLOSED, 1);
    assert.ok(Object.values(a.stages).every(stage => stage.valid));
    assert.equal(a.accountingComplete, true); assert.equal(a.lostUnaccounted, 0); assert.equal(a.overflowUnaccounted, 0);
    assert.deepEqual(Array.from(s.requests), ['REANCHOR']);
});

test('STEP2 duplicate CLEAR returns original count without second mutation or counter increment', async () => {
    const s = await fixture(true, { holdTypes: [CLEAR, ACK] }), c = s.c, t = c.transportFixture;
    const command = t.take(d => d.type === CLEAR);
    t.deliver(command); t.flush();
    const original = t.take(d => d.type === ACK);
    const count = c.replaySchedulerDiagnostic.schedulerLifecycleDiscarded;
    t.deliver(command); t.flush();
    const duplicate = t.take(d => d.type === ACK);
    assert.equal(duplicate.data.status, 'DUPLICATE'); assert.equal(duplicate.data.count, original.data.count);
    assert.equal(duplicate.data.originalStatus, 'APPLIED');
    assert.equal(c.replaySchedulerDiagnostic.schedulerLifecycleDiscarded, count);
    t.deliver(duplicate); t.deliver(original); t.flush();
    assert.equal(c.replayPendingClearOperations.get(command.data.operationId).resolved, true);
    assert.equal(c.replaySchedulerDiagnostic.schedulerLifecycleDiscarded, count);
});

test('STEP2 conflicting CLEAR and unknown owner cannot clear a different queue', async () => {
    const s = await fixture(true, { holdTypes: [CLEAR, ACK] }), c = s.c, t = c.transportFixture;
    const first = t.take(d => d.type === CLEAR); t.deliver(first); t.flush();
    const pending = c.phase3Runtime.queue.snapshot();
    const second = t.take(d => d.type === CLEAR);
    t.deliver({ ...first, data: { ...first.data, owner: second.data.owner } });
    const conflict = t.take(d => d.type === ACK && d.status === 'FAILED');
    assert.equal(conflict.data.count, 0); assert.deepEqual(c.phase3Runtime.queue.snapshot(), pending);
    t.deliver({ id: 999, data: { ...second.data, operationId: 999,
        owner: { ...second.data.owner, stream: 999 } } });
    const unknown = t.take(d => d.type === ACK && d.operationId === 999);
    assert.equal(unknown.data.status, 'NOT_APPLIED_UNKNOWN');
    assert.deepEqual(c.phase3Runtime.queue.snapshot(), pending);
    t.deliver(conflict); t.flush(); assert.equal(c.replayAccountingStatus().accountingComplete, false);
});

test('STEP2 Runtime unknown entry blocks every selective mutation and closure', async () => {
    const s = await fixture(true, { holdTypes: [CLEAR] }), c = s.c, t = c.transportFixture;
    c.phase3Runtime.enqueue({ pendingOwner: null }, { id: 'unknown', enqueuedAt: 0,
        rendererType: 'liveChatTextMessageRenderer', footprint: {} });
    const before = c.phase3Runtime.queue.snapshot();
    t.held.delete(CLEAR); t.flush();
    assert.deepEqual(c.phase3Runtime.queue.snapshot(), before);
    assert.equal(c.replayAccountingStatus().accountingComplete, false);
    assert.ok([...c.replayPendingClearOperations.values()].every(op => !op.resolved));
});

test('STEP2 missing ACK holds terminal; reversed late ACK closes only old scope and duplicates cannot mutate archive', async () => {
    const s = await fixture(true, { holdTypes: [ACK] }), c = s.c, t = c.transportFixture;
    assert.equal(c.phase3Runtime.status().pendingCount, 0);
    assert.equal(c.replayAccountingStatus().lostUnaccounted, 0);
    assert.equal(c.replayAccountingStatus().accountingComplete, false);
    c.closeReplayDiagnosticScope(); t.flush();
    assert.equal(c.replayAccountingStatus().diagnosticScope.scopes[0].state, 'INCOMPLETE');
    const previous = c.openReplayDiagnosticScope(); c.postReplayDiagnosticScope(previous); t.flush();
    const acks = [t.take(d => d.type === ACK), t.take(d => d.type === ACK)];
    t.deliver(acks[1]); assert.equal(c.replayAccountingStatus().accountingComplete, false);
    t.deliver(acks[0]); t.flush();
    const a = c.replayAccountingStatus();
    assert.equal(a.diagnosticScope.scopes[0].state, 'CLOSED'); assert.equal(a.accountingComplete, true);
    assert.equal(a.stages.scheduler.input, 0); assert.equal(a.stages.scheduler.explicitRemoval, 0);
    assert.equal(a.stages.temporal.input, 0); // Empty new scope is not a new READ success.
    const old = JSON.stringify(a.diagnosticScope.scopes[0]);
    t.deliver(acks[0]); t.deliver(acks[1]);
    assert.equal(JSON.stringify(c.replayAccountingStatus().diagnosticScope.scopes[0]), old);
});

test('STEP2 ACK before event snapshot cannot resolve counters; terminal first buffers until event sequence arrives', async () => {
    const s = await fixture(true, { holdTypes: [CLEAR, ACK] }), c = s.c, t = c.transportFixture;
    t.held.add(c.REPLAY_PIPELINE_DIAGNOSTIC_TYPE);
    t.held.delete(CLEAR); t.flush(); // Remove pending, but hold every associated snapshot.
    const acks = [t.take(d => d.type === ACK), t.take(d => d.type === ACK)];
    acks.reverse().forEach(p => t.deliver(p));
    assert.ok([...c.replayPendingClearOperations.values()].every(op => !op.resolved));
    c.closeReplayDiagnosticScope(); const terminal = t.take(d => d.diagnosticTerminal === true);
    t.deliver(terminal); assert.equal(c.replayAccountingStatus().accountingComplete, false);
    t.held.delete(c.REPLAY_PIPELINE_DIAGNOSTIC_TYPE); t.flush();
    const a = c.replayAccountingStatus();
    assert.equal(a.accountingComplete, true); assert.equal(a.diagnosticScope.scopes[0].state, 'CLOSED');
    assert.equal(a.lostUnaccounted, 0); assert.equal(a.overflowUnaccounted, 0);
});

for (const mismatch of ['scope', 'count', 'owner']) test('STEP2 mismatched ' + mismatch + ' ACK stays incomplete without inventing removal', async () => {
    const s = await fixture(true, { holdTypes: [ACK] }), c = s.c, t = c.transportFixture;
    const ack = t.take(d => d.type === ACK), before = c.replayPipelineDiagnostic.schedulerLifecycleDiscarded;
    const data = { ...ack.data };
    if (mismatch === 'scope') data.epoch += 1;
    if (mismatch === 'count') data.count += 1;
    if (mismatch === 'owner') data.owner = { ...data.owner, stream: 999 };
    t.deliver({ ...ack, data });
    assert.equal(c.replayAccountingStatus().accountingComplete, false);
    assert.equal(c.replayPipelineDiagnostic.schedulerLifecycleDiscarded, before);
    t.deliver(ack); t.held.delete(ACK); t.flush();
    assert.equal(c.replayAccountingStatus().accountingComplete, false); // Conflicting truth is not silently cleared.
});

test('STEP2 delayed old CLEAR cannot remove a new owner queue; already removed owner is proven stale', async () => {
    const s = await fixture(true, { holdTypes: [CLEAR] }), c = s.c, t = c.transportFixture;
    s.h.accept([{ id: 'new-stream', messageType: 'text', replayOffsetMsec: 5000 }], true); t.flush();
    const survivor = c.phase3Runtime.queue.snapshot().at(-1);
    t.held.delete(CLEAR); t.flush();
    assert.equal(c.phase3Runtime.status().pendingCount, 1); assert.equal(c.phase3Runtime.queue.snapshot()[0], survivor);
    assert.equal(c.replayAccountingStatus().accountingComplete, true);
    const entry = [...c.replayContentPendingOwners.values()][0];
    const before = c.phase3Runtime.queue.snapshot();
    t.deliver({ id: 1000, data: { source: 'liveflow-page-state', type: CLEAR,
        document: entry.owner.document, operationId: 1000, owner: entry.owner, reason: 'FAIL_CLOSED',
        epoch: entry.epoch, lifecycle: entry.lifecycle } }); t.flush();
    assert.deepEqual(c.phase3Runtime.queue.snapshot(), before);
    assert.equal(c.replayContentClearOperations.get(entry.owner.document + ':1000').status, 'STALE_OR_NOT_FOUND');
});

test('STEP2 bounded MAIN registry exhaustion retains pending truth and fails incomplete', async () => {
    const s = await fixture(true, { beforeReanchor(c) {
        for (let i = 0; i < 64; i++) c.replayPendingClearOperations.set(100 + i, { resolved: false });
    } });
    assert.equal(s.c.replayPending.length, 0); assert.equal(s.c.phase3Runtime.status().pendingCount, 3);
    assert.equal(s.c.replayAccountingStatus().accountingComplete, false);
    assert.equal(s.c.replayPendingClearOperations.size, 64);
});

test('STEP2 bounded Content registry exhaustion does not evict or mutate pending', async () => {
    const s = await fixture(true, { holdTypes: [CLEAR] }), c = s.c, t = c.transportFixture;
    for (let i = 0; i < 64; i++) c.replayContentClearOperations.set('held:' + i, { status: 'FAILED' });
    const before = c.phase3Runtime.queue.snapshot();
    t.held.delete(CLEAR); t.flush();
    assert.deepEqual(c.phase3Runtime.queue.snapshot(), before);
    assert.equal(c.replayContentClearOperations.size, 64);
    assert.equal(c.replayAccountingStatus().accountingComplete, false);
});

test('STEP2 foreign document ACK and changed media binding cannot reconcile or clear another owner', async () => {
    const s = await fixture(true, { holdTypes: [CLEAR, ACK] }), c = s.c, t = c.transportFixture;
    const command = t.take(d => d.type === CLEAR);
    const snapshot = c.phase3Runtime.queue.snapshot();
    c.getCurrentMainMedia = () => ({ video: {} });
    t.deliver(command); t.flush();
    const ack = t.take(d => d.type === ACK);
    assert.equal(ack.data.status, 'NOT_APPLIED_UNKNOWN'); assert.equal(ack.data.count, 0);
    assert.deepEqual(c.phase3Runtime.queue.snapshot(), snapshot);
    t.deliver({ ...ack, data: { ...ack.data, document: 'OTHER_DOCUMENT' } });
    assert.equal(c.replayPendingClearOperations.get(command.data.operationId).resolved, false);
    assert.equal(c.replayAccountingStatus().accountingComplete, false);
});
