const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRenderer } = require('../src/youtube-chat.js');
const overlayCore = require('../src/overlay-core.js');
const schedulerFoundations = require('../src/scheduler-foundations.js');
const geometryCore = require('../src/geometry-adapter.js');
const tuning = require('../src/phase5-tuning.js');
const overlap = require('../src/normal-overlap-policy.js');
const density = require('../src/opportunity-aware-density.js');

// Layout/native Animation doubles only; all rendering, proof and cleanup code is real.
function fixture({ observed = true, observer: receivers, animationMode, onCommit, onTerminal,
    onFault, runtimeObserver, rendererFactory = createRenderer, captions = false, width = 120, height = 32 } = {}) {
    let now = 1000, displayedPublications = 0, cancelCalls = 0, clears = 0;
    let removeFailure = false, animateFailure = false;
    const animations = [], events = [], faults = [], nodes = [];
    class Node {
        constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {};
            this.parentElement = null; this.className = ''; this.textContent = '';
            this.classList = { contains: name => this.className.split(' ').includes(name),
                add: name => { this.className += ` ${name}`; } }; nodes.push(this); }
        get childNodes() { return this.children; }
        get isConnected() { return this === player || Boolean(this.parentElement?.isConnected); }
        appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
        append(...children) { children.forEach(node => this.appendChild(node)); }
        remove() { if (removeFailure && this.className === 'liveflow-danmaku') throw Error('remove failed');
            if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
            this.parentElement = null; }
        querySelector(selector) { if (selector.startsWith('.ytp-subtitles-button')) return captions ? caption : null;
            return this.children.find(node => node.classList.contains(selector.slice(1))) ||
                this.children.map(node => node.querySelector(selector)).find(Boolean) || null; }
        querySelectorAll() { return []; }
        get scrollWidth() { return width; }
        getBoundingClientRect() {
            if (this === player || this === video) return { left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 };
            const surface = this.id === 'liveflow-danmaku-surface';
            const left = surface ? parseFloat(this.style.left) || 0 : 1000;
            const top = parseFloat(this.style.top) || 0;
            const w = surface ? parseFloat(this.style.width) : width;
            const h = surface ? parseFloat(this.style.height) : height;
            return { left, top, width: w, height: h, right: left + w, bottom: top + h };
        }
        animate(keyframes, options) {
            if (animateFailure) throw Error('animate failed');
            let resolve, reject;
            const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
            const animation = { keyframes, options, resolve, reject, promise, reads: 0,
                get finished() { this.reads++; if (animationMode === 'getter-throw') throw Error('finished failed');
                    if (animationMode === 'thenable') return { then: () => ({ catch() {} }) };
                    return promise; },
                cancel() { cancelCalls++; if (animationMode === 'cancel-throw') throw Error('cancel failed');
                    if (!['never', 'thenable'].includes(animationMode)) reject(Error('cancelled')); } };
            animations.push(animation); return animation;
        }
    }
    const player = new Node('player'), video = new Node('video'), caption = new Node('caption');
    player.appendChild(video);
    Object.assign(video, { paused: false, ended: false, readyState: 4, playbackRate: 1 });
    const state = { overlayRoot: null, overlaySurface: null, laneStates: [], activeDanmaku: new Map(),
        rendererGeneration: 0, phase3Runtime: { clear() { clears++; } }, phase3RuntimeVideo: video,
        runtimeSettings: Object.freeze({ opacityPercent: 73 }), currentChatMode: 'replay',
        subtitleGeometryAdapter: { markDirty() {}, refresh: () => ({ geometry: { state: 'KNOWN' }, revision: 1 }) },
        replayDiagnosticDisplayed: 0 };
    const observer = receivers || {
        onCommit(identity) { events.push(['commit', identity]); onCommit?.(identity); },
        onTerminal(identity, outcome, cancel) { events.push(['terminal', identity, outcome, cancel]); onTerminal?.(identity); },
        onFault(identity, reason) { faults.push([identity, reason]); onFault?.(identity, reason); }
    };
    const recognized = new WeakMap();
    const dependencies = { state, document: { createElement: tag => new Node(tag), createTextNode: text => {
        const node = new Node('#text'); node.textContent = text; return node; } },
        window: { getComputedStyle: () => ({ fontSize: '28px', display: 'block', visibility: 'visible', opacity: '1' }),
            LiveFlowPhase5Tuning: tuning, LiveFlowSchedulerFoundations: schedulerFoundations,
            LiveFlowNormalOverlapPolicy: overlap, LiveFlowOpportunityAwareDensity: density },
        performance: { now: () => now }, overlayCore, schedulerFoundations, geometryCore,
        phase5Tuning: tuning.CURRENT, PHASE3_UNTUNED_RUNTIME: { subtitleMargin: 8 },
        isEffectiveDisplayActive: () => true, getCurrentMainMedia: () => ({ player, video }),
        ensureSubtitleGeometryObservers() {}, disconnectSubtitleGeometryObservers() {}, logInfo() {},
        publishReplaySchedulerDiagnostic() { displayedPublications++; },
        recognizeAttempt: (scope, owner, attempt) => recognized.get(attempt)?.scope === scope && recognized.get(attempt)?.owner === owner,
        runtimeObserver };
    if (observed) dependencies.observer = observer;
    const renderer = rendererFactory(dependencies);
    const message = { id: 'id', messageType: 'text', message: 'fixture', authorRole: 'guest' };
    function lease(scope = Object.freeze({}), owner = Object.freeze({}), attempt = Object.freeze({ scope, owner })) {
        recognized.set(attempt, { scope, owner });
        return { value: renderer.registerAttempt(scope, owner, attempt), scope, owner, attempt };
    }
    function proof(msg = message) {
        const entry = { id: 'entry', footprint: { width, height }, payload: { message: msg } };
        const policy = schedulerFoundations.getDensityVisualPolicy('NORMAL');
        const result = renderer.getCandidateProof(entry, { exclusionRegions: [] }, policy);
        const candidate = result.candidates?.[0];
        return candidate && { ...candidate, density: 'NORMAL', geometryRevision: 1 };
    }
    function render({ msg = message, binding = lease(), launchProof = proof(msg) } = {}) {
        return renderer.renderDanmaku(msg, state.rendererGeneration, video, launchProof, state.runtimeSettings, binding.value);
    }
    return { renderer, dependencies, state, player, video, animations, events, faults, nodes, message,
        lease, proof, render, setRemoveFailure: v => { removeFailure = v; }, setAnimateFailure: v => { animateFailure = v; },
        setNow: value => { now = value; }, counts: () => ({ cancelCalls, clears, displayedPublications }) };
}
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

