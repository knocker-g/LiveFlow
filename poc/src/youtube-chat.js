(function () {
    const LOG_PREFIX = '[LiveFlow PoC]';
    const REQUEST_TYPE = 'LIVEFLOW_REQUEST_INITIAL_CHAT_CONTINUATION';
    const RESPONSE_TYPE = 'LIVEFLOW_INITIAL_CHAT_CONTINUATION';
    const READ_REQUEST_TYPE = 'LIVEFLOW_REQUEST_CHAT_READ_ONCE';
    const READ_RESPONSE_TYPE = 'LIVEFLOW_CHAT_READ_ONCE_RESULT';
    const STOP_READ_LOOP_TYPE = 'LIVEFLOW_STOP_CHAT_READ_LOOP';
    const MAX_MESSAGES = 500;
    const overlayCore = window.LiveFlowOverlayCore;
    let overlayRoot = null;
    let overlaySurface = null;
    let laneAvailableAt = [];
    const activeDanmaku = new Map();
    let initialContinuation = '';
    let internalApiContext = null;
    let chatAvailable = false;
    let currentPageRevision = 0;
    let readRequestedRevision = -1;
    let currentMessages = [];
    let currentPageKey = '';

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

    function getPlayer() {
        return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    }

    function getVideo() {
        return document.querySelector('video.html5-main-video') || document.querySelector('video');
    }

    function cleanupOverlay() {
        activeDanmaku.forEach(({ animation, node }) => {
            animation?.cancel();
            node?.remove();
        });
        activeDanmaku.clear();
        laneAvailableAt = [];
        overlayRoot?.remove();
        overlayRoot = null;
        overlaySurface = null;
    }

    function attachOverlay() {
        const player = getPlayer();
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

    function renderDanmaku(message) {
        const player = getPlayer();
        const video = getVideo();
        if (!player || !overlayCore?.isPlaybackEligible?.(video)) return false;
        if (!attachOverlay() || !overlayRoot || !overlaySurface) return false;
        if (!overlayCore.canRenderDanmaku(message, activeDanmaku.size)) return false;

        const surfaceRect = overlayCore.calculateVideoSurfaceRect(player.getBoundingClientRect(), video.getBoundingClientRect());
        if (!surfaceRect) return false;
        overlaySurface.style.left = `${surfaceRect.left}px`;
        overlaySurface.style.top = `${surfaceRect.top}px`;
        overlaySurface.style.width = `${surfaceRect.width}px`;
        overlaySurface.style.height = `${surfaceRect.height}px`;

        const laneCount = overlayCore.calculateLaneCount(surfaceRect.height);
        if (laneCount <= 0) return false;
        if (laneAvailableAt.length !== laneCount) {
            laneAvailableAt = Array.from({ length: laneCount }, (_, index) => laneAvailableAt[index] || 0);
        }

        const now = performance.now();
        const lane = overlayCore.selectAvailableLane(laneAvailableAt, laneCount, now);
        if (lane < 0) return false;
        const normalized = overlayCore.normalizeDanmakuMessage(message);
        if (!normalized) return false;

        const node = document.createElement('div');
        node.className = 'liveflow-danmaku';
        node.textContent = normalized.text;
        node.style.cssText = `position:absolute;left:0;top:${lane * (overlayCore.DANMAKU_LINE_HEIGHT_PX + overlayCore.DANMAKU_LANE_GAP_PX)}px;white-space:nowrap;font:${overlayCore.DANMAKU_FONT_SIZE_PX}px/${overlayCore.DANMAKU_LINE_HEIGHT_PX}px sans-serif;font-weight:600;color:#fff;text-shadow:0 1px 3px #000;will-change:transform;pointer-events:none;`;
        overlaySurface.appendChild(node);
        const commentWidth = node.getBoundingClientRect().width;
        const motion = overlayCore.calculateDanmakuMotion({
            overlayWidth: surfaceRect.width,
            commentWidth,
            startTimeMs: now
        });
        if (!motion || typeof node.animate !== 'function') {
            node.remove();
            return false;
        }

        laneAvailableAt[lane] = motion.laneAvailableAtMs;
        const token = Symbol('danmaku');
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

    function handleInitialContinuation(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== RESPONSE_TYPE) return;

        const previousRevision = currentPageRevision;
        const nextPageKey = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        const continuation = event.data.continuation;
        initialContinuation = typeof continuation === 'string' ? continuation : '';
        internalApiContext = event.data.context && typeof event.data.context === 'object'
            ? event.data.context
            : null;
        currentPageRevision = Number.isInteger(event.data.pageRevision) ? event.data.pageRevision : currentPageRevision;
        if (currentPageKey && currentPageKey !== nextPageKey) {
            readRequestedRevision = -1;
            currentMessages = [];
        }
        currentPageKey = nextPageKey;
        if (previousRevision !== currentPageRevision) {
            readRequestedRevision = -1;
            currentMessages = [];
        }
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

        attachOverlay();
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
        newMessages.forEach(renderDanmaku);
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
        requestInitialContinuation();
    }

    function handleNavigation() {
        requestInitialContinuation();
    }

    window.addEventListener('message', handleInitialContinuation);
    window.addEventListener('message', handleReadResult);
    window.addEventListener('yt-navigate-finish', detectPage);
    window.addEventListener('yt-page-data-updated', handleNavigation);
    window.addEventListener('pagehide', cleanupOverlay);

    if (isYouTubeWatchPage()) {
        detectPage();
    }
})();
