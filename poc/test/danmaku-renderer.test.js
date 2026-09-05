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
    isPlaybackEligible,
    calculateVideoSurfaceRect,
    MIN_PLAYABLE_READY_STATE,
    calculateDanmakuSpeed,
    isLaneCollisionSafe,
    selectCollisionSafeLane,
    planDanmakuBatch,
    DANMAKU_MAX_BATCH_SPREAD_MS,
    DANMAKU_BATCH_STAGGER_MS,
    DANMAKU_MAX_PENDING_COMMENTS,
    isRendererTargetCurrent,
    isEffectiveDisplayActive,
    getDisplayStateTransition,
    reduceDisplayState,
    getManagementBarViewModel,
    isNativeChatOpenButtonUsable,
    isNativeChatFrameVisible
} = require('../src/overlay-core.js');

const runtimeSource = fs.readFileSync(path.join(__dirname, '../src/youtube-chat.js'), 'utf8');

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
    assert.deepEqual(normalizeDanmakuMessage({ id: 'a', authorName: 'Alice', messageType: 'text', message: ' hello ' }), { id: 'a', text: 'hello' });
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
    assert.match(runtimeSource, /if \(!media \|\| !overlayCore\?\.isPlaybackEligible\?\.\(media\.video\)\) return;/);
    assert.doesNotMatch(runtimeSource, /addEventListener\(['"]play|addEventListener\(['"]playing|pendingMessages|messageQueue/);
    assert.match(runtimeSource, /scheduleDanmakuBatch\(newMessages\)/);
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
    assert.match(runtimeSource, /pendingDanmakuTimers\.forEach\(\(timerId\) => window\.clearTimeout\(timerId\)\)/);
    assert.match(runtimeSource, /activeDanmaku\.forEach\([^]*?animation\?\.cancel\(\)/);
    assert.match(runtimeSource, /addEventListener\('yt-navigate-start', handleNavigationStart\)/);
    assert.match(runtimeSource, /function handleNavigationStart\(\)[^]*?disconnectNativeChatObserver\(\)[^]*?cleanupOverlay\(\)/);
});

test('stale timer callback verifies generation and video before DOM insertion', () => {
    assert.match(runtimeSource, /const currentMedia = getCurrentMainMedia\(\);[^]*?isRendererTargetCurrent\([^]*?\)\) return;[^]*?renderDanmaku\(message, scheduledGeneration, scheduledVideo\)/);
});

test('main-player lookup is scoped to the current watch root and rejects MiniPlayer', () => {
    assert.match(runtimeSource, /watchRoot\?\.querySelector\(PLAYER_SELECTORS\.player\)/);
    assert.match(runtimeSource, /player\.closest\(PLAYER_SELECTORS\.miniPlayerAncestor\)/);
    assert.match(runtimeSource, /player\.classList\.contains\('ytp-player-minimized'\)/);
    assert.doesNotMatch(runtimeSource, /document\.querySelector\('#movie_player'\)/);
});

test('pending batch timers are bounded and cancelled during teardown and SPA cleanup', () => {
    assert.match(runtimeSource, /DANMAKU_MAX_PENDING_COMMENTS - pendingDanmakuTimers\.size/);
    assert.match(runtimeSource, /pendingDanmakuTimers\.set\(token, timerId\)/);
    assert.match(runtimeSource, /pendingDanmakuTimers\.forEach\(\(timerId\) => window\.clearTimeout\(timerId\)\)/);
    assert.match(runtimeSource, /pendingDanmakuTimers\.clear\(\)/);
    assert.match(runtimeSource, /function resetPageState\(\)[^]*?cleanupOverlay\(\)/);
});

test('renderer refreshes the actual video rect for each new comment', () => {
    assert.match(runtimeSource, /calculateVideoSurfaceRect\(player\.getBoundingClientRect\(\), video\.getBoundingClientRect\(\)\)/);
    assert.match(runtimeSource, /overlaySurface\.style\.left/);
    assert.match(runtimeSource, /overlaySurface\.style\.width/);
    assert.match(runtimeSource, /calculateLaneCount\(surfaceRect\.height\)/);
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
    assert.match(runtimeSource, /node\.textContent = normalized\.text/);
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

test('display controller is memory-only and exposes future UI integration without persistence', () => {
    assert.match(runtimeSource, /window\.LiveFlowDisplayState = Object\.freeze\(\{/);
    assert.match(runtimeSource, /setUserEnabled\(value\)/);
    assert.match(runtimeSource, /getUserEnabled\(\)/);
    assert.doesNotMatch(runtimeSource, /chrome\.storage|localStorage|sessionStorage/);
});

test('inactive transitions clean pending and active danmaku without replay on re-enable', () => {
    assert.match(runtimeSource, /if \(transition\.cleanupRequired\) cleanupOverlay\(\)/);
    assert.match(runtimeSource, /function scheduleDanmakuBatch\(messages\) \{\s*if \(!isEffectiveDisplayActive\(\)\) return;/);
    assert.match(runtimeSource, /pendingDanmakuTimers\.delete\(token\);\s*if \(!isEffectiveDisplayActive\(\)\) return;/);
    assert.match(runtimeSource, /if \(media && isEffectiveDisplayActive\(\)\) attachOverlay\(media\.player\)/);
    assert.doesNotMatch(runtimeSource, /disabledMessages|displayBacklog|replayPending/);
});

test('Native Chat observer is single, scoped, mutation-filtered, and cleaned up for SPA and pagehide', () => {
    assert.match(runtimeSource, /if \(watchRoot === observedWatchRoot && nativeChatObserver\) return;/);
    assert.match(runtimeSource, /nativeChatObserver\.observe\(watchRoot,/);
    assert.match(runtimeSource, /mutations\.some\(mutationAffectsNativeChat\)/);
    assert.match(runtimeSource, /window\.queueMicrotask\(evaluateNativeChatVisibility\)/);
    assert.match(runtimeSource, /function handleNavigationStart\(\) \{\s*disconnectNativeChatObserver\(\)/);
    assert.match(runtimeSource, /function handlePageHide\(\) \{\s*disconnectNativeChatObserver\(\)/);
    assert.doesNotMatch(runtimeSource, /nativeChatObserver\.observe\(document/);
});

test('SPA evaluation uses the new current watch root and MiniPlayer policy remains intact', () => {
    assert.match(runtimeSource, /const watchRoot = document\.querySelector\(PLAYER_SELECTORS\.watchRoot\);\s*applyDisplayAction/);
    assert.match(runtimeSource, /player\.closest\(PLAYER_SELECTORS\.miniPlayerAncestor\)/);
    assert.match(runtimeSource, /addEventListener\('yt-navigate-finish', detectPage\)/);
});

test('Native Chat open button is usable only when visible, enabled, and owned by current watch root', () => {
    const usable = { belongsToCurrentWatchRoot: true, disabled: false, ariaDisabled: 'false', display: 'block', visibility: 'visible', width: 100, height: 32 };
    assert.equal(isNativeChatOpenButtonUsable(usable), true);
    assert.equal(isNativeChatOpenButtonUsable({ ...usable, belongsToCurrentWatchRoot: false }), false);
    assert.equal(isNativeChatOpenButtonUsable({ ...usable, disabled: true }), false);
    assert.equal(isNativeChatOpenButtonUsable({ ...usable, display: 'none' }), false);
    assert.equal(isNativeChatOpenButtonUsable({ ...usable, width: 0 }), false);
});

test('Native Chat open uses an outer structural button and fails safe for open or unknown state', () => {
    assert.match(runtimeSource, /if \(!nativeChatKnown \|\| nativeChatVisible\) return false;/);
    assert.match(runtimeSource, /frame\.querySelector\(PLAYER_SELECTORS\.nativeChatOpenButton\)/);
    assert.match(runtimeSource, /if \(!knownClosedState\) return false;/);
    assert.match(runtimeSource, /if \(!button\) return false;/);
    assert.match(runtimeSource, /button\.click\(\)/);
    assert.doesNotMatch(runtimeSource, /contentDocument|contentWindow/);
});

test('management bar view reflects enabled state without controlling READ timing', () => {
    assert.deepEqual(getManagementBarViewModel({ userEnabled: true, readState: 'active' }), {
        enabled: true,
        toggleLabel: 'LiveFlow ON',
        togglePressed: true,
        readState: 'active',
        showCloseButton: true
    });
    assert.deepEqual(getManagementBarViewModel({ userEnabled: false, readState: 'active' }), {
        enabled: false,
        toggleLabel: 'LiveFlow OFF',
        togglePressed: false,
        readState: 'active',
        showCloseButton: false
    });
});

test('management bar attaches below current main player once and remains when disabled', () => {
    assert.match(runtimeSource, /const media = getCurrentMainMedia\(\);\s*if \(!media\) return false;/);
    assert.match(runtimeSource, /managementBar\?\.isConnected && watchRoot\.contains\(managementBar\)/);
    assert.match(runtimeSource, /playerHost\.insertAdjacentElement\('afterend', bar\)/);
    assert.match(runtimeSource, /data-enabled="false"[^]*?\.liveflow-close-button/);
    assert.doesNotMatch(runtimeSource, /data-enabled="false"[^}]*display:\s*none[^}]*#liveflow-management-bar/);
});

test('management controls toggle future rendering, close means OFF, and gear is a safe stub', () => {
    assert.match(runtimeSource, /toggle\.addEventListener\('click', \(\) => applyDisplayAction\(\{ type: 'set-user-enabled', value: !userEnabled \}\)\)/);
    assert.match(runtimeSource, /close\.addEventListener\('click', \(\) => applyDisplayAction\(\{ type: 'set-user-enabled', value: false \}\)\)/);
    assert.match(runtimeSource, /gear\.addEventListener\('click', \(\) => \{\}\)/);
    assert.doesNotMatch(runtimeSource, /settings.*throw|gear.*console\.error/is);
});

test('management bar cleanup and reattach follow SPA lifecycle and exclude MiniPlayer', () => {
    assert.match(runtimeSource, /function handleNavigationStart\(\)[^]*?cleanupManagementBar\(\)/);
    assert.match(runtimeSource, /function detectPage\(\)[^]*?attachManagementBar\(\)/);
    assert.match(runtimeSource, /function cleanupManagementBar\(\)[^]*?MANAGEMENT_HEIGHT_PROPERTY, '0px'/);
    assert.match(runtimeSource, /player\.closest\(PLAYER_SELECTORS\.miniPlayerAncestor\)/);
});

test('management bar stays outside the player while danmaku remains player-owned for fullscreen', () => {
    assert.match(runtimeSource, /playerHost\.insertAdjacentElement\('afterend', bar\)/);
    assert.match(runtimeSource, /player\.appendChild\(overlayRoot\)/);
    assert.doesNotMatch(runtimeSource, /player\.appendChild\(bar\)/);
});

test('READ indicator is response-driven presentation and never initiates fetch or polling', () => {
    assert.match(runtimeSource, /setReadIndicatorState\('active'\)/);
    assert.match(runtimeSource, /setReadIndicatorState\('stopped'\)/);
    assert.match(runtimeSource, /liveflow-read-indicator/);
    assert.doesNotMatch(runtimeSource, /setInterval\s*\(/);
});