test('export-only import touches no browser, settings, DOM, timer or network', () => {
    const forbidden = () => { throw Error('initialization'); };
    const sandbox = { module: { exports: {} }, fetch: forbidden, setTimeout: forbidden };
    for (const name of ['window', 'document', 'chrome', 'performance', 'MutationObserver']) {
        Object.defineProperty(sandbox, name, { get: forbidden });
    }
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8'), sandbox);
    assert.equal(typeof sandbox.module.exports.createRenderer, 'function');
});

test('actual NORMAL commit, original private identity and fulfilled cleanup once', async () => {
    const f = fixture(), binding = f.lease();
    assert.equal(f.render({ binding }).status, 'rendered');
    assert.equal(f.state.activeDanmaku.size, 1);
    assert.equal(f.state.replayDiagnosticDisplayed, 1);
    assert.equal(f.counts().displayedPublications, 1);
    assert.equal(f.events.length, 1);
    const identity = f.events[0][1];
    assert.equal(identity.scope, binding.scope); assert.equal(identity.pendingOwner, binding.owner);
    assert.equal(identity.attempt, binding.attempt); assert.equal(typeof identity.token, 'symbol');
    assert.equal(f.animations[0].reads, 1);
    f.animations[0].resolve(); f.animations[0].resolve(); await settle();
    assert.equal(f.state.activeDanmaku.size, 0); assert.ok(f.state.laneStates.every(lane => !lane));
    assert.deepEqual(f.events[1], ['terminal', identity, 'FINISHED', 'NONE']);
    assert.equal(f.events.length, 2); assert.equal(f.state.replayDiagnosticDisplayed, 1);
    assert.equal(f.renderer.observationStatus().unresolved, 0);
});

