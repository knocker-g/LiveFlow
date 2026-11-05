'use strict';

const core = require('./chat-read-core.js');
const control = require('./replay-control-plane-core.js');
const pending = require('./pending-selection.js');
const scopeCore = require('./diagnostic-scope-core.js');
const factsCore = require('./native-facts.js');
const frameCore = require('./chat-frame-role-core.js');
const { createLiveAcquisitionOwner } = require('./acquisition-owner.js');
const { createPrivatePendingScope } = require('./private-pending-scope.js');
const { createTenStageCollector } = require('./ten-stage-collector.js');
const { createPrivateLifetime } = require('./private-lifetime.js');
const { createRuntimeSourceRegistry } = require('./runtime-source-registry.js');
const { exactManifest } = require('./production-manifest.js');
const PORT_NAME = 'liveflow-bootstrap-private-v1';
const installedDocuments = new WeakSet();
const installationKey = Symbol.for('LiveFlow.ISOLATED.documentInstallation');
const replayAssociationPolicy = 'ACCEPTED_Z';

function targetFromURL(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || !['www.youtube.com','youtube.com'].includes(url.hostname) || url.port || url.username || url.password) return null;
        if (url.pathname === '/watch') { const values = url.searchParams.getAll('v'); return values.length === 1 && values[0] ? values[0] : null; }
        const match = /^\/live\/([^/]+)$/.exec(url.pathname); return match ? decodeURIComponent(match[1]) : null;
    } catch (_) { return null; }
}

