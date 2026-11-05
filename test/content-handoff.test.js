const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createContentHandoff } = require('../src/youtube-chat.js');
const pending = require('../src/pending-selection.js');
const overlayCore = require('../src/overlay-core.js');
const geometry = require('../src/geometry-adapter.js');
const { createPrivateSchedulerRuntime } = require('../src/scheduler-runtime.js');
const source = fs.readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8');
const baseline = fs.readFileSync(require.resolve('./fixtures/content-handoff-legacy.js'), 'utf8');
const handler = source.match(/    function handleReadResult\([^]*?\n    \}/)[0];
const message = (id, messageType = 'text') => ({ id, messageType, message: 'fixture' });
const owner = pending.clonePendingOwner({ document: '12345678-1234-1234-1234-123456789abc',
    target: 'target', lifecycle: 0, revision: 0, stream: 1 });

function setup(options = {}) {
    const effects = [], evaluations = [], observations = [], registry = new WeakMap(), occurrences = new WeakMap();
    let clockCalls = 0, current = true;
    const claimed = new WeakSet();
    const marker = new Error('original dispatch');
    const runtime = createPrivateSchedulerRuntime({ clock: () => 1000, generation: () => 0,
        scheduleOneShot() { effects.push(['timer']); if (options.afterThrow) throw marker; return 1; },
        cancelOneShot() { effects.push(['cancelTimer']); },
        geometryAdapter: geometry.createSubtitleGeometryAdapter({
            authority: geometry.createGeometryAuthority({ epsilon: 1 }),
            readGeometry: () => ({ state: 'UNKNOWN', capabilityAvailable: false }) }),
        candidateProof() { throw Error('must not evaluate'); }, launch() { throw Error('must not render'); },
        observe: e => effects.push(['scheduler', e.type]),
        config: { maxPendingAge: 1000, maxPendingCount: options.capacity ?? 1000,
            pendingPressureCapacity: 1000, scanDepth: 5, cohortMaximumItems: 5, cohortMaximumSpan: 800,
            density: { minimumAttackResidence: 1 } }
    }, (item, outcome) => evaluations.push({ item, outcome })).runtime;
    const wrapped = { ...runtime,
        clear() { effects.push(['clear']); return runtime.clear(); },
        enqueue(payload, settings) {
            effects.push(['enqueue', payload.message.id, payload.generation, payload.settingsSnapshot,
                settings.id, settings.enqueuedAt, settings.rendererType, settings.footprint]);
            if (options.beforeThrow) throw marker;
            if (options.missingQueue) return runtime.enqueue(payload, settings);
            return runtime.enqueue(payload, options.reject ? { ...settings, enqueuedAt: NaN } : settings);
        }
    };
    if (options.missingQueue) delete wrapped.queue;
    const ranges = { length: 1, start: () => 0, end: () => 100 };
    const video = { paused: !!options.paused, ended: !!options.ended, readyState: options.readyState ?? 4,
        currentTime: 10, seekable: ranges, buffered: options.liveGate
            ? { length: 1, start: () => 0, end: () => 50 } : ranges };
    const player = { classList: { contains: name => name === options.ad } };
    const window = { location: { origin: 'https://www.youtube.com' }, LiveFlowPendingSelection: pending };
    const c = {
        window, overlayCore, phase5Tuning: { lineHeight: 32 },
        performance: { now() { clockCalls++; effects.push(['clock']); return 1000; } },
        PHASE3_UNTUNED_RUNTIME: { sourceActivityWindowMsec: 10000 },
        currentMessages: options.prior ? options.prior.slice() : [], MAX_MESSAGES: 500,
        currentChatMode: options.live ? 'live' : 'replay', currentPageKey: 'target', currentPageRevision: 0,
        currentPageLifecycleGeneration: 0, rendererGeneration: 0, runtimeSettings: { showSuperChats: false },
        acceptingReadResults: true, READ_RESPONSE_TYPE: 'fixture-read',
        phase3Runtime: wrapped, phase3RuntimeVideo: options.replaced ? {} : video,
        livePresentationResumeGateActive: !!options.liveGate, replayDiagnosticBatch: {}, replayDiagnosticBatchInProgress: false,
        isEffectiveDisplayActive() { effects.push(['display']); return options.display !== false; },
        getCurrentMainMedia() { effects.push(['media']); return options.noMedia ? null : { player, video }; },
        cleanupOverlay() { effects.push(['cleanup']); },
        ensurePhase3Runtime() { effects.push(['runtime']); return options.noRuntime ? null : wrapped; },
        ensureSubtitleGeometryObservers() { effects.push(['subtitle']); },
        ensurePlaybackContextObserver() { effects.push(['playback']); },
        observeLivePresentationBatch(fields) { effects.push(['live', fields]); },
        publishReplaySchedulerDiagnostic() { effects.push(['publish', { ...c.replayDiagnosticBatch }]); },
        rememberReplayPendingOwner(binding, scope) { effects.push(['remember', binding, scope]); },
        setReadIndicatorState(state) { effects.push(['indicator', state]); },
        logInfo(text) { effects.push(['log', text]); }
    };
    const entry = {
        recognizeBatch: handle => registry.get(handle), recognizeOccurrence: handle => occurrences.get(handle), isCurrent: () => current,
        claimBatch(identity) { if (claimed.has(identity)) return false; claimed.add(identity); return true; },
        onDisposition(identity, event) { observations.push({ identity, event }); options.receiver?.(identity, event); }
    };
    if (options.noReceiver) delete entry.onDisposition;
    const handoff = createContentHandoff({ ...c, state: c, pending, privateEntry: options.private ? entry : undefined });
    function register(messages, scope = {}, ticket = {}) {
        const handle = Object.freeze({});
        const handles = messages.map(message => {
            const occurrence = Object.freeze({});
            occurrences.set(occurrence, { message, origin: { document: window, ticket },
                association: { scope, pendingOwner: owner } });
            return occurrence;
        });
        const identity = Object.freeze({ document: window, targetId: 'target', lifecycle: 0, revision: 0,
            ticket, scope, pendingOwner: owner, messages: Object.freeze(messages.slice()), occurrences: Object.freeze(handles) });
        registry.set(handle, identity);
        assert.equal(handoff.registerBatch(handle), true);
        return { handle, identity };
    }
    function legacy(messages, original = false, fields = {}) {
        c.contentHandoff = handoff;
        c.event = { source: window, origin: window.location.origin,
            data: { source: 'liveflow-page-state', type: 'fixture-read', ok: true,
                pageRevision: 0, pageLifecycleGeneration: 0, messages, pendingOwner: owner, ...fields } };
        vm.runInNewContext((original ? baseline : handler) + '\nhandleReadResult(event);', c);
    }
    function snapshot() {
        return JSON.parse(JSON.stringify({ effects, history: c.currentMessages,
            batch: c.replayDiagnosticBatch, liveGate: c.livePresentationResumeGateActive,
            inProgress: c.replayDiagnosticBatchInProgress, clockCalls,
            queue: runtime.queue.snapshot().map(i => ({ id: i.id, payload: i.payload, enqueuedAt: i.enqueuedAt })) }));
    }
    return { handoff, register, legacy, snapshot, observations, c, marker, runtime, evaluations,
        setCurrent(value) { current = value; } };
}
function run(messages, options = {}) {
    const h = setup({ ...options, private: true }), registration = h.register(messages);
    h.handoff.processRegisteredBatch(registration.handle);
    return { ...h, registration, dispositions: h.observations.map(o => o.event.disposition) };
}