test('actual SPECIAL node/fit/base-anchor proof and Settings snapshot are preserved', async () => {
    const f = fixture();
    const msg = { ...f.message, messageType: 'superChat', authorName: 'fixture', purchaseAmountText: 'fixture' };
    const proof = f.proof(msg); assert.ok(proof); assert.equal(proof.interleaved, false);
    assert.equal(f.render({ msg, launchProof: proof }).status, 'rendered');
    const record = [...f.state.activeDanmaku.values()][0];
    assert.ok(record.node.classList.contains('liveflow-danmaku-special'));
    assert.ok(record.node.querySelector('.liveflow-danmaku-special-body'));
    assert.equal(record.trajectory.semanticClass, 'SPECIAL');
    assert.equal(f.state.overlaySurface.style.opacity, '0.73');
    f.animations[0].resolve(); await settle();
});

test('native rejection is distinct from successful completion', async () => {
    const f = fixture(); f.render(); f.animations[0].reject(Error('fixture')); await settle();
    assert.equal(f.events[1][2], 'REJECTED'); assert.equal(f.events[1][3], 'NONE');
    assert.equal(f.state.activeDanmaku.size, 0); assert.equal(f.faults.length, 0);
});

test('cancel returned without native settlement remains unresolved', async () => {
    const f = fixture({ animationMode: 'never' }); f.render(); f.renderer.cleanupOverlay(); await settle();
    assert.equal(f.counts().cancelCalls, 1); assert.equal(f.events.length, 1);
    assert.equal(f.renderer.observationStatus().unresolved, 1);
    f.animations[0].reject(Error('late')); await settle();
    assert.equal(f.events[1][2], 'REJECTED'); assert.equal(f.events[1][3], 'ISSUED_RETURNED');
});

test('full teardown cancels actual animation; old settlement cannot release new token', async () => {
    const f = fixture(); const a = f.lease(), b = f.lease();
    f.render({ binding: a }); f.renderer.cleanupOverlay();
    assert.equal(f.state.rendererGeneration, 1); assert.equal(f.state.overlayRoot, null);
    assert.equal(f.counts().clears, 1);
    f.render({ binding: b }); const tokenB = f.events[1][1].token;
    await settle(); assert.equal(f.events[2][1].scope, a.scope);
    assert.equal(f.state.activeDanmaku.has(tokenB), true);
    assert.ok(f.state.laneStates.some(lane => lane?.token === tokenB));
    f.animations[1].resolve(); await settle();
    assert.equal(f.events[3][1].scope, b.scope);
});

test('reentrant commit cleanup retains commit-before-terminal ordering', async () => {
    let f;
    f = fixture({ onCommit() { f.renderer.cleanupOverlay(); } });
    assert.equal(f.render().status, 'rendered'); assert.equal(f.events.length, 1);
    await settle(); assert.deepEqual(f.events.map(e => e[0]), ['commit', 'terminal']);
    assert.equal(f.events[1][3], 'ISSUED_RETURNED');
});

test('throwing receivers are attempted once and faults survive failed fault receiver', async () => {
    const f = fixture({ onCommit() { throw Error('receiver'); }, onTerminal() { throw Error('receiver'); },
        onFault() { throw Error('fault receiver'); } });
    f.render(); f.animations[0].resolve(); await settle();
    assert.deepEqual(f.events.map(e => e[0]), ['commit', 'terminal']);
    assert.deepEqual(new Set(f.renderer.observationStatus().faults),
        new Set(['COMMIT_RECEIVER_FAILED', 'TERMINAL_RECEIVER_FAILED', 'FAULT_RECEIVER_FAILED']));
});

