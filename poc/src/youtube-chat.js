(function () {
    const LOG_PREFIX = '[LiveFlow PoC]';
    const REQUEST_TYPE = 'LIVEFLOW_REQUEST_INITIAL_CHAT_CONTINUATION';
    const RESPONSE_TYPE = 'LIVEFLOW_INITIAL_CHAT_CONTINUATION';
    const READ_REQUEST_TYPE = 'LIVEFLOW_REQUEST_CHAT_READ_ONCE';
    const READ_RESPONSE_TYPE = 'LIVEFLOW_CHAT_READ_ONCE_RESULT';
    const STOP_READ_LOOP_TYPE = 'LIVEFLOW_STOP_CHAT_READ_LOOP';
    const NAVIGATION_INVALIDATED_TYPE = 'LIVEFLOW_PAGE_LIFECYCLE_INVALIDATED';
    const LIFECYCLE_DIAGNOSTIC_TYPE = 'LIVEFLOW_READ_LIFECYCLE_DIAGNOSTIC';
    const MAX_MESSAGES = 500;
    const MANAGEMENT_BAR_ID = 'liveflow-management-bar';
    const MANAGEMENT_STYLE_ID = 'liveflow-management-bar-style';
    const DISPLAY_LINK_SETTINGS = Object.freeze({
        autoEnableLiveFlowWhenNativeChatClosed: true,
        autoOpenNativeChatWhenLiveFlowDisabled: true
    });
    const PLAYER_SELECTORS = Object.freeze({
        watchRoot: 'ytd-watch-flexy',
        nativeChat: 'ytd-live-chat-frame#chat, ytd-live-chat-frame',
        nativeChatContainer: '#chat-container, #secondary-inner',
        nativeChatOpenButtons: Object.freeze([
            'ytd-live-chat-frame#chat #show-hide-button button',
            'ytd-live-chat-frame#chat #show-hide-button tp-yt-paper-button',
            '#chat-container #show-hide-button button',
            '#chat-container #show-hide-button tp-yt-paper-button'
        ]),
        belowPlayer: '#below',
        player: '#movie_player, .html5-video-player',
        video: 'video.html5-main-video, video',
        miniPlayerAncestor: 'ytd-miniplayer, #miniplayer'
    });
    const overlayCore = window.LiveFlowOverlayCore;
    let overlayRoot = null;
    let overlaySurface = null;
    let laneStates = [];
    const activeDanmaku = new Map();
    const rendererQueue = [];
    let rendererQueueTimer = null;
    let rendererQueueTimerDueAt = null;
    let initialContinuation = '';
    let internalApiContext = null;
    let chatAvailable = false;
    let currentPageRevision = 0;
    let readRequestedRevision = -1;
    let currentMessages = [];
    let currentPageKey = '';
    let rendererGeneration = 0;
    let acceptingReadResults = false;
    let minimumAcceptedPageRevision = 0;
    let geometryChangeQueued = false;
    let pageGeneration = 0;
    let currentPageLifecycleGeneration = -1;
    let userEnabled = true;
    let nativeChatVisible = true;
    let nativeChatKnown = false;
    let nativeChatObserver = null;
    let observedWatchRoot = null;
    let visibilityEvaluationQueued = false;
    let managementBar = null;
    let managementToggleButton = null;
    let managementToggleLabel = null;
    let managementReadIndicator = null;
    let readIndicatorState = 'idle';
    let nativeChatOpenAttempt = null;

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
        setReadIndicatorState('idle');
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
        if (rendererQueueTimer !== null) window.clearTimeout(rendererQueueTimer);
        rendererQueueTimer = null;
        rendererQueueTimerDueAt = null;
        rendererQueue.length = 0;
        laneStates = [];
        overlayRoot?.remove();
        overlayRoot = null;
        overlaySurface = null;
    }

    function isEffectiveDisplayActive() {
        return overlayCore?.isEffectiveDisplayActive?.({ userEnabled, nativeChatVisible }) === true;
    }

    function applyDisplayAction(action) {
        const transition = overlayCore.reduceDisplayState(
            { userEnabled, nativeChatVisible, nativeChatKnown },
            action,
            DISPLAY_LINK_SETTINGS
        );
        userEnabled = transition.userEnabled;
        nativeChatVisible = transition.nativeChatVisible;
        nativeChatKnown = transition.nativeChatKnown;
        if (nativeChatVisible && nativeChatOpenAttempt) {
            logInfo('Native Chat open confirmation: observerTransition=true, result=confirmed');
            clearNativeChatOpenAttempt();
        }
        if (transition.cleanupRequired) cleanupOverlay();
        updateManagementBar();
        if (transition.requestNativeChatOpen) {
            logInfo(`Native Chat open linkage: triggered=true, visible=${nativeChatVisible}`);
            tryOpenNativeChat();
        }
        return transition;
    }

    window.LiveFlowDisplayState = Object.freeze({
        setUserEnabled(value) {
            if (typeof value !== 'boolean') return false;
            applyDisplayAction({ type: 'set-user-enabled', value });
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
            applyDisplayAction({ type: 'reset-native-chat' });
            return;
        }
        const watchRoot = document.querySelector(PLAYER_SELECTORS.watchRoot);
        applyDisplayAction({ type: 'native-chat-visibility', value: readNativeChatVisibility(watchRoot) });
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

    function clearNativeChatOpenAttempt() {
        if (!nativeChatOpenAttempt) return;
        window.clearTimeout(nativeChatOpenAttempt.timerId);
        nativeChatOpenAttempt = null;
    }

    function tryOpenNativeChat() {
        if (!nativeChatKnown || nativeChatVisible || nativeChatOpenAttempt) return false;
        const watchRoot = document.querySelector(PLAYER_SELECTORS.watchRoot);
        const frame = watchRoot?.querySelector(PLAYER_SELECTORS.nativeChat) || null;
        if (!watchRoot) {
            logInfo('Native Chat open attempt: started=false, result=no-watch-root');
            return false;
        }
        if (readNativeChatVisibility(watchRoot) !== false) {
            logInfo('Native Chat open attempt: started=false, result=visibility-not-closed');
            return false;
        }
        const chatContainer = watchRoot.querySelector(PLAYER_SELECTORS.nativeChatContainer);
        const elements = [];
        PLAYER_SELECTORS.nativeChatOpenButtons.forEach((selector) => {
            watchRoot.querySelectorAll(selector).forEach((element) => {
                if (!elements.includes(element)) elements.push(element);
            });
        });
        const candidates = elements.map((element) => {
            let style;
            let rect;
            try {
                style = window.getComputedStyle(element);
                rect = element.getBoundingClientRect();
            } catch (error) {
                return { element: null };
            }
            const strategy = frame?.contains(element) ? 'frame-control' : 'chat-container-control';
            const associatedWithNativeChat = Boolean(
                frame?.contains(element) || chatContainer?.contains(element)
            );
            const candidate = {
                element,
                strategy,
                associatedWithNativeChat,
                belongsToCurrentWatchRoot: watchRoot.contains(element),
                disabled: element.disabled === true,
                ariaDisabled: element.getAttribute('aria-disabled'),
                display: style.display,
                visibility: style.visibility,
                width: rect.width,
                height: rect.height
            };
            candidate.rejectionReason = overlayCore.getNativeChatOpenCandidateRejectionReason(candidate);
            logInfo(`Native Chat open candidate: strategy=${strategy}, accepted=${candidate.rejectionReason === 'none'}, reason=${candidate.rejectionReason}`);
            return candidate;
        });
        const button = overlayCore.selectFirstUsableNativeChatButton(candidates);
        if (!button) {
            logInfo(`Native Chat open attempt: started=true, candidates=${elements.length}, clickIssued=false, result=no-candidate`);
            return false;
        }
        const attemptGeneration = pageGeneration;
        button.click();
        const timerId = window.setTimeout(() => {
            if (nativeChatOpenAttempt?.generation !== attemptGeneration) return;
            nativeChatOpenAttempt = null;
            logInfo(`Native Chat open confirmation: visible=${nativeChatVisible}, result=${nativeChatVisible ? 'confirmed' : 'not-confirmed'}`);
        }, 1500);
        nativeChatOpenAttempt = { generation: attemptGeneration, timerId };
        logInfo(`Native Chat open attempt: started=true, candidates=${elements.length}, clickIssued=true, result=pending`);
        return true;
    }

    function ensureManagementStyle() {
        if (document.getElementById(MANAGEMENT_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = MANAGEMENT_STYLE_ID;
        style.textContent = `
            #${MANAGEMENT_BAR_ID} {
                display: flex;
                align-items: center;
                gap: clamp(4px, 2vw, 10px);
                box-sizing: border-box;
                width: 100%;
                min-height: 52px;
                padding: 4px 12px;
                border-top: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,.1));
                border-bottom: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,.1));
                border-radius: 6px;
                color: var(--yt-spec-text-primary, #f1f1f1);
                background: var(--yt-spec-base-background, #0f0f0f);
                font: 500 14px/1.2 Roboto, Arial, sans-serif;
            }
            #${MANAGEMENT_BAR_ID} button {
                flex: 0 0 auto;
                min-width: 44px;
                min-height: 44px;
                border: 0;
                border-radius: 5px;
                padding: 0 12px;
                color: inherit;
                background: var(--yt-spec-badge-chip-background, rgba(255,255,255,.1));
                font: inherit;
                cursor: pointer;
            }
            #${MANAGEMENT_BAR_ID} .liveflow-toggle-button {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                max-width: 100%;
                white-space: nowrap;
            }
            #${MANAGEMENT_BAR_ID} .liveflow-status-icon { width: 1em; text-align: center; }
            #${MANAGEMENT_BAR_ID} .liveflow-status-icon::before {
                display: block;
                width: 0;
                height: 0;
                margin: auto;
                border-top: 7px solid transparent;
                border-bottom: 7px solid transparent;
                border-left: 11px solid currentColor;
                content: '';
            }
            #${MANAGEMENT_BAR_ID}[data-status-shape="stopped"] .liveflow-status-icon::before {
                width: 12px;
                height: 12px;
                border: 0;
                background: currentColor;
            }
            #${MANAGEMENT_BAR_ID} button:focus-visible {
                outline: 2px solid currentColor;
                outline-offset: 1px;
            }
            #${MANAGEMENT_BAR_ID} .liveflow-read-indicator {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                color: var(--yt-spec-call-to-action, #3ea6ff);
                letter-spacing: 3px;
                white-space: nowrap;
                opacity: .35;
            }
            #${MANAGEMENT_BAR_ID}[data-read-state="active"] .liveflow-read-indicator {
                opacity: 1;
                animation: liveflow-read-indicator 1.2s ease-in-out infinite alternate;
            }
            #${MANAGEMENT_BAR_ID}[data-enabled="false"] .liveflow-read-indicator {
                visibility: hidden;
            }
            @keyframes liveflow-read-indicator { from { opacity: .35; } to { opacity: 1; } }
            @media (prefers-reduced-motion: reduce) {
                #${MANAGEMENT_BAR_ID}[data-read-state="active"] .liveflow-read-indicator { animation: none; }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function updateManagementBar() {
        if (!managementBar) return;
        const view = overlayCore.getManagementBarViewModel({ userEnabled, readState: readIndicatorState });
        managementBar.dataset.enabled = String(view.enabled);
        managementBar.dataset.readState = view.readState;
        managementBar.dataset.statusShape = view.statusShape;
        managementToggleLabel.textContent = view.toggleLabel;
        managementToggleButton.setAttribute('aria-pressed', String(view.togglePressed));
    }

    function cleanupManagementBar() {
        managementBar?.remove();
        managementBar = null;
        managementToggleButton = null;
        managementToggleLabel = null;
        managementReadIndicator = null;
    }

    function getManagementBarPlacement(watchRoot, media) {
        const nativeChat = watchRoot.querySelector(PLAYER_SELECTORS.nativeChat);
        if (nativeChat && watchRoot.contains(nativeChat) && overlayCore.isChatStackedBelowPlayer(
            media.player.getBoundingClientRect(),
            nativeChat.getBoundingClientRect()
        )) return { parent: nativeChat.parentElement, before: nativeChat };

        const belowPlayer = watchRoot.querySelector(PLAYER_SELECTORS.belowPlayer);
        if (belowPlayer?.parentElement && watchRoot.contains(belowPlayer)) {
            return { parent: belowPlayer.parentElement, before: belowPlayer };
        }
        return null;
    }

    function attachManagementBar() {
        const media = getCurrentMainMedia();
        if (!media) {
            cleanupManagementBar();
            return false;
        }
        const watchRoot = document.querySelector(PLAYER_SELECTORS.watchRoot);
        if (!watchRoot || !watchRoot.contains(media.player)) {
            cleanupManagementBar();
            return false;
        }
        const placement = getManagementBarPlacement(watchRoot, media);
        if (!placement?.parent || !watchRoot.contains(placement.parent)) {
            cleanupManagementBar();
            return false;
        }
        if (managementBar?.isConnected && watchRoot.contains(managementBar) &&
            managementBar.parentElement === placement.parent && managementBar.nextSibling === placement.before) {
            updateManagementBar();
            return true;
        }
        cleanupManagementBar();
        document.getElementById(MANAGEMENT_BAR_ID)?.remove();
        ensureManagementStyle();

        const bar = document.createElement('div');
        bar.id = MANAGEMENT_BAR_ID;
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'LiveFlow controls');

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'liveflow-toggle-button';
        toggle.addEventListener('click', () => applyDisplayAction({ type: 'set-user-enabled', value: !userEnabled }));
        const statusIcon = document.createElement('span');
        statusIcon.className = 'liveflow-status-icon';
        statusIcon.setAttribute('aria-hidden', 'true');
        const toggleLabel = document.createElement('span');
        toggleLabel.className = 'liveflow-toggle-label';
        toggle.append(statusIcon, toggleLabel);

        const indicator = document.createElement('span');
        indicator.className = 'liveflow-read-indicator';
        indicator.textContent = '›››››';
        indicator.setAttribute('aria-hidden', 'true');

        const gear = document.createElement('button');
        gear.type = 'button';
        gear.className = 'liveflow-settings-button';
        gear.textContent = '⚙';
        gear.title = 'Settings (not yet available)';
        gear.setAttribute('aria-label', 'LiveFlow settings (not yet available)');
        gear.addEventListener('click', () => {});

        bar.append(toggle, indicator, gear);
        placement.parent.insertBefore(bar, placement.before);
        managementBar = bar;
        managementToggleButton = toggle;
        managementToggleLabel = toggleLabel;
        managementReadIndicator = indicator;
        updateManagementBar();
        return true;
    }

    function setReadIndicatorState(state) {
        readIndicatorState = state;
        updateManagementBar();
    }

    function refreshManagementBarPlacement() {
        attachManagementBar();
    }

    function attachOverlay(player) {
        if (!player) return false;

        if (overlayRoot?.isConnected && overlayRoot.parentElement === player) return true;
        if (overlayRoot) {
            cleanupOverlay();
            return false;
        }
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
        if (!isEffectiveDisplayActive()) return { status: 'drop' };
        const media = getCurrentMainMedia();
        if (!media || !overlayCore?.isRendererTargetCurrent?.({
            scheduledGeneration,
            currentGeneration: rendererGeneration,
            scheduledVideo: scheduledVideo || media.video,
            currentVideo: media.video,
            currentPlayerOwnsVideo: true
        })) return { status: 'drop' };
        const { player, video } = media;
        if (!overlayCore.isPlaybackEligible(video)) return { status: 'drop' };
        if (!attachOverlay(player) || !overlayRoot || !overlaySurface) return { status: 'drop' };
        const normalized = overlayCore.normalizeDanmakuMessage(message);
        if (!normalized) return { status: 'drop' };

        const surfaceRect = overlayCore.calculateVideoSurfaceRect(player.getBoundingClientRect(), video.getBoundingClientRect());
        if (!surfaceRect) return { status: 'drop' };
        overlaySurface.style.left = `${surfaceRect.left}px`;
        overlaySurface.style.top = `${surfaceRect.top}px`;
        overlaySurface.style.width = `${surfaceRect.width}px`;
        overlaySurface.style.height = `${surfaceRect.height}px`;

        const laneCount = overlayCore.calculateLaneCount(surfaceRect.height);
        if (laneCount <= 0) return { status: 'drop' };
        if (laneStates.length !== laneCount) {
            laneStates = Array.from({ length: laneCount }, (_, index) => laneStates[index] || null);
        }

        const now = performance.now();
        if (activeDanmaku.size >= overlayCore.DANMAKU_MAX_ACTIVE_COMMENTS) {
            const resumeAtMs = laneStates.reduce((earliest, lane) => {
                if (!Number.isFinite(lane?.endTimeMs) || lane.endTimeMs <= now) return earliest;
                return earliest === null || lane.endTimeMs < earliest ? lane.endTimeMs : earliest;
            }, null);
            return { status: resumeAtMs === null ? 'drop' : 'wait', resumeAtMs };
        }

        const node = document.createElement('div');
        node.className = 'liveflow-danmaku';
        node.textContent = normalized.text;
        node.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;font:${overlayCore.DANMAKU_FONT_SIZE_PX}px/${overlayCore.DANMAKU_LINE_HEIGHT_PX}px sans-serif;font-weight:600;color:#fff;text-shadow:0 1px 3px #000;will-change:transform;pointer-events:none;`;
        overlaySurface.appendChild(node);
        const commentWidth = node.getBoundingClientRect().width;
        const speed = overlayCore.calculateDanmakuSpeed({ overlayWidth: surfaceRect.width, commentWidth });
        const nextMotion = { startX: surfaceRect.width, speed };
        const availability = overlayCore.findNextLaneAvailability(laneStates, laneCount, nextMotion, surfaceRect.width, now);
        if (availability.lane < 0) {
            node.remove();
            return Number.isFinite(availability.nextSafeAtMs)
                ? { status: 'wait', resumeAtMs: availability.nextSafeAtMs }
                : { status: 'drop' };
        }
        const lane = availability.lane;
        const motion = overlayCore.calculateDanmakuMotion({
            overlayWidth: surfaceRect.width,
            commentWidth,
            speed,
            startTimeMs: now
        });
        if (!motion || typeof node.animate !== 'function') {
            node.remove();
            return { status: 'drop' };
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
            drainRendererQueue();
        }).catch(() => {
            activeDanmaku.delete(token);
            node.remove();
        });
        return { status: 'rendered' };
    }

    function clearRendererQueue() {
        if (rendererQueueTimer !== null) window.clearTimeout(rendererQueueTimer);
        rendererQueueTimer = null;
        rendererQueueTimerDueAt = null;
        rendererQueue.length = 0;
    }

    function scheduleRendererQueueDrain(dueAtMs) {
        if (!Number.isFinite(dueAtMs)) return;
        if (rendererQueueTimer !== null && Number.isFinite(rendererQueueTimerDueAt) && rendererQueueTimerDueAt <= dueAtMs) return;
        if (rendererQueueTimer !== null) window.clearTimeout(rendererQueueTimer);
        rendererQueueTimerDueAt = dueAtMs;
        rendererQueueTimer = window.setTimeout(() => {
            rendererQueueTimer = null;
            rendererQueueTimerDueAt = null;
            drainRendererQueue();
        }, Math.max(1, Math.ceil(dueAtMs - performance.now())));
    }

    function drainRendererQueue() {
        if (rendererQueueTimer !== null) {
            window.clearTimeout(rendererQueueTimer);
            rendererQueueTimer = null;
            rendererQueueTimerDueAt = null;
        }
        if (!isEffectiveDisplayActive()) {
            clearRendererQueue();
            return;
        }
        const media = getCurrentMainMedia();
        if (!media || !overlayCore?.isPlaybackEligible?.(media.video)) {
            clearRendererQueue();
            return;
        }
        while (rendererQueue.length > 0) {
            const entry = rendererQueue[0];
            const currentMedia = getCurrentMainMedia();
            if (!overlayCore.isRendererTargetCurrent({
                scheduledGeneration: entry.generation,
                currentGeneration: rendererGeneration,
                scheduledVideo: entry.video,
                currentVideo: currentMedia?.video || null,
                currentPlayerOwnsVideo: Boolean(currentMedia)
            }) || entry.pageLifecycleGeneration !== currentPageLifecycleGeneration) {
                rendererQueue.shift();
                continue;
            }
            const now = performance.now();
            if (entry.notBeforeMs > now) {
                scheduleRendererQueueDrain(entry.notBeforeMs);
                return;
            }
            const result = renderDanmaku(entry.message, entry.generation, entry.video);
            if (result.status === 'rendered' || result.status === 'drop') {
                rendererQueue.shift();
                continue;
            }
            scheduleRendererQueueDrain(result.resumeAtMs);
            return;
        }
    }

    function scheduleDanmakuBatch(messages) {
        if (!isEffectiveDisplayActive()) return;
        const media = getCurrentMainMedia();
        if (!media || !overlayCore?.isPlaybackEligible?.(media.video)) {
            clearRendererQueue();
            return;
        }
        const scheduledGeneration = rendererGeneration;
        const scheduledVideo = media.video;
        const availableSlots = Math.max(0, overlayCore.DANMAKU_MAX_RENDER_QUEUE - rendererQueue.length);
        const incoming = Array.isArray(messages) ? messages.slice(0, availableSlots) : [];
        const droppedCount = Array.isArray(messages) ? messages.length - incoming.length : 0;
        if (droppedCount > 0) logInfo(`Renderer queue overflow dropped: ${droppedCount}`);
        const batchStartMs = performance.now();
        const plan = overlayCore.planDanmakuBatch(incoming, incoming.length || 1);
        plan.forEach(({ message, delayMs }) => rendererQueue.push({
            message,
            notBeforeMs: batchStartMs + delayMs,
            generation: scheduledGeneration,
            pageLifecycleGeneration: currentPageLifecycleGeneration,
            video: scheduledVideo
        }));
        drainRendererQueue();
    }

    function handleInitialContinuation(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== RESPONSE_TYPE) return;
        if (!Number.isInteger(event.data.pageRevision) || event.data.pageRevision < minimumAcceptedPageRevision) {
            logInfo('Bridge page-state rejected: reason=stale-revision');
            return;
        }
        if (!Number.isInteger(event.data.pageLifecycleGeneration) || event.data.pageLifecycleGeneration < currentPageLifecycleGeneration) {
            logInfo('Bridge page-state rejected: reason=stale-generation');
            return;
        }

        const previousRevision = currentPageRevision;
        const nextPageKey = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        const pageChanged = Boolean(currentPageKey && currentPageKey !== nextPageKey);
        const continuation = event.data.continuation;
        initialContinuation = typeof continuation === 'string' ? continuation : '';
        internalApiContext = event.data.context && typeof event.data.context === 'object'
            ? event.data.context
            : null;
        currentPageRevision = Number.isInteger(event.data.pageRevision) ? event.data.pageRevision : currentPageRevision;
        currentPageLifecycleGeneration = event.data.pageLifecycleGeneration;
        acceptingReadResults = true;
        logInfo(`New page established: revision=${currentPageRevision}, generation=${currentPageLifecycleGeneration}`);
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
        attachManagementBar();
        if (media && isEffectiveDisplayActive()) attachOverlay(media.player);
        requestReadOnce();
    }

    function requestReadOnce() {
        if (!chatAvailable || !internalApiContext || readRequestedRevision === currentPageRevision) return;
        readRequestedRevision = currentPageRevision;
        window.postMessage({
            source: 'liveflow-content-script',
            type: READ_REQUEST_TYPE,
            pageLifecycleGeneration: currentPageLifecycleGeneration
        }, window.location.origin);
        setReadIndicatorState('active');
    }

    function handleReadResult(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== READ_RESPONSE_TYPE) return;
        if (!acceptingReadResults) {
            logInfo('Bridge READ batch rejected: reason=lifecycle-inactive');
            return;
        }
        if (event.data.pageRevision !== currentPageRevision) {
            logInfo('Bridge READ batch rejected: reason=stale-revision');
            return;
        }
        if (event.data.pageLifecycleGeneration !== currentPageLifecycleGeneration) {
            logInfo('Bridge READ batch rejected: reason=stale-generation');
            return;
        }

        if (!event.data.ok) {
            setReadIndicatorState('stopped');
            const readNumber = event.data.readNumber || 0;
            if (event.data.status === null || event.data.status === undefined) {
                logInfo(`READ #${readNumber} failed: ${event.data.errorType}`);
            } else {
                logInfo(`READ #${readNumber} completed: HTTP ${event.data.status}`);
            }
            return;
        }

        const readNumber = event.data.readNumber || 0;
        setReadIndicatorState('active');
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
        attachManagementBar();
        evaluateNativeChatVisibility();
        requestInitialContinuation();
    }

    function handleNavigation() {
        attachManagementBar();
        requestInitialContinuation();
    }

    function handleNavigationStart() {
        logInfo(`Navigation invalidate: rendererGeneration=${rendererGeneration}, queue=${rendererQueue.length}, active=${activeDanmaku.size}, timer=${rendererQueueTimer !== null}`);
        pageGeneration += 1;
        acceptingReadResults = false;
        minimumAcceptedPageRevision = currentPageRevision + 1;
        clearNativeChatOpenAttempt();
        disconnectNativeChatObserver();
        applyDisplayAction({ type: 'reset-native-chat' });
        cleanupManagementBar();
        setReadIndicatorState('idle');
        cleanupOverlay();
    }

    function handlePageHide() {
        acceptingReadResults = false;
        clearNativeChatOpenAttempt();
        disconnectNativeChatObserver();
        cleanupManagementBar();
        cleanupOverlay();
    }

    function handlePageLifecycleInvalidated(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== NAVIGATION_INVALIDATED_TYPE) return;
        if (!Number.isInteger(event.data.pageRevision) || !Number.isInteger(event.data.pageLifecycleGeneration)) return;
        acceptingReadResults = false;
        minimumAcceptedPageRevision = Math.max(minimumAcceptedPageRevision, event.data.pageRevision);
        currentPageLifecycleGeneration = Math.max(currentPageLifecycleGeneration, event.data.pageLifecycleGeneration);
        initialContinuation = '';
        internalApiContext = null;
        chatAvailable = false;
        readRequestedRevision = -1;
        currentMessages = [];
        cleanupOverlay();
        logInfo(`Page lifecycle invalidated: revision=${event.data.pageRevision}, generation=${event.data.pageLifecycleGeneration}`);
    }

    function handleReadLifecycleDiagnostic(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== LIFECYCLE_DIAGNOSTIC_TYPE) return;
        const allowedEvents = new Set(['NAV_INVALIDATE', 'PAGE_STATE_REJECTED', 'NEW_PAGE_STATE', 'READ_START_REJECTED', 'READ_START', 'READ_REQUEST_BEGIN', 'READ_RESPONSE_RECEIVED', 'READ_STOP']);
        if (!allowedEvents.has(event.data.eventName)) return;
        const lifecycleSignal = ['request', 'yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated'].includes(event.data.lifecycleSignal || event.data.eventSource)
            ? event.data.lifecycleSignal || event.data.eventSource
            : 'unknown';
        logInfo(`READ lifecycle: event=${event.data.eventName}, signal=${lifecycleSignal}, pageRevision=${event.data.pageRevision}, pageGeneration=${event.data.pageLifecycleGeneration}, readGeneration=${event.data.readGeneration}, active=${event.data.readActive}, inFlight=${event.data.requestInFlight}, reason=${event.data.rejectionReason || 'NONE'}, pageDataSeen=${event.data.navigationPageDataUpdated === true}, canReevaluate=${event.data.canReevaluate === true}, targetKnown=${event.data.targetKnown === true}, bootstrapKnown=${event.data.bootstrapKnown === true}, pageTargetChanged=${event.data.pageTargetChanged === true}, bootstrapTargetMatched=${event.data.bootstrapTargetMatched === true}, supportingCandidates=${Number.isInteger(event.data.supportingCandidateCount) ? event.data.supportingCandidateCount : 0}, supportingMatches=${Number.isInteger(event.data.supportingMatchCount) ? event.data.supportingMatchCount : 0}, abortIssued=${event.data.abortIssued === true}, aborted=${event.data.aborted === true}, requestAfterInvalidation=${event.data.requestAfterInvalidation === true}, responseAfterInvalidation=${event.data.responseAfterInvalidation === true}, watchRootChanged=${event.data.watchRootChanged === true}, videoElementChanged=${event.data.videoElementChanged === true}`);
    }

    function handleGeometryChange() {
        if (geometryChangeQueued) return;
        geometryChangeQueued = true;
        window.queueMicrotask(() => {
            geometryChangeQueued = false;
            cleanupOverlay();
            refreshManagementBarPlacement();
        });
    }

    window.addEventListener('message', handleInitialContinuation);
    window.addEventListener('message', handleReadResult);
    window.addEventListener('message', handlePageLifecycleInvalidated);
    window.addEventListener('message', handleReadLifecycleDiagnostic);
    window.addEventListener('yt-navigate-start', handleNavigationStart);
    window.addEventListener('yt-navigate-finish', detectPage);
    window.addEventListener('yt-page-data-updated', handleNavigation);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('resize', handleGeometryChange);
    window.addEventListener('orientationchange', handleGeometryChange);
    document.addEventListener('fullscreenchange', handleGeometryChange);
    window.visualViewport?.addEventListener('resize', handleGeometryChange);
    window.visualViewport?.addEventListener('scroll', handleGeometryChange);

    if (isYouTubeWatchPage()) {
        detectPage();
    }
})();
