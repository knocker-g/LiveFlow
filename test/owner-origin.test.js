const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fixtures/acquisition-harness');
const { createPrivatePendingScope } = require('../src/private-pending-scope');
const { createPrivateSchedulerRuntime } = require('../src/scheduler-runtime');
const { createContentHandoff } = require('../src/youtube-chat');
const { createOccurrenceProvenance } = require('../src/occurrence-provenance');
const pending = require('../src/pending-selection');
const scopeCore = require('../src/diagnostic-scope-core');
const geometry = require('../src/geometry-adapter');
const overlay = require('../src/overlay-core');

function setup(kind = 'replay', options = {}) {
    const fixture = load(kind === 'native' ? 'acquisition-owner-recovery.test.js'
        : kind === 'live' ? 'acquisition-owner.test.js' : 'acquisition-owner-replay.test.js');
    const batches = [], events = [], evaluations = [], opportunities = [], allocations = { traces: 0, ownerLeases: 0 };
    let port, view, runtime, content, h;
    const video = {}, player = { classList: { contains: () => false } };
    const c = { currentMessages: [], currentChatMode: kind === 'live' ? 'live' : 'replay',
        currentPageKey: '', currentPageRevision: kind === 'native' ? 0 : 1,
        currentPageLifecycleGeneration: kind === 'native' ? 0 : 1, rendererGeneration: 0,
        runtimeSettings: {}, replayDiagnosticBatch: {}, replayDiagnosticBatchInProgress: false,
        livePresentationResumeGateActive: false };
    const mode = c.currentChatMode;
    const config = { configure(config) {
        if (options.missingTemporal) config.core = { ...config.core, selectReplayTemporalWithTrace: undefined };
        const createTrace = config.core.createReplayTemporalTrace;
        config.core = { ...config.core, createReplayTemporalTrace(...args) { allocations.traces++; return createTrace(...args); } };
        const epoch = kind === 'native' ? 0 : 1;
        const p = createPrivatePendingScope({ document: config.document, route: config.route, targetId: 'target',
            lifecycle: epoch, revision: epoch, pending, scopeCore,
            createRuntime(settings) {
                runtime = createPrivateSchedulerRuntime(settings, (item, outcome) => evaluations.push({ item, outcome })).runtime;
                c.phase3Runtime = runtime; return runtime;
            }, runtimeOptions: { clock: () => 1000, generation: () => 0,
                scheduleOneShot: fn => { opportunities.push(fn); return opportunities.length; }, cancelOneShot() {},
                geometryAdapter: geometry.createSubtitleGeometryAdapter({ authority: geometry.createGeometryAuthority({ epsilon: 1 }),
                    readGeometry: () => ({ state: 'UNKNOWN', capabilityAvailable: true }) }),
                candidateProof() { throw Error('unobserved geometry'); }, launch() { throw Error('no launch'); },
                config: { maxPendingAge: 1000, maxPendingCount: 2000, pendingPressureCapacity: 2000,
                    scanDepth: 5, cohortMaximumItems: 5, cohortMaximumSpan: 800, density: { minimumAttackResidence: 1 } } }
        });
        assert.ok(p);
        config.pendingScopePort = { connect(...args) {
            view = p.connect(...args);
            return Object.freeze({ ...view, lease(...args) { allocations.ownerLeases++; return view.lease(...args); } });
        } };
        config.provenance = { connect(value) {
            port = value;
            content = createContentHandoff({ state: c, pending, overlayCore: overlay,
                phase5Tuning: { lineHeight: 32 }, performance: { now: () => 1000 },
                isEffectiveDisplayActive: () => options.display !== false,
                getCurrentMainMedia: () => ({ player: kind === 'native' ? h.f.player : player,
                    video: kind === 'native' ? h.f.video : video }),
                ensurePhase3Runtime: () => runtime, ensureSubtitleGeometryObservers() {}, ensurePlaybackContextObserver() {},
                cleanupOverlay() { throw Error('unexpected renderer replacement'); },
                observeLivePresentationBatch() {}, publishReplaySchedulerDiagnostic() {}, rememberReplayPendingOwner() {},
                privateEntry: { ...value, onDisposition(identity, event) {
                    const original = value.recognizeOccurrence(event.occurrence);
                    events.push({ identity, event, original });
                } }
            });
        } };
        config.onBatch = (messages, scope, handle) => {
            c.phase3RuntimeVideo = kind === 'native' ? h.f.video : video;
            const identity = port.recognizeBatch(handle);
            batches.push({ messages, scope, handle, identity });
            if (options.throwHandoff) throw options.throwHandoff;
            if (handle) {
                assert.equal(content.registerBatch(handle), true); content.processRegisteredBatch(handle);
            } else {
                // Diagnostics exhaustion cannot suppress actual accepted presentation.
                const lease = view.resolveLease(view.lease(scope));
                content.processLegacySuccess(messages, lease?.pendingOwner);
            }
        };
        if (options.provenance === false) {
            delete config.provenance;
            config.onBatch = function (messages, scope, diagnosticHandle, productLease) {
                batches.push({ messages, scope, diagnosticHandle, productLease, argumentCount: arguments.length });
            };
        }
    } };
    h = fixture.harness(config);
    if (kind !== 'native') {
        Object.assign(h.facts.video, { paused: false, ended: false, readyState: 4 });
        Object.assign(video, h.facts.video);
    }
    return { h, fixture, batches, events, evaluations, c, allocations, get port() { return port; }, get view() { return view; },
        get runtime() { return runtime; }, get content() { return content; }, mode,
        fireScheduler() { opportunities.shift()?.(); } };
}
async function answer(s, index, payload) {
    if (s.h.answer) await s.h.answer(index, payload);
    else { s.h.requests[index].resolve({ status: 200, json: async () => payload }); await new Promise(r => setImmediate(r)); }
}

