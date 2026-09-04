(function () {
    const LOG_PREFIX = '[LiveFlow PoC]';
    const REQUEST_TYPE = 'LIVEFLOW_REQUEST_INITIAL_CHAT_CONTINUATION';
    const RESPONSE_TYPE = 'LIVEFLOW_INITIAL_CHAT_CONTINUATION';
    const READ_REQUEST_TYPE = 'LIVEFLOW_REQUEST_CHAT_READ_ONCE';
    const READ_RESPONSE_TYPE = 'LIVEFLOW_CHAT_READ_ONCE_RESULT';
    const STOP_READ_LOOP_TYPE = 'LIVEFLOW_STOP_CHAT_READ_LOOP';
    const MAX_MESSAGES = 500;
    const PLAYER_SELECTORS = Object.freeze({
        watchRoot: 'ytd-watch-flexy',
        nativeChat: 'ytd-live-chat-frame#chat, ytd-live-chat-frame',
        player: '#movie_player, .html5-video-player',
        video: 'video.html5-main-video, video',
        miniPlayerAncestor: 'ytd-miniplayer, #miniplayer'
    });
    const overlayCore = window.LiveFlowOverlayCore;
    let overlayRoot = null;
    let overlaySurface = null;
    let laneStates = [];
    const activeDanmaku = new Map();
    const pendingDanmakuTimers = new Map();
    let initialContinuation = '';
    let internalApiContext = null;
    let chatAvailable = false;
    let currentPageRevision = 0;
    let readRequestedRevision = -1;
    let currentMessages = [];
    let currentPageKey = '';
    let rendererGeneration = 0;
    let userEnabled = true;
    let nativeChatVisible = true;
    let nativeChatObserver = null;
    let observedWatchRoot = null;
    let visibilityEvaluationQueued = false;

    function logInfo(message) {
        console.log(`${LOG_PREFIX} ${message}`);
    }

    function requestInitialContinuation() {
        window.postMessage({
            source: 'liveflow-content-script',
            type: REQUEST_TYPE
        }, window.location.origin);
    }

    window.LiveFlowStopReadLoop = function () {
        window.postMessage({
            source: 'liveflow-content-script',
            type: STOP_READ_LOOP_TYPE
        }, window.location.origin);
    };

    function resetPageState() {
        initialContinuation = '';
        internalApiContext = null;
        chatAvailable = false;
        readRequestedRevision = -1;
        currentMessages = [];
        currentPageKey = '';
        cleanupOverlay();
    }

    function getCurrentMainMedia() {
        if (!isYouTubeWatchPage()) return null;
        const watchRoot = document.querySelector(PLAYER_SELECTORS.watchRoot);
        const player = watchRoot?.querySelector(PLAYER_SELECTORS.player) || null;
        if (!player || player.closest(PLAYER_SELECTORS.miniPlayerAncestor) || player.classList.contains('ytp-player-minimized')) return null;
        const video = player.querySelector(PLAYER_SELECTORS.video);
        return video ? { player, video } : null;
    }

    function cleanupOverlay() {
        rendererGeneration += 1;
        activeDanmaku.forEach(({ animation, node }) => {
            animation?.cancel();
            node?.remove();
        });
        activeDanmaku.clear();
        pendingDanmakuTimers.forEach((timerId) => window.clearTimeout(timerId));
        pendingDanmakuTimers.clear();
        laneStates = [];
        overlayRoot?.remove();
        overlayRoot = null;
        overlaySurface = null;
    }

    function isEffectiveDisplayActive() {
        return overlayCore?.isEffectiveDisplayActive?.({ userEnabled, nativeChatVisible }) === true;
    }

    function setDisplayState(nextState) {
        const transition = overlayCore.getDisplayStateTransition({ userEnabled, nativeChatVisible }, nextState);
        userEnabled = transition.userEnabled;
        nativeChatVisible = transition.nativeChatVisible;
        if (transition.cleanupRequired) cleanupOverlay();
        return transition.effectiveActive;
    }

    window.LiveFlowDisplayState = Object.freeze({
        setUserEnabled(value) {
            if (typeof value !== 'boolean') return false;
            setDisplayState({ userEnabled: value });
            return true;
        },
        getUserEnabled() {
            return userEnabled;
        },
        getNativeChatVisible() {
            return nativeChatVisible;
        },
        getEffectiveDisplayActive() {
            return isEffectiveDisplayActive();
        }
    });

    function readNativeChatVisibility(watchRoot) {
        if (!watchRoot) return true;
        const frame = watchRoot.querySelector(PLAYER_SELECTORS.nativeChat);
        if (!frame) return false;
        let style;
        let rect;
        try {
            style = window.getComputedStyle(frame);
            rect = frame.getBoundingClientRect();
        } catch (error) {
            return true;
        }
        return overlayCore?.isNativeChatFrameVisible?.({
            belongsToCurrentWatchRoot: watchRoot.contains(frame),
            hiddenAttribute: frame.hidden === true || frame.hasAttribute('hidden'),
            collapsed: frame.hasAttribute('collapsed') || frame.getAttribute('aria-hidden') === 'true',
            display: style.display,
            visibility: style.visibility,
            width: rect.width,
            height: rect.height
        }) !== false;
    }

    function evaluateNativeChatVisibility() {
        visibilityEvaluationQueued = false;
        if (!isYouTubeWatchPage()) {
            setDisplayState({ nativeChatVisible: true });
            return;
        }
        const watchRoot = document.querySelector(PLAYER_SELECTORS.watchRoot);
        setDisplayState({ nativeChatVisible: readNativeChatVisibility(watchRoot) });
        observeNativeChat(watchRoot);
    }

    function scheduleNativeChatVisibilityEvaluation() {
        if (visibilityEvaluationQueued) return;
        visibilityEvaluationQueued = true;
        window.queueMicrotask(evaluateNativeChatVisibility);
    }

    function nodeContainsNativeChat(node) {
        return node?.nodeType === 1 && (
            node.matches?.(PLAYER_SELECTORS.nativeChat) ||
            Boolean(node.querySelector?.(PLAYER_SELECTORS.nativeChat))
        );
    }

    function mutationAffectsNativeChat(mutation) {
        if (mutation.type === 'attributes') {
            return mutation.target?.matches?.(PLAYER_SELECTORS.nativeChat) === true ||
                Boolean(mutation.target?.querySelector?.(PLAYER_SELECTORS.nativeChat));
        }
        return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeContainsNativeChat);
    }

    function observeNativeChat(watchRoot) {
        if (watchRoot === observedWatchRoot && nativeChatObserver) return;
        nativeChatObserver?.disconnect();
        nativeChatObserver = null;
        observedWatchRoot = watchRoot || null;
        if (!watchRoot) return;
        nativeChatObserver = new MutationObserver((mutations) => {
            if (mutations.some(mutationAffectsNativeChat)) scheduleNativeChatVisibilityEvaluation();
        });
        nativeChatObserver.observe(watchRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['hidden', 'style', 'class', 'collapsed', 'aria-hidden']
        });
    }

    function disconnectNativeChatObserver() {
        nativeChatObserver?.disconnect();
        nativeChatObserver = null;
        observedWatchRoot = null;
        visibilityEvaluationQueued = false;
    }

    function attachOverlay(player) {
        if (!player) return false;

        if (overlayRoot?.isConnected && overlayRoot.parentElement === player) return true;
        cleanupOverlay();
        overlayRoot = document.createElement('div');
        overlayRoot.id = 'liveflow-overlay-root';
        overlayRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:20;overflow:hidden;contain:layout paint;';
        overlaySurface = document.createElement('div');
        overlaySurface.id = 'liveflow-danmaku-surface';
        overlaySurface.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;contain:layout paint;';
        overlayRoot.appendChild(overlaySurface);
        player.appendChild(overlayRoot);
        logInfo('Overlay attached');
        return true;
    }

    function renderDanmaku(message, scheduledGeneration = rendererGeneration, scheduledVideo = null) {
        if (!isEffectiveDisplayActive()) return false;
        const media = getCurrentMainMedia();
        if (!media || !overlayCore?.isRendererTargetCurrent?.({
            scheduledGeneration,
            currentGeneration: rendererGeneration,
            scheduledVideo: scheduledVideo || media.video,
            currentVideo: media.video,
            currentPlayerOwnsVideo: true
        })) return false;
        const { player, video } = media;
        if (!overlayCore.isPlaybackEligible(video)) return false;
        if (!attachOverlay(player) || !overlayRoot || !overlaySurface) return false;
        if (!overlayCore.canRenderDanmaku(message, activeDanmaku.size)) return false;

        const surfaceRect = overlayCore.calculateVideoSurfaceRect(player.getBoundingClientRect(), video.getBoundingClientRect());
        if (!surfaceRect) return false;
        overlaySurface.style.left = `${surfaceRect.left}px`;
        overlaySurface.style.top = `${surfaceRect.top}px`;
        overlaySurface.style.width = `${surfaceRect.width}px`;
        overlaySurface.style.height = `${surfaceRect.height}px`;

        const laneCount = overlayCore.calculateLaneCount(surfaceRect.height);
        if (laneCount <= 0) return false;
        if (laneStates.length !== laneCount) {
            laneStates = Array.from({ length: laneCount }, (_, index) => laneStates[index] || null);
        }

        const now = performance.now();
        const normalized = overlayCore.normalizeDanmakuMessage(message);
        if (!normalized) return false;

        const node = document.createElement('div');
        node.className = 'liveflow-danmaku';
        node.textContent = normalized.text;
        node.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;font:${overlayCore.DANMAKU_FONT_SIZE_PX}px/${overlayCore.DANMAKU_LINE_HEIGHT_PX}px sans-serif;font-weight:600;color:#fff;text-shadow:0 1px 3px #000;will-change:transform;pointer-events:none;`;
        overlaySurface.appendChild(node);
        const commentWidth = node.getBoundingClientRect().width;
        const speed = overlayCore.calculateDanmakuSpeed({ overlayWidth: surfaceRect.width, commentWidth });
        const nextMotion = { startX: surfaceRect.width, speed };
        const lane = overlayCore.selectCollisionSafeLane(laneStates, laneCount, nextMotion, now);
        if (lane < 0) {
            node.remove();
            return false;
        }
        const motion = overlayCore.calculateDanmakuMotion({
            overlayWidth: surfaceRect.width,
            commentWidth,
            speed,
            startTimeMs: now
        });
        if (!motion || typeof node.animate !== 'function') {
            node.remove();
            return false;
        }

        const token = Symbol('danmaku');
        laneStates[lane] = {
            token,
            startTimeMs: now,
            startX: motion.startX,
            commentWidth,
            speed,
            endTimeMs: now + motion.durationMs
        };
        node.style.top = `${lane * (overlayCore.DANMAKU_LINE_HEIGHT_PX + overlayCore.DANMAKU_LANE_GAP_PX)}px`;
        node.style.visibility = 'visible';
        const animation = node.animate([
            { transform: `translateX(${motion.startX}px)` },
            { transform: `translateX(${motion.endX}px)` }
        ], {
            duration: motion.durationMs,
            easing: 'linear',
            fill: 'forwards'
        });
        activeDanmaku.set(token, { animation, node });
        animation.finished.then(() => {
            activeDanmaku.delete(token);
            node.remove();
        }).catch(() => {
            activeDanmaku.delete(token);
            node.remove();
        });
        return true;
    }

    function scheduleDanmakuBatch(messages) {
        if (!isEffectiveDisplayActive()) return;
        const media = getCurrentMainMedia();
        if (!media || !overlayCore?.isPlaybackEligible?.(media.video)) return;
        const scheduledGeneration = rendererGeneration;
        const scheduledVideo = media.video;
        const availableSlots = Math.max(0, overlayCore.DANMAKU_MAX_PENDING_COMMENTS - pendingDanmakuTimers.size);
        const plan = overlayCore.planDanmakuBatch(messages, availableSlots);
        plan.forEach(({ message, delayMs }) => {
            if (delayMs <= 0) {
                renderDanmaku(message, scheduledGeneration, scheduledVideo);
                return;
            }
            const token = Symbol('pending-danmaku');
            const timerId = window.setTimeout(() => {
                pendingDanmakuTimers.delete(token);
                if (!isEffectiveDisplayActive()) return;
                const currentMedia = getCurrentMainMedia();
                if (!overlayCore.isRendererTargetCurrent({
                    scheduledGeneration,
                    currentGeneration: rendererGeneration,
                    scheduledVideo,
                    currentVideo: currentMedia?.video || null,
                    currentPlayerOwnsVideo: Boolean(currentMedia)
                })) return;
                renderDanmaku(message, scheduledGeneration, scheduledVideo);
            }, delayMs);
            pendingDanmakuTimers.set(token, timerId);
        });
    }

    function handleInitialContinuation(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== RESPONSE_TYPE) return;

        const previousRevision = currentPageRevision;
        const nextPageKey = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        const pageChanged = Boolean(currentPageKey && currentPageKey !== nextPageKey);
        const continuation = event.data.continuation;
        initialContinuation = typeof continuation === 'string' ? continuation : '';
        internalApiContext = event.data.context && typeof event.data.context === 'object'
            ? event.data.context
            : null;
        currentPageRevision = Number.isInteger(event.data.pageRevision) ? event.data.pageRevision : currentPageRevision;
        if (pageChanged) {
            readRequestedRevision = -1;
            currentMessages = [];
        }
        currentPageKey = nextPageKey;
        const revisionChanged = previousRevision !== currentPageRevision;
        if (revisionChanged) {
            readRequestedRevision = -1;
            currentMessages = [];
        }
        if (pageChanged || revisionChanged) cleanupOverlay();
        chatAvailable = Boolean(initialContinuation);

        if (chatAvailable) {
            logInfo('Initial live chat continuation found');
        } else {
            logInfo('Live chat is not available');
        }

        if (internalApiContext) {
            logInfo('YouTube internal API context found');
        } else {
            logInfo('YouTube internal API context is not available');
        }

        const media = getCurrentMainMedia();
        if (media && isEffectiveDisplayActive()) attachOverlay(media.player);
        requestReadOnce();
    }

    function requestReadOnce() {
        if (!chatAvailable || !internalApiContext || readRequestedRevision === currentPageRevision) return;
        readRequestedRevision = currentPageRevision;
        window.postMessage({
            source: 'liveflow-content-script',
            type: READ_REQUEST_TYPE
        }, window.location.origin);
    }

    function handleReadResult(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== READ_RESPONSE_TYPE) return;
        if (event.data.pageRevision !== currentPageRevision) return;

        if (!event.data.ok) {
            const readNumber = event.data.readNumber || 0;
            if (event.data.status === null || event.data.status === undefined) {
                logInfo(`READ #${readNumber} failed: ${event.data.errorType}`);
            } else {
                logInfo(`READ #${readNumber} completed: HTTP ${event.data.status}`);
            }
            return;
        }

        const readNumber = event.data.readNumber || 0;
        const messages = Array.isArray(event.data.messages) ? event.data.messages : [];
        const messageIds = new Set(currentMessages.map((message) => message.id).filter(Boolean));
        const newMessages = [];
        messages.forEach((message) => {
            if (message.id && messageIds.has(message.id)) return;
            if (message.id) messageIds.add(message.id);
            currentMessages.push(message);
            newMessages.push(message);
        });
        if (currentMessages.length > MAX_MESSAGES) {
            currentMessages.splice(0, currentMessages.length - MAX_MESSAGES);
        }
        scheduleDanmakuBatch(newMessages);
        logInfo(`READ #${readNumber} completed: HTTP ${event.data.status}`);
        logInfo(`READ #${readNumber} parsed messages: ${event.data.parsedMessageCount ?? messages.length}`);
        if (event.data.nextContinuationAvailable) logInfo(`READ #${readNumber} next continuation available`);
        if (Array.isArray(event.data.continuationTypes) && event.data.continuationTypes.length > 0) {
            logInfo(`READ #${readNumber} continuation types: ${event.data.continuationTypes.join(', ')}`);
        }
    }

    function isYouTubeWatchPage() {
        return /(?:^|\.)youtube\.com\/(?:watch|live)(?:[/?]|$)/i.test(window.location.href);
    }

    function detectPage() {
        if (!isYouTubeWatchPage()) return;
        const nextPageKey = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        if (currentPageKey !== nextPageKey) resetPageState();
        logInfo('YouTube watch page detected');
        evaluateNativeChatVisibility();
        requestInitialContinuation();
    }

    function handleNavigation() {
        requestInitialContinuation();
    }

    function handleNavigationStart() {
        disconnectNativeChatObserver();
        setDisplayState({ nativeChatVisible: true });
        cleanupOverlay();
    }

    function handlePageHide() {
        disconnectNativeChatObserver();
        cleanupOverlay();
    }

    window.addEventListener('message', handleInitialContinuation);
    window.addEventListener('message', handleReadResult);
    window.addEventListener('yt-navigate-start', handleNavigationStart);
    window.addEventListener('yt-navigate-finish', detectPage);
    window.addEventListener('yt-page-data-updated', handleNavigation);
    window.addEventListener('pagehide', handlePageHide);

    if (isYouTubeWatchPage()) {
        detectPage();
    }
})();