test('cleanup throw after fulfillment does not fabricate native rejection', async () => {
    const f = fixture(); f.render(); f.setRemoveFailure(true); f.animations[0].resolve();
    // First cleanup throws, original catch retries. Permit that retry to succeed.
    await Promise.resolve(); f.setRemoveFailure(false); await settle();
    assert.equal(f.events[1][2], 'FINISHED');
    assert.ok(f.renderer.observationStatus().faults.includes('CLEANUP_FAILED'));
    assert.equal(f.renderer.observationStatus().state, 'UNKNOWN');
});

test('missing native promise proof cannot manufacture terminal evidence', async () => {
    const f = fixture({ animationMode: 'thenable' }); assert.equal(f.render().status, 'rendered');
    f.renderer.cleanupOverlay(); await settle();
    assert.equal(f.events.length, 1);
    assert.ok(f.renderer.observationStatus().faults.includes('SETTLEMENT_UNOBSERVABLE'));
});

test('synchronous creation and finished getter failures preserve original throws', () => {
    const f = fixture(); f.setAnimateFailure(true); assert.throws(() => f.render(), /animate failed/);
    assert.equal(f.state.replayDiagnosticDisplayed, 0); assert.equal(f.events.length, 0);
    assert.equal(f.renderer.observationStatus().state, 'UNKNOWN');
    const g = fixture({ animationMode: 'getter-throw' }); assert.throws(() => g.render(), /finished failed/);
    assert.equal(g.state.replayDiagnosticDisplayed, 1); assert.equal(g.events.length, 1);
    assert.equal(g.renderer.observationStatus().unresolved, 1);
});

test('cancel throwing propagates and does not settle a token', async () => {
    const f = fixture({ animationMode: 'cancel-throw' }); f.render();
    assert.throws(() => f.renderer.cleanupOverlay(), /cancel failed/);
    assert.equal(f.events.length, 1); assert.equal(f.state.activeDanmaku.size, 1);
    f.animations[0].resolve(); await settle();
    assert.equal(f.events[1][2], 'FINISHED'); assert.equal(f.events[1][3], 'THREW');
    assert.equal(f.renderer.observationStatus().state, 'UNKNOWN');
});

test('soft40 includes retiring records; saturation never changes real render success', async () => {
    const f = fixture({ animationMode: 'never' });
    for (let i = 0; i < 41; i++) {
        assert.equal(f.render().status, 'rendered'); f.renderer.cleanupOverlay();
    }
    assert.equal(f.state.replayDiagnosticDisplayed, 41); assert.equal(f.animations.length, 41);
    assert.equal(f.events.length, 40); assert.equal(f.renderer.observationStatus().unresolved, 40);
    assert.ok(f.renderer.observationStatus().faults.includes('REGISTRY_EXHAUSTED'));
    for (const animation of f.animations) animation.resolve(); await settle();
    assert.equal(f.renderer.observationStatus().unresolved, 0);
    assert.equal(f.renderer.observationStatus().state, 'UNKNOWN');
});

test('unrecognized/duplicate attempt never fabricates observation or blocks rendering', async () => {
    const f = fixture(), binding = f.lease(); f.render({ binding }); f.renderer.cleanupOverlay();
    assert.equal(f.renderer.registerAttempt(binding.scope, binding.owner, binding.attempt), null);
    assert.equal(f.renderer.registerAttempt('serialized', binding.owner, {}), null);
    f.render({ binding }); assert.equal(f.state.replayDiagnosticDisplayed, 2);
    assert.equal(f.events.filter(e => e[0] === 'commit').length, 1);
    assert.ok(f.renderer.observationStatus().faults.includes('IDENTITY_INVALID'));
    for (const animation of f.animations) animation.resolve(); await settle();
});

