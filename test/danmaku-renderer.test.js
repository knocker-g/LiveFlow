const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    DANMAKU_MAX_ACTIVE_COMMENTS,
    DANMAKU_MAX_MESSAGE_LENGTH,
    calculateLaneCount,
    selectAvailableLane,
    calculateDanmakuMotion,
    canRenderDanmaku,
    normalizeDanmakuMessage,
    getDanmakuLaneSpan,
    normalizeImageUrl,
    isMessageVisibleForSettings,
    shouldRenderAvatar,
    getRenderableMessageRuns,
    normalizeYouTubeColor,
    withCssColorAlpha,
    isPlaybackEligible,
    isMainContentPlaybackEligible,
    classifyLiveEdgeProximity,
    reduceLivePresentationResumeGate,
    computeLivePresentationAccounting,
    calculateVideoSurfaceRect,
    MIN_PLAYABLE_READY_STATE,
    calculateDanmakuSpeed,
    calculateCompensatedDanmakuDuration,
    calculateReplayPlaybackRateFactor,
    isLaneCollisionSafe,
    selectCollisionSafeLane,
    planDanmakuBatch,
    planContinuousDanmakuLaunch,
    calculateDanmakuLaunchCadence,
    calculateTimestampVisualGap,
    DANMAKU_DEFAULT_LAUNCH_CADENCE_MS,
    DANMAKU_MIN_LAUNCH_CADENCE_MS,
    DANMAKU_MAX_BATCH_SPREAD_MS,
    DANMAKU_BATCH_STAGGER_MS,
    DANMAKU_MAX_PENDING_COMMENTS,
    DANMAKU_MAX_RENDER_QUEUE,
    DANMAKU_ENTRY_CLEAR_FRACTION,
    calculateLaneSafeAtMs,
    findNextLaneAvailability,
    findNextLaneSpanAvailability,
    reserveLaneSpan,
    releaseLaneReservation,
    isRendererTargetCurrent,
    isEffectiveDisplayActive,
    getDisplayStateTransition,
    reduceDisplayState,
    getLocalizedMessage,
    getManagementBarViewModel,
    isChatStackedBelowPlayer,
    isNativeChatOpenButtonUsable,
    selectFirstUsableNativeChatButton,
    isChatOwnedZeroGeometryReopenCandidate,
    getNativeChatOpenCandidateRejectionReason,
    isNativeChatFrameVisible
} = require('../src/overlay-core.js');

const runtimeSource = fs.readFileSync(path.join(__dirname, '../src/youtube-chat.js'), 'utf8');
const pageStateSource = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');
const schedulerRuntimeSource = fs.readFileSync(path.join(__dirname, '../src/scheduler-runtime.js'), 'utf8');
const schedulerStateSource = fs.readFileSync(path.join(__dirname, '../src/scheduler-state-machine.js'), 'utf8');

test('lane count follows overlay height and remains bounded', () => {
    assert.equal(calculateLaneCount(360, 32, 4, 20), 10);
    assert.equal(calculateLaneCount(5000, 32, 4, 20), 20);
    assert.equal(calculateLaneCount(35, 32, 4, 20), 0);
});

test('invalid overlay geometry provides no lane', () => {
    for (const height of [0, -1, Number.NaN, Infinity, '360']) {
        assert.equal(calculateLaneCount(height), 0);
    }
});

test('lane assignment selects only a lane whose safe-entry time has passed', () => {
    assert.equal(selectAvailableLane([1200, 900, 1500], 3, 1000), 1);
    assert.equal(selectAvailableLane([1200, 1300], 2, 1000), -1);
    assert.equal(selectAvailableLane([], 0, 1000), -1);
});

test('constant-speed motion prevents a following comment from catching its predecessor', () => {
    const motion = calculateDanmakuMotion({ overlayWidth: 800, commentWidth: 240, speed: 120, horizontalGap: 24, startTimeMs: 1000 });
    assert.deepEqual(motion, {
        durationMs: 8667,
        laneAvailableAtMs: 3200,
        startX: 800,
        endX: -240
    });
    assert.equal(selectAvailableLane([motion.laneAvailableAtMs], 1, 3199), -1);
    assert.equal(selectAvailableLane([motion.laneAvailableAtMs], 1, 3200), 0);
});

test('relative batch timing preserves small timestamp differences and order', () => {
    const plan = planDanmakuBatch([
        { id: 'a', timestampUsec: '1000000' },
        { id: 'b', timestampUsec: '1200000' },
        { id: 'c', timestampUsec: '1500000' }
    ]);
    assert.deepEqual(plan.map((item) => item.delayMs), [0, 200, 500]);
    assert.deepEqual(plan.map((item) => item.message.id), ['a', 'b', 'c']);
});

test('large timestamp spread is proportionally compressed to the maximum display spread', () => {
    const plan = planDanmakuBatch([
        { timestampUsec: '1000000' },
        { timestampUsec: '3000000' },
        { timestampUsec: '6000000' }
    ]);
    assert.deepEqual(plan.map((item) => item.delayMs), [0, 320, DANMAKU_MAX_BATCH_SPREAD_MS]);
    assert.equal(plan.every((item) => item.delayMs <= DANMAKU_MAX_BATCH_SPREAD_MS), true);
});

test('invalid and equal timestamps use deterministic fallback stagger', () => {
    assert.deepEqual(planDanmakuBatch([
        { timestampUsec: 'invalid' },
        { timestampUsec: '' }
    ]).map((item) => item.delayMs), [0, DANMAKU_BATCH_STAGGER_MS]);
    assert.deepEqual(planDanmakuBatch([
        { timestampUsec: '1000000' },
        { timestampUsec: '1000000' }
    ]).map((item) => item.delayMs), [0, DANMAKU_BATCH_STAGGER_MS]);
});

test('long invalid-timestamp batches remain ordered and proportionally bounded', () => {
    const plan = planDanmakuBatch(Array.from({ length: 40 }, (_, index) => ({ id: String(index) })));
    assert.equal(plan.at(-1).delayMs, DANMAKU_MAX_BATCH_SPREAD_MS);
    assert.equal(plan.every((item, index) => index === 0 || item.delayMs >= plan[index - 1].delayMs), true);
});

test('initial large batches are bounded without reversing input order', () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({ id: String(index), timestampUsec: String(2000000 - index * 1000) }));
    const plan = planDanmakuBatch(messages);
    assert.equal(plan.length, DANMAKU_MAX_PENDING_COMMENTS);
    assert.deepEqual(plan.map((item) => item.message.id), messages.slice(-DANMAKU_MAX_PENDING_COMMENTS).map((item) => item.id));
    assert.equal(plan.every((item, index) => index === 0 || item.delayMs >= plan[index - 1].delayMs), true);
    assert.equal(plan.every((item) => item.delayMs <= DANMAKU_MAX_BATCH_SPREAD_MS), true);
});

test('variable speed keeps short comments near baseline and moderately accelerates longer comments', () => {
    const short = calculateDanmakuSpeed({ overlayWidth: 800, commentWidth: 50 });
    const medium = calculateDanmakuSpeed({ overlayWidth: 800, commentWidth: 400 });
    const long = calculateDanmakuSpeed({ overlayWidth: 800, commentWidth: 1000 });
    assert.equal(short, 120);
    assert.equal(medium, 150);
    assert.equal(long, 225);
    assert.ok(short < medium && medium < long);
});

test('variable speed clamps extremes and rejects invalid geometry', () => {
    assert.equal(calculateDanmakuSpeed({ overlayWidth: 100, commentWidth: 10 }), 120);
    assert.equal(calculateDanmakuSpeed({ overlayWidth: 800, commentWidth: 5000 }), 240);
    assert.equal(calculateDanmakuSpeed({ overlayWidth: 0, commentWidth: 100 }), null);
    assert.equal(calculateDanmakuSpeed({ overlayWidth: 800, commentWidth: Number.NaN }), null);
});

function previousLaneState(overrides = {}) {
    return {
        startTimeMs: 0,
        startX: 800,
        commentWidth: 200,
        speed: 120,
        endTimeMs: 8334,
        ...overrides
    };
}

test('collision model accepts same or slower trailing comments only after minimum gap', () => {
    const previous = previousLaneState();
    assert.equal(isLaneCollisionSafe(previous, { startX: 800, speed: 120 }, 2000, 24), true);
    assert.equal(isLaneCollisionSafe(previous, { startX: 800, speed: 100 }, 2000, 24), true);
    assert.equal(isLaneCollisionSafe(previous, { startX: 800, speed: 120 }, 1000, 24), false);
});

test('collision model rejects faster trailing comments that would catch the predecessor', () => {
    const previous = previousLaneState();
    assert.equal(isLaneCollisionSafe(previous, { startX: 800, speed: 200 }, 2000, 24), false);
    assert.equal(isLaneCollisionSafe(previous, { startX: 800, speed: 200 }, 8000, 24), true);
});

test('collision model handles long-to-short and short-to-long transitions safely', () => {
    const longPrevious = previousLaneState({ commentWidth: 600, speed: 200, endTimeMs: 7000 });
    const shortPrevious = previousLaneState({ commentWidth: 100, speed: 120, endTimeMs: 7500 });
    assert.equal(isLaneCollisionSafe(longPrevious, { startX: 800, speed: 120 }, 4000, 24), true);
    assert.equal(isLaneCollisionSafe(shortPrevious, { startX: 800, speed: 220 }, 2000, 24), false);
    assert.equal(selectCollisionSafeLane([shortPrevious, longPrevious], 2, { startX: 800, speed: 220 }, 2000, 24), -1);
});

test('motion rejects zero and invalid dimensions', () => {
    assert.equal(calculateDanmakuMotion({ overlayWidth: 0, commentWidth: 100, startTimeMs: 0 }), null);
    assert.equal(calculateDanmakuMotion({ overlayWidth: 100, commentWidth: -1, startTimeMs: 0 }), null);
    assert.equal(calculateDanmakuMotion({ overlayWidth: 100, commentWidth: 20, speed: Number.NaN, startTimeMs: 0 }), null);
});

