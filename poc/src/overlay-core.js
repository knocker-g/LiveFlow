(function (global) {
    const MAX_VISIBLE_MESSAGES = 20;
    const DANMAKU_FONT_SIZE_PX = 24;
    const DANMAKU_LINE_HEIGHT_PX = 32;
    const DANMAKU_LANE_GAP_PX = 4;
    const DANMAKU_HORIZONTAL_GAP_PX = 24;
    const DANMAKU_SPEED_PX_PER_SECOND = 120;
    const DANMAKU_MAX_ACTIVE_COMMENTS = 40;
    const DANMAKU_MAX_LANES = 20;
    const DANMAKU_MAX_MESSAGE_LENGTH = 300;
    const MIN_PLAYABLE_READY_STATE = 2;
    const DANMAKU_TARGET_DURATION_MS = 8000;
    const DANMAKU_MIN_SPEED_PX_PER_SECOND = 120;
    const DANMAKU_MAX_SPEED_PX_PER_SECOND = 240;
    const DANMAKU_MAX_BATCH_SPREAD_MS = 2500;
    const DANMAKU_BATCH_STAGGER_MS = 80;
    const DANMAKU_MAX_PENDING_COMMENTS = 40;

    function mergeMessagesById(currentMessages, incomingMessages, maxMessages = 500) {
        const messages = Array.isArray(currentMessages) ? currentMessages.slice() : [];
        const ids = new Set(messages.map((message) => message?.id).filter(Boolean));

        (Array.isArray(incomingMessages) ? incomingMessages : []).forEach((message) => {
            if (!message || (message.id && ids.has(message.id))) return;
            if (message.id) ids.add(message.id);
            messages.push(message);
        });

        return messages.slice(-maxMessages);
    }

    function getVisibleMessages(messages, limit = MAX_VISIBLE_MESSAGES) {
        if (!Array.isArray(messages) || limit <= 0) return [];
        return messages.filter((message) => message && typeof message.message === 'string' && message.message.trim()).slice(-limit);
    }

    function formatMessageText(message) {
        if (!message || typeof message.message !== 'string' || !message.message.trim()) return '';
        const author = typeof message.authorName === 'string' ? message.authorName.trim() : '';
        return author ? `${author}: ${message.message}` : message.message;
    }

    function normalizeDanmakuMessage(message) {
        if (!message || message.messageType !== 'text' || typeof message.message !== 'string') return null;
        const text = message.message.trim();
        if (!text || text.length > DANMAKU_MAX_MESSAGE_LENGTH) return null;
        return { id: typeof message.id === 'string' ? message.id : '', text };
    }

    function calculateLaneCount(overlayHeight, lineHeight = DANMAKU_LINE_HEIGHT_PX, laneGap = DANMAKU_LANE_GAP_PX, maxLanes = DANMAKU_MAX_LANES) {
        if (![overlayHeight, lineHeight, laneGap, maxLanes].every((value) => typeof value === 'number' && Number.isFinite(value))) return 0;
        if (overlayHeight <= 0 || lineHeight <= 0 || laneGap < 0 || maxLanes <= 0) return 0;
        return Math.max(0, Math.min(Math.floor(overlayHeight / (lineHeight + laneGap)), Math.floor(maxLanes)));
    }

    function selectAvailableLane(laneAvailableAt, laneCount, nowMs) {
        if (!Array.isArray(laneAvailableAt) || !Number.isFinite(nowMs) || laneCount <= 0) return -1;
        const limit = Math.min(Math.floor(laneCount), laneAvailableAt.length);
        for (let index = 0; index < limit; index += 1) {
            const availableAt = laneAvailableAt[index];
            if (!Number.isFinite(availableAt) || availableAt <= nowMs) return index;
        }
        return -1;
    }

    function calculateDanmakuMotion({ overlayWidth, commentWidth, speed = DANMAKU_SPEED_PX_PER_SECOND, horizontalGap = DANMAKU_HORIZONTAL_GAP_PX, startTimeMs } = {}) {
        if (![overlayWidth, commentWidth, speed, horizontalGap, startTimeMs].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
        if (overlayWidth <= 0 || commentWidth <= 0 || speed <= 0 || horizontalGap < 0 || startTimeMs < 0) return null;
        const pixelsPerMs = speed / 1000;
        return {
            durationMs: Math.ceil((overlayWidth + commentWidth) / pixelsPerMs),
            laneAvailableAtMs: startTimeMs + Math.ceil((commentWidth + horizontalGap) / pixelsPerMs),
            startX: overlayWidth,
            endX: -commentWidth
        };
    }

    function calculateDanmakuSpeed({ overlayWidth, commentWidth, targetDurationMs = DANMAKU_TARGET_DURATION_MS, minSpeed = DANMAKU_MIN_SPEED_PX_PER_SECOND, maxSpeed = DANMAKU_MAX_SPEED_PX_PER_SECOND } = {}) {
        const values = [overlayWidth, commentWidth, targetDurationMs, minSpeed, maxSpeed];
        if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
        if (overlayWidth <= 0 || commentWidth <= 0 || targetDurationMs <= 0 || minSpeed <= 0 || maxSpeed < minSpeed) return null;
        const targetSpeed = (overlayWidth + commentWidth) / (targetDurationMs / 1000);
        return Math.min(Math.max(targetSpeed, minSpeed), maxSpeed);
    }

    function isLaneCollisionSafe(previous, next, nowMs, horizontalGap = DANMAKU_HORIZONTAL_GAP_PX) {
        if (!previous) return true;
        const values = [
            previous.startTimeMs, previous.startX, previous.commentWidth, previous.speed, previous.endTimeMs,
            next?.startX, next?.speed, nowMs, horizontalGap
        ];
        if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return false;
        if (previous.commentWidth <= 0 || previous.speed <= 0 || next.speed <= 0 || horizontalGap < 0) return false;
        if (nowMs >= previous.endTimeMs) return true;

        const elapsedSeconds = Math.max(0, nowMs - previous.startTimeMs) / 1000;
        const previousRight = previous.startX - previous.speed * elapsedSeconds + previous.commentWidth;
        const initialDistance = next.startX - previousRight;
        if (initialDistance < horizontalGap) return false;
        if (next.speed <= previous.speed) return true;

        const previousRemainingSeconds = Math.max(0, previousRight / previous.speed);
        return initialDistance - (next.speed - previous.speed) * previousRemainingSeconds >= horizontalGap;
    }

    function selectCollisionSafeLane(laneStates, laneCount, next, nowMs, horizontalGap = DANMAKU_HORIZONTAL_GAP_PX) {
        if (!Array.isArray(laneStates) || !Number.isInteger(laneCount) || laneCount <= 0) return -1;
        const limit = Math.min(laneCount, laneStates.length);
        for (let index = 0; index < limit; index += 1) {
            if (isLaneCollisionSafe(laneStates[index], next, nowMs, horizontalGap)) return index;
        }
        return -1;
    }

    function parseTimestampUsec(value) {
        if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
        try { return BigInt(value); } catch (error) { return null; }
    }

    function planDanmakuBatch(messages, maxItems = DANMAKU_MAX_PENDING_COMMENTS, maxSpreadMs = DANMAKU_MAX_BATCH_SPREAD_MS, staggerMs = DANMAKU_BATCH_STAGGER_MS) {
        if (!Array.isArray(messages) || !Number.isInteger(maxItems) || maxItems <= 0 || !Number.isFinite(maxSpreadMs) || maxSpreadMs < 0 || !Number.isFinite(staggerMs) || staggerMs < 0) return [];
        const selected = messages.slice(-maxItems);
        const timestamps = selected.map((message) => parseTimestampUsec(message?.timestampUsec));
        const valid = timestamps.filter((value) => value !== null);
        const oldest = valid.length > 0 ? valid.reduce((minimum, value) => value < minimum ? value : minimum) : null;
        const maxSpreadUsec = BigInt(Math.floor(maxSpreadMs * 1000));
        let previousDelay = 0;

        return selected.map((message, index) => {
            const timestamp = timestamps[index];
            let relativeDelay = index === 0 ? 0 : previousDelay + staggerMs;
            if (timestamp !== null && oldest !== null) {
                const difference = timestamp - oldest;
                relativeDelay = difference >= maxSpreadUsec ? maxSpreadMs : Number(difference) / 1000;
                if (index > 0) relativeDelay = Math.max(relativeDelay, previousDelay + staggerMs);
            }
            const delayMs = Math.min(Math.max(0, Math.floor(relativeDelay)), maxSpreadMs);
            previousDelay = delayMs;
            return { message, delayMs };
        });
    }

    function canRenderDanmaku(message, activeCount, maxActive = DANMAKU_MAX_ACTIVE_COMMENTS) {
        if (!Number.isInteger(activeCount) || !Number.isInteger(maxActive) || activeCount < 0 || maxActive <= 0 || activeCount >= maxActive) return false;
        return normalizeDanmakuMessage(message) !== null;
    }

    function isPlaybackEligible(video) {
        return Boolean(video) &&
            video.paused === false &&
            video.ended === false &&
            typeof video.readyState === 'number' &&
            Number.isFinite(video.readyState) &&
            video.readyState >= MIN_PLAYABLE_READY_STATE;
    }

    function calculateVideoSurfaceRect(playerRect, videoRect) {
        if (!playerRect || !videoRect) return null;
        const values = [
            playerRect.left, playerRect.top, playerRect.width, playerRect.height,
            videoRect.left, videoRect.top, videoRect.width, videoRect.height
        ];
        if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
        if (playerRect.width <= 0 || playerRect.height <= 0 || videoRect.width <= 0 || videoRect.height <= 0) return null;

        const left = Math.max(0, videoRect.left - playerRect.left);
        const top = Math.max(0, videoRect.top - playerRect.top);
        const right = Math.min(playerRect.width, videoRect.left - playerRect.left + videoRect.width);
        const bottom = Math.min(playerRect.height, videoRect.top - playerRect.top + videoRect.height);
        const width = right - left;
        const height = bottom - top;
        if (width <= 0 || height <= 0) return null;
        return { left, top, width, height };
    }

    const api = {
        MAX_VISIBLE_MESSAGES,
        DANMAKU_FONT_SIZE_PX,
        DANMAKU_LINE_HEIGHT_PX,
        DANMAKU_LANE_GAP_PX,
        DANMAKU_HORIZONTAL_GAP_PX,
        DANMAKU_SPEED_PX_PER_SECOND,
        DANMAKU_MAX_ACTIVE_COMMENTS,
        DANMAKU_MAX_LANES,
        DANMAKU_MAX_MESSAGE_LENGTH,
        MIN_PLAYABLE_READY_STATE,
        DANMAKU_TARGET_DURATION_MS,
        DANMAKU_MIN_SPEED_PX_PER_SECOND,
        DANMAKU_MAX_SPEED_PX_PER_SECOND,
        DANMAKU_MAX_BATCH_SPREAD_MS,
        DANMAKU_BATCH_STAGGER_MS,
        DANMAKU_MAX_PENDING_COMMENTS,
        mergeMessagesById,
        getVisibleMessages,
        formatMessageText,
        normalizeDanmakuMessage,
        calculateLaneCount,
        selectAvailableLane,
        calculateDanmakuMotion,
        calculateDanmakuSpeed,
        isLaneCollisionSafe,
        selectCollisionSafeLane,
        planDanmakuBatch,
        canRenderDanmaku,
        isPlaybackEligible,
        calculateVideoSurfaceRect
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowOverlayCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