test('observer absent uses legacy native promise chain with no additional then observer', async () => {
    const f = fixture({ observed: false }); const animationThen = Promise.prototype.then;
    let subscriptions = 0;
    Promise.prototype.then = function (...args) { subscriptions++; return Reflect.apply(animationThen, this, args); };
    try { assert.equal(f.render().status, 'rendered'); } finally { Promise.prototype.then = animationThen; }
    assert.equal(subscriptions, 2); // Original then + downstream catch only.
    assert.equal(f.renderer.observationStatus().state, 'NOT_INSTALLED');
    assert.equal(f.events.length, 0); f.animations[0].resolve(); await settle();
    assert.equal(f.state.activeDanmaku.size, 0);
});

test('actual candidate proof excludes subtitles and launch revalidates stale geometry', async () => {
    const f = fixture({ captions: true }); const proof = f.proof(); assert.ok(proof);
    assert.equal(proof.captionsEnabled, true); assert.equal(proof.hardExclusions.length, 1);
    assert.ok(schedulerFoundations.isOutsideHardExclusions(proof.rectangle, proof.hardExclusions));
    assert.equal(f.render({ launchProof: { ...proof, geometryRevision: 99 } }).status, 'drop');
    assert.equal(f.animations.length, 0); assert.equal(f.state.replayDiagnosticDisplayed, 0);
    assert.equal(f.render({ launchProof: proof }).status, 'rendered');
    f.animations[0].resolve(); await settle();
});

test('invalid/missing receiver remains UNKNOWN; missing observers are never success evidence', async () => {
    const f = fixture({ observer: {} }); assert.equal(f.render().status, 'rendered');
    f.animations[0].resolve(); await settle();
    assert.equal(f.renderer.observationStatus().state, 'UNKNOWN');
    assert.ok(f.renderer.observationStatus().faults.includes('OBSERVER_INVALID'));
    const g = fixture({ observed: false }); g.render(); g.animations[0].resolve(); await settle();
    assert.equal(g.renderer.observationStatus().state, 'NOT_INSTALLED');
});

test('legacy active cap, invalid target, Display and media guards preserve statuses', async () => {
    const f = fixture({ observed: false });
    f.video.paused = true; assert.equal(f.render().status, 'drop'); f.video.paused = false;
    assert.equal(f.renderer.renderDanmaku(f.message, 999, f.video, f.proof()).status, 'drop');
    for (let i = 0; i < overlayCore.DANMAKU_MAX_ACTIVE_COMMENTS; i++) {
        f.state.activeDanmaku.set(Symbol(), { animation: null, node: null });
    }
    assert.equal(f.renderer.renderDanmaku(f.message, 0, f.video, {}).status, 'drop');
    f.state.laneStates[0] = { endTimeMs: 2000 };
    assert.deepEqual(f.renderer.renderDanmaku(f.message, 0, f.video, {}), { status: 'wait', resumeAtMs: 2000 });
    f.state.activeDanmaku.clear();
});