function createProductionBridge({ api, realm, diagnostic = null }) {
    let hooks, owner = null, port = null, bootstrap = null, ownerPort = null, view = null;
    let registry = null, collector = null, lifetime = null, nativeAdapter = null;
    let pendingObserver = null;
    let productFence = null, productLease = null;
    let route = null, target = null, failed = false, connecting = false, diagnosticActive = false;
    let request = null, lastMedia = null, lastGeometry = null;
    let drainQueued = false, mediaObserver = null;
    const originalItems = new WeakMap(), attemptBindings = new WeakMap();
    const noQueue = Object.freeze([]);
    const fault = () => { diagnosticActive = false; registry?.disable(); };
    function requestDrain() {
        if (!diagnosticActive || drainQueued || typeof realm.queueMicrotask !== 'function') return;
        drainQueued = true;
        realm.queueMicrotask(() => { drainQueued = false; drain(); });
    }
    function proof(kind, value) { if (diagnosticActive) { collector.observe(kind, value); requestDrain(); } }
    function drain() {
        if (!diagnosticActive) return;
        try {
            registry.drain();
            for (const identity of registry.sources()) if (registry.generation(identity)?.phase === 'FINALIZED') registry.release(identity);
            lifetime.archives(); lifetime.owner();
        } catch (_) { fault(); }
    }
    const privateEntry = Object.freeze({
        // B1 observes established Product invalidation only. It does not sample
        // Native Facts, cancel an Owner, or interpret diagnostic retirement.
        isProductInvalidated: lease => owner?.status().phase === 'TERMINAL' ||
            !view?.resolveProductLease(lease),
        resolveProductLease: lease => view?.resolveProductLease(lease) || null,
        isProductCurrent(lease) {
            const association = view?.resolveProductLease(lease);
            return Boolean(association && view.presentationWorkAllowed(lease) &&
                owner?.isProductPresentationCurrent(lease) === true &&
                view.resolveProductLease(lease) === association && view.presentationWorkAllowed(lease));
        },
        withProductReceiver: (lease, operation) => view?.withProductReceiver(lease, operation),
        withPresentationCleanup: (lease, operation) => view?.withPresentationCleanup(lease, operation) ||
            Object.freeze({ status: 'NOT_APPLIED_UNKNOWN' }),
        recognizeBatch: handle => ownerPort?.recognizeBatch(handle) || null,
        recognizeOccurrence: value => ownerPort?.recognizeOccurrence(value) || null,
        claimBatch: handle => ownerPort?.claimBatch(handle) === true,
        isCurrent: identity => ownerPort?.isCurrent(identity) === true,
        onDisposition(identity, event, value) {
            if (event.item) originalItems.set(event.item, { source: ownerPort.recognizeOccurrence(event.occurrence), proof: value, identity });
            if (diagnosticActive) registry.observeContent(value);
        }
    });
    const rendererObserver = Object.freeze({
        onCommit(_identity, value) { if (diagnosticActive) registry.observeRenderer(value); },
        onTerminal(_identity, _outcome, _cancel, value) { if (diagnosticActive) registry.observeRenderer(value); },
        onFault() { fault(); }
    });
    function createRuntime(options) {
        if (!registry) return null;
        const schedule = options.scheduleOneShot;
        if (!productFence || productFence.participates() !== true) return null;
        const actualOptions = { ...options, productMutationFence: productFence, prepareLaunch,
            observe(event) { pendingObserver?.(event); options.observe?.(event); }, scheduleOneShot(callback, delay) {
            return schedule((...args) => { drain(); try { return callback(...args); } finally { drain(); } }, delay);
        } };
        drain();
        const result = registry.create(actualOptions);
        return result?.runtime || null;
    }
    function connectOwner(portValue) {
        ownerPort = portValue;
        registry = createRuntimeSourceRegistry({ owner: portValue.readLifetime().owner,
            onProof(kind, value) {
                if (kind === 'item') {
                    const event = registry.itemSource.recognize(value)?.event;
                    if (event?.type === 'LAUNCH_REQUESTED') {
                        const original = originalItems.get(event.item);
                        request = event;
                        if (original && hooks.content.recognizeProof(original.proof)?.state === 'FINAL_DELIVERED')
                            attemptBindings.set(event.attempt, original);
                    }
                }
                proof(kind, value);
            } });
        const retirement = portValue.enableRetirement();
        if (!registry || !retirement) { fault(); return; }
        const contentSource = { recognize: hooks.content.recognizeProof, isDelivering: hooks.content.isProofDelivering,
            status: hooks.content.observationStatus, coverage: hooks.content.proofCoverage };
        const rendererSource = { recognize: hooks.renderer.recognizeProof, isDelivering: hooks.renderer.isProofDelivering,
            status: hooks.renderer.observationStatus, coverage: hooks.renderer.proofCoverage };
        for (const [kind, source] of [['audit',{ recognize: portValue.recognizeAuditProof, isDelivering: portValue.isProofDelivering }],
            ['content',contentSource],['item',registry.itemSource],['renderer',rendererSource]])
            if (!retirement.bindSource(kind, source)) { fault(); return; }
        collector = createTenStageCollector({ core, ownerPort: portValue, retirement });
        for (const [kind, source] of [['content',contentSource],['item',registry.itemSource],
            ['evaluation',registry.evaluationSource],['renderer',rendererSource]])
            if (!collector.bindSource(kind, source)) { fault(); return; }
        lifetime = createPrivateLifetime({ collector, ownerPort: portValue, pendingView: view });
        if (!lifetime || !registry.connect({ content: hooks.content, renderer: hooks.renderer, collector })) { fault(); return; }
        diagnosticActive = true;
    }
    function construct() {
        if (owner || failed || !route || !hooks) return;
        try {
            if (!nativeAdapter) nativeAdapter = factsCore.createNativeFactsAdapter({ document: hooks.document, route,
                targetId: target, mode: null, discoverMode: true, native: factsCore.captureNativeAccess(realm),
                readDocument: () => hooks.document, readRoute: () => route,
                classifyChatFramePath: frameCore.classifyChatFramePath });
            const sample = nativeAdapter?.readFacts();
            if (!factsCore.inspectNativeAdmission(nativeAdapter, sample, replayAssociationPolicy)) { diagnostic?.record('C_ADMISSION_DENIED'); return; }
            diagnostic?.record('C_ADMISSION_ACCEPTED');
            const mode = sample.facts.mode.value;
            hooks.setBinding(mode);
            const sourceRuntime = Object.freeze({
                queue: Object.freeze({ snapshot: () => registry?.pendingRuntime.queue.snapshot() || noQueue,
                    successfulLaunchSequence: () => registry?.pendingRuntime.queue.successfulLaunchSequence() || 0 }),
                status: () => registry?.pendingRuntime.status() || { state: 'IDLE', pendingCount: 0 },
                mutationQuiescent: () => registry?.pendingRuntime.mutationQuiescent() === true,
                resumeArms: () => registry?.pendingRuntime.resumeArms(),
                enqueue: (...args) => registry?.pendingRuntime.enqueue(...args) === true,
                removePendingOwner: (...args) => registry ? registry.pendingRuntime.removePendingOwner(...args) : { status: 'FAILED', count: null }
            });
            const scopePort = createPrivatePendingScope({ document: hooks.document, route, targetId: target, lifecycle: 0, revision: 0,
                pending, scopeCore, terminalPath: 'DEFERRED_PRIVATE', runtimeGenerations: true,
                readRuntimeCoverage: () => registry?.status().state === 'OBSERVING',
                createRuntime: settings => { pendingObserver = settings.observe; productFence = settings.productMutationFence; return sourceRuntime; } });
            if (!scopePort) { failed = true; return; }
            owner = createLiveAcquisitionOwner({ diagnostic, document: hooks.document, route, nativeFacts: { adapter: nativeAdapter }, replayAssociationPolicy,
                clock: { now: () => hooks.performance.now() }, timers: { setTimeout: (callback, delay) => realm.setTimeout(() => {
                    drain(); try { return callback(); } finally { drain(); diagnostic?.flush(); }
                }, delay), clearTimeout: handle => realm.clearTimeout(handle) },
                entropy: bytes => realm.crypto.getRandomValues(bytes), AbortController: realm.AbortController,
                transport: (url, init) => realm.fetch(url, init), core, control,
                readPendingCount: () => sourceRuntime.status().pendingCount,
                pendingScopePort: { connect(binding, value) {
                    view = scopePort.connect(binding,value);
                    return view && Object.freeze({ ...view, terminal: view.requestTerminal });
                } },
                provenance: { connect: connectOwner, onParserAudit: (_event,value) => proof('audit',value),
                    onTemporalTransition: (_event,value) => proof('transition',value), onDisposition: (_event,value) => proof('temporal',value) },
                onBatch(messages, scope, handle, lease) {
                    productLease = lease;
                    const association = view?.resolveLease(view.lease(scope));
                    hooks.onBatch(messages, scope, handle, association?.pendingOwner, lease);
                } });
            if (!owner) { failed = true; diagnostic?.record('C_OWNER_NULL'); return; }
            diagnostic?.record('C_OWNER_CREATED');
            lastMedia = sampleMedia(sample);
            lastGeometry = geometryValues(sample);
            if (typeof realm.MutationObserver === 'function') {
                mediaObserver = new realm.MutationObserver(() => synchronize());
                mediaObserver.observe(sample.facts.player.value,{attributes:true,attributeFilter:['class']});
            }
        } catch (_) { failed = true; fault(); diagnostic?.record('C_CONSTRUCT_THROW'); }
    }
    function sampleMedia(sample) {
        const facts = sample?.facts;
        if (!facts || !factsCore.inspectNativeAdmission(nativeAdapter, sample, replayAssociationPolicy)) return null;
        const fields = ['video','childDocument','mode','visible','ready','adActive','seeking','paused','rate'];
        if (fields.some(key => facts[key]?.state !== 'KNOWN')) return null;
        return fields.map(key => facts[key].value);
    }
    function dispatch() {
        construct();
        if (!owner || failed || bootstrap) { diagnostic?.flush(); return; }
        if (!hooks.enabled()) return;
        bootstrap = owner.openBootstrap(port);
        if (!bootstrap) { diagnostic?.flush(); return; }
        const permit = bootstrap.consumePermit({ operationId: bootstrap.operationId, route });
        if (permit !== true) { failed = true; return; }
        try { port.postMessage({ kind: 'EXTRACT', operationId: bootstrap.operationId }); diagnostic?.record('C_EXTRACT_POSTED'); }
        catch (_) { bootstrap.lost(); failed = true; diagnostic?.record('C_EXTRACT_POST_FAILED'); diagnostic?.flush(); }
    }
    function start() {
        if (failed || !hooks) return;
        if (owner) { synchronize(); return; }
        if (connecting) { if (route) dispatch(); return; }
        if (!targetFromURL(hooks.document.URL)) { failed = true; return; }
        connecting = true;
        let diagnosticConnected = false;
        try {
            port = api.runtime.connect({ name: PORT_NAME });
            diagnosticConnected = true; diagnostic?.record('C_CONNECT_RETURNED');
            port.onDisconnect.addListener(() => {
                bootstrap?.lost();
                if (!bootstrap || owner?.status().bootstrap !== 'ACCEPTED') { owner?.cancel(); failed = true; }
                drain(); diagnostic?.record('C_PORT_DISCONNECTED'); diagnostic?.fault(); diagnostic?.flush();
            });
            port.onMessage.addListener(message => {
                if (failed) return;
                if (!route) {
                    let documentId;
                    if (message?.kind !== 'ROUTE' || message.targetId !== targetFromURL(hooks.document.URL) ||
                        message.route?.frameId !== 0 || !Number.isSafeInteger(message.route?.tabId) ||
                        !(documentId = message.route?.documentId || '',
                            /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(documentId) ||
                            (typeof documentId === 'string' && /^[0-9A-Fa-f]{32}$/.test(documentId) && !/^0{32}$/.test(documentId)))) { failed = true; diagnostic?.record('C_ROUTE_REJECTED'); diagnostic?.flush(); return; }
                    diagnostic?.record('C_ROUTE_ACCEPTED');
                    route = Object.freeze({ ...message.route }); target = message.targetId; dispatch();
                } else if (bootstrap) {
                    diagnostic?.record('C_CANDIDATE_MESSAGE_SEEN');
                    const accepted = bootstrap.receive(message);
                    if (accepted) hooks.setReadIndicatorState('active');
                    drain();
                    if (accepted) { diagnostic?.record('C_BOOTSTRAP_ACCEPTED_RETURN'); diagnostic?.complete(); }
                    diagnostic?.flush();
                }
            });
            diagnostic?.flush();
        } catch (_) { failed = true; if (!diagnosticConnected) diagnostic?.record('C_CONNECT_THROW'); else diagnostic?.fault(); diagnostic?.flush(); }
    }
    function synchronize() {
        if (failed) return;
        if (!owner) { start(); return; }
        try {
            owner.synchronize();
            if (owner.status().phase === 'TERMINAL') mediaObserver?.disconnect();
            if (!bootstrap) dispatch();
        } finally { drain(); }
    }
    function mediaChanged() {
        synchronize();
        const value = sampleMedia(nativeAdapter?.readFacts());
        if (!value) return false;
        const changed = lastMedia && value.some((field,i) => field !== lastMedia[i]); lastMedia = value;
        return Boolean(changed);
    }
    function geometryChanged() {
        synchronize();
        const sample = nativeAdapter?.readFacts();
        if (!['KNOWN','WAIT'].includes(sample?.outcome)) return false;
        const value = geometryValues(sample);
        if (!value) return false;
        const changed = lastGeometry && value.some((field,i) => field !== lastGeometry[i]); lastGeometry = value;
        return Boolean(changed);
    }
    function geometryValues(sample) {
        try {
            const values=[];
            for(const key of ['player','video']) {
                const rect=Reflect.apply(realm.Element.prototype.getBoundingClientRect,sample.facts[key].value,[]);
                values.push(rect.left,rect.top,rect.width,rect.height);
            }
            return values.every(Number.isFinite)?values:null;
        } catch (_) { return null; }
    }
    function prepareLaunch(entry, geometry) {
        if (!privateEntry.isProductCurrent(entry.productLease)) return null;
        const event = request, original = event && attemptBindings.get(event.attempt);
        let diagnosticLease = null;
        try {
            if (original && event.item.payload === entry) diagnosticLease = hooks.renderer.registerAttempt(
                original.source.association.scope, original.source.association.pendingOwner, event.attempt);
        } catch (_) { fault(); }
        return hooks.renderer.prepareDanmaku(entry.message, entry.generation, entry.video, geometry,
            entry.settingsSnapshot, diagnosticLease, entry.productLease);
    }
    return Object.freeze({ privateEntry, rendererObserver, createRuntime, start, synchronize, mediaChanged, geometryChanged,
        cleanupPresentation(renderer) {
            if (productLease && view?.resolveProductLease(productLease) && owner?.status().phase !== 'TERMINAL')
                return renderer.cleanupPresentation(productLease);
            return renderer.cleanupOverlay();
        },
        bind(value) { if (hooks) throw new TypeError('ALREADY_BOUND'); hooks = value; },
        observeDetached(value) { if (diagnosticActive) { registry.observeDetached(value); requestDrain(); } },
        recognizeAttempt(scope, pendingOwner, attempt) {
            const original = attemptBindings.get(attempt);
            return original?.source?.association.scope === scope && original.source.association.pendingOwner === pendingOwner;
        },
        launch(entry, geometry, render) {
            // Product presentation requires the actual selected transaction;
            // this old Boolean adapter cannot stand in for queue confirmation.
            return false;
        },
        retire() { owner?.cancel(); mediaObserver?.disconnect(); drain(); },
        navigationChanged() {
            synchronize();
            if (target && targetFromURL(hooks.document.URL)!==target) return true;
            const sample=nativeAdapter?.readFacts();
            return sample?.outcome==='TERMINAL' && ['TARGET_CHANGED','MODE_CHANGED','OWNER_REPLACED','CHILD_REPLACED',
                'OWNER_BINDING_LOST','DOCUMENT_CHANGED'].includes(sample.reason);
        },
        // Accessible only to private composition/tests, never assigned to a global.
        inspect() { drain(); return Object.freeze({ failed, diagnostics: diagnosticActive ? registry.status().state : 'UNKNOWN',
            owner: owner?.status().phase || 'NONE', lifetime: diagnosticActive ? lifetime.owner() : null }); }
    });
}

