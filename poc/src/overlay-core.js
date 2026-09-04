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
        mergeMessagesById,
        getVisibleMessages,
        formatMessageText,
        normalizeDanmakuMessage,
        calculateLaneCount,
        selectAvailableLane,
        calculateDanmakuMotion,
        canRenderDanmaku,
        isPlaybackEligible,
        calculateVideoSurfaceRect
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowOverlayCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
