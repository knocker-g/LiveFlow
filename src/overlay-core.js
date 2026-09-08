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
    const DANMAKU_MAX_BATCH_SPREAD_MS = 800;
    const DANMAKU_BATCH_STAGGER_MS = 50;
    const DANMAKU_MAX_PENDING_COMMENTS = 40;
    const DANMAKU_MAX_RENDER_QUEUE = 150;
    const DANMAKU_ENTRY_CLEAR_FRACTION = 0.25;

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
        let previousRawDelay = 0;
        let previousTimestamp = null;
        const rawPlan = selected.map((message, index) => {
            const timestamp = timestamps[index];
            let rawDelay = 0;
            if (index > 0) {
                const parsedTimestampDelay = timestamp !== null && oldest !== null
                    ? Number(timestamp - oldest) / 1000
                    : null;
                const timestampDelay = Number.isFinite(parsedTimestampDelay) ? parsedTimestampDelay : null;
                rawDelay = timestampDelay !== null && previousTimestamp !== null && timestamp > previousTimestamp
                    ? Math.max(timestampDelay, previousRawDelay)
                    : previousRawDelay + staggerMs;
            }
            previousRawDelay = Math.max(0, rawDelay);
            previousTimestamp = timestamp;
            return { message, rawDelayMs: previousRawDelay };
        });
        const actualSpreadMs = rawPlan.at(-1)?.rawDelayMs || 0;
        const scale = actualSpreadMs > maxSpreadMs && actualSpreadMs > 0 ? maxSpreadMs / actualSpreadMs : 1;
        return rawPlan.map(({ message, rawDelayMs }) => ({
            message,
            delayMs: Math.min(maxSpreadMs, Math.max(0, Math.floor(rawDelayMs * scale)))
        }));
    }

    function isRendererTargetCurrent({ scheduledGeneration, currentGeneration, scheduledVideo, currentVideo, currentPlayerOwnsVideo } = {}) {
        return Number.isInteger(scheduledGeneration) &&
            scheduledGeneration === currentGeneration &&
            Boolean(scheduledVideo) &&
            scheduledVideo === currentVideo &&
            currentPlayerOwnsVideo === true;
    }

    function isEffectiveDisplayActive({ userEnabled, nativeChatVisible } = {}) {
        return userEnabled === true;
    }

    function calculateLaneSafeAtMs(previous, next, overlayWidth, nowMs, horizontalGap = DANMAKU_HORIZONTAL_GAP_PX, clearFraction = DANMAKU_ENTRY_CLEAR_FRACTION) {
        if (!previous) return nowMs;
        const values = [
            previous.startTimeMs, previous.startX, previous.commentWidth, previous.speed, previous.endTimeMs,
            next?.startX, next?.speed, overlayWidth, nowMs, horizontalGap, clearFraction
        ];
        if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
        if (previous.commentWidth <= 0 || previous.speed <= 0 || next.speed <= 0 || overlayWidth <= 0 || horizontalGap < 0 || clearFraction <= 0 || clearFraction >= 1) return null;
        if (nowMs >= previous.endTimeMs) return nowMs;

        const quarterClearRight = overlayWidth * (1 - clearFraction);
        const entryGapRight = next.startX - horizontalGap;
        const futureCollisionRight = next.speed > previous.speed
            ? (next.startX - horizontalGap) * previous.speed / next.speed
            : Infinity;
        const requiredPreviousRight = Math.min(quarterClearRight, entryGapRight, futureCollisionRight);
        const travelPx = Math.max(0, previous.startX + previous.commentWidth - requiredPreviousRight);
        const safeAtMs = previous.startTimeMs + Math.ceil(travelPx / previous.speed * 1000);
        return Math.min(previous.endTimeMs, Math.max(nowMs, safeAtMs));
    }

    function findNextLaneAvailability(laneStates, laneCount, next, overlayWidth, nowMs, horizontalGap = DANMAKU_HORIZONTAL_GAP_PX) {
        if (!Array.isArray(laneStates) || !Number.isInteger(laneCount) || laneCount <= 0) return { lane: -1, nextSafeAtMs: null };
        let nextSafeAtMs = null;
        const limit = Math.min(laneCount, laneStates.length);
        for (let index = 0; index < limit; index += 1) {
            const safeAtMs = calculateLaneSafeAtMs(laneStates[index], next, overlayWidth, nowMs, horizontalGap);
            if (safeAtMs === null) continue;
            if (safeAtMs <= nowMs && isLaneCollisionSafe(laneStates[index], next, nowMs, horizontalGap)) {
                return { lane: index, nextSafeAtMs: nowMs };
            }
            if (nextSafeAtMs === null || safeAtMs < nextSafeAtMs) nextSafeAtMs = safeAtMs;
        }
        return { lane: -1, nextSafeAtMs };
    }

    function getDisplayStateTransition(currentState = {}, nextState = {}) {
        const resolved = {
            userEnabled: typeof nextState.userEnabled === 'boolean' ? nextState.userEnabled : currentState.userEnabled === true,
            nativeChatVisible: typeof nextState.nativeChatVisible === 'boolean' ? nextState.nativeChatVisible : currentState.nativeChatVisible !== false
        };
        const wasActive = isEffectiveDisplayActive(currentState);
        const effectiveActive = isEffectiveDisplayActive(resolved);
        return { ...resolved, effectiveActive, cleanupRequired: wasActive && !effectiveActive };
    }

    function reduceDisplayState(currentState = {}, action = {}, settings = {}) {
        const state = {
            userEnabled: currentState.userEnabled === true,
            nativeChatVisible: currentState.nativeChatVisible === true,
            nativeChatKnown: currentState.nativeChatKnown === true
        };
        const result = {
            ...state,
            effectiveActive: isEffectiveDisplayActive(state),
            changed: false,
            cleanupRequired: false,
            requestNativeChatOpen: false
        };

        if (action.type === 'native-chat-visibility' && typeof action.value === 'boolean') {
            const closedTransition = state.nativeChatKnown && state.nativeChatVisible && !action.value;
            result.nativeChatVisible = action.value;
            result.nativeChatKnown = true;
            if (closedTransition && settings.autoEnableLiveFlowWhenNativeChatClosed === true && !state.userEnabled) {
                result.userEnabled = true;
            }
        } else if (action.type === 'set-user-enabled' && typeof action.value === 'boolean') {
            result.userEnabled = action.value;
            result.requestNativeChatOpen = state.userEnabled && !action.value &&
                state.nativeChatKnown && !state.nativeChatVisible &&
                settings.autoOpenNativeChatWhenLiveFlowDisabled === true;
        } else if (action.type === 'reset-native-chat') {
            result.nativeChatVisible = true;
            result.nativeChatKnown = false;
        } else {
            return result;
        }

        result.effectiveActive = isEffectiveDisplayActive(result);
        result.changed = result.userEnabled !== state.userEnabled ||
            result.nativeChatVisible !== state.nativeChatVisible ||
            result.nativeChatKnown !== state.nativeChatKnown;
        result.cleanupRequired = isEffectiveDisplayActive(state) && !result.effectiveActive;
        return result;
    }

    function getManagementBarViewModel({ userEnabled, readState } = {}) {
        const enabled = userEnabled === true;
        const normalizedReadState = ['idle', 'active', 'stopped'].includes(readState) ? readState : 'idle';
        return {
            enabled,
            statusShape: enabled ? 'playing' : 'stopped',
            toggleLabel: enabled ? 'LiveFlow ON' : 'LiveFlow OFF',
            togglePressed: enabled,
            readState: normalizedReadState
        };
    }

    function selectFirstUsableNativeChatButton(candidates) {
        if (!Array.isArray(candidates)) return null;
        for (const candidate of candidates) {
            if (candidate?.element && hasPositiveNativeChatCandidateGeometry(candidate) &&
                getNativeChatOpenCandidateRejectionReason(candidate) === 'none') return candidate.element;
        }
        const zeroGeometryExceptions = candidates.filter((candidate) =>
            candidate?.element && !hasPositiveNativeChatCandidateGeometry(candidate) &&
            isChatOwnedZeroGeometryReopenCandidate(candidate) &&
            getNativeChatOpenCandidateRejectionReason(candidate) === 'none'
        );
        return zeroGeometryExceptions.length === 1 ? zeroGeometryExceptions[0].element : null;
    }

    function hasPositiveNativeChatCandidateGeometry(candidate = {}) {
        return typeof candidate.width === 'number' && Number.isFinite(candidate.width) && candidate.width > 0 &&
            typeof candidate.height === 'number' && Number.isFinite(candidate.height) && candidate.height > 0;
    }

    function isChatOwnedZeroGeometryReopenCandidate(candidate = {}) {
        return candidate.nativeChatClosed === true &&
            candidate.belongsToCurrentWatchRoot === true &&
            candidate.insideChatContainer === true &&
            candidate.insideLiveChatFrame === true &&
            candidate.descendantOfShowHideButton === true &&
            candidate.actualButton === true &&
            candidate.hiddenAttribute !== true;
    }

    function getNativeChatOpenCandidateRejectionReason(candidate = {}) {
        if (candidate.belongsToCurrentWatchRoot !== true) return 'wrong-watch-ownership';
        if (candidate.associatedWithNativeChat !== true) return 'not-chat-associated';
        if (candidate.hiddenAttribute === true) return 'hidden';
        if (candidate.disabled === true || candidate.ariaDisabled === 'true') return 'disabled';
        if (candidate.display === 'none') return 'display-none';
        if (candidate.visibility === 'hidden' || candidate.visibility === 'collapse') return 'visibility-hidden';
        if (!hasPositiveNativeChatCandidateGeometry(candidate) && !isChatOwnedZeroGeometryReopenCandidate(candidate)) {
            return 'zero-or-invalid-geometry';
        }
        return 'none';
    }

    function isChatStackedBelowPlayer(playerRect, chatRect) {
        if (!playerRect || !chatRect) return false;
        const values = [
            playerRect.left, playerRect.top, playerRect.width, playerRect.height,
            chatRect.left, chatRect.top, chatRect.width, chatRect.height
        ];
        if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return false;
        if (playerRect.width <= 0 || playerRect.height <= 0 || chatRect.width <= 0 || chatRect.height <= 0) return false;
        const horizontalOverlap = Math.min(playerRect.left + playerRect.width, chatRect.left + chatRect.width) -
            Math.max(playerRect.left, chatRect.left);
        return horizontalOverlap > 0 && chatRect.top >= playerRect.top + playerRect.height - 1;
    }

    function isNativeChatOpenButtonUsable({ belongsToCurrentWatchRoot, disabled, ariaDisabled, display, visibility, width, height } = {}) {
        return belongsToCurrentWatchRoot === true &&
            disabled !== true &&
            ariaDisabled !== 'true' &&
            display !== 'none' &&
            visibility !== 'hidden' &&
            visibility !== 'collapse' &&
            typeof width === 'number' && Number.isFinite(width) && width > 0 &&
            typeof height === 'number' && Number.isFinite(height) && height > 0;
    }

    function isNativeChatFrameVisible({
        belongsToCurrentWatchRoot,
        hiddenAttribute,
        collapsed,
        display,
        visibility,
        width,
        height
    } = {}) {
        if (belongsToCurrentWatchRoot !== true) return false;
        if (hiddenAttribute === true || collapsed === true) return false;
        if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') return false;
        if (![width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) return true;
        return width > 0 && height > 0;
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
        DANMAKU_MAX_RENDER_QUEUE,
        DANMAKU_ENTRY_CLEAR_FRACTION,
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
        calculateLaneSafeAtMs,
        findNextLaneAvailability,
        planDanmakuBatch,
        isRendererTargetCurrent,
        isEffectiveDisplayActive,
        getDisplayStateTransition,
        reduceDisplayState,
        getManagementBarViewModel,
        isChatStackedBelowPlayer,
        isNativeChatOpenButtonUsable,
        selectFirstUsableNativeChatButton,
        hasPositiveNativeChatCandidateGeometry,
        isChatOwnedZeroGeometryReopenCandidate,
        getNativeChatOpenCandidateRejectionReason,
        isNativeChatFrameVisible,
        canRenderDanmaku,
        isPlaybackEligible,
        calculateVideoSurfaceRect
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowOverlayCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
