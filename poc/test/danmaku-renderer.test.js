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
    MIN_PLAYABLE_READY_STATE
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
    assert.match(runtimeSource, /if \(!player \|\| !overlayCore\?\.isPlaybackEligible\?\.\(video\)\) return false;/);
    assert.doesNotMatch(runtimeSource, /addEventListener\(['"]play|addEventListener\(['"]playing|pendingMessages|messageQueue/);
    assert.match(runtimeSource, /newMessages\.forEach\(renderDanmaku\)/);
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