function startProduction(realm = globalThis, diagnostic = null) {
    diagnostic?.record('C_START_ENTER');
    const api = realm.chrome;
    if (!realm.document || installedDocuments.has(realm.document)) return false;
    installedDocuments.add(realm.document);
    // Fixed, non-enumerable tombstone in the extension ISOLATED global only.
    // It contains no owner/Authority/credential and survives bundle reinjection.
    // It denies duplicate installation; absence never grants READ authority.
    try {
        if (Object.getOwnPropertyDescriptor(realm,installationKey)) { diagnostic?.record('C_INSTALL_DENY'); diagnostic?.flush(); return false; }
        Object.defineProperty(realm,installationKey,{value:realm.document,enumerable:false,writable:false,configurable:false});
    } catch (_) { diagnostic?.record('C_INSTALL_DENY'); diagnostic?.flush(); return false; }
    try {
        if (!api?.runtime || typeof api.runtime.connect !== 'function' || typeof api.runtime.getManifest !== 'function' ||
            !exactManifest(api.runtime.getManifest())) { diagnostic?.record('C_API_DENY'); diagnostic?.flush(); return false; }
    } catch (_) { diagnostic?.record('C_API_DENY'); diagnostic?.flush(); return false; }
    if (!targetFromURL(realm.document.URL)) { diagnostic?.record('C_URL_DENY'); diagnostic?.flush(); return false; }
    // Legacy browser policy modules keep their existing single-source APIs in the
    // extension ISOLATED world; no acquisition owner/global is assigned to MAIN.
    require('./settings-core.js'); require('./overlay-core.js'); require('./scheduler-foundations.js');
    require('./normal-overlap-policy.js'); require('./geometry-adapter.js'); require('./scheduler-runtime.js');
    require('./phase5-tuning.js'); require('./opportunity-aware-density.js');
    require('./youtube-chat.js').startContent({ createBridge: () => createProductionBridge({ api,realm,diagnostic }) });
    diagnostic?.record('C_CONTENT_STARTED'); diagnostic?.flush();
    return true;
}
module.exports = Object.freeze({ createProductionBridge, startProduction, exactManifest, targetFromURL, PORT_NAME });
