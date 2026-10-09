const test = require('node:test');
const assert = require('node:assert/strict');
const { GEOMETRY_STATES, createGeometryAuthority, createSubtitleGeometryAdapter } = require('../src/geometry-adapter.js');
const { createSchedulerRuntime, classifyLaunchGapClass, classifyLaunchGapCause } = require('../src/scheduler-runtime.js');

function harness({ geometryState = GEOMETRY_STATES.KNOWN_EMPTY, safe = true, observe, candidateProof, config: configOverride = {} } = {}) {
    let now = 100;
    let generation = 1;
    const timers = [];
    const launched = [];
    const launchProofs = [];
    const authority = createGeometryAuthority({ epsilon: 1 });
    let nextGeometry = { state: geometryState, exclusionRegions: [], capabilityAvailable: true };
    const adapter = createSubtitleGeometryAdapter({ authority, readGeometry: () => nextGeometry });
    const runtime = createSchedulerRuntime({
        clock: () => now,
        scheduleOneShot(callback, delay) { const timer = { callback, delay, fired: false, cancelled: false }; timers.push(timer); return timer; },
        cancelOneShot(timer) { timer.cancelled = true; },
        generation: () => generation,
        geometryAdapter: adapter,
        observe,
        candidateProof: candidateProof || (() => safe ? {
            candidates: [{ rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 100 }, lane: 0, laneSpan: 1 }],
            activeComments: [], horizontalGap: 20
        } : null),
        launch(payload, proof) { launched.push(payload.id); launchProofs.push(proof); return true; },
        config: {
            maxPendingAge: 1000, maxPendingCount: 10, pendingPressureCapacity: 5,
            scanDepth: 3, cohortMaximumItems: 3, cohortMaximumSpan: 50,
            pacing: { userBaseInterval: 400, minimumInterval: 100, maximumRescueFraction: 0.75 },
            density: { attackThresholds: [0.5, 0.7, 0.9], releaseThresholds: [0.2, 0.3, 0.4], minimumAttackResidence: 1, releaseDwell: 3 },
            collisionAllowances: Object.fromEntries(['CONSERVATIVE', 'LIMITED_CATCH_UP', 'BOUNDED_OVERLAP', 'MAXIMUM_READABLE_RESCUE'].map((name) => [name, {
                nominalGap: 20, hardMinimumSeparation: -10, maxCatchUpRatio: 0.5,
                maxOverlapDuration: 1, maxOverlapDepthRatio: 0.2, minimumVisibleFraction: 0.8
            }])),
            ...configOverride
        }
    });
    function fire() { const timer = timers.find((entry) => !entry.fired && !entry.cancelled); if (timer) { timer.fired = true; timer.callback(); } }
    function enqueue(id, rendererType = 'liveChatTextMessageRenderer', enqueuedAt = now) {
        return runtime.enqueue({ id }, { id, enqueuedAt, rendererType, footprint: { width: 50, height: 20 } });
    }
    return { runtime, timers, launched, launchProofs, adapter, authority, fire, enqueue,
        setGeneration(value) { generation = value; },
        setGeometry(value) { nextGeometry = value; adapter.markDirty('RESIZE'); },
        setNow(value) { now = value; } };
}

test('arrival flows through pending scheduler to one launch', () => {
    const h = harness();
    h.enqueue('a');
    assert.equal(h.timers[0].delay, 0);
    h.fire();
    assert.deepEqual(h.launched, ['a']);
});

test('launch-gap diagnostic classifies duration and fixed causes without raw timing', () => {
    assert.equal(classifyLaunchGapClass(100), 'SHORT');
    assert.equal(classifyLaunchGapClass(1000), 'NOTICEABLE');
    assert.equal(classifyLaunchGapClass(1600), 'LONG');
    assert.equal(classifyLaunchGapCause({ pendingCount: 0 }), 'NO_DUE_COMMENT');
    assert.equal(classifyLaunchGapCause({ pendingCount: 0, nearestFutureClass: 'SHORT_GAP' }), 'WAITING_FOR_FUTURE');
    assert.equal(classifyLaunchGapCause({ pendingCount: 2 }), 'PACING');
    assert.equal(classifyLaunchGapCause({ pendingCount: 2, collisionBlocked: true }), 'COLLISION_BLOCKED');
    assert.equal(classifyLaunchGapCause({ pendingCount: 2, selectionNone: true }), 'SELECTION_NONE');
    assert.equal(classifyLaunchGapCause({ pendingCount: 2, staleOnly: true }), 'STALE_ONLY');
    assert.equal(classifyLaunchGapCause({ pendingCount: 2, geometryBlocked: true }), 'GEOMETRY');
    assert.equal(JSON.stringify(classifyLaunchGapCause({ pendingCount: 2 })).includes('1000'), false);
});