test('real dedup preserves history/within-batch/falsy IDs and trims after entire batch', () => {
    const h = run([message('old'), message('new'), message('new'), message(''), message(0), message(null)],
        { prior: [message('old')] });
    assert.deepEqual(h.dispositions, ['EXACT_ID_DUPLICATE', 'ADMITTED', 'EXACT_ID_DUPLICATE', 'ADMITTED', 'ADMITTED', 'ADMITTED']);
    assert.equal(h.c.currentMessages.length, 5);
    assert.equal(new Set(h.observations.map(o => o.event.occurrence)).size, 6);
    const prior = Array.from({ length: 500 }, (_, i) => message('old' + i));
    const many = run([...Array.from({ length: 501 }, (_, i) => message('new' + i)), message('old0')], { prior, display: false });
    assert.equal(many.dispositions.at(-1), 'EXACT_ID_DUPLICATE');
    assert.equal(many.c.currentMessages.length, 500);
    assert.equal(many.c.currentMessages[0].id, 'new1');
});
test('Display OFF mutates original accepted history before suppression and avoids Runtime', () => {
    const h = run([message('a')], { display: false });
    assert.deepEqual(h.dispositions, ['DISPLAY_SUPPRESSED']); assert.equal(h.c.currentMessages[0].id, 'a');
    assert.equal(h.snapshot().effects.some(e => ['runtime', 'enqueue', 'media'].includes(e[0])), false);
});
for (const option of [{ paused: true }, { ended: true }, { readyState: 1 }, { noMedia: true }, { ad: 'ad-showing' }]) {
    test('actual media suppression and clear: ' + JSON.stringify(option), () => {
        const h = run([message('a')], option);
        assert.deepEqual(h.dispositions, ['MEDIA_SUPPRESSED']);
        assert.equal(h.snapshot().effects.filter(e => e[0] === 'clear').length, 1);
        assert.equal(h.runtime.queue.snapshot().length, 0);
    });
}
test('actual Live resume behind edge remains suppressed with original clear ordering', () => {
    const h = run([message('a')], { live: true, liveGate: true });
    assert.deepEqual(h.dispositions, ['LIVE_RESUME_SUPPRESSED']);
    assert.ok(h.snapshot().effects.findIndex(e => e[0] === 'clear') < h.snapshot().effects.findIndex(e => e[0] === 'live'));
});
test('actual visibility helper retains NORMAL/SPECIAL despite legacy settings flags', () => {
    const h = run([message('x', 'unknown'), message('n'), message('s', 'superChat'), message('t', 'superSticker')]);
    assert.deepEqual(h.dispositions, ['VISIBILITY_FILTERED', 'ADMITTED', 'ADMITTED', 'ADMITTED']);
    assert.equal(h.runtime.queue.snapshot().length, 3);
});
test('ADMITTED joins exact actual item and original identity, not scalar receipt alone', () => {
    const h = run([message('a')]), o = h.observations[0];
    assert.equal(o.identity, h.registration.identity);
    assert.equal(o.event.item, h.runtime.queue.snapshot()[0]);
    assert.equal(o.event.item.payload.message, o.identity.messages[0]);
    const missing = run([message('b')], { missingQueue: true });
    assert.deepEqual(missing.dispositions, ['UNKNOWN']);
    assert.equal(missing.runtime.queue.snapshot().length, 1);
});
for (const option of [{ noRuntime: true }, { reject: true }]) {
    test('P1 verified no admission: ' + JSON.stringify(option), () => {
        const h = run([message('a')], option);
        assert.deepEqual(h.dispositions, ['ADMISSION_REJECTED']);
        assert.equal(h.runtime.queue.snapshot().length, 0); assert.equal(h.observations[0].event.item, null);
    });
}
for (const option of [{ beforeThrow: true }, { afterThrow: true }]) {
    test('real enqueue exception preserves identical error and actual stock: ' + JSON.stringify(option), () => {
        const h = setup({ private: true, ...option }), r = h.register([message('a'), message('b')]);
        assert.throws(() => h.handoff.processRegisteredBatch(r.handle), e => e === h.marker);
        assert.equal(h.runtime.queue.snapshot().length, option.afterThrow ? 1 : 0);
        assert.ok(h.observations.every(o => o.event.disposition === 'UNKNOWN'));
        assert.equal(h.c.replayDiagnosticBatchInProgress, false);
        assert.equal(h.handoff.observationStatus().state, 'UNKNOWN');
    });
}
test('mixed actual batch receipts preserve INPUT order, not disposition edge order', () => {
    const h = run([message('x'), message('old'), message('bad', 'unknown'), message('x')], { prior: [message('old')] });
    assert.deepEqual(h.dispositions, ['ADMITTED', 'EXACT_ID_DUPLICATE', 'VISIBILITY_FILTERED', 'EXACT_ID_DUPLICATE']);
});
test('missing receiver is incomplete; receiver return has no control authority', () => {
    const missing = run([message('a')], { noReceiver: true });
    assert.equal(missing.handoff.observationStatus().state, 'UNKNOWN');
    assert.equal(missing.runtime.queue.snapshot().length, 1);
    const ignored = run([message('b')], { receiver: () => false });
    assert.deepEqual(ignored.dispositions, ['ADMITTED']);
    assert.equal(ignored.runtime.queue.snapshot().length, 1);
});
test('real capacity mutation cannot be misreported as no-admission or scalar success', () => {
    const h = run([message('a')], { capacity: 0 });
    assert.deepEqual(h.dispositions, ['UNKNOWN']); assert.equal(h.runtime.queue.snapshot().length, 0);
    assert.equal(h.handoff.observationStatus().state, 'UNKNOWN');
});
test('unrecognized/stale/reused registration cannot mutate history or replay processing', () => {
    const h = setup({ private: true });
    assert.equal(h.handoff.registerBatch({}), false); h.handoff.processRegisteredBatch({});
    const stale = h.register([message('stale')]); h.setCurrent(false); h.handoff.processRegisteredBatch(stale.handle);
    assert.equal(h.c.currentMessages.length, 0);
    h.setCurrent(true); h.handoff.processRegisteredBatch(stale.handle); assert.equal(h.c.currentMessages.length, 0);
    const good = h.register([message('good')]); h.handoff.processRegisteredBatch(good.handle);
    h.handoff.processRegisteredBatch(good.handle); assert.equal(h.c.currentMessages.length, 1);
    assert.equal(h.observations.length, 1); assert.equal(h.handoff.observationStatus().state, 'UNKNOWN');
});
test('late old Scope attribution stays original while next registered Scope exists', () => {
    const h = setup({ private: true }), a = h.register([message('a')]), b = h.register([message('b')]);
    h.handoff.processRegisteredBatch(b.handle); h.handoff.processRegisteredBatch(a.handle);
    assert.equal(h.observations[1].identity, a.identity);
    assert.notEqual(h.observations[1].identity.scope, b.identity.scope);
});
test('receiver throw/return and processing reentry cannot change Product outcome or redeliver', () => {
    let h, r;
    h = setup({ private: true, receiver() {
        assert.throws(() => h.handoff.processRegisteredBatch(r.handle), /REENTRANT/);
        assert.throws(() => h.handoff.processLegacySuccess([message('forged')], owner), /REENTRANT/);
        throw Error('receiver');
    } });
    r = h.register([message('a')]); assert.equal(h.handoff.processRegisteredBatch(r.handle), undefined);
    assert.equal(h.runtime.queue.snapshot().length, 1); assert.equal(h.c.currentMessages.length, 1);
    h.handoff.processRegisteredBatch(r.handle); assert.equal(h.observations.length, 1);
    assert.equal(h.handoff.observationStatus().state, 'UNKNOWN');
    assert.equal(JSON.stringify(h.handoff.observationStatus()).includes('fixture'), false);
});
test('interrupted history visit does not invent dispositions for unvisited input tail', () => {
    const marker = new Error('id'), h = setup({ private: true });
    const r = h.register([message('a'), { get id() { throw marker; } }, message('never')]);
    assert.throws(() => h.handoff.processRegisteredBatch(r.handle), e => e === marker);
    assert.equal(h.observations.length, 2); assert.equal(h.c.currentMessages.length, 1);
    assert.ok(h.observations.every(o => o.event.disposition === 'UNKNOWN'));
});