test('empty, unknown, and excessively long messages are ignored safely', () => {
    assert.equal(normalizeDanmakuMessage({ messageType: 'text', message: '   ' }), null);
    assert.equal(normalizeDanmakuMessage({ messageType: 'unknown', message: 'hello' }), null);
    assert.equal(normalizeDanmakuMessage({ messageType: 'text', message: 'x'.repeat(DANMAKU_MAX_MESSAGE_LENGTH + 1) }), null);
    assert.deepEqual(normalizeDanmakuMessage({ id: 'a', authorName: 'Alice', messageType: 'text', message: ' hello ' }), {
        id: 'a', text: 'hello', authorName: 'Alice', authorPhoto: '', authorRole: 'guest', timestampUsec: '', laneSpan: 1, messageRuns: [{ type: 'text', text: 'hello' }]
    });
});

test('continuous launch planning preserves order and state across response batches', () => {
    const first = planContinuousDanmakuLaunch([{ id: 'a', timestampUsec: '1000000' }, { id: 'b', timestampUsec: '1150000' }], 1000, 0);
    assert.deepEqual(first.plan.map((entry) => [entry.message.id, entry.notBeforeMs]), [['a', 1000], ['b', 1150]]);
    const second = planContinuousDanmakuLaunch([{ id: 'c', timestampUsec: '1300000' }, { id: 'd', timestampUsec: '1600000' }], 1020, first.nextLaunchAtMs, 40, 120, first.lastTimestampUsec);
    assert.deepEqual(second.plan.map((entry) => [entry.message.id, entry.notBeforeMs]), [['c', 1300], ['d', 1600]]);
});

test('continuous launch planning gives low-density arrivals immediate deterministic launch', () => {
    const plan = planContinuousDanmakuLaunch([{ id: 'one' }], 5000, 1100);
    assert.equal(plan.plan[0].notBeforeMs, 5000);
    assert.equal(plan.nextLaunchAtMs, 5000);
    assert.deepEqual(planContinuousDanmakuLaunch(null, 10), { plan: [], nextLaunchAtMs: 10 });
});

test('high-density launch planning remains bounded and evenly cadenced', () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({ id: String(index) }));
    const cadence = calculateDanmakuLaunchCadence(DANMAKU_MAX_PENDING_COMMENTS);
    const result = planContinuousDanmakuLaunch(messages, 2000, 0, DANMAKU_MAX_PENDING_COMMENTS, cadence);
    assert.equal(result.plan.length, DANMAKU_MAX_PENDING_COMMENTS);
    assert.equal(result.plan.every((entry, index) => index === 0 || entry.notBeforeMs - result.plan[index - 1].notBeforeMs === 100), true);
    assert.equal(new Set(result.plan.map((entry) => entry.notBeforeMs)).size, result.plan.length);
    assert.equal(result.plan.at(-1).notBeforeMs - result.plan[0].notBeforeMs <= DANMAKU_MAX_BATCH_SPREAD_MS * 6, true);
    assert.equal(calculateDanmakuLaunchCadence(2), DANMAKU_DEFAULT_LAUNCH_CADENCE_MS);
    assert.equal(calculateDanmakuLaunchCadence(150), DANMAKU_MIN_LAUNCH_CADENCE_MS);
});

test('timestamp visual gaps are deterministic and bounded', () => {
    assert.equal(calculateTimestampVisualGap('1000000', '1250000'), 250);
    assert.equal(calculateTimestampVisualGap('1000000', '1001000'), 100);
    assert.equal(calculateTimestampVisualGap('1000000', '9000000'), 450);
    for (const current of ['', 'invalid', '999999', '1000000']) {
        assert.equal(calculateTimestampVisualGap('1000000', current), DANMAKU_DEFAULT_LAUNCH_CADENCE_MS);
    }
});

test('long comment duration compensation is bounded by rendered width and video width', () => {
    assert.equal(calculateCompensatedDanmakuDuration(800, 100), 8000);
    assert.equal(calculateCompensatedDanmakuDuration(800, 500), 7520);
    assert.equal(calculateCompensatedDanmakuDuration(800, 1000), 6720);
    assert.equal(calculateCompensatedDanmakuDuration(800, 5000), 6400);
    assert.equal(calculateCompensatedDanmakuDuration(0, 100), null);
    const duration = calculateCompensatedDanmakuDuration(800, 1000);
    const speed = calculateDanmakuSpeed({ overlayWidth: 800, commentWidth: 1000, targetDurationMs: duration });
    assert.equal(speed, Math.min(240, 1800 / (duration / 1000)));
});

test('Replay playback-rate factor scales wall-clock duration while Live baseline stays unchanged', () => {
    assert.equal(calculateReplayPlaybackRateFactor(0.5), 2);
    assert.equal(calculateReplayPlaybackRateFactor(1), 1);
    assert.equal(calculateReplayPlaybackRateFactor(2), 0.5);
    assert.equal(calculateReplayPlaybackRateFactor(1.25), 0.8);
    assert.equal(calculateReplayPlaybackRateFactor(0), null);
    assert.equal(calculateReplayPlaybackRateFactor(Number.NaN), null);
    assert.equal(calculateCompensatedDanmakuDuration(800, 100), 8000);
});

test('special card color alpha is bounded and invalid colors fail closed', () => {
    assert.equal(withCssColorAlpha('rgba(17, 34, 51, 1)', 0.8), 'rgba(17, 34, 51, 0.8)');
    assert.equal(withCssColorAlpha('rgb(1, 2, 3)', 0.75), 'rgba(1, 2, 3, 0.75)');
    assert.equal(withCssColorAlpha('rgba(999, 2, 3, 1)', 0.8), '');
    assert.equal(withCssColorAlpha('red', 0.8), '');
});

test('rich text uses sharp strokes and special cards keep opaque white flexible headers', () => {
    assert.doesNotMatch(runtimeSource, /text-shadow\s*:/);
    assert.match(runtimeSource, /-webkit-text-stroke/);
    assert.match(runtimeSource, /\.liveflow-danmaku img \{ -webkit-text-stroke: 0/);
    assert.match(runtimeSource, /withCssColorAlpha\(backgroundColor, 0\.8\)/);
    assert.match(runtimeSource, /node\.style\.color = '#FFFFFF'/);
    assert.match(runtimeSource, /liveflow-danmaku-amount \{ flex: 0 0 auto; white-space: nowrap/);
    assert.doesNotMatch(runtimeSource, /liveflow-danmaku-amount[^}]*text-overflow:\s*ellipsis/);
    assert.match(runtimeSource, /liveflow-danmaku-special \.liveflow-danmaku-author[^}]*overflow: visible[^}]*text-overflow: clip[^}]*white-space: nowrap/);
    assert.match(runtimeSource, /const renderedRect = node\.getBoundingClientRect\(\)[^]*?const commentWidth = renderedRect\.width[^]*?calculateCompensatedDanmakuDuration\(surfaceRect\.width, commentWidth\)/);
});