test('stale diagnostic attributes collision-blocked and already-stale items without changing pruning', () => {
    const collisionEvents = [];
    const blocked = harness({
        observe: (event) => collisionEvents.push(event),
        candidateProof: () => ({
            candidates: [{ rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 200 }, lane: 0, laneSpan: 1 }],
            activeComments: [{ x: 80, y: 0, width: 50, height: 20, velocity: 100 }]
        })
    });
    blocked.enqueue('blocked');
    blocked.fire();
    blocked.setNow(1200);
    blocked.fire();
    const collisionStale = collisionEvents.find((event) => event.type === 'STALE_PRUNED');
    assert.equal(collisionStale.staleReasons.collisionBlocked, 1);
    assert.equal(blocked.runtime.status().pendingCount, 0);

    const oldEvents = [];
    const old = harness({ observe: (event) => oldEvents.push(event) });
    old.enqueue('old', 'liveChatTextMessageRenderer', -2000);
    old.fire();
    assert.equal(oldEvents.find((event) => event.type === 'STALE_PRUNED').staleReasons.alreadyStaleOnEnqueue, 1);
});

test('source-active collision blank reaches stale without lane expansion and launches through bounded expansion', () => {
    function run(includeExpansion) {
        const events = [];
        const h = harness({
            observe: (event) => events.push(event),
            config: { density: { attackThresholds: [0, 0.7, 0.9], releaseThresholds: [0.2, 0.3, 0.4], minimumAttackResidence: 1, releaseDwell: 3 } },
            candidateProof: (_item, _geometry, policy) => {
                assert.ok(['COMPACT', 'DENSE'].includes(policy.density));
                const candidates = [
                    { rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 200 }, lane: 0, laneSpan: 1 }
                ];
                if (includeExpansion) candidates.push(
                    { rectangle: { x: 100, y: 40, width: 50, height: 20, velocity: 200 }, lane: 2, laneSpan: 1, expanded: true }
                );
                return { candidates, activeComments: [{ x: 80, y: 0, width: 50, height: 20, velocity: 100 }] };
            }
        });
        h.runtime.clear();
        h.runtime.queue.enforceHardCount(0);
        h.enqueue('source-active');
        h.fire();
        if (!includeExpansion) {
            h.setNow(500); h.fire();
            h.setNow(900); h.fire();
            h.setNow(1200); h.fire();
        }
        return { h, events };
    }

    const baseline = run(false);
    assert.deepEqual(baseline.h.launched, []);
    assert.ok(baseline.events.filter(({ type }) => type === 'COLLISION_BLOCKED').length >= 3);
    assert.ok(baseline.events.filter(({ type }) => type === 'SELECTION_NONE').length >= 3);
    assert.equal(baseline.events.find(({ type }) => type === 'STALE_PRUNED').staleReasons.collisionBlocked, 1);
    assert.equal(baseline.h.runtime.status().pendingCount, 0);
    assert.equal(baseline.h.launched.length + 1 + baseline.h.runtime.status().pendingCount, 1,
        'one input is explicitly stale-dropped with zero unaccounted loss');

    const rescued = run(true);
    assert.deepEqual(rescued.h.launched, ['source-active']);
    assert.equal(rescued.events.filter(({ type }) => type === 'LAUNCH_COMMITTED').length, 1);
    assert.equal(rescued.events.filter(({ type }) => type === 'SELECTION_NONE').length, 0);
    assert.equal(rescued.events.filter(({ type }) => type === 'STALE_PRUNED').length, 0);
    assert.equal(rescued.h.runtime.status().pendingCount, 0);
    assert.equal(rescued.h.launched.length + rescued.h.runtime.status().pendingCount, 1,
        'one input is launched with zero unaccounted loss');
});