const vectors = [{}, { display: false }, { paused: true }, { ended: true }, { readyState: 1 },
    { ad: 'ad-showing' }, { noMedia: true }, { live: true, liveGate: true }, { noRuntime: true },
    { reject: true }, { replaced: true }, { beforeThrow: true }, { afterThrow: true }];
for (const options of vectors) {
    test('actual original Content vs shared legacy body equivalence: ' + JSON.stringify(options), () => {
        const old = setup(options), fresh = setup(options);
        const messages = [message('a'), message('a'), message('', 'superChat'), message('u', 'unknown')];
        let oldError, newError;
        try { old.legacy(messages, true); } catch (e) { oldError = e; }
        try { fresh.legacy(messages); } catch (e) { newError = e; }
        assert.equal(oldError, options.beforeThrow || options.afterThrow ? old.marker : undefined);
        assert.equal(newError, options.beforeThrow || options.afterThrow ? fresh.marker : undefined);
        assert.deepEqual(fresh.snapshot(), old.snapshot());
        assert.equal(fresh.observations.length, 0);
    });
}
test('legacy guard/failure/log behavior remains actual and identical', () => {
    for (const fields of [{ ok: false, status: null, errorType: 'fixture' }, { pageRevision: 1 }, { pageLifecycleGeneration: 1 }]) {
        const a = setup(), b = setup(); a.legacy([message('x')], true, fields); b.legacy([message('x')], false, fields);
        assert.deepEqual(b.snapshot(), a.snapshot()); assert.equal(b.c.currentMessages.length, 0);
    }
});
test('factory import/construction remains inert with no browser global API', () => {
    const c = { module: { exports: {} }, require };
    for (const key of ['window', 'document', 'chrome', 'performance', 'fetch', 'setTimeout']) {
        Object.defineProperty(c, key, { get() { throw Error('startup ' + key); } });
    }
    vm.runInNewContext(source, c);
    assert.deepEqual(Object.keys(c.module.exports), ['createRenderer', 'createContentHandoff', 'startContent']);
    const inert = c.module.exports.createContentHandoff({ state: {} });
    assert.equal(typeof inert.processLegacySuccess, 'function');
    assert.equal(source.includes('window.createContentHandoff'), false);
});