test('runtime smoothing uses one-shot Phase 3 pacing without response-boundary reset or burst credit', () => {
    assert.match(runtimeSource, /runtime\.enqueue\(/);
    assert.doesNotMatch(runtimeSource, /rendererNextLaunchAtMs|planContinuousDanmakuLaunch\s*\(|drainRendererQueue/);
    assert.match(schedulerStateSource, /if \(wasEmpty && state === STATES\.IDLE\) arm\(0\)/);
    assert.match(schedulerStateSource, /launched: 1/);
    assert.doesNotMatch(schedulerStateSource, /credit\s*\+=|launchAllowance/);
});

test('rich text normalization validates avatar URLs and role fallback', () => {
    const normalized = normalizeDanmakuMessage({
        id: 'rich', authorName: 'Alice', authorPhoto: 'https://example.com/avatar.png', authorRole: 'unknown',
        messageType: 'text', message: 'hello', messageRuns: [{ type: 'text', text: 'he' }, { type: 'image', url: 'javascript:bad' }, { type: 'text', text: 'llo' }]
    });
    assert.equal(normalized.authorPhoto, 'https://example.com/avatar.png');
    assert.equal(normalized.authorRole, 'guest');
    assert.deepEqual(normalized.messageRuns, [{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }]);
    assert.equal(normalizeImageUrl('javascript:alert(1)'), '');
    assert.equal(normalizeImageUrl('not a url'), '');
});

test('v1 semantic classes remain displayable regardless of legacy visibility flags', () => {
    assert.equal(isMessageVisibleForSettings({ messageType: 'text', authorRole: 'guest' }, { showGuest: true }), true);
    assert.equal(isMessageVisibleForSettings({ messageType: 'text', authorRole: 'guest' }, { showGuest: false }), true);
    assert.equal(isMessageVisibleForSettings({ messageType: 'text', authorRole: 'unknown' }, { showGuest: false }), true);
    assert.equal(isMessageVisibleForSettings({ messageType: 'unknown' }, {}), false);
});

test('avatar preference controls validated avatar rendering', () => {
    const message = { authorPhoto: 'https://example.com/avatar.png' };
    assert.equal(shouldRenderAvatar(message, { showAvatars: true }), true);
    assert.equal(shouldRenderAvatar(message, { showAvatars: false }), false);
    assert.equal(shouldRenderAvatar({ authorPhoto: 'javascript:bad' }, { showAvatars: true }), false);
    assert.equal(shouldRenderAvatar({}, { showAvatars: true }), false);
});

test('emoji image setting switches validated image runs to safe alt text immediately', () => {
    const message = { messageRuns: [
        { type: 'text', text: 'a' },
        { type: 'image', url: 'https://example.com/emoji.png', alt: ':wave:', isCustomEmoji: true },
        { type: 'image', url: 'javascript:bad', alt: 'bad' }
    ] };
    assert.deepEqual(getRenderableMessageRuns(message, { emojiImages: true }), [
        { type: 'text', text: 'a' },
        { type: 'image', url: 'https://example.com/emoji.png', alt: ':wave:', isCustomEmoji: true }
    ]);
    assert.deepEqual(getRenderableMessageRuns(message, { emojiImages: false }), [
        { type: 'text', text: 'a' }, { type: 'text', text: ':wave:' }
    ]);
    assert.notEqual(normalizeDanmakuMessage({ messageType: 'text', message: '', messageRuns: [{ type: 'image', url: 'https://example.com/only.png', alt: '' }] }), null);
});

test('SPECIAL remains displayable regardless of legacy visibility flags', () => {
    assert.equal(isMessageVisibleForSettings({ messageType: 'superChat' }, { showSuperChat: true }), true);
    assert.equal(isMessageVisibleForSettings({ messageType: 'superChat' }, { showSuperChat: false }), true);
    assert.equal(isMessageVisibleForSettings({ messageType: 'superSticker' }, { showSuperSticker: true }), true);
    assert.equal(isMessageVisibleForSettings({ messageType: 'superSticker' }, { showSuperSticker: false }), true);
});

test('legacy false values do not change the displayable activity shape', () => {
    const messages = [
        { messageType: 'text', authorRole: 'guest' },
        { messageType: 'text', authorRole: 'member' },
        { messageType: 'superChat' },
        { messageType: 'superSticker' }
    ];
    const legacyFalse = { showGuest: false, showMember: false, showSuperChat: false, showSuperSticker: false };
    assert.equal(messages.filter((message) => isMessageVisibleForSettings(message, legacyFalse)).length, messages.length);
});

test('special messages normalize observed fields and malformed colors fall back safely', () => {
    const normalized = normalizeDanmakuMessage({
        id: 'paid', messageType: 'superChat', message: 'hello', authorName: 'Alice', purchaseAmountText: '$5',
        colors: { bodyBackgroundColor: 0xff112233, bodyTextColor: 'unsafe' },
        messageRuns: [{ type: 'text', text: 'hello' }]
    });
    assert.equal(normalized.messageType, 'superChat');
    assert.equal(normalized.purchaseAmountText, '$5');
    assert.deepEqual(normalized.colors, { bodyBackgroundColor: 'rgba(17, 34, 51, 1)' });
    assert.equal(normalizeYouTubeColor(Number.NaN), '');
    assert.equal(normalizeYouTubeColor('4278190080'), '');
    assert.equal(normalizeYouTubeColor(0x00112233), '');
    assert.equal(normalizeDanmakuMessage({ messageType: 'superSticker', message: '', purchaseAmountText: '', sticker: { url: 'javascript:bad' } }), null);
});

test('rich comment DOM uses safe construction, bounded avatar geometry, and measured total width', () => {
    assert.match(runtimeSource, /document\.createElement\('img'\)/);
    assert.match(runtimeSource, /avatar\.width = 22/);
    assert.match(runtimeSource, /avatar\.height = 22/);
    assert.match(runtimeSource, /document\.createTextNode\(run\.text\)/);
    assert.match(runtimeSource, /liveflow-danmaku-emoji/);
    assert.match(runtimeSource, /image\.width = 29/);
    assert.match(runtimeSource, /liveflow-danmaku-sticker/);
    assert.match(runtimeSource, /sticker\.width = 32/);
    assert.match(runtimeSource, /liveflow-danmaku-special/);
    assert.match(runtimeSource, /const renderedRect = node\.getBoundingClientRect\(\)/);
    assert.match(runtimeSource, /min-height: 68px/);
    assert.match(runtimeSource, /const laneSpan = 1;/);
    assert.match(runtimeSource, /reserveLaneSpan\(laneStates, anchorIndex, laneSpan, reservation\)/);
    assert.match(runtimeSource, /releaseLaneReservation\(laneStates, token\)/);
    assert.doesNotMatch(runtimeSource, /innerHTML|insertAdjacentHTML|eval\s*\(|new Function/);
    assert.match(runtimeSource, /data-author-role="member"/);
    assert.match(runtimeSource, /data-author-role="moderator"/);
    assert.match(runtimeSource, /data-author-role="owner"/);
});

test('active hard limit drops new comments without disturbing existing comments', () => {
    const message = { messageType: 'text', message: 'hello' };
    assert.equal(canRenderDanmaku(message, DANMAKU_MAX_ACTIVE_COMMENTS - 1), true);
    assert.equal(canRenderDanmaku(message, DANMAKU_MAX_ACTIVE_COMMENTS), false);
});

test('playback gating accepts only a playing and ready video', () => {
    assert.equal(isPlaybackEligible({ paused: false, ended: false, readyState: MIN_PLAYABLE_READY_STATE }), true);
    assert.equal(isPlaybackEligible({ paused: true, ended: false, readyState: 4 }), false);
    assert.equal(isPlaybackEligible({ paused: false, ended: true, readyState: 4 }), false);
    assert.equal(isPlaybackEligible(null), false);
    assert.equal(isPlaybackEligible({ paused: false, ended: false, readyState: 1 }), false);
    assert.equal(isPlaybackEligible({ paused: false, ended: false, readyState: Number.NaN }), false);
});

test('Live edge proximity uses media ranges without an elapsed-time threshold', () => {
    assert.equal(classifyLiveEdgeProximity({
        currentTime: 118,
        seekable: [{ start: 0, end: 120 }],
        buffered: [{ start: 110, end: 120 }]
    }), 'NEAR_LIVE_EDGE');
    assert.equal(classifyLiveEdgeProximity({
        currentTime: 60,
        seekable: [{ start: 0, end: 120 }],
        buffered: [{ start: 55, end: 70 }]
    }), 'BEHIND_LIVE');
    for (const fixture of [
        {},
        { currentTime: 60, seekable: [], buffered: [{ start: 55, end: 70 }] },
        { currentTime: 60, seekable: [{ start: 0, end: 120 }], buffered: [] },
        { currentTime: 60, seekable: [{ start: 0, end: 120 }], buffered: [{ start: 70, end: 80 }] }
    ]) assert.equal(classifyLiveEdgeProximity(fixture), 'UNKNOWN');
});

test('Live and Premiere-live resume gate discards pause backlog and releases only on positive near-edge evidence', () => {
    const paused = reduceLivePresentationResumeGate(false, 'PAUSE');
    assert.deepEqual(paused, { active: true, allowLaunch: false, reason: 'MEDIA_PAUSED' });
    assert.deepEqual(reduceLivePresentationResumeGate(paused.active, 'BATCH', 'BEHIND_LIVE'), {
        active: true, allowLaunch: false, reason: 'BEHIND_LIVE'
    });
    assert.deepEqual(reduceLivePresentationResumeGate(paused.active, 'BATCH', 'UNKNOWN'), {
        active: true, allowLaunch: false, reason: 'UNKNOWN'
    });
    assert.deepEqual(reduceLivePresentationResumeGate(paused.active, 'BATCH', 'NEAR_LIVE_EDGE'), {
        active: false, allowLaunch: true, reason: 'CURRENT'
    });
    assert.deepEqual(reduceLivePresentationResumeGate(false, 'BATCH', 'UNKNOWN'), {
        active: false, allowLaunch: true, reason: 'CURRENT'
    });
});

test('Live and Premiere-live pause gate Presentation while leaving acquisition and Replay R8 separate', () => {
    const mediaHandler = runtimeSource.match(/function handleReplayMediaContextChange\(event\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(mediaHandler, /currentChatMode === 'live' && \['pause', 'seeking'\]\.includes\(event\.type\)[^]*?reduceLivePresentationResumeGate[^]*?livePresentationResumeGateActive = gate\?\.active !== false[^]*?cleanupOverlay\(\)[^]*?return/);
    const liveBranch = mediaHandler.slice(mediaHandler.indexOf("if (currentChatMode === 'live'"), mediaHandler.indexOf("if (currentChatMode !== 'replay')"));
    assert.doesNotMatch(liveBranch, /currentMessages\s*=\s*\[\]/);
    assert.doesNotMatch(mediaHandler, /LiveFlowStopReadLoop|requestInitialContinuation/);
    assert.match(mediaHandler, /if \(currentChatMode !== 'replay'\) return;[^]*?replaySchedulerDiagnostic/);
    const schedule = runtimeSource.match(/function scheduleDanmakuBatch\(messages\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(schedule, /currentChatMode === 'live' && livePresentationResumeGateActive[^]*?classifyLiveEdgeProximity[^]*?reduceLivePresentationResumeGate[^]*?if \(!gate\.allowLaunch\)[^]*?return/);
    assert.match(schedule, /suppressedBehindLive[^]*?suppressedUnknown/);
    assert.doesNotMatch(schedule, /\b\d+\s*\*\s*1000|setTimeout|setInterval/);
});

test('Live pause suppression accounting is explicit and conservative', () => {
    assert.deepEqual(computeLivePresentationAccounting({ input: 4, lifecycleSuppressed: 4 }), {
        input: 4, accounted: 4, lostUnaccounted: 0, valid: true
    });
    assert.deepEqual(computeLivePresentationAccounting({ input: 4, enqueued: 3 }), {
        input: 4, accounted: 3, lostUnaccounted: 1, valid: true
    });
    assert.match(runtimeSource, /function livePresentationAccountingStatus\(\)[^]*?computeLivePresentationAccounting/);
    assert.match(runtimeSource, /suppressedPaused:[^]*suppressedBehindLive:[^]*suppressedUnknown:/);
    assert.match(runtimeSource, /LiveFlowLivePresentationDiagnostic = Object\.freeze/);
});

test('video surface matches video when player and video have equal rects', () => {
    const rect = { left: 10, top: 20, width: 800, height: 450 };
    assert.deepEqual(calculateVideoSurfaceRect(rect, rect), { left: 0, top: 0, width: 800, height: 450 });
});

test('video surface excludes landscape pillarbox regions', () => {
    assert.deepEqual(calculateVideoSurfaceRect(
        { left: 0, top: 0, width: 1000, height: 500 },
        { left: 100, top: 0, width: 800, height: 500 }
    ), { left: 100, top: 0, width: 800, height: 500 });
});

test('video surface excludes letterbox regions and preserves offsets', () => {
    assert.deepEqual(calculateVideoSurfaceRect(
        { left: 20, top: 30, width: 800, height: 600 },
        { left: 20, top: 105, width: 800, height: 450 }
    ), { left: 0, top: 75, width: 800, height: 450 });
    assert.deepEqual(calculateVideoSurfaceRect(
        { left: 50, top: 60, width: 900, height: 600 },
        { left: 150, top: 110, width: 700, height: 400 }
    ), { left: 100, top: 50, width: 700, height: 400 });
});

test('video surface rejects missing, invalid, zero, and non-overlapping rects', () => {
    const player = { left: 0, top: 0, width: 800, height: 450 };
    assert.equal(calculateVideoSurfaceRect(player, null), null);
    assert.equal(calculateVideoSurfaceRect(player, { left: 0, top: 0, width: 0, height: 450 }), null);
    assert.equal(calculateVideoSurfaceRect(player, { left: 0, top: 0, width: Number.NaN, height: 450 }), null);
    assert.equal(calculateVideoSurfaceRect(player, { left: 900, top: 0, width: 100, height: 100 }), null);
});

test('new geometry can be calculated independently after resize', () => {
    const wide = calculateDanmakuMotion({ overlayWidth: 1000, commentWidth: 100, startTimeMs: 0 });
    const narrow = calculateDanmakuMotion({ overlayWidth: 400, commentWidth: 100, startTimeMs: 0 });
    assert.ok(wide.durationMs > narrow.durationMs);
    assert.equal(wide.laneAvailableAtMs, narrow.laneAvailableAtMs);
});

test('renderer drops paused messages without queueing or resume bursts', () => {
    assert.match(runtimeSource, /if \(!media \|\| !overlayCore\?\.isMainContentPlaybackEligible\?\.\(media\.player, media\.video\)\) \{\s*phase3Runtime\?\.clear\(\)/);
    assert.doesNotMatch(runtimeSource, /addEventListener\(['"]play|addEventListener\(['"]playing|pendingMessages|messageQueue/);
    assert.match(runtimeSource, /scheduleDanmakuBatch\(newMessages\)/);
});

test('Replay due handoff can become lifecycleDiscarded when playback pauses before presentation admission', () => {
    const player = { classList: { contains: () => false } };
    const video = { paused: false, ended: false, readyState: MIN_PLAYABLE_READY_STATE };
    assert.equal(isMainContentPlaybackEligible(player, video), true,
        'the acquisition-side due decision can observe playable media');
    video.paused = true;
    assert.equal(isMainContentPlaybackEligible(player, video), false,
        'the later presentation-side admission can observe the same media paused');

    const flush = pageStateSource.match(/function flushReplayPending\([^]*?\n    \}/)?.[0] || '';
    assert.ok(flush.indexOf('replayPending = selection.pending') < flush.indexOf('postReadResult({ ok: true'),
        'due items leave replayPending before the asynchronous bridge handoff');
    const schedule = runtimeSource.match(/function scheduleDanmakuBatch\(messages\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(schedule, /media\.video\?\.paused === true[^]*'lifecycleDiscardedMediaPaused'/);
    assert.match(schedule, /lifecycleDiscarded: inputCount, \[reasonField\]: inputCount/);
    const admission = schedule.slice(0, schedule.indexOf('const runtime = ensurePhase3Runtime()'));
    assert.doesNotMatch(admission, /pageRevision|pageLifecycleGeneration|readGeneration|authority/,
        'this discard is presentation eligibility, not an authority-binding comparison');
});

test('Replay lifecycle discard diagnostics distinguish disabled and not-ready admission without changing returns', () => {
    const schedule = runtimeSource.match(/function scheduleDanmakuBatch\(messages\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(schedule, /!isEffectiveDisplayActive\(\)[^]*lifecycleDiscardedDisplayDisabled: inputCount[^]*return;/);
    assert.equal(isEffectiveDisplayActive({ userEnabled: false, nativeChatVisible: false }), false);
    assert.equal(isMainContentPlaybackEligible(
        { classList: { contains: () => false } },
        { paused: false, ended: false, readyState: MIN_PLAYABLE_READY_STATE - 1 }
    ), false);
    assert.match(schedule, /media\.video\.readyState < 2[^]*'lifecycleDiscardedMediaNotReady'/);
    assert.equal((schedule.match(/lifecycleDiscarded: inputCount/g) || []).length, 2,
        'the two existing discard branches and their control flow remain unchanged');
});

test('renderer generation rejects stale timers across repeated transitions', () => {
    const firstVideo = {};
    const secondVideo = {};
    assert.equal(isRendererTargetCurrent({
        scheduledGeneration: 1,
        currentGeneration: 2,
        scheduledVideo: firstVideo,
        currentVideo: secondVideo,
        currentPlayerOwnsVideo: true
    }), false);
    assert.equal(isRendererTargetCurrent({
        scheduledGeneration: 1,
        currentGeneration: 3,
        scheduledVideo: firstVideo,
        currentVideo: secondVideo,
        currentPlayerOwnsVideo: true
    }), false);
});

test('renderer target accepts only the same current main video', () => {
    const currentVideo = {};
    assert.equal(isRendererTargetCurrent({
        scheduledGeneration: 4,
        currentGeneration: 4,
        scheduledVideo: currentVideo,
        currentVideo,
        currentPlayerOwnsVideo: true
    }), true);
    assert.equal(isRendererTargetCurrent({
        scheduledGeneration: 4,
        currentGeneration: 4,
        scheduledVideo: {},
        currentVideo,
        currentPlayerOwnsVideo: true
    }), false);
    assert.equal(isRendererTargetCurrent({
        scheduledGeneration: 4,
        currentGeneration: 4,
        scheduledVideo: currentVideo,
        currentVideo,
        currentPlayerOwnsVideo: false
    }), false);
});

test('navigation invalidates renderer and cancels pending and active work', () => {
    assert.match(runtimeSource, /function cleanupOverlay\(\)\s*\{\s*rendererGeneration \+= 1;/);
    assert.match(runtimeSource, /phase3Runtime\?\.clear\(\)/);
    assert.match(schedulerRuntimeSource, /scheduler\.stop\(\);\s*queue\.enforceHardCount\(0\)/);
    assert.match(runtimeSource, /activeDanmaku\.forEach\([^]*?animation\?\.cancel\(\)/);
    assert.match(runtimeSource, /addEventListener\('yt-navigate-start', handleNavigationStart\)/);
    assert.match(runtimeSource, /function handleNavigationStart\(\)[^]*?disconnectNativeChatObserver\(\)[^]*?cleanupOverlay\(\)/);
});

test('stale timer callback verifies generation and video before DOM insertion', () => {
    assert.match(runtimeSource, /launch: \(entry, proof\) => renderDanmaku\(entry\.message, entry\.generation, entry\.video, proof, entry\.settingsSnapshot\)/);
    assert.match(runtimeSource, /scheduledGeneration,[^]*?currentGeneration: rendererGeneration[^]*?scheduledVideo/);
    assert.match(schedulerStateSource, /generation\(\) !== expectedGeneration[^]*?OUTCOMES\.INVALIDATED/);
});

test('main-player lookup is scoped to the current watch root and rejects MiniPlayer', () => {
    assert.match(runtimeSource, /watchRoot\?\.querySelector\(PLAYER_SELECTORS\.player\)/);
    assert.match(runtimeSource, /player\.closest\(PLAYER_SELECTORS\.miniPlayerAncestor\)/);
    assert.match(runtimeSource, /player\.classList\.contains\('ytp-player-minimized'\)/);
    assert.doesNotMatch(runtimeSource, /document\.querySelector\('#movie_player'\)/);
});

test('renderer queue is bounded with one timer and cancelled during teardown and SPA cleanup', () => {
    assert.equal(DANMAKU_MAX_RENDER_QUEUE, 150);
    assert.match(runtimeSource, /maxPendingCount: overlayCore\.DANMAKU_MAX_RENDER_QUEUE/);
    assert.match(schedulerRuntimeSource, /queue\.enforceHardCount\(config\.maxPendingCount\)/);
    assert.match(schedulerStateSource, /let timerHandle = null/);
    assert.match(schedulerStateSource, /cancelOneShot\(timerHandle\)/);
    assert.match(schedulerRuntimeSource, /queue\.enforceHardCount\(0\)/);
    assert.match(runtimeSource, /function resetPageState\(\)[^]*?cleanupOverlay\(\)/);
});

test('quarter-width rule and variable-speed collision safety determine lane release', () => {
    assert.equal(DANMAKU_ENTRY_CLEAR_FRACTION, 0.25);
    const previous = previousLaneState();
    const sameSpeed = { startX: 800, speed: 120 };
    assert.equal(calculateLaneSafeAtMs(previous, sameSpeed, 800, 3000), 3334);
    assert.deepEqual(findNextLaneAvailability([previous], 1, sameSpeed, 800, 3333), { lane: -1, nextSafeAtMs: 3334 });
    assert.equal(findNextLaneAvailability([previous], 1, sameSpeed, 800, 3334).lane, 0);
    const faster = { startX: 800, speed: 200 };
    const waiting = findNextLaneAvailability([previous], 1, faster, 800, 4000);
    assert.equal(waiting.lane, -1);
    assert.ok(waiting.nextSafeAtMs > 4000);
    assert.equal(findNextLaneAvailability([previous], 1, faster, 800, waiting.nextSafeAtMs).lane, 0);
});

test('empty lane is immediately available and invalid lane data fails closed', () => {
    assert.deepEqual(findNextLaneAvailability([null], 1, { startX: 800, speed: 120 }, 800, 1000), { lane: 0, nextSafeAtMs: 1000 });
    assert.equal(calculateLaneSafeAtMs({ startTimeMs: 0 }, { startX: 800, speed: 120 }, 800, 1000), null);
});

test('renderer refreshes the actual video rect for each new comment', () => {
    assert.match(runtimeSource, /calculateVideoSurfaceRect\(player\.getBoundingClientRect\(\), video\.getBoundingClientRect\(\)\)/);
    assert.match(runtimeSource, /overlaySurface\.style\.left/);
    assert.match(runtimeSource, /overlaySurface\.style\.width/);
    assert.match(runtimeSource, /calculateLaneCount\(surfaceRect\.height, phase5Tuning\.lineHeight, phase5Tuning\.laneGap\)/);
    assert.match(runtimeSource, /overlayWidth: surfaceRect\.width/);
});

test('renderer uses browser animation and removes completed or torn-down comments', () => {
    assert.match(runtimeSource, /node\.animate\(/);
    assert.match(runtimeSource, /animation\.finished\.then\(/);
    assert.match(runtimeSource, /activeDanmaku\.delete\(token\)/);
    assert.match(runtimeSource, /activeDanmaku\.forEach/);
    assert.match(runtimeSource, /animation\?\.cancel\(\)/);
    assert.match(runtimeSource, /activeDanmaku\.clear\(\)/);
    assert.doesNotMatch(runtimeSource, /setInterval\s*\(|innerHTML|requestAnimationFrame/);
});

test('overlay root is reused and remains non-interactive', () => {
    assert.match(runtimeSource, /overlayRoot\?\.isConnected && overlayRoot\.parentElement === player/);
    assert.match(runtimeSource, /pointer-events:none/);
    assert.match(runtimeSource, /overflow:hidden/);
    assert.match(runtimeSource, /document\.createTextNode\(run\.text\)/);
});

test('display state permits every Native Chat combination and follows userEnabled only', () => {
    assert.equal(isEffectiveDisplayActive({ userEnabled: true, nativeChatVisible: false }), true);
    assert.equal(isEffectiveDisplayActive({ userEnabled: true, nativeChatVisible: true }), true);
    assert.equal(isEffectiveDisplayActive({ userEnabled: false, nativeChatVisible: false }), false);
    assert.equal(isEffectiveDisplayActive({ userEnabled: false, nativeChatVisible: true }), false);
    assert.match(runtimeSource, /let userEnabled = true;/);
});

test('Native Chat visibility transitions do not disable or clean an enabled renderer', () => {
    const chatOpened = getDisplayStateTransition(
        { userEnabled: true, nativeChatVisible: false },
        { nativeChatVisible: true }
    );
    assert.deepEqual(chatOpened, { userEnabled: true, nativeChatVisible: true, effectiveActive: true, cleanupRequired: false });

    const chatClosed = getDisplayStateTransition(chatOpened, { nativeChatVisible: false });
    assert.deepEqual(chatClosed, { userEnabled: true, nativeChatVisible: false, effectiveActive: true, cleanupRequired: false });

    const userDisabled = getDisplayStateTransition(chatClosed, { userEnabled: false });
    assert.deepEqual(userDisabled, { userEnabled: false, nativeChatVisible: false, effectiveActive: false, cleanupRequired: true });

    const userEnabled = getDisplayStateTransition(userDisabled, { userEnabled: true });
    assert.deepEqual(userEnabled, { userEnabled: true, nativeChatVisible: false, effectiveActive: true, cleanupRequired: false });
});

test('Native Chat linkage remains presentation-only and never starts or stops acquisition', () => {
    const action = runtimeSource.match(/function applyDisplayAction\(action\) \{[^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(action, /requestReadOnce|STOP_READ_LOOP_TYPE|RESUME_READ_LOOP_TYPE|acceptingReadResults|currentPageRevision/);
});

test('closing Native Chat auto-enables LiveFlow only on a known open-to-closed edge', () => {
    const settings = { autoEnableLiveFlowWhenNativeChatClosed: true, autoOpenNativeChatWhenLiveFlowDisabled: true };
    const closed = reduceDisplayState(
        { userEnabled: false, nativeChatVisible: true, nativeChatKnown: true },
        { type: 'native-chat-visibility', value: false },
        settings
    );
    assert.equal(closed.userEnabled, true);
    assert.equal(closed.effectiveActive, true);

    const alreadyEnabled = reduceDisplayState(
        { userEnabled: true, nativeChatVisible: true, nativeChatKnown: true },
        { type: 'native-chat-visibility', value: false },
        settings
    );
    assert.equal(alreadyEnabled.userEnabled, true);
    assert.equal(alreadyEnabled.cleanupRequired, false);

    const initialClosed = reduceDisplayState(
        { userEnabled: false, nativeChatVisible: true, nativeChatKnown: false },
        { type: 'native-chat-visibility', value: false },
        settings
    );
    assert.equal(initialClosed.userEnabled, false);
});

test('disabling LiveFlow requests Native Chat open only for a known closed Chat', () => {
    const settings = { autoEnableLiveFlowWhenNativeChatClosed: true, autoOpenNativeChatWhenLiveFlowDisabled: true };
    const closed = reduceDisplayState(
        { userEnabled: true, nativeChatVisible: false, nativeChatKnown: true },
        { type: 'set-user-enabled', value: false },
        settings
    );
    assert.equal(closed.requestNativeChatOpen, true);
    assert.equal(closed.cleanupRequired, true);

    const open = reduceDisplayState(
        { userEnabled: true, nativeChatVisible: true, nativeChatKnown: true },
        { type: 'set-user-enabled', value: false },
        settings
    );
    assert.equal(open.requestNativeChatOpen, false);

    const repeated = reduceDisplayState(closed, { type: 'set-user-enabled', value: false }, settings);
    assert.equal(repeated.requestNativeChatOpen, false);
    assert.equal(repeated.changed, false);
});

test('disabled linkage settings never change the opposite state', () => {
    const disabled = { autoEnableLiveFlowWhenNativeChatClosed: false, autoOpenNativeChatWhenLiveFlowDisabled: false };
    const closed = reduceDisplayState(
        { userEnabled: false, nativeChatVisible: true, nativeChatKnown: true },
        { type: 'native-chat-visibility', value: false },
        disabled
    );
    assert.equal(closed.userEnabled, false);
    const turnedOff = reduceDisplayState(
        { userEnabled: true, nativeChatVisible: false, nativeChatKnown: true },
        { type: 'set-user-enabled', value: false },
        disabled
    );
    assert.equal(turnedOff.requestNativeChatOpen, false);
});

test('Native Chat visibility handles visible, hidden, collapsed, and missing ownership states', () => {
    const visible = { belongsToCurrentWatchRoot: true, hiddenAttribute: false, collapsed: false, display: 'block', visibility: 'visible', width: 400, height: 300 };
    assert.equal(isNativeChatFrameVisible(visible), true);
    assert.equal(isNativeChatFrameVisible({ ...visible, hiddenAttribute: true }), false);
    assert.equal(isNativeChatFrameVisible({ ...visible, display: 'none' }), false);
    assert.equal(isNativeChatFrameVisible({ ...visible, visibility: 'hidden' }), false);
    assert.equal(isNativeChatFrameVisible({ ...visible, collapsed: true }), false);
    assert.equal(isNativeChatFrameVisible({ ...visible, width: 0 }), false);
    assert.equal(isNativeChatFrameVisible({ ...visible, height: 0 }), false);
    assert.equal(isNativeChatFrameVisible({ ...visible, belongsToCurrentWatchRoot: false }), false);
});

test('unknown frame geometry fails safe while a missing frame is treated as not visible', () => {
    assert.equal(isNativeChatFrameVisible({
        belongsToCurrentWatchRoot: true,
        hiddenAttribute: false,
        collapsed: false,
        display: 'block',
        visibility: 'visible'
    }), true);
    assert.match(runtimeSource, /if \(!frame\) return false;/);
    assert.match(runtimeSource, /catch \(error\) \{\s*return true;/);
});

test('display controller persists only the user default while runtime state stays document-local', () => {
    assert.match(runtimeSource, /window\.LiveFlowDisplayState = Object\.freeze\(\{/);
    assert.match(runtimeSource, /setUserEnabled\(value\)/);
    assert.match(runtimeSource, /getUserEnabled\(\)/);
    assert.match(runtimeSource, /updateSettings\(storageArea, runtimeSettings, \{ displayEnabled: value \}\)/);
    assert.match(runtimeSource, /if \(initializeDisplay\) userEnabled = snapshot\.displayEnabled === true/);
    assert.match(runtimeSource, /storage\?\.onChanged\?\.addListener[^]*?applyPersistentSettings\(changes\[settingsCore\.STORAGE_KEY\]\.newValue\)/);
    assert.doesNotMatch(runtimeSource, /localStorage|sessionStorage/);
});

test('display OFF is presentation-only and re-enable does not restart acquisition', () => {
    const action = runtimeSource.match(/function applyDisplayAction\(action\) \{[^]*?\n    \}/)?.[0] || '';
    assert.match(action, /if \(transition\.cleanupRequired\) cleanupOverlay\(\)/);
    assert.match(action, /if \(wasUserEnabled && !userEnabled\) \{\s*currentMessages = \[\]/);
    assert.doesNotMatch(action, /LiveFlowStopReadLoop|acceptingReadResults\s*=\s*false|requestInitialContinuation|readRequestedRevision\s*=\s*-1/);
    assert.match(runtimeSource, /function scheduleDanmakuBatch\(messages\)[^]*?if \(!isEffectiveDisplayActive\(\)\) \{[^]*?lifecycleDiscardedDisplayDisabled: inputCount[^]*?return;/);
});

test('persisted display default is applied before startup without cross-tab runtime broadcast', () => {
    assert.match(runtimeSource, /initializePersistentSettings\(\)\.then\(\(\) => \{\s*if \(isYouTubeWatchPage\(\)\) detectPage\(\)/);
    assert.match(runtimeSource, /function detectPage\(\) \{\s*if \(!persistentSettingsReady\) return;/);
    const persistent = runtimeSource.match(/function applyPersistentSettings\(settings[^]*?\n    \}/)?.[0] || '';
    assert.match(persistent, /if \(initializeDisplay\) userEnabled = snapshot\.displayEnabled === true/);
    const listener = runtimeSource.match(/storage\?\.onChanged\?\.addListener\([^]*?\n        \}\);/)?.[0] || '';
    assert.doesNotMatch(listener, /set-user-enabled|userEnabled\s*=/);
});

test('inactive transitions clean pending and active danmaku without replay on re-enable', () => {
    assert.match(runtimeSource, /if \(transition\.cleanupRequired\) cleanupOverlay\(\)/);
    assert.match(runtimeSource, /function scheduleDanmakuBatch\(messages\)[^]*?if \(!isEffectiveDisplayActive\(\)\) \{[^]*?lifecycleDiscarded: inputCount[^]*?return;/);
    assert.match(runtimeSource, /function cleanupOverlay\(\)[^]*?phase3Runtime\?\.clear\(\)/);
    assert.match(runtimeSource, /if \(media && isEffectiveDisplayActive\(\)\) attachOverlay\(media\.player\)/);
    assert.doesNotMatch(runtimeSource, /disabledMessages|displayBacklog|replayPending/);
});

test('Native Chat observer is single, scoped, mutation-filtered, and cleaned up for SPA and pagehide', () => {
    assert.match(runtimeSource, /if \(watchRoot === observedWatchRoot && nativeChatObserver\) return;/);
    assert.match(runtimeSource, /nativeChatObserver\.observe\(watchRoot,/);
    assert.match(runtimeSource, /mutations\.some\(mutationAffectsNativeChat\)/);
    assert.match(runtimeSource, /window\.queueMicrotask\(evaluateNativeChatVisibility\)/);
    assert.match(runtimeSource, /function handleNavigationStart\(\)[^]*?disconnectNativeChatObserver\(\)/);
    assert.match(runtimeSource, /function handlePageHide\(\)[^]*?disconnectNativeChatObserver\(\)/);
    assert.doesNotMatch(runtimeSource, /nativeChatObserver\.observe\(document/);
});

test('SPA evaluation uses the new current watch root and MiniPlayer policy remains intact', () => {
    assert.match(runtimeSource, /const watchRoot = document\.querySelector\(PLAYER_SELECTORS\.watchRoot\);\s*applyDisplayAction/);
    assert.match(runtimeSource, /player\.closest\(PLAYER_SELECTORS\.miniPlayerAncestor\)/);
    assert.match(runtimeSource, /addEventListener\('yt-navigate-finish', detectPage\)/);
});

test('Native Chat open button is usable only when visible, enabled, and owned by current watch root', () => {
    const usable = { belongsToCurrentWatchRoot: true, associatedWithNativeChat: true, disabled: false, ariaDisabled: 'false', display: 'block', visibility: 'visible', width: 100, height: 32 };
    assert.equal(isNativeChatOpenButtonUsable(usable), true);
    assert.equal(isNativeChatOpenButtonUsable({ ...usable, belongsToCurrentWatchRoot: false }), false);
    assert.equal(isNativeChatOpenButtonUsable({ ...usable, disabled: true }), false);
    assert.equal(isNativeChatOpenButtonUsable({ ...usable, display: 'none' }), false);
    assert.equal(isNativeChatOpenButtonUsable({ ...usable, width: 0 }), false);
    const first = {};
    const second = {};
    assert.equal(selectFirstUsableNativeChatButton([
        { element: first, ...usable, disabled: true },
        { element: second, ...usable }
    ]), second);
    assert.equal(selectFirstUsableNativeChatButton([{ element: first, ...usable, width: 0 }]), null);
    assert.equal(getNativeChatOpenCandidateRejectionReason(usable), 'none');
    assert.equal(getNativeChatOpenCandidateRejectionReason({ ...usable, associatedWithNativeChat: false }), 'not-chat-associated');
    assert.equal(getNativeChatOpenCandidateRejectionReason({ ...usable, belongsToCurrentWatchRoot: false }), 'wrong-watch-ownership');
    assert.equal(getNativeChatOpenCandidateRejectionReason({ ...usable, disabled: true }), 'disabled');
    assert.equal(getNativeChatOpenCandidateRejectionReason({ ...usable, width: 0 }), 'zero-or-invalid-geometry');
});

test('unique Chat-owned zero-geometry reopen button is accepted without weakening general geometry safety', () => {
    const element = {};
    const qualified = {
        element,
        belongsToCurrentWatchRoot: true,
        associatedWithNativeChat: true,
        nativeChatClosed: true,
        insideChatContainer: true,
        insideLiveChatFrame: true,
        descendantOfShowHideButton: true,
        actualButton: true,
        hiddenAttribute: false,
        disabled: false,
        ariaDisabled: 'false',
        display: 'block',
        visibility: 'visible',
        width: 0,
        height: 0
    };
    assert.equal(isChatOwnedZeroGeometryReopenCandidate(qualified), true);
    assert.equal(getNativeChatOpenCandidateRejectionReason(qualified), 'none');
    assert.equal(selectFirstUsableNativeChatButton([qualified]), element);
    assert.equal(selectFirstUsableNativeChatButton([qualified, { ...qualified, element: {} }]), null);
    assert.equal(getNativeChatOpenCandidateRejectionReason({ ...qualified, hiddenAttribute: true }), 'hidden');
    assert.equal(getNativeChatOpenCandidateRejectionReason({ ...qualified, disabled: true }), 'disabled');
    assert.equal(getNativeChatOpenCandidateRejectionReason({ ...qualified, ariaDisabled: 'true' }), 'disabled');
    for (const field of ['nativeChatClosed', 'insideChatContainer', 'insideLiveChatFrame', 'descendantOfShowHideButton', 'actualButton']) {
        assert.equal(getNativeChatOpenCandidateRejectionReason({ ...qualified, [field]: false }), 'zero-or-invalid-geometry');
    }
});

test('positive-geometry Native Chat candidate remains preferred over zero-geometry exception', () => {
    const zeroElement = {};
    const positiveElement = {};
    const zero = {
        element: zeroElement,
        belongsToCurrentWatchRoot: true,
        associatedWithNativeChat: true,
        nativeChatClosed: true,
        insideChatContainer: true,
        insideLiveChatFrame: true,
        descendantOfShowHideButton: true,
        actualButton: true,
        hiddenAttribute: false,
        disabled: false,
        ariaDisabled: 'false',
        display: 'block',
        visibility: 'visible',
        width: 0,
        height: 0
    };
    const positive = { ...zero, element: positiveElement, width: 100, height: 32 };
    assert.equal(selectFirstUsableNativeChatButton([zero, positive]), positiveElement);
});

test('Native Chat open uses an outer structural button and fails safe for open or unknown state', () => {
    assert.match(runtimeSource, /if \(!nativeChatKnown \|\| nativeChatVisible \|\| nativeChatOpenAttempt\) return false;/);
    assert.match(runtimeSource, /PLAYER_SELECTORS\.nativeChatOpenButtons\.forEach/);
    assert.match(runtimeSource, /readNativeChatVisibility\(watchRoot\) !== false/);
    assert.doesNotMatch(runtimeSource, /if \(!watchRoot \|\| !frame/);
    assert.match(runtimeSource, /chatContainer = watchRoot\.querySelector/);
    assert.match(runtimeSource, /if \(!button\) \{\s*logInfo\(`Native Chat open attempt: started=true, candidates=\$\{elements\.length\}, clickIssued=false, result=no-candidate`\);\s*return false;\s*\}/);
    assert.match(runtimeSource, /button\.click\(\)/);
    assert.match(runtimeSource, /document\.querySelector\(PLAYER_SELECTORS\.watchRoot\) !== watchRoot/);
    assert.match(runtimeSource, /!watchRoot\.contains\(button\) \|\| readNativeChatVisibility\(watchRoot\) !== false/);
    assert.match(runtimeSource, /nativeChatOpenAttempt = \{ generation: attemptGeneration, timerId \}/);
    assert.match(runtimeSource, /if \(nativeChatVisible && nativeChatOpenAttempt\) \{/);
    assert.match(runtimeSource, /clearNativeChatOpenAttempt\(\);[^]*?disconnectNativeChatObserver\(\)/);
    assert.doesNotMatch(runtimeSource, /contentDocument|contentWindow/);
});

test('Native Chat open failure remains fail-safe and reports only structural counts and booleans', () => {
    assert.match(runtimeSource, /Native Chat open linkage: triggered=true, visible=\$\{nativeChatVisible\}/);
    assert.match(runtimeSource, /Native Chat open candidate: strategy=\$\{strategy\}, accepted=\$\{candidate\.rejectionReason === 'none'\}, reason=\$\{candidate\.rejectionReason\}/);
    assert.match(runtimeSource, /Native Chat open confirmation: visible=\$\{nativeChatVisible\}, result=\$\{nativeChatVisible \? 'confirmed' : 'not-confirmed'\}/);
    assert.match(runtimeSource, /Native Chat open confirmation: observerTransition=true, result=confirmed/);
    assert.doesNotMatch(runtimeSource, /Native Chat open[^\r\n]*(?:outerHTML|innerHTML|continuation|visitorData)/i);
});

test('Native Chat reopen can use an existing scoped container control when the frame is absent', () => {
    assert.match(runtimeSource, /const frame = watchRoot\?\.querySelector\(PLAYER_SELECTORS\.nativeChat\) \|\| null;/);
    assert.match(runtimeSource, /const chatContainer = watchRoot\.querySelector\(PLAYER_SELECTORS\.nativeChatContainer\);/);
    assert.match(runtimeSource, /frame\?\.contains\(element\) \|\| chatContainer\?\.contains\(element\)/);
    assert.match(runtimeSource, /belongsToCurrentWatchRoot: watchRoot\.contains\(element\)/);
    assert.match(runtimeSource, /button\.click\(\)/);
    assert.equal((runtimeSource.match(/button\.click\(\)/g) || []).length, 1);
});

test('Native Chat open attempt is single-shot, observer-confirmed, and never retries', () => {
    assert.match(runtimeSource, /nativeChatVisible \|\| nativeChatOpenAttempt/);
    assert.match(runtimeSource, /nativeChatOpenAttempt = \{ generation: attemptGeneration, timerId \}/);
    assert.match(runtimeSource, /if \(nativeChatVisible && nativeChatOpenAttempt\) \{/);
    assert.doesNotMatch(runtimeSource, /tryOpenNativeChat\(\)[^]*?setTimeout[^]*?tryOpenNativeChat\(\)/);
});

test('management bar view reflects enabled state without controlling READ timing', () => {
    assert.deepEqual(getManagementBarViewModel({ userEnabled: true, readState: 'active' }), {
        enabled: true,
        statusShape: 'playing',
        toggleLabel: 'LiveFlow ON',
        togglePressed: true,
        readState: 'active'
    });
    assert.deepEqual(getManagementBarViewModel({ userEnabled: false, readState: 'active' }), {
        enabled: false,
        statusShape: 'stopped',
        toggleLabel: 'LiveFlow OFF',
        togglePressed: false,
        readState: 'active'
    });
    assert.equal(getManagementBarViewModel({ userEnabled: true, enabledLabel: '有効' }).toggleLabel, '有効');
    assert.equal(getManagementBarViewModel({ userEnabled: false, disabledLabel: 'Disabled' }).toggleLabel, 'Disabled');
});

test('ads are not eligible for main-content rendering and class transitions clear the runtime', () => {
    const playable = { paused: false, ended: false, readyState: MIN_PLAYABLE_READY_STATE };
    const player = { classList: { contains: (name) => name === 'ad-showing' } };
    assert.equal(isMainContentPlaybackEligible(player, playable), false);
    assert.equal(isMainContentPlaybackEligible({ classList: { contains: () => false } }, playable), true);
    assert.match(runtimeSource, /playbackContextObserver\.observe\(player, \{ attributes: true, attributeFilter: \['class'\] \}\)/);
    assert.match(runtimeSource, /if \(adActive === playbackContextWasAd\) return;[^]*?cleanupOverlay\(\)/);
});

test('candidate collision proof measures rendered geometry instead of fixed maximum widths', () => {
    assert.match(runtimeSource, /const probe = createDanmakuNode\(normalized, entry\.payload\.settingsSnapshot\)[^]*?const measured = probe\.getBoundingClientRect\(\)/);
    assert.match(runtimeSource, /const width = measured\.width;\s*const height = measured\.height/);
    assert.doesNotMatch(runtimeSource, /const width = Math\.min\(surface\.width, special \? 520 : 720\)/);
});

test('candidate measurement applies connected video surface geometry before reading probe bounds', () => {
    const applyIndex = runtimeSource.indexOf('if (!applyOverlaySurfaceRect(surface))');
    const appendIndex = runtimeSource.indexOf('overlaySurface.appendChild(probe)', applyIndex);
    const measureIndex = runtimeSource.indexOf('probe.getBoundingClientRect()', appendIndex);
    assert.ok(applyIndex >= 0);
    assert.ok(appendIndex > applyIndex);
    assert.ok(measureIndex > appendIndex);
    assert.match(runtimeSource, /function applyOverlaySurfaceRect[^]*overlayRoot\?\.isConnected[^]*overlaySurface\?\.isConnected[^]*surfaceRect\.width <= 0[^]*surfaceRect\.height <= 0[^]*overlaySurface\.style\.width[^]*overlaySurface\.style\.height/);
});

test('SPECIAL body preserves full one-line text and measured two-line footprint', () => {
    assert.match(runtimeSource, /liveflow-danmaku-special \.liveflow-danmaku-message \{[^}]*overflow: visible;[^}]*text-overflow: clip;[^}]*white-space: nowrap/);
    assert.match(runtimeSource, /function applySpecialFit\([^]*computeSpecialSingleLineFit/);
    assert.match(runtimeSource, /message\.style\.fontSize = `\$\{fit\.bodyFontSize\}px`/);
    assert.match(runtimeSource, /commentHeight: renderedRect\.height/);
    assert.match(runtimeSource, /height: trajectory\.height/);
    assert.match(runtimeSource, /const laneSpan = 1;/);
    assert.match(runtimeSource, /commentHeight: renderedRect\.height/);
    assert.match(runtimeSource, /visualFootprint: Object\.freeze\(\{ width: commentWidth, height: renderedRect\.height, anchorLane: launchProof\.lane, logicalLaneSpan: 1 \}\)/);
    assert.match(runtimeSource, /trajectory: Object\.freeze\([^]*height: renderedRect\.height/);
    assert.match(runtimeSource, /liveflow-danmaku-special \.liveflow-danmaku-author \{[^}]*overflow: visible;[^}]*text-overflow: clip;[^}]*white-space: nowrap/);
    assert.doesNotMatch(runtimeSource, /liveflow-danmaku-special \.liveflow-danmaku-author \{[^}]*text-overflow: ellipsis/);
});

test('Normal comments preserve full natural-width one-line text without ellipsis', () => {
    assert.match(runtimeSource, /\.liveflow-danmaku \{[^}]*max-width: none;[^}]*white-space: nowrap/);
    assert.match(runtimeSource, /\.liveflow-danmaku-message \{[^}]*overflow: visible;[^}]*text-overflow: clip;[^}]*white-space: nowrap/);
    assert.doesNotMatch(runtimeSource, /\.liveflow-danmaku-message \{[^}]*text-overflow: ellipsis/);
});

test('DENSE and MAX_READABLE add bounded half-pitch anchors without changing displayed comments', () => {
    assert.match(runtimeSource, /interleavedAnchorStride\[densityPolicy\.density\]/);
    assert.match(runtimeSource, /band\[lane\]\.lane \+ 0\.5/);
    assert.match(runtimeSource, /anchorIndex: band\[lane\]\.anchorIndex \+ 1/);
    assert.match(runtimeSource, /rankDensityRescuePlacements\(/);
    assert.doesNotMatch(runtimeSource, /Math\.random/);
});

test('COMPACT adds limited subtitle-safe secondary anchors after primary placement', () => {
    assert.match(runtimeSource, /const secondaryCandidates = \[\]/);
    assert.match(runtimeSource, /rankDensityRescuePlacements\(\s*band, secondaryCandidates, activeComments, entry\.id, densityPolicy\.density/);
    assert.match(runtimeSource, /if \(lane >= reservedBottomLaneStart\) continue;[^]*selectDensityLaneBand/);
    assert.match(runtimeSource, /isOutsideHardExclusions\(candidateGeometry\.rectangle, geometryState\.exclusionRegions\)/);
});

test('captions enabled reserves the bottom two logical lanes before Density band selection', () => {
    assert.match(runtimeSource, /\.ytp-subtitles-button\[aria-pressed="true"\]/);
    assert.match(runtimeSource, /attributeFilter: \['class', 'style', 'hidden', 'aria-pressed'\]/);
    assert.match(runtimeSource, /reservedBottomLaneStart = captionsEnabled \? Math\.max\(0, laneCount - 2\) : laneCount/);
    assert.match(runtimeSource, /if \(lane >= reservedBottomLaneStart\) continue;[^]*selectDensityLaneBand/);
});

test('lane availability deterministically selects the earliest currently safe lane', () => {
    const busy = previousLaneState();
    const next = { startX: 800, speed: 120 };
    assert.deepEqual(findNextLaneAvailability([busy, null, null], 3, next, 800, 1000), { lane: 1, nextSafeAtMs: 1000 });
    assert.deepEqual(findNextLaneAvailability([busy, busy], 2, next, 800, 1000), { lane: -1, nextSafeAtMs: 3334 });
});

test('message metadata keeps every renderer on one logical lane anchor', () => {
    assert.equal(getDanmakuLaneSpan({ messageType: 'text' }), 1);
    assert.equal(getDanmakuLaneSpan({ messageType: 'superChat' }), 1);
    assert.equal(getDanmakuLaneSpan({ messageType: 'superSticker' }), 1);
    assert.equal(getDanmakuLaneSpan({ messageType: 'futureSpecial', laneSpan: 2 }), 1);
    assert.equal(getDanmakuLaneSpan({ messageType: 'futureUnknown' }), 1);
});

test('two-lane selection requires a consecutive safe pair and handles narrow surfaces safely', () => {
    const next = { startX: 800, speed: 120 };
    const busy = previousLaneState();
    assert.deepEqual(findNextLaneSpanAvailability([null, null, busy], 3, next, 800, 1000, 2), { lane: 0, nextSafeAtMs: 1000 });
    assert.deepEqual(findNextLaneSpanAvailability([busy, null, null], 3, next, 800, 1000, 2), { lane: 1, nextSafeAtMs: 1000 });
    assert.deepEqual(findNextLaneSpanAvailability([null, busy, null], 3, next, 800, 1000, 2), { lane: -1, nextSafeAtMs: 3334 });
    assert.deepEqual(findNextLaneSpanAvailability([null], 1, next, 800, 1000, 2), { lane: -1, nextSafeAtMs: null });
});

test('two-lane reservation shares one token and releases only matching reservations', () => {
    const token = Symbol('special');
    const replacement = Symbol('replacement');
    const lanes = [null, null, null];
    const reservation = { token, speed: 120 };
    assert.equal(reserveLaneSpan(lanes, 1, 2, reservation), true);
    assert.equal(lanes[1], reservation);
    assert.equal(lanes[2], reservation);
    assert.equal(findNextLaneSpanAvailability(lanes, 3, { startX: 800, speed: 120 }, 800, 1000, 2).lane, -1);
    lanes[2] = { token: replacement };
    assert.equal(releaseLaneReservation(lanes, token), 1);
    assert.equal(lanes[1], null);
    assert.equal(lanes[2].token, replacement);
    assert.equal(reserveLaneSpan(lanes, 2, 2, reservation), false);
});

test('runtime localization uses Chrome i18n and falls back deterministically', () => {
    assert.equal(getLocalizedMessage({ getMessage: (key) => key === 'liveFlowOn' ? 'Localized ON' : '' }, 'liveFlowOn', 'Fallback'), 'Localized ON');
    assert.equal(getLocalizedMessage({ getMessage: () => '' }, 'liveFlowOn', 'Fallback'), 'Fallback');
    assert.equal(getLocalizedMessage({ getMessage: () => { throw new Error('unavailable'); } }, 'liveFlowOn', 'Fallback'), 'Fallback');
    assert.equal(getLocalizedMessage(undefined, 'liveFlowOn', 'Fallback'), 'Fallback');
    assert.equal(getLocalizedMessage(undefined, 'liveFlowOn'), '');
    assert.match(runtimeSource, /globalThis\.chrome\?\.i18n/);
    assert.doesNotMatch(runtimeSource, /navigator\.language|fetch\s*\([^)]*(?:locale|translation)/i);
});

test('management placement identifies narrow stacked Chat without viewport classification', () => {
    const player = { left: 0, top: 0, width: 400, height: 225 };
    assert.equal(isChatStackedBelowPlayer(player, { left: 0, top: 225, width: 400, height: 300 }), true);
    assert.equal(isChatStackedBelowPlayer(player, { left: 400, top: 0, width: 300, height: 400 }), false);
    assert.equal(isChatStackedBelowPlayer(player, { left: 0, top: 225, width: 0, height: 300 }), false);
});

test('management bar uses the stable primary below-player host and never Native Chat or playlist flow', () => {
    assert.match(runtimeSource, /const media = getCurrentMainMedia\(\);\s*if \(!media\) \{\s*cleanupManagementBar\(\)/);
    assert.match(runtimeSource, /watchRoot\.querySelector\(PLAYER_SELECTORS\.belowPlayer\)/);
    const placement = runtimeSource.match(/function getManagementBarPlacement\([^]*?\n    \}/)?.[0] || '';
    assert.doesNotMatch(placement, /nativeChat|isChatStackedBelowPlayer/);
    assert.match(placement, /return \{ parent: belowPlayer\.parentElement, before: belowPlayer \}/);
    assert.match(runtimeSource, /placement\.parent\.insertBefore\(bar, placement\.before\)/);
    assert.match(runtimeSource, /managementBar\.parentElement === placement\.parent && managementBar\.nextSibling === placement\.before/);
    assert.match(runtimeSource, /data-enabled="false"[^]*?\.liveflow-read-indicator[^]*?visibility: hidden/);
});

test('management bar uses touch-friendly sizing and CSS-only status shapes', () => {
    assert.match(runtimeSource, /min-height: 52px/);
    assert.match(runtimeSource, /padding: 4px 12px/);
    assert.match(runtimeSource, /min-width: 44px/);
    assert.match(runtimeSource, /min-height: 44px/);
    assert.match(runtimeSource, /liveflow-status-icon::before/);
    assert.match(runtimeSource, /data-status-shape="stopped"/);
    assert.doesNotMatch(runtimeSource, /▶|⏹/);
    assert.match(runtimeSource, /managementToggleLabel\.textContent = view\.toggleLabel/);
});

test('management controls retain runtime toggle and READ indicator without settings gear', () => {
    assert.match(runtimeSource, /toggle\.addEventListener\('click', \(\) => applyDisplayAction\(\{ type: 'set-user-enabled', value: !userEnabled \}\)\)/);
    assert.doesNotMatch(runtimeSource, /liveflow-close-button|Turn LiveFlow off|close\.addEventListener/);
    assert.match(runtimeSource, /bar\.append\(toggle, indicator\)/);
    assert.doesNotMatch(runtimeSource, /liveflow-settings-button|const gear|gear\.addEventListener/);
    assert.match(runtimeSource, /liveflow-read-indicator/);
});

test('management bar cleanup and reattach follow SPA lifecycle and exclude MiniPlayer', () => {
    assert.match(runtimeSource, /function handleNavigationStart\(\)[^]*?cleanupManagementBar\(\)/);
    assert.match(runtimeSource, /function detectPage\(\)[^]*?attachManagementBar\(\)/);
    assert.match(runtimeSource, /player\.closest\(PLAYER_SELECTORS\.miniPlayerAncestor\)/);
});

test('management bar attachment follows current watch DOM readiness independently of READ bootstrap', () => {
    const schedulerStart = runtimeSource.indexOf('function scheduleManagementBarAttachment');
    const schedulerEnd = runtimeSource.indexOf('function attachOverlay', schedulerStart);
    const schedulerSource = runtimeSource.slice(schedulerStart, schedulerEnd);
    assert.match(runtimeSource, /function observeNativeChat\(watchRoot\)[^]*?scheduleManagementBarAttachment\(watchRoot\)/);
    assert.match(runtimeSource, /const managementPlacementChanged = mutations\.some\(mutationAffectsManagementPlacement\)/);
    assert.match(runtimeSource, /if \(managementPlacementChanged\) scheduleManagementBarAttachment\(watchRoot\)/);
    assert.match(runtimeSource, /function mutationAffectsManagementPlacement\(mutation\)[^]*?mutation\.type === 'childList'/);
    assert.match(runtimeSource, /function scheduleManagementBarAttachment\(watchRoot\)[^]*?window\.queueMicrotask/);
    assert.match(runtimeSource, /task\.pageGeneration !== pageGeneration/);
    assert.match(runtimeSource, /document\.querySelector\(PLAYER_SELECTORS\.watchRoot\) !== task\.watchRoot/);
    assert.doesNotMatch(schedulerSource, /requestInitialContinuation|requestReadOnce|fetch\s*\(/);
    assert.doesNotMatch(schedulerSource, /cleanupOverlay|rendererGeneration|pageGeneration\s*[+]=|acceptingReadResults/);
});

test('LiveFlow-owned bar and danmaku mutations are not management placement signals', () => {
    const classifierStart = runtimeSource.indexOf('function nodeAffectsManagementPlacement');
    const classifierEnd = runtimeSource.indexOf('function observeNativeChat', classifierStart);
    const classifierSource = runtimeSource.slice(classifierStart, classifierEnd);
    const observerStart = runtimeSource.indexOf('function observeNativeChat');
    const observerEnd = runtimeSource.indexOf('function disconnectNativeChatObserver', observerStart);
    const observerSource = runtimeSource.slice(observerStart, observerEnd);
    assert.match(classifierSource, /PLAYER_SELECTORS\.player/);
    assert.match(classifierSource, /PLAYER_SELECTORS\.video/);
    assert.match(classifierSource, /PLAYER_SELECTORS\.nativeChat/);
    assert.match(classifierSource, /PLAYER_SELECTORS\.belowPlayer/);
    assert.doesNotMatch(classifierSource, /MANAGEMENT_BAR_ID|liveflow-overlay-root|liveflow-danmaku/);
    assert.doesNotMatch(observerSource, /if \(nativeChatChanged\) scheduleManagementBarAttachment/);
    assert.doesNotMatch(observerSource, /cleanupOverlay|rendererGeneration|requestReadOnce/);
});

test('management bar DOM readiness scheduling is deduplicated and navigation cleanup invalidates stale work', () => {
    assert.match(runtimeSource, /if \(!watchRoot \|\| managementAttachmentTask\) return;/);
    assert.match(runtimeSource, /managementAttachmentTask = task/);
    assert.match(runtimeSource, /if \(managementAttachmentTask !== task\) return;/);
    assert.match(runtimeSource, /function disconnectNativeChatObserver\(\)[^]*?managementAttachmentTask = null/);
    assert.match(runtimeSource, /function handleNavigationStart\(\)[^]*?pageGeneration \+= 1[^]*?disconnectNativeChatObserver\(\)[^]*?cleanupManagementBar\(\)/);
});

test('management bar lifecycle remains independent of READ acceptance and Native Chat display state', () => {
    const diagnosticStart = runtimeSource.indexOf('function handleReadLifecycleDiagnostic');
    const diagnosticEnd = runtimeSource.indexOf('function handleGeometryChange', diagnosticStart);
    const diagnosticSource = runtimeSource.slice(diagnosticStart, diagnosticEnd);
    assert.match(runtimeSource, /function detectPage\(\)[^]*?attachManagementBar\(\)/);
    assert.match(runtimeSource, /function handleNavigation\(\)[^]*?attachManagementBar\(\)/);
    assert.match(runtimeSource, /function handleInitialContinuation\(event\)[^]*?attachManagementBar\(\)/);
    assert.doesNotMatch(diagnosticSource, /cleanupManagementBar\(\)/);
    assert.doesNotMatch(runtimeSource, /--liveflow-management-height|native-chat-layout/);
});

test('management bar stays outside the player while danmaku remains player-owned for fullscreen', () => {
    assert.match(runtimeSource, /placement\.parent\.insertBefore\(bar, placement\.before\)/);
    assert.match(runtimeSource, /player\.appendChild\(overlayRoot\)/);
    assert.doesNotMatch(runtimeSource, /player\.appendChild\(bar\)/);
});

test('READ indicator is response-driven presentation and never initiates fetch or polling', () => {
    assert.match(runtimeSource, /setReadIndicatorState\('active'\)/);
    assert.match(runtimeSource, /setReadIndicatorState\('stopped'\)/);
    assert.match(runtimeSource, /liveflow-read-indicator/);
    assert.doesNotMatch(runtimeSource, /setInterval\s*\(/);
});

test('geometry changes invalidate active and queued renderer work before using new rects', () => {
    assert.match(runtimeSource, /function handleGeometryChange\(\)[^]*?window\.queueMicrotask\([^]*?cleanupOverlay\(\)[^]*?refreshManagementBarPlacement\(\)/);
    assert.match(runtimeSource, /addEventListener\('orientationchange', handleGeometryChange\)/);
    assert.match(runtimeSource, /visualViewport\?\.addEventListener\('resize', handleGeometryChange\)/);
    assert.match(runtimeSource, /visualViewport\?\.addEventListener\('scroll', handleGeometryChange\)/);
    assert.match(runtimeSource, /document\.addEventListener\('fullscreenchange', handleGeometryChange\)/);
});

test('SPA blocks old bridge results until a newer page revision is accepted', () => {
    assert.match(runtimeSource, /acceptingReadResults = false/);
    assert.match(runtimeSource, /minimumAcceptedPageRevision = currentPageRevision \+ 1/);
    assert.match(runtimeSource, /event\.data\.pageRevision < minimumAcceptedPageRevision\) \{/);
    assert.match(runtimeSource, /acceptingReadResults = true/);
    assert.match(runtimeSource, /if \(!acceptingReadResults\) \{/);
});

test('SPA lifecycle token covers READ request, bridge response, queue, and delayed rendering', () => {
    assert.match(runtimeSource, /pageLifecycleGeneration: currentPageLifecycleGeneration/);
    assert.match(runtimeSource, /event\.data\.pageLifecycleGeneration !== currentPageLifecycleGeneration/);
    assert.match(runtimeSource, /pageLifecycleGeneration: currentPageLifecycleGeneration/);
    assert.match(runtimeSource, /type !== NAVIGATION_INVALIDATED_TYPE/);
    assert.match(runtimeSource, /acceptingReadResults = false;[^]*?cleanupOverlay\(\)/);
    assert.match(runtimeSource, /generation: \(\) => rendererGeneration/);
});

test('A to B to C navigation repeatedly invalidates every asynchronous renderer boundary', () => {
    assert.match(runtimeSource, /function handleNavigationStart\(\)[^]*?pageGeneration \+= 1/);
    assert.match(runtimeSource, /function handleNavigationStart\(\)[^]*?cleanupOverlay\(\)/);
    assert.match(runtimeSource, /function cleanupOverlay\(\)[^]*?rendererGeneration \+= 1/);
    assert.match(runtimeSource, /function cleanupOverlay\(\)[^]*?activeDanmaku\.clear\(\)/);
    assert.match(runtimeSource, /function cleanupOverlay\(\)[^]*?phase3Runtime\?\.clear\(\)/);
});

test('collision queue delegates FIFO, hard bounds, and one-shot pacing without polling', () => {
    assert.match(runtimeSource, /schedulerRuntimeCore\.createSchedulerRuntime/);
    assert.match(schedulerRuntimeSource, /pending\.createPendingQueue\(\)/);
    assert.match(schedulerRuntimeSource, /queue\.enforceHardCount\(config\.maxPendingCount\)/);
    assert.match(schedulerRuntimeSource, /foundations\.proveBoundedCollisionSafe/);
    assert.doesNotMatch(runtimeSource + schedulerRuntimeSource, /setInterval\s*\(|requestAnimationFrame\s*\(/);
});