test('MAX_READABLE physical saturation emits one explicit NORMAL relief while SPECIAL remains retained', () => {
    const events = [];
    const h = harness({
        observe: (event) => events.push(event),
        config: { density: { attackThresholds: [0, 0, 0], releaseThresholds: [0.2, 0.3, 0.4], minimumAttackResidence: 1, releaseDwell: 3 } },
        candidateProof: () => ({
            candidates: [{ rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 200 }, lane: 0, laneSpan: 1 }],
            activeComments: [{ x: 80, y: 0, width: 50, height: 20, velocity: 100 }]
        })
    });
    h.enqueue('special', 'liveChatPaidMessageRenderer');
    h.enqueue('normal-oldest');
    h.enqueue('normal-newer');
    h.fire();
    h.fire();
    h.fire();

    const relief = events.filter(({ type }) => type === 'CAPACITY_DROPPED');
    assert.equal(relief.length, 1);
    assert.deepEqual(relief[0], { type: 'CAPACITY_DROPPED', count: 1, semanticClass: 'NORMAL', reason: 'PHYSICAL_SATURATION' });
    assert.deepEqual(h.runtime.queue.snapshot().map(({ id }) => id), ['special', 'normal-newer']);
    assert.equal(1 + h.runtime.status().pendingCount, 3, 'explicit relief plus retained closes accounting');
});

test('MAX_READABLE uses a safe candidate before relief and SPECIAL-only saturation remains temporal', () => {
    const safeEvents = [];
    const safe = harness({
        observe: (event) => safeEvents.push(event),
        config: { density: { attackThresholds: [0, 0, 0], releaseThresholds: [0.2, 0.3, 0.4], minimumAttackResidence: 1, releaseDwell: 3 } },
        candidateProof: (_item, _geometry, policy) => ({
            candidates: [{ rectangle: { x: 100, y: policy.density === 'MAX_READABLE' ? 40 : 0, width: 50, height: 20, velocity: 200 }, lane: 0, laneSpan: 1 }],
            activeComments: [{ x: 80, y: 0, width: 50, height: 20, velocity: 100 }]
        })
    });
    safe.enqueue('normal');
    safe.fire(); safe.fire(); safe.fire();
    assert.deepEqual(safe.launched, ['normal']);
    assert.equal(safeEvents.some(({ type }) => type === 'CAPACITY_DROPPED'), false);

    const specialEvents = [];
    const special = harness({
        observe: (event) => specialEvents.push(event),
        config: { density: { attackThresholds: [0, 0, 0], releaseThresholds: [0.2, 0.3, 0.4], minimumAttackResidence: 1, releaseDwell: 3 } },
        candidateProof: () => ({
            candidates: [{ rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 200 }, lane: 0, laneSpan: 1 }],
            activeComments: [{ x: 80, y: 0, width: 50, height: 20, velocity: 100 }]
        })
    });
    special.enqueue('special', 'liveChatPaidStickerRenderer');
    special.fire(); special.fire(); special.fire();
    assert.equal(specialEvents.some(({ type }) => type === 'CAPACITY_DROPPED'), false);
    assert.equal(special.runtime.status().pendingCount, 1);
    special.setNow(1200); special.fire();
    assert.equal(special.runtime.status().pendingCount, 0);
    assert.equal(specialEvents.some(({ type }) => type === 'STALE_PRUNED'), true);
});

test('emergency pending overflow remains distinct from physical saturation relief', () => {
    const events = [];
    const h = harness({ observe: (event) => events.push(event), config: { maxPendingCount: 2 } });
    h.enqueue('special', 'liveChatPaidMessageRenderer');
    h.enqueue('normal-a');
    h.enqueue('normal-b');
    assert.equal(events.some(({ type }) => type === 'CAPACITY_DROPPED'), false);
    const emergency = events.find(({ type }) => type === 'EMERGENCY_PENDING_DROPPED');
    assert.deepEqual(emergency, { type: 'EMERGENCY_PENDING_DROPPED', count: 1, reason: 'MAX_PENDING_COUNT' });
});

test('arrival while armed leaves the one-shot timer unchanged', () => {
    const h = harness();
    h.enqueue('a');
    const timer = h.timers[0];
    h.enqueue('b');
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0], timer);
});

test('one opportunity launches at most one and carries no blocked credit', () => {
    const h = harness();
    h.enqueue('a'); h.enqueue('b');
    h.fire();
    assert.deepEqual(h.launched, ['a']);
    assert.equal(h.runtime.status().pendingCount, 1);
});

test('stale entries are pruned before selection', () => {
    const h = harness();
    h.enqueue('old', 'liveChatTextMessageRenderer', 0);
    h.setNow(1500);
    h.enqueue('current');
    h.fire();
    assert.deepEqual(h.launched, ['current']);
    assert.equal(h.runtime.status().pendingCount, 0);
});