test('Live accepted origin carries actual consumed ticket/owner binding and genuine association', async () => {
    const s = setup('live'); await s.h.bootstrap(); s.h.clock.fire();
    const payload = s.fixture.payload('next');
    payload.continuationContents.liveChatContinuation.actions = [{ addChatItemAction: { item: {
        liveChatTextMessageRenderer: { id: 'live', message: { runs: [{ text: 'fixture' }] } }
    } } }];
    await answer(s, 0, payload);
    assert.equal(s.events.length, 1); const e = s.events[0];
    assert.equal(e.original.origin.ticket.accepted, true);
    assert.equal(e.original.origin.ticket.controller.signal, s.h.requests[0].request.signal);
    assert.equal(e.original.origin.document, s.h.document);
    assert.equal(e.original.origin.authorityBinding, e.original.origin.binding);
    assert.equal(e.event.occurrence, s.batches[0].identity.occurrences[0]);
    assert.equal(e.event.item, s.runtime.queue.snapshot()[0]);
    s.h.owner.cancel();
});
test('Replay two future-only tickets wait unassigned and join one actual due handoff', async () => {
    const s = setup(), h = s.h; await h.bootstrap();
    assert.equal(s.view.status().scopes.length, 0);
    assert.equal(h.owner.status().pendingScopeFault, false);
    await answer(s, 0, s.fixture.payload([5000], 'first', 'seek1'));
    assert.equal(s.view.status().scopes.length, 0); assert.equal(h.owner.status().accepted, 1);
    await h.advance(1000); assert.equal(h.requests.length, 2);
    await answer(s, 1, s.fixture.payload([6000], 'second', 'seek2'));
    assert.equal(h.owner.status().accepted, 2); assert.equal(h.owner.status().pending, 2);
    assert.equal(s.port.observationStatus().origins, 2);
    assert.equal(s.view.status().scopes.length, 0); assert.equal(s.batches.length, 0);
    assert.equal(h.owner.status().pendingScopeFault, false, 'known unassigned future is not a failed Scope open');
    h.facts.currentTime = 6; await h.advance(2000);
    assert.equal(s.view.status().scopes.length, 1); assert.equal(s.batches.length, 1);
    const batch = s.batches[0], entries = batch.identity.occurrences.map(s.port.recognizeOccurrence);
    assert.equal(entries.length, 2); assert.notEqual(entries[0].origin.ticket, entries[1].origin.ticket);
    assert.notEqual(entries[0].origin.response, entries[1].origin.response);
    assert.equal(entries[0].association.scope, entries[1].association.scope);
    assert.equal(entries[0].origin.authorityBinding, entries[1].origin.authorityBinding);
    assert.ok(entries.every(e => e.origin.ticket.accepted === true));
    assert.equal(entries[0].origin.ticket.controller.signal, h.requests[0].init.signal);
    assert.equal(entries[1].origin.ticket.controller.signal, h.requests[1].init.signal);
    assert.deepEqual(entries.map(e => e.message), batch.messages);
    assert.deepEqual(s.events.map(e => e.event.occurrence), batch.identity.occurrences);
    assert.ok(s.events.every(e => e.event.item.payload.settingsSnapshot === s.c.runtimeSettings));
    h.owner.cancel();
});
test('provenance-absent legacy Owner keeps original early Scope and two-argument handoff', async () => {
    const s = setup('replay', { provenance: false }), h = s.h;
    assert.equal(s.view.status().scopes.length, 1); assert.equal(h.requests.length, 0);
    await h.bootstrap(); await answer(s, 0, s.fixture.payload([5000], 'first', 'seek'));
    assert.equal(s.batches.length, 0); assert.equal(s.view.status().scopes.length, 1);
    h.facts.currentTime = 6; await h.advance(1000);
    assert.equal(s.batches[0].argumentCount, 4); assert.equal(s.view.status().scopes.length, 1);
    assert.equal(s.batches[0].diagnosticHandle, null);
    assert.equal(s.view.resolveProductLease(s.batches[0].productLease).scope, s.batches[0].scope);
    assert.ok(s.batches[0].scope); assert.equal(s.allocations.traces, 0); h.owner.cancel();
});
test('empty accepted Live response creates no synthetic Presentation Scope', async () => {
    const s = setup('live'); await s.h.bootstrap(); s.h.clock.fire();
    await answer(s, 0, s.fixture.payload('next'));
    assert.equal(s.h.owner.status().accepted, 1); assert.equal(s.batches[0].messages.length, 0);
    assert.equal(s.view.status().scopes.length, 0); assert.equal(s.allocations.ownerLeases, 0);
    s.h.owner.cancel();
});
test('native SEEK retires old Scope and replaces future while old item retains original association', async () => {
    const s = setup('native'), h = s.h; await h.bootstrap();
    await answer(s, 0, s.fixture.payload([0, 5000], 'old', 'seek'));
    const old = s.events[0], oldScope = old.original.association.scope;
    h.seeking(true, 30); h.seeking(false, 30); await h.tick();
    await answer(s, 1, s.fixture.payload([30000, 35000], 'fresh', 'seek2'));
    assert.notEqual(s.events.at(-1).original.association.scope, oldScope);
    assert.equal(s.port.recognizeOccurrence(old.event.occurrence).association.scope, oldScope);
    assert.equal(s.content.registerBatch(s.batches[0].handle), false);
    assert.equal(h.owner.status().pending, 1); h.owner.cancel();
});
test('actual abort/stale response creates no accepted origin or handoff', async () => {
    for (const stale of [false, true]) {
        const s = setup(); await s.h.bootstrap();
        if (stale) s.h.facts.revision++; else s.h.owner.cancel();
        await answer(s, 0, s.fixture.payload([0], 'late'));
        assert.equal(s.batches.length, 0); assert.equal(s.port.observationStatus().origins, 0);
    }
});
test('actual interrupted parser response cannot publish accepted origin prefix', async () => {
    const s = setup(); await s.h.bootstrap();
    const body = s.fixture.payload([0, 5000], 'partial', 'seek');
    const renderer = body.continuationContents.liveChatContinuation.actions[1].replayChatItemAction.actions[0]
        .addChatItemAction.item.liveChatTextMessageRenderer;
    Object.defineProperty(renderer, 'authorName', { get() { throw new Error('interrupted parser'); } });
    await answer(s, 0, body);
    assert.equal(s.h.owner.status().accepted, 0); assert.equal(s.batches.length, 0);
    assert.equal(s.port.observationStatus().origins, 0); assert.equal(s.h.requests.length, 1);
});
test('actual COVERAGE_HOLE retains original future origin through repair merge', async () => {
    const s = setup('native'), h = s.h; await h.bootstrap();
    await answer(s, 0, s.fixture.payload([0, 60000], 'first', 'seek1'));
    const firstOrigin = s.events[0].original.origin, scope = s.batches[0].scope;
    h.drain(); await h.tick(); assert.equal(h.owner.status().lastReanchor, 'COVERAGE_HOLE');
    await answer(s, 1, s.fixture.payload([0, 500], 'repair', 'seek2'));
    assert.equal(h.owner.status().temporalReplaced, 0);
    h.f.value(h.f.video).position = 60; await h.tick();
    const retained = s.events.find(e => e.original.message.replayOffsetMsec === 60000);
    assert.ok(retained); assert.equal(retained.original.origin, firstOrigin);
    assert.equal(retained.original.association.scope, scope); h.owner.cancel();
});
test('actual Temporal capacity discard records original occurrences exactly once', async () => {
    const s = setup(), h = s.h; await h.bootstrap();
    await answer(s, 0, s.fixture.payload([0, ...Array.from({ length: 102 }, (_, i) => (i + 1) * 1000)], 'large', 'seek'));
    assert.equal(h.owner.status().pending, 100); assert.equal(h.owner.status().temporalDropped, 2);
    assert.equal(s.port.observationStatus().dispositions.CAPACITY_DROPPED, 2);
    h.owner.cancel();
    assert.equal(s.port.observationStatus().dispositions.OWNER_TERMINAL, 100);
});
test('same-ID messages from different accepted responses never substitute for origin identity', async () => {
    const s = setup(), h = s.h; await h.bootstrap();
    await answer(s, 0, s.fixture.payload([0, 5000], 'first', 'seek1'));
    const original = s.events[0].original.origin;
    await h.advance(1000);
    const second = s.fixture.payload([0, 6000], 'second', 'seek2');
    second.continuationContents.liveChatContinuation.actions[1].replayChatItemAction.actions[0]
        .addChatItemAction.item.liveChatTextMessageRenderer.id = 'first-1';
    await answer(s, 1, second);
    assert.equal(s.port.observationStatus().dispositions.DEDUPLICATED, 1);
    h.facts.currentTime = 6; await h.advance(2000);
    assert.equal(s.events.at(-1).original.origin, original); h.owner.cancel();
});
test('missing source evidence and forged registration remain UNKNOWN without suppressing accepted Product', async () => {
    const s = setup('replay', { missingTemporal: true }); await s.h.bootstrap();
    await answer(s, 0, s.fixture.payload([0], 'first', 'seek'));
    assert.equal(s.batches.length, 1); assert.equal(s.batches[0].handle, null);
    assert.equal(s.runtime.queue.snapshot().length, 1);
    assert.equal(s.content.registerBatch({}), false);
    assert.equal(s.port.observationStatus().state, 'UNKNOWN');
    assert.equal(s.h.owner.status().accepted, 1); s.h.owner.cancel();
});
test('actual accepted Live overflow leaves Product batch/queue and request count unchanged', async () => {
    const s = setup('live'); await s.h.bootstrap(); s.h.clock.fire();
    const body = s.fixture.payload('next');
    body.continuationContents.liveChatContinuation.actions = Array.from({ length: 1025 }, (_, i) => ({
        addChatItemAction: { item: { liveChatTextMessageRenderer: { id: String(i), message: { runs: [{ text: 'fixture' }] } } } }
    }));
    await answer(s, 0, body);
    assert.equal(s.batches[0].messages.length, 1025); assert.equal(s.batches[0].handle, null);
    assert.equal(s.runtime.queue.snapshot().length, 1025); assert.equal(s.h.requests.length, 1);
    assert.equal(s.port.observationStatus().state, 'UNKNOWN');
    assert.equal(s.port.observationStatus().occurrences, 0); s.h.owner.cancel();
});
test('Replay overflow stops Owner trace/lease allocation while retaining actual Temporal decisions', async () => {
    const s = setup(); await s.h.bootstrap();
    await answer(s, 0, s.fixture.payload([0, ...Array.from({ length: 1024 }, (_, i) => (i + 1) * 1000)], 'many', 'seek'));
    assert.equal(s.h.owner.status().accepted, 1); assert.equal(s.h.owner.status().pending, 100);
    assert.equal(s.h.owner.status().temporalDropped, 924);
    assert.equal(s.allocations.traces, 0); assert.equal(s.allocations.ownerLeases, 0);
    assert.equal(s.batches[0].messages.length, 1); assert.equal(s.runtime.queue.snapshot().length, 1);
    assert.equal(s.h.requests.length, 1); assert.equal(s.port.observationStatus().state, 'UNKNOWN');
    s.port.onFault('private unapproved diagnostic text');
    assert.equal(JSON.stringify(s.port.observationStatus()).includes('private unapproved'), false);
    assert.ok(s.port.observationStatus().faults.includes('UNKNOWN_FAULT')); s.h.owner.cancel();
});
test('accepted response remains accepted after actual private handoff throws', async () => {
    const marker = new Error('handoff'), s = setup('replay', { throwHandoff: marker });
    await s.h.bootstrap(); await answer(s, 0, s.fixture.payload([0], 'next', 'seek'));
    const original = s.port.recognizeOccurrence(s.batches[0].identity.occurrences[0]);
    assert.equal(original.origin.ticket.accepted, true); assert.equal(s.h.owner.status().accepted, 1);
});
test('Content duplicate/Display/media handling reuses genuine input occurrence and actual item join', async () => {
    const s = setup('replay', { display: false }); await s.h.bootstrap();
    await answer(s, 0, s.fixture.payload([0], 'one', 'seek'));
    assert.equal(s.events[0].event.disposition, 'DISPLAY_SUPPRESSED');
    assert.equal(s.events[0].event.occurrence, s.batches[0].identity.occurrences[0]);
    assert.equal(s.runtime.queue.snapshot().length, 0); s.h.owner.cancel();
});
test('actual origin registry preserves repeated message references as separate output positions', () => {
    const registry = createOccurrenceProvenance({ owner: {}, document: {}, binding: {} }), ticket = {}, shared = {};
    const handles = registry.accept(ticket, {}, [shared, shared]);
    assert.notEqual(handles[0], handles[1]); assert.equal(registry.lookup(handles[0]).origin.ticket, ticket);
    assert.equal(registry.lookup(handles[0]).origin, registry.lookup(handles[1]).origin);
    assert.equal(registry.lookup(handles[0]).association, 'KNOWN_UNASSIGNED');
    assert.deepEqual(handles.map(h => registry.lookup(h).position), [0, 1]);
});
test('64/1024 evidence limits and no-reopen overflow do not impose Product limits', () => {
    const a = createOccurrenceProvenance({ owner: {}, document: {}, binding: {} });
    for (let i = 0; i < 64; i++) assert.equal(a.accept({}, {}, [{}]).length, 1);
    assert.equal(a.accept({}, {}, [{}]), null); assert.equal(a.status().origins, 64);
    const b = createOccurrenceProvenance({ owner: {}, document: {}, binding: {} });
    const handles = b.accept({}, {}, Array.from({ length: 1024 }, () => ({})));
    assert.equal(handles.length, 1024); assert.equal(b.accept({}, {}, [{}]), null);
    b.discard(handles, 'TEMPORAL_REPLACED');
    assert.equal(b.status().occurrences, 0); assert.equal(b.accept({}, {}, [{}]), null);
    assert.equal(b.status().state, 'UNKNOWN');
});
test('private registry terminal observation is once-only even under reentry/failure', () => {
    let registry, handles; let observed = 0;
    registry = createOccurrenceProvenance({ owner: {}, document: {}, binding: {}, observe() {
        observed++; registry.discard(handles, 'TEMPORAL_REPLACED'); throw Error('receiver');
    } });
    handles = registry.accept({}, {}, [{}]); registry.discard(handles, 'TEMPORAL_REPLACED');
    assert.equal(observed, 1); assert.equal(registry.status().dispositions.TEMPORAL_REPLACED, 1);
    assert.equal(registry.status().state, 'UNKNOWN');
    let delivered = 0;
    registry.deliver(() => registry.deliver(() => { delivered++; }));
    assert.equal(delivered, 1); assert.equal(registry.isDelivering(), false);
});
test('genuine Scope leases cannot be forged or rebound after retirement', async () => {
    const s = setup(); await s.h.bootstrap(); await answer(s, 0, s.fixture.payload([0], 'one', 'seek'));
    const b = s.batches[0]; assert.equal(s.view.resolveLease({}), null);
    const lease = s.view.lease(b.scope); assert.ok(s.view.resolveLease(lease));
    s.h.facts.capability = false; assert.equal(s.port.isCurrent(b.identity), false); s.h.facts.capability = true;
    const other = createContentHandoff({ state: {}, pending, privateEntry: s.port });
    assert.equal(other.registerBatch(b.handle), true);
    other.processRegisteredBatch(b.handle);
    assert.equal(other.observationStatus().state, 'UNKNOWN');
    assert.equal(s.runtime.queue.snapshot().length, 1, 'a second factory cannot enqueue the consumed original batch');
    assert.equal(s.port.claimBatch(b.identity), false, 'another receiver cannot replay an already processed original batch');
    assert.equal(s.port.claimBatch({ ...b.identity }), false, 'lookalike records are not original registrations');
    s.view.retire(b.scope); assert.equal(s.view.resolveLease(lease), null);
    assert.equal(s.port.isCurrent(b.identity), false); s.h.owner.cancel();
});
test('actual Scheduler C1S evaluation resolves exact original admitted item and occurrence', async () => {
    const s = setup(); await s.h.bootstrap(); await answer(s, 0, s.fixture.payload([0], 'one', 'seek'));
    const receipt = s.events[0]; s.fireScheduler();
    assert.equal(s.evaluations.length, 1); assert.equal(s.evaluations[0].outcome, 'GEOMETRY_UNKNOWN');
    assert.equal(s.evaluations[0].item, receipt.event.item);
    assert.equal(s.port.recognizeOccurrence(receipt.event.occurrence).origin, receipt.original.origin);
    assert.equal(s.runtime.queue.snapshot().length, 1); s.h.owner.cancel();
});
test('actual renderer native late settlement retains original owner occurrence/Scope after recovery', async () => {
    const { fixture, settle } = load('renderer-lifecycle-seam.test.js', ['fixture', 'settle']);
    const s = setup('native'); await s.h.bootstrap(); await answer(s, 0, s.fixture.payload([0, 5000], 'one', 'seek'));
    const original = s.events[0], attemptOrigins = new WeakMap(); let settled;
    const renderer = fixture({ onTerminal(identity) { settled = attemptOrigins.get(identity.attempt); } });
    const lease = renderer.lease(original.original.association.scope, s.batches[0].identity.pendingOwner);
    attemptOrigins.set(lease.attempt, original);
    assert.equal(renderer.render({ binding: lease, msg: original.original.message }).status, 'rendered');
    s.h.seeking(true, 30); s.h.seeking(false, 30); await s.h.tick();
    await answer(s, 1, s.fixture.payload([30000], 'fresh', 'seek2'));
    assert.notEqual(s.batches.at(-1).scope, lease.scope);
    renderer.animations[0].resolve(); await settle();
    assert.equal(settled, original); assert.equal(renderer.events.at(-1)[1].scope, lease.scope);
    assert.equal(renderer.state.activeDanmaku.size, 0); s.h.owner.cancel();
});