test('pending-only real private port removal preserves actual renderer token and animation', async () => {
    const { createPrivatePendingScope } = require('../src/private-pending-scope.js');
    const { createSchedulerRuntime } = require('../src/scheduler-runtime.js');
    const pending = require('../src/pending-selection.js'), scopeCore = require('../src/diagnostic-scope-core.js');
    const f = fixture({ animationMode: 'never' }), document = {}, route = {
        tabId: 7, frameId: 0, documentId: '12345678-1234-1234-1234-123456789abc' };
    const binding = { document, targetId: 'target', lifecycle: 0, revision: 0 };
    const port = createPrivatePendingScope({ document, route, targetId: 'target', lifecycle: 0, revision: 0,
        pending, scopeCore, createRuntime: createSchedulerRuntime,
        runtimeOptions: { clock: () => 1000, generation: () => 0, scheduleOneShot: () => 1, cancelOneShot() {},
            geometryAdapter: geometryCore.createSubtitleGeometryAdapter({
                authority: geometryCore.createGeometryAuthority({ epsilon: 1 }),
                readGeometry: () => ({ state: 'KNOWN_EMPTY', exclusionRegions: [], capabilityAvailable: true }) }),
            candidateProof: () => null, launch() { throw Error('unexpected opportunity'); },
            config: { maxPendingAge: 1000, maxPendingCount: 20, pendingPressureCapacity: 5,
                scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
                pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: .75 },
                density: { attackThresholds: [.5, .7, .9], releaseThresholds: [.2, .3, .4], minimumAttackResidence: 1, releaseDwell: 3 },
                collisionAllowances: tuning.CURRENT.collisionAllowances } } });
    assert.ok(port); const view = port.connect(binding, route), scope = view.open();
    const lease = f.lease(scope); assert.equal(f.render({ binding: lease }).status, 'rendered');
    const [token, active] = [...f.state.activeDanmaku][0];
    assert.equal(port.presentation.enqueue(scope, { id: 'pending' }, {
        id: 'pending', enqueuedAt: 1000, rendererType: 'liveChatTextMessageRenderer', footprint: {} }), true);
    const result = view.terminal(scope); assert.equal(result.count, 1); assert.equal(result.proof, 'VERIFIED');
    assert.equal(f.state.activeDanmaku.get(token), active); assert.equal(active.node.isConnected, true);
    assert.equal(f.counts().cancelCalls, 0); assert.equal(f.events.length, 1);
    assert.equal(view.status().scopes.at(-1).accounting, 'UNKNOWN');
    f.animations[0].resolve(); await settle(); assert.equal(f.events[1][1].scope, scope);
});

test('late old-instance settlement is never assigned to another instance or Scope', async () => {
    const a = fixture({ animationMode: 'never' }), b = fixture();
    const old = a.lease(), current = b.lease(); a.render({ binding: old }); a.renderer.cleanupOverlay();
    b.render({ binding: current }); a.animations[0].resolve(); await settle();
    assert.equal(a.events[1][1].scope, old.scope);
    assert.notEqual(a.events[1][1].instance, b.events[0][1].instance);
    assert.equal(b.events.length, 1); assert.equal(b.state.activeDanmaku.size, 1);
    b.animations[0].resolve(); await settle();
});

test('legacy browser startup installs the existing listeners without the dormant observer', async () => {
    const calls = [], listeners = [];
    const window = { LiveFlowOverlayCore: overlayCore, location: { origin: 'https://www.youtube.com', pathname: '/' },
        addEventListener: (...args) => listeners.push(args), postMessage: value => calls.push(value.type) };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8'), {
        window, document: { addEventListener: (...args) => listeners.push(args) },
        performance: { now: () => 0 }, console, URL,
        fetch() { throw Error('network'); }, setTimeout() { throw Error('timer'); }
    });
    await settle();
    assert.equal(listeners.length, 17);
    assert.deepEqual(calls, ['LIVEFLOW_REPLAY_DIAGNOSTIC_SCOPE_HELLO']);
    assert.equal(Object.keys(window).some(key => /createRenderer|onCommit|onTerminal|onFault/.test(key)), false);
});

test('full teardown failure beyond cancel preserves throw and latches incomplete coverage', async () => {
    const f = fixture({ animationMode: 'never' }); f.render();
    f.state.phase3Runtime = { clear() { throw Error('runtime clear failed'); } };
    assert.throws(() => f.renderer.cleanupOverlay(), /runtime clear failed/);
    assert.equal(f.events.length, 1); assert.equal(f.renderer.observationStatus().state, 'UNKNOWN');
    f.animations[0].resolve(); await settle();
    assert.equal(f.events[1][2], 'FINISHED');
    assert.ok(f.renderer.observationStatus().faults.includes('CLEANUP_FAILED'));
});