test('SPECIAL preference remains bounded by the temporal cohort', () => {
    const h = harness();
    h.enqueue('normal');
    h.enqueue('special', 'liveChatPaidMessageRenderer');
    h.fire();
    assert.deepEqual(h.launched, ['special']);
});

test('current Density policy is injected into bounded candidate proof and committed launch', () => {
    const observedPolicies = [];
    const h = harness({ candidateProof: (_item, _geometry, policy) => {
        observedPolicies.push(policy);
        return {
            candidates: [{ rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 100 }, lane: 0, laneSpan: 1 }],
            activeComments: []
        };
    } });
    h.enqueue('a'); h.fire();
    assert.equal(observedPolicies[0].laneBandClass, 'UPPER');
    assert.equal(observedPolicies[0].collisionAllowanceClass, 'CONSERVATIVE');
    assert.equal(h.launchProofs[0].laneSpan, 1);
    assert.equal(h.launchProofs[0].density, 'NORMAL');
});

test('UNREPRESENTABLE_SPECIAL is structurally removed and cannot permanently block a bounded scan', () => {
    const events = [];
    const h = harness({
        observe: (event) => events.push(event.type),
        candidateProof: (item) => item.payload.id === 'too-wide'
            ? { unrepresentableSpecial: true }
            : {
                candidates: [{ rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 100 }, lane: 0, laneSpan: 1 }],
                activeComments: []
            }
    });
    h.enqueue('too-wide', 'liveChatPaidMessageRenderer');
    h.enqueue('normal');
    h.fire();
    assert.deepEqual(h.launched, ['normal']);
    assert.equal(h.runtime.status().pendingCount, 0);
    assert.ok(events.includes('UNREPRESENTABLE_SPECIAL'));
});

test('subtitle exclusion and UNKNOWN geometry block without launch', () => {
    const blocked = harness();
    blocked.setGeometry({ state: GEOMETRY_STATES.KNOWN_PRESENT, exclusionRegions: [{ x: 0, y: 0, width: 200, height: 30 }], capabilityAvailable: true });
    blocked.enqueue('subtitle-blocked'); blocked.fire();
    assert.deepEqual(blocked.launched, []);

    const unknown = harness({ geometryState: GEOMETRY_STATES.UNKNOWN });
    unknown.enqueue('unknown'); unknown.fire();
    assert.deepEqual(unknown.launched, []);
});

test('generation and geometry revision changes invalidate before launch', () => {
    const generation = harness();
    generation.enqueue('a');
    generation.setGeneration(2);
    generation.fire();
    assert.deepEqual(generation.launched, []);
    assert.equal(generation.runtime.status().lastResult.outcome, 'INVALIDATED');
    generation.fire();
    assert.deepEqual(generation.launched, ['a']);

    const revision = harness();
    revision.enqueue('b');
    revision.setGeometry({ state: GEOMETRY_STATES.KNOWN_PRESENT, exclusionRegions: [{ x: 500, y: 500, width: 20, height: 20 }], capabilityAvailable: true });
    revision.fire();
    assert.deepEqual(revision.launched, []);
    assert.equal(revision.runtime.status().lastResult.outcome, 'INVALIDATED');
});

test('clear cancels scheduling and removes pending without touching launched objects', () => {
    const h = harness();
    h.enqueue('a');
    const displayed = Object.freeze({ immutable: true });
    h.runtime.clear();
    assert.equal(h.runtime.status().pendingCount, 0);
    assert.equal(h.timers[0].cancelled, true);
    assert.equal(displayed.immutable, true);
});

test('a fresh arrival after seek-style clear rearms through the normal empty transition', () => {
    const h = harness();
    h.enqueue('before-seek');
    h.runtime.clear();
    h.enqueue('after-seek');
    assert.equal(h.runtime.status().state, 'ARMED');
    h.fire();
    assert.deepEqual(h.launched, ['after-seek']);
});

