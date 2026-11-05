const assert = require('node:assert/strict');
const { load } = require('./acquisition-harness');
const { createPrivatePendingScope } = require('../../src/private-pending-scope');
const runtimeCore = require('../../src/scheduler-runtime');
const { createContentHandoff } = require('../../src/youtube-chat');
const pending = require('../../src/pending-selection');
const scopeCore = require('../../src/diagnostic-scope-core');
const geometry = require('../../src/geometry-adapter');
const overlay = require('../../src/overlay-core');
const tuning = require('../../src/phase5-tuning');

function setup(options = {}) {
    const mode = options.native ? 'replay' : options.mode || 'live', observed = options.observed !== false;
    const f = load(options.native ? 'acquisition-owner-recovery.test.js' : mode === 'live' ? 'acquisition-owner.test.js' : 'acquisition-owner-replay.test.js');
    const rendererFixture = load('renderer-lifecycle-seam.test.js', ['fixture', 'settle']);
    const log = [], batches = [], jobs = [], originalItems = new WeakMap(), pendingOperations = [];
    let h, ownerPort, retire, content, runtime, privateRuntime, view, request, collector, lifetime, lifetimePending;
    let generationRegistry, runtimeConfiguration;
    const call = (kind, proof, value) => {
        if (proof) { log.push({ kind, proof }); if (options.dropCollectorKind !== kind) collector?.observe(kind, proof); }
        return options[kind]?.(value, proof, api);
    };
    const r = rendererFixture.fixture({ observed, animationMode: options.animationMode,
        runtimeObserver: options.generations ? proof => generationRegistry.observeDetached(proof) : undefined,
        onCommit(id, proof) { call('renderer', proof, id); },
        onTerminal(id, outcome, cancel, proof) { call('renderer', proof, id); },
        onFault(id, reason) { options.onFault?.(id, reason); } });
    // The existing fixture's default receiver wrappers intentionally preserve
    // legacy arity; install proof-aware receivers at factory construction.
    if (observed) {
        r.dependencies.observer.onCommit = (id, proof) => { r.events.push(['commit', id]); return options.generations ? generationRegistry.observeRenderer(proof) : call('renderer', proof, id); };
        r.dependencies.observer.onTerminal = (id, outcome, cancel, proof) => { r.events.push(['terminal', id, outcome, cancel]); return options.generations ? generationRegistry.observeRenderer(proof) : call('renderer', proof, id); };
    }
    const state = { currentMessages: [], currentChatMode: mode, currentPageKey: '', currentPageRevision: 1,
        currentPageLifecycleGeneration: 1, rendererGeneration: 0, runtimeSettings: {},
        replayDiagnosticBatch: {}, replayDiagnosticBatchInProgress: false, livePresentationResumeGateActive: false };
    const api = { log, batches, r, state, mode, pendingOperations, get h() { return h; }, get ownerPort() { return ownerPort; },
        get retire() { return retire; }, get content() { return content; }, get runtime() { return runtime; },
        get scheduler() { return privateRuntime; }, get view() { return view; },
        get collector() { return collector; },
        get lifetime() { return lifetime; },
        get lifetimePending() { return lifetimePending; },
        get generations() { return generationRegistry; },
        get runtimeConfiguration() { return runtimeConfiguration; },
        recreateRuntime() { r.renderer.cleanupOverlay(); generationRegistry.drain(); return ensureRuntime(); },
        async start() { await h.bootstrap(); if (mode === 'live') h.clock.fire(); },
        async answer(payload, index = 0) { if (h.answer) await h.answer(index, payload);
            else { h.requests[index].resolve({ status: 200, json: async () => payload }); await new Promise(resolve => setImmediate(resolve)); } },
        payload(ids = ['one'], next = 'next', offsets = ids.map(() => 0)) {
            const p = mode === 'live' ? f.payload(next) : f.payload(offsets, next, 'seek-' + next);
            if (mode === 'live') p.continuationContents.liveChatContinuation.actions = ids.map(id => ({ addChatItemAction: { item: {
                liveChatTextMessageRenderer: { id, message: { runs: [{ text: 'fixture' }] } }
            } } }));
            return p;
        },
        tick() { jobs.shift()?.(); },
        consumeAll() { return log.splice(0).map(e => ({ ...e, accepted: retire.consume(e.kind, e.proof) })); },
        async settle(index = 0, reject = false) { reject ? r.animations[index].reject(Error('native fixture')) : r.animations[index].resolve(); await rendererFixture.settle(); },
        originals: originalItems };
    h = f.harness({ configure(config) {
        const epoch = options.native ? 0 : 1;
        state.currentPageRevision = epoch; state.currentPageLifecycleGeneration = epoch;
        if (options.native) config.readPendingCount = () => runtime?.queue.snapshot().length;
        const scopePort = createPrivatePendingScope({ document: config.document, route: config.route, targetId: 'target', lifecycle: epoch, revision: epoch,
            pending, scopeCore, runtimeGenerations: options.generations === true,
            readRuntimeCoverage: () => generationRegistry?.status().state === 'OBSERVING',
            createRuntime(settings) {
                if (options.generations) {
                    runtimeConfiguration = settings;
                    return Object.freeze({
                        queue: Object.freeze({ snapshot: () => generationRegistry?.pendingRuntime.queue.snapshot() || [],
                            successfulLaunchSequence: () => generationRegistry?.pendingRuntime.queue.successfulLaunchSequence() || 0 }),
                        status: () => generationRegistry?.pendingRuntime.status() || { state: 'IDLE', pendingCount: 0 },
                        enqueue: (...args) => generationRegistry.pendingRuntime.enqueue(...args),
                        removePendingOwner: (...args) => generationRegistry.pendingRuntime.removePendingOwner(...args)
                    });
                }
                if (observed) {
                    privateRuntime = runtimeCore.createPrivateSchedulerRuntime(settings, (item, outcome, proof) => {
                        if (options.collector) call('evaluation', proof, { item, outcome });
                    }, (event, proof) => {
                        if (event.type === 'LAUNCH_REQUESTED') request = event;
                        return call('item', proof, event);
                    }); runtime = privateRuntime.runtime;
                } else runtime = runtimeCore.createSchedulerRuntime(settings);
                if (options.enqueueError || options.rejectEnqueue) {
                    const actual = runtime;
                    runtime = Object.freeze({ ...actual, enqueue(...args) {
                        if (options.rejectEnqueue) return false;
                        if (options.partialEnqueue) actual.enqueue(...args);
                        throw options.enqueueError;
                    } });
                }
                return runtime;
            }, runtimeOptions: { clock: () => 1000, generation: () => 0, observe: event => options.generic?.(event, api),
                scheduleOneShot(fn) { jobs.push(fn); return fn; }, cancelOneShot(fn) { const i = jobs.indexOf(fn); if (i >= 0) jobs.splice(i, 1); },
                geometryAdapter: geometry.createSubtitleGeometryAdapter({ authority: geometry.createGeometryAuthority({ epsilon: 1 }),
                    readGeometry: () => ({ state: options.unknownGeometry ? 'UNKNOWN' : 'KNOWN_EMPTY', exclusionRegions: [], capabilityAvailable: true }) }),
                candidateProof: () => options.blocked ? { blockedReason: 'NO_USABLE_LANE' } : {
                    candidates: [{ rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 100 }, lane: 0, laneSpan: 1 }], activeComments: [] },
                launch(payload) {
                    if (!observed) return r.render({ msg: payload.message }).status === 'rendered';
                    const original = originalItems.get(request.item); assert.ok(original);
                    const binding = r.lease(original.association.scope, original.association.pendingOwner, request.attempt);
                    const result = r.render({ msg: payload.message, binding });
                    const proof = r.renderer.proofForAttempt?.(request.attempt);
                    if (proof) {
                        if (options.generations) generationRegistry.observeRenderer(proof);
                        else { log.push({ kind: 'renderer', proof }); collector?.observe('renderer', proof); }
                    }
                    return result.status === 'rendered';
                }, config: { maxPendingAge: 1000, maxPendingCount: 150, pendingPressureCapacity: 150,
                    scanDepth: 5, cohortMaximumItems: 5, cohortMaximumSpan: 800,
                    pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: .75 },
                    density: { attackThresholds: [.5,.7,.9], releaseThresholds: [.2,.3,.4], minimumAttackResidence: 1, releaseDwell: 3 },
                    collisionAllowances: tuning.CURRENT.collisionAllowances } } });
        config.pendingScopePort = { connect(...args) {
            view = scopePort.connect(...args);
            if (options.pendingTerminalError || options.pendingTerminalProbe) return { ...view, terminal(handle) {
                const result = view.terminal(handle);
                options.pendingTerminalProbe?.(handle, api);
                if (options.pendingTerminalError) throw options.pendingTerminalError;
                return result;
            } };
            return options.delayPendingRemoval ? { ...view, terminal(handle) {
                pendingOperations.push(view.retire(handle));
                return Object.freeze({ status: 'UNKNOWN', count: 0 });
            } } : view;
        } };
        function createContent(port) {
            content = createContentHandoff({ state, pending, overlayCore: overlay, phase5Tuning: { lineHeight: 32 }, performance: { now: () => 1000 },
                isEffectiveDisplayActive: () => options.display !== false, getCurrentMainMedia: () => ({ player: r.player, video: r.video }),
                ensurePhase3Runtime: () => options.missingRuntime ? null : options.generations ? ensureRuntime() : runtime, ensureSubtitleGeometryObservers() {}, ensurePlaybackContextObserver() {},
                cleanupOverlay() {}, observeLivePresentationBatch() {}, publishReplaySchedulerDiagnostic() {}, rememberReplayPendingOwner() {},
                privateEntry: port ? { ...port, onDisposition(identity, event, proof) {
                    if (event.item) originalItems.set(event.item, port.recognizeOccurrence(event.occurrence));
                    return options.generations ? generationRegistry.observeContent(proof) : call('content', proof, { identity, event });
                } } : undefined });
        }
        if (observed) config.provenance = {
            ...(options.temporal || options.collector ? { onTemporalTransition(event, proof) { return call('transition', proof, event); } } : {}),
            connect(port) {
                ownerPort = port;
                if (options.generations) {
                    generationRegistry = require('../../src/runtime-source-registry').createRuntimeSourceRegistry({
                        owner: port.readLifetime().owner, onProof(kind, proof) {
                            const event = kind === 'item' ? generationRegistry.itemSource.recognize(proof)?.event : null;
                            if (event?.type === 'LAUNCH_REQUESTED') request = event;
                            call(kind, proof, event);
                        } });
                    privateRuntime = Object.freeze({
                        recognizeProof: generationRegistry.itemSource.recognize,
                        recognizeEvaluationProof: generationRegistry.evaluationSource.recognize,
                        isProofDelivering: generationRegistry.itemSource.isDelivering,
                        observationStatus: () => ({ ...generationRegistry.evaluationSource.status(),
                            itemAttempts: generationRegistry.itemSource.coverage() })
                    });
                }
                if (options.retirement !== false) { retire = port.enableRetirement(); assert.ok(retire); }
                createContent(port);
                if (retire) for (const [kind, recognize, isDelivering] of [
                    ['audit', port.recognizeAuditProof, port.isProofDelivering],
                    ['content', content.recognizeProof, content.isProofDelivering],
                    ['item', privateRuntime.recognizeProof, privateRuntime.isProofDelivering],
                    ['renderer', r.renderer.recognizeProof, r.renderer.isProofDelivering]]) assert.equal(retire.bindSource(kind, { recognize, isDelivering }), true);
                if (options.collector) {
                    collector = require('../../src/ten-stage-collector').createTenStageCollector({
                        core: require('../../src/chat-read-core'), ownerPort: port, retirement: retire });
                    for (const [kind, recognize, isDelivering, status, coverage] of [
                        ['content', content.recognizeProof, content.isProofDelivering, content.observationStatus, content.proofCoverage],
                        ['item', privateRuntime.recognizeProof, privateRuntime.isProofDelivering, privateRuntime.observationStatus, () => privateRuntime.observationStatus().itemAttempts],
                        ['evaluation', privateRuntime.recognizeEvaluationProof, privateRuntime.isProofDelivering, privateRuntime.observationStatus, () => privateRuntime.observationStatus().attempts],
                        ['renderer', r.renderer.recognizeProof, r.renderer.isProofDelivering, r.renderer.observationStatus, r.renderer.proofCoverage]]) {
                        if (options.omitCollectorSource !== kind) assert.equal(collector.bindSource(kind, { recognize, isDelivering, status, coverage }), true);
                    }
                    if (options.lifetime) lifetime = require('../../src/private-lifetime').createPrivateLifetime({
                        collector, ownerPort: options.lifetimeOwnerPort || port, pendingView: { ...view, connectLifetime(reader) {
                            lifetimePending = view.connectLifetime(reader); return lifetimePending;
                        } } });
                    if (options.generations) assert.equal(generationRegistry.connect({ content, renderer: r.renderer, collector }), true);
                }
            },
            onParserAudit(event, proof) { return call('audit', proof, event); },
            onDisposition(event, proof) { return call('temporal', proof, event); }
        };
        config.onBatch = (messages, scope, handle) => {
            state.phase3RuntimeVideo = r.video; batches.push({ messages, scope, handle, identity: ownerPort?.recognizeBatch(handle) });
            if (!content) createContent(null);
            if (handle) { assert.equal(content.registerBatch(handle), true); content.processRegisteredBatch(handle); }
            else content.processLegacySuccess(messages, view.resolveLease(view.lease(scope))?.pendingOwner);
        };
        options.configure?.(config, api);
    } });
    return api;

    function ensureRuntime() {
        if (!options.generations) return runtime;
        if (!r.state.phase3Runtime || r.state.phase3Runtime !== runtime) {
            const created = generationRegistry.create(runtimeConfiguration);
            assert.ok(created);
            runtime = created.runtime;
            r.state.phase3Runtime = runtime; r.state.phase3RuntimeVideo = r.video;
        }
        return runtime;
    }
}
module.exports = { setup };