test('runtime source uses no interval or animation-frame pacing loop', () => {
    const source = require('node:fs').readFileSync(require.resolve('../src/scheduler-runtime.js'), 'utf8');
    assert.doesNotMatch(source, /setInterval\s*\(|requestAnimationFrame\s*\(/);
    assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|postMessage\s*\(/);
});

test('production runtime loads Phase 3 modules and removes the legacy spread drain', () => {
    const fs = require('node:fs');
    const manifest = JSON.parse(fs.readFileSync(require.resolve('../manifest.json'), 'utf8'));
    const isolated = manifest.content_scripts.find((entry) => entry.world === 'ISOLATED').js;
    assert.ok(isolated.indexOf('src/scheduler-foundations.js') < isolated.indexOf('src/youtube-chat.js'));
    assert.ok(isolated.indexOf('src/scheduler-runtime.js') < isolated.indexOf('src/youtube-chat.js'));
    const source = fs.readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8');
    assert.doesNotMatch(source, /rendererQueue|drainRendererQueue|scheduleRendererQueueDrain|planContinuousDanmakuLaunch\s*\(/);
    assert.doesNotMatch(source, /setInterval\s*\(|requestAnimationFrame\s*\(/);
    assert.match(source, /runtime\.enqueue\(/);
    assert.match(source, /maxPendingAge: overlayCore\.DANMAKU_TARGET_DURATION_MS/);
    assert.doesNotMatch(source, /maxPendingAge: overlayCore\.DANMAKU_MAX_BATCH_SPREAD_MS/);
    assert.match(source, /phase3Runtime && phase3RuntimeVideo !== media\.video\) cleanupOverlay\(\)/);
});

test('subtitle dirty observation does not mutate already displayed comments', () => {
    const source = require('node:fs').readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8');
    const runtime = require('node:fs').readFileSync(require.resolve('../src/scheduler-runtime.js'), 'utf8');
    const observer = source.match(/subtitleMutationObserver = new MutationObserver\([^;]+;/)?.[0] || '';
    assert.match(observer, /markDirty/);
    assert.doesNotMatch(observer, /cleanupOverlay|activeDanmaku|animation|remove\s*\(/);
    assert.match(source, /generateDensityLaneCandidates/);
    assert.match(runtime, /proveBoundedCollisionSafe/);
});

test('runtime diagnostic distinguishes unknown geometry, collision blocking, and committed launch', () => {
    const unknownEvents = [];
    const unknown = harness({ geometryState: GEOMETRY_STATES.UNKNOWN, observe: (event) => unknownEvents.push(event.type) });
    unknown.enqueue('unknown'); unknown.fire();
    assert.ok(unknownEvents.includes('GEOMETRY_UNKNOWN'));
    assert.ok(unknownEvents.includes('SELECTION_NONE'));

    const blockedEvents = [];
    const blocked = harness({ safe: false, observe: (event) => blockedEvents.push(event.type) });
    blocked.enqueue('blocked'); blocked.fire();
    assert.ok(blockedEvents.includes('COLLISION_OTHER'));
    assert.ok(blockedEvents.includes('COLLISION_BLOCKED'));
    assert.ok(blockedEvents.includes('SELECTION_NONE'));

    const launchedEvents = [];
    const launched = harness({ observe: (event) => launchedEvents.push(event.type) });
    launched.enqueue('launched'); launched.fire();
    assert.ok(launchedEvents.includes('LAUNCH_COMMITTED'));
});

test('runtime diagnostic reports subtitle and active-danmaku rejection without raw geometry', () => {
    const subtitleEvents = [];
    const subtitle = harness({ geometryState: GEOMETRY_STATES.KNOWN_PRESENT, observe: (event) => subtitleEvents.push(event) });
    subtitle.setGeometry({ state: GEOMETRY_STATES.KNOWN_PRESENT, exclusionRegions: [{ x: 90, y: 0, width: 100, height: 30 }], capabilityAvailable: true });
    subtitle.enqueue('subtitle'); subtitle.fire();
    assert.ok(subtitleEvents.some(({ type }) => type === 'COLLISION_SUBTITLE'));

    const activeEvents = [];
    const active = harness({
        observe: (event) => activeEvents.push(event),
        candidateProof: () => ({
            candidates: [{ rectangle: { x: 100, y: 0, width: 50, height: 20, velocity: 200 }, lane: 0, laneSpan: 1 }],
            activeComments: [{ x: 80, y: 0, width: 50, height: 20, velocity: 100 }],
            horizontalGap: 20
        })
    });
    active.enqueue('active'); active.fire();
    assert.ok(activeEvents.some(({ type }) => type === 'COLLISION_ACTIVE_DANMAKU'));
    assert.ok([...subtitleEvents, ...activeEvents].every((event) =>
        !Object.hasOwn(event, 'candidate') && !Object.hasOwn(event, 'activeComments') && !Object.hasOwn(event, 'geometry')));
});
