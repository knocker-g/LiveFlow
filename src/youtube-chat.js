(function () {
    const LOG_PREFIX = '[LiveFlow PoC]';
    const REQUEST_TYPE = 'LIVEFLOW_REQUEST_INITIAL_CHAT_CONTINUATION';
    const RESPONSE_TYPE = 'LIVEFLOW_INITIAL_CHAT_CONTINUATION';
    const READ_REQUEST_TYPE = 'LIVEFLOW_REQUEST_CHAT_READ_ONCE';
    const READ_RESPONSE_TYPE = 'LIVEFLOW_CHAT_READ_ONCE_RESULT';
    const STOP_READ_LOOP_TYPE = 'LIVEFLOW_STOP_CHAT_READ_LOOP';
    const RESUME_READ_LOOP_TYPE = 'LIVEFLOW_RESUME_CHAT_READ_AFTER_VISIBILITY';
    const NAVIGATION_INVALIDATED_TYPE = 'LIVEFLOW_PAGE_LIFECYCLE_INVALIDATED';
    const LIFECYCLE_DIAGNOSTIC_TYPE = 'LIVEFLOW_READ_LIFECYCLE_DIAGNOSTIC';
    const REPLAY_DISPLAYED_TYPE = 'LIVEFLOW_REPLAY_DANMAKU_DISPLAYED';
    const REPLAY_AD_ENTER_TYPE = 'LIVEFLOW_REPLAY_AD_ENTER';
    const REPLAY_AD_EXIT_TYPE = 'LIVEFLOW_REPLAY_AD_EXIT';
    const REPLAY_PIPELINE_DIAGNOSTIC_TYPE = 'LIVEFLOW_REPLAY_PIPELINE_DIAGNOSTIC';
    const MAX_MESSAGES = 500;
    const MANAGEMENT_BAR_ID = 'liveflow-management-bar';
    const MANAGEMENT_STYLE_ID = 'liveflow-management-bar-style';
    const UI_FALLBACK_MESSAGES = Object.freeze({
        managementBarLabel: 'LiveFlow controls',
        liveFlowOn: 'LiveFlow ON',
        liveFlowOff: 'LiveFlow OFF'
    });
    // Structural integration placeholders only; Phase 5 owns production tuning.
    const PHASE3_UNTUNED_RUNTIME = Object.freeze({
        geometryEpsilon: 1,
        subtitleMargin: 8,
        scanDepth: 5,
        cohortMaximumItems: 5,
        maximumRescueFraction: 0.75,
        attackThresholds: Object.freeze([0.5, 0.75, 0.9]),
        releaseThresholds: Object.freeze([0.2, 0.35, 0.5]),
        minimumAttackResidence: 2,
        releaseDwell: 4,
    });
    let displayLinkSettings = Object.freeze({
        autoEnableLiveFlowWhenNativeChatClosed: true,
        autoOpenNativeChatWhenLiveFlowDisabled: true
    });
    let runtimeSettings = Object.freeze({});
    let persistentSettingsReady = false;
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
    const schedulerRuntimeCore = window.LiveFlowSchedulerRuntime;
    const schedulerFoundations = window.LiveFlowSchedulerFoundations;
    const geometryCore = window.LiveFlowGeometryAdapter;
    const phase5Tuning = window.LiveFlowPhase5Tuning?.CURRENT;
    let overlayRoot = null;
    let overlaySurface = null;
    let laneStates = [];
    const activeDanmaku = new Map();
    let phase3Runtime = null;
    let phase3RuntimeVideo = null;
    let subtitleGeometryAuthority = null;
    let subtitleGeometryAdapter = null;
    let subtitleMutationObserver = null;
    let subtitleResizeObserver = null;
    let subtitleObservedPlayer = null;
    let playbackContextObserver = null;
    let playbackContextObservedPlayer = null;
    let playbackContextWasAd = false;
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
    let currentChatMode = 'unknown';
    let livePresentationResumeGateActive = false;
    let livePresentationAccounting = createLivePresentationAccounting();
    let replaySchedulerDiagnostic = createReplaySchedulerDiagnostic();
    let userEnabled = true;
    let nativeChatVisible = true;
    let nativeChatKnown = false;
    let nativeChatObserver = null;

    function createReplaySchedulerDiagnostic() {
        return {
            pendingCurrent: 0,
            opportunitiesArmed: 0,
            opportunitiesEvaluated: 0,
            stalePruned: 0,
            staleAfterCollision: 0,
            staleAfterPacing: 0,
            staleAfterSelectionMiss: 0,
            staleAlreadyOnEnqueue: 0,
            staleOther: 0,
            selectionNone: 0,
            selectionNoneNoPending: 0,
            selectionNoneCollisionBlocked: 0,
            selectionNoneNoEligible: 0,
            collisionBlocked: 0,
            collisionActiveDanmaku: 0,
            collisionSubtitle: 0,
            collisionCandidateGeometry: 0,
            collisionNoUsableLane: 0,
            collisionOther: 0,
            geometryUnknown: 0,
            generationInvalidated: 0,
            geometryInvalidated: 0,
            launchCommitted: 0,
            launchAttempted: 0,
            launchRejected: 0,
            launchGapClass: 'NONE',
            launchGapCause: 'UNKNOWN',
            launchGapDuePending: false,
            launchGapEligibleCandidate: false,
            launchGapActiveDanmaku: false,
            launchGapCollisionBlocked: false,
            launchGapSchedulerState: 'IDLE',
            launchGapDensityLevel: 'NORMAL',
            schedulerState: 'IDLE'
        };
    }

    function createLivePresentationAccounting() {
        return {
            input: 0,
            enqueued: 0,
            visibilityFiltered: 0,
            enqueueRejected: 0,
            lifecycleSuppressed: 0,
            suppressedPaused: 0,
            suppressedBehindLive: 0,
            suppressedUnknown: 0,
            suppressedOther: 0
        };
    }

    function observeLivePresentationBatch(fields = {}) {
        if (currentChatMode !== 'live') return;
        for (const key of Object.keys(livePresentationAccounting)) {
            const value = fields[key];
            if (Number.isInteger(value) && value >= 0) livePresentationAccounting[key] += value;
        }
    }

    function livePresentationAccountingStatus() {
        const ledger = overlayCore?.computeLivePresentationAccounting?.(livePresentationAccounting) ||
            Object.freeze({ accounted: 0, lostUnaccounted: livePresentationAccounting.input, valid: false });
        return Object.freeze({ ...livePresentationAccounting, ...ledger });
    }

    window.LiveFlowLivePresentationDiagnostic = Object.freeze({ status: livePresentationAccountingStatus });

    let replayLastLaunchAt = null;
    let replayGapCollisionBlocked = false;
    let replayGapSelectionNone = false;
    let replayGapGeometryBlocked = false;
    let replayGapStaleOnly = false;
    let replayGapHadNoDuePeriod = false;

    function resetReplayLaunchGapDiagnostic() {
        replayLastLaunchAt = null;
        replayGapCollisionBlocked = false;
        replayGapSelectionNone = false;
        replayGapGeometryBlocked = false;
        replayGapStaleOnly = false;
        replayGapHadNoDuePeriod = false;
    }

    function classifyReplayLaunchGap(elapsed) {
        return schedulerRuntimeCore?.classifyLaunchGapClass?.(elapsed) || 'NONE';
    }

    function updateReplayLaunchGap(status, completed = false) {
        if (replayLastLaunchAt === null) return;
        replaySchedulerDiagnostic.launchGapClass = classifyReplayLaunchGap(performance.now() - replayLastLaunchAt);
        replaySchedulerDiagnostic.launchGapDuePending = (status?.pendingCount || 0) > 0;
        replaySchedulerDiagnostic.launchGapEligibleCandidate = completed === true;
        replaySchedulerDiagnostic.launchGapActiveDanmaku = activeDanmaku.size > 0;
        replaySchedulerDiagnostic.launchGapCollisionBlocked = replayGapCollisionBlocked;
        replaySchedulerDiagnostic.launchGapSchedulerState = ['IDLE', 'ARMED', 'EVALUATING'].includes(status?.state) ? status.state : 'IDLE';
        replaySchedulerDiagnostic.launchGapDensityLevel = ['NORMAL', 'COMPACT', 'DENSE', 'MAX_READABLE'].includes(status?.density) ? status.density : 'NORMAL';
        replaySchedulerDiagnostic.launchGapCause = schedulerRuntimeCore?.classifyLaunchGapCause?.({
            pendingCount: replayGapHadNoDuePeriod ? 0 : status?.pendingCount || 0,
            geometryBlocked: replayGapGeometryBlocked,
            collisionBlocked: replayGapCollisionBlocked,
            selectionNone: replayGapSelectionNone,
            staleOnly: replayGapStaleOnly
        }) || 'UNKNOWN';
    }

    function publishReplaySchedulerDiagnostic() {
        if (currentChatMode !== 'replay') return;
        window.postMessage({
            source: 'liveflow-content-script',
            type: REPLAY_PIPELINE_DIAGNOSTIC_TYPE,
            pageLifecycleGeneration: currentPageLifecycleGeneration,
            scheduler: { ...replaySchedulerDiagnostic }
        }, window.location.origin);
    }

    function observeReplayScheduler(event) {
        if (!event || typeof event.type !== 'string') return;
        if (event.type === 'ARMED') replaySchedulerDiagnostic.opportunitiesArmed += 1;
        if (event.type === 'EVALUATING') replaySchedulerDiagnostic.opportunitiesEvaluated += 1;
        if (event.type === 'STALE_PRUNED') {
            replaySchedulerDiagnostic.stalePruned += Number.isInteger(event.count) ? event.count : 0;
            replaySchedulerDiagnostic.staleAfterCollision += event.staleReasons?.collisionBlocked || 0;
            replaySchedulerDiagnostic.staleAfterPacing += event.staleReasons?.pacingWait || 0;
            replaySchedulerDiagnostic.staleAfterSelectionMiss += event.staleReasons?.selectionMiss || 0;
            replaySchedulerDiagnostic.staleAlreadyOnEnqueue += event.staleReasons?.alreadyStaleOnEnqueue || 0;
            replaySchedulerDiagnostic.staleOther += event.staleReasons?.other || 0;
            replayGapStaleOnly = true;
        }
        if (event.type === 'SELECTION_NONE') {
            replaySchedulerDiagnostic.selectionNone += 1;
            if ((event.pendingCount || 0) === 0) replaySchedulerDiagnostic.selectionNoneNoPending += 1;
            else if (replayGapCollisionBlocked) replaySchedulerDiagnostic.selectionNoneCollisionBlocked += 1;
            else replaySchedulerDiagnostic.selectionNoneNoEligible += 1;
            replayGapSelectionNone = true;
        }
        if (event.type === 'COLLISION_BLOCKED') {
            replaySchedulerDiagnostic.collisionBlocked += 1;
            replayGapCollisionBlocked = true;
        }
        if (event.type === 'COLLISION_ACTIVE_DANMAKU') replaySchedulerDiagnostic.collisionActiveDanmaku += 1;
        if (event.type === 'COLLISION_SUBTITLE') replaySchedulerDiagnostic.collisionSubtitle += 1;
        if (event.type === 'COLLISION_CANDIDATE_GEOMETRY') replaySchedulerDiagnostic.collisionCandidateGeometry += 1;
        if (event.type === 'COLLISION_NO_USABLE_LANE') replaySchedulerDiagnostic.collisionNoUsableLane += 1;
        if (event.type === 'COLLISION_OTHER') replaySchedulerDiagnostic.collisionOther += 1;
        if (event.type === 'GEOMETRY_UNKNOWN') { replaySchedulerDiagnostic.geometryUnknown += 1; replayGapGeometryBlocked = true; }
        if (event.type === 'GENERATION_INVALIDATED') replaySchedulerDiagnostic.generationInvalidated += 1;
        if (event.type === 'GEOMETRY_INVALIDATED') replaySchedulerDiagnostic.geometryInvalidated += 1;
        if (event.type === 'LAUNCH_COMMITTED') replaySchedulerDiagnostic.launchCommitted += 1;
        if (event.type === 'LAUNCH_ATTEMPTED') replaySchedulerDiagnostic.launchAttempted += 1;
        if (event.type === 'LAUNCH_REJECTED') replaySchedulerDiagnostic.launchRejected += 1;
        const status = phase3Runtime?.status?.();
        updateReplayLaunchGap(status, event.type === 'LAUNCH_COMMITTED');
        if (event.type === 'LAUNCH_COMMITTED') {
            replayGapHadNoDuePeriod = (status?.pendingCount || 0) === 0;
            replayLastLaunchAt = performance.now();
            replayGapCollisionBlocked = false;
            replayGapSelectionNone = false;
            replayGapGeometryBlocked = false;
            replayGapStaleOnly = false;
        }
        replaySchedulerDiagnostic.pendingCurrent = Number.isInteger(status?.pendingCount) ? status.pendingCount :
            Number.isInteger(event.pendingCount) ? event.pendingCount : replaySchedulerDiagnostic.pendingCurrent;
        replaySchedulerDiagnostic.schedulerState = ['IDLE', 'ARMED', 'EVALUATING'].includes(status?.state)
            ? status.state : ['IDLE', 'ARMED', 'EVALUATING'].includes(event.state) ? event.state : replaySchedulerDiagnostic.schedulerState;
        publishReplaySchedulerDiagnostic();
    }
    let observedWatchRoot = null;
    let visibilityEvaluationQueued = false;
    let managementAttachmentTask = null;
    let managementBar = null;
    let managementToggleButton = null;
    let managementToggleLabel = null;
    let managementReadIndicator = null;
    let readIndicatorState = 'idle';
    let nativeChatOpenAttempt = null;

    function logInfo(message) {
        console.log(`${LOG_PREFIX} ${message}`);
    }

    function getUiMessage(key) {
        return overlayCore.getLocalizedMessage(globalThis.chrome?.i18n, key, UI_FALLBACK_MESSAGES[key]);
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
        internalApiContext = null;
        chatAvailable = false;
        readRequestedRevision = -1;
        currentMessages = [];
        currentPageKey = '';
        currentChatMode = 'unknown';
        livePresentationResumeGateActive = false;
        livePresentationAccounting = createLivePresentationAccounting();
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
        phase3Runtime?.clear();
        phase3Runtime = null;
        phase3RuntimeVideo = null;
        disconnectSubtitleGeometryObservers();
        laneStates = [];
        overlayRoot?.remove();
        overlayRoot = null;
        overlaySurface = null;
    }

    function isEffectiveDisplayActive() {
        return overlayCore?.isEffectiveDisplayActive?.({ userEnabled, nativeChatVisible }) === true;
    }

    function applyDisplayAction(action) {
        const wasUserEnabled = userEnabled;
        const transition = overlayCore.reduceDisplayState(
            { userEnabled, nativeChatVisible, nativeChatKnown },
            action,
            displayLinkSettings
        );
        userEnabled = transition.userEnabled;
        nativeChatVisible = transition.nativeChatVisible;
        nativeChatKnown = transition.nativeChatKnown;
        if (nativeChatVisible && nativeChatOpenAttempt) {
            logInfo('Native Chat open confirmation: observerTransition=true, result=confirmed');
            clearNativeChatOpenAttempt();
        }
        if (transition.cleanupRequired) cleanupOverlay();
        if (wasUserEnabled && !userEnabled) {
            currentMessages = [];
        }
        if (action?.type === 'set-user-enabled' && wasUserEnabled !== userEnabled) {
            persistDisplayDefault(userEnabled);
        }
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

    function nodeAffectsManagementPlacement(node) {
        if (node?.nodeType !== 1) return false;
        const selector = `${PLAYER_SELECTORS.player}, ${PLAYER_SELECTORS.video}, ${PLAYER_SELECTORS.nativeChat}, ${PLAYER_SELECTORS.belowPlayer}`;
        return node.matches?.(selector) === true || Boolean(node.querySelector?.(selector));
    }

    function mutationAffectsManagementPlacement(mutation) {
        return mutation.type === 'childList' &&
            [...mutation.addedNodes, ...mutation.removedNodes].some(nodeAffectsManagementPlacement);
    }

    function observeNativeChat(watchRoot) {
        if (watchRoot === observedWatchRoot && nativeChatObserver) return;
        nativeChatObserver?.disconnect();
        nativeChatObserver = null;
        observedWatchRoot = watchRoot || null;
        if (!watchRoot) return;
        nativeChatObserver = new MutationObserver((mutations) => {
            const nativeChatChanged = mutations.some(mutationAffectsNativeChat);
            const managementPlacementChanged = mutations.some(mutationAffectsManagementPlacement);
            if (nativeChatChanged) scheduleNativeChatVisibilityEvaluation();
            if (managementPlacementChanged) scheduleManagementBarAttachment(watchRoot);
        });
        nativeChatObserver.observe(watchRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['hidden', 'style', 'class', 'collapsed', 'aria-hidden']
        });
        scheduleManagementBarAttachment(watchRoot);
    }

    function disconnectNativeChatObserver() {
        nativeChatObserver?.disconnect();
        nativeChatObserver = null;
        observedWatchRoot = null;
        visibilityEvaluationQueued = false;
        managementAttachmentTask = null;
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
        const ownedChatContainer = watchRoot.querySelector('#chat-container');
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
            const showHideButton = element.closest('#show-hide-button');
            const associatedWithNativeChat = Boolean(
                frame?.contains(element) || chatContainer?.contains(element)
            );
            const candidate = {
                element,
                strategy,
                associatedWithNativeChat,
                belongsToCurrentWatchRoot: watchRoot.contains(element),
                nativeChatClosed: true,
                insideChatContainer: Boolean(ownedChatContainer?.contains(element)),
                insideLiveChatFrame: Boolean(frame?.contains(element)),
                descendantOfShowHideButton: Boolean(showHideButton && frame?.contains(showHideButton)),
                actualButton: element.tagName === 'BUTTON',
                hiddenAttribute: element.hidden === true || element.hasAttribute('hidden'),
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
        if (attemptGeneration !== pageGeneration || document.querySelector(PLAYER_SELECTORS.watchRoot) !== watchRoot ||
            !watchRoot.contains(button) || readNativeChatVisibility(watchRoot) !== false) {
            logInfo('Native Chat open attempt: started=true, clickIssued=false, result=stale-or-open');
            return false;
        }
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
            .liveflow-danmaku { display: inline-flex; align-items: center; gap: 6px; max-width: none; white-space: nowrap; }
            .liveflow-danmaku-avatar { flex: 0 0 22px; width: 22px; height: 22px; border-radius: 50%; object-fit: cover; }
            .liveflow-danmaku-author { flex: 0 0 auto; font-weight: 700; }
            .liveflow-danmaku-message { flex: 0 0 auto; min-width: 0; overflow: visible; text-overflow: clip; white-space: nowrap; }
            .liveflow-danmaku-emoji { width: 1.2em; height: 1.2em; object-fit: contain; vertical-align: middle; }
            .liveflow-danmaku-special { box-sizing: border-box; display: flex; flex-direction: column; align-items: stretch; gap: 2px; width: max-content; min-width: 180px; min-height: 68px; height: auto; padding: 4px 8px; overflow: visible; border-radius: 8px; background: rgba(24,24,24,.8); color: #fff; }
            .liveflow-danmaku-special-header, .liveflow-danmaku-special-body { display: flex; min-width: 0; align-items: center; gap: 6px; }
            .liveflow-danmaku-special-header { flex: 0 0 28px; white-space: nowrap; }
            .liveflow-danmaku-special-body { flex: 1 1 28px; overflow: visible; white-space: nowrap; }
            .liveflow-danmaku-special .liveflow-danmaku-message { flex: 0 0 auto; overflow: visible; text-overflow: clip; white-space: nowrap; overflow-wrap: normal; }
            .liveflow-danmaku-special .liveflow-danmaku-author { flex: 0 0 auto; min-width: 0; overflow: visible; text-overflow: clip; white-space: nowrap; color: #fff; }
            .liveflow-danmaku-amount { flex: 0 0 auto; white-space: nowrap; padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,.25); color: #fff; font-weight: 700; }
            .liveflow-danmaku-sticker { flex: 0 0 32px; width: 32px; height: 32px; object-fit: contain; }
            .liveflow-danmaku[data-author-role="guest"] { color: #fff; -webkit-text-stroke: 1.1px #202020; paint-order: stroke fill; }
            .liveflow-danmaku[data-author-role="member"] { color: #66e08a; -webkit-text-stroke: .45px #12381d; }
            .liveflow-danmaku[data-author-role="moderator"] { color: #70b7ff; -webkit-text-stroke: .45px #183b5c; }
            .liveflow-danmaku[data-author-role="owner"] { color: #ffd75e; -webkit-text-stroke: .45px #564813; }
            .liveflow-danmaku.liveflow-danmaku-special { -webkit-text-stroke: .8px rgba(0,0,0,.85); paint-order: stroke fill; }
            .liveflow-danmaku img { -webkit-text-stroke: 0; }
            @keyframes liveflow-read-indicator { from { opacity: .35; } to { opacity: 1; } }
            @media (prefers-reduced-motion: reduce) {
                #${MANAGEMENT_BAR_ID}[data-read-state="active"] .liveflow-read-indicator { animation: none; }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function updateManagementBar() {
        if (!managementBar) return;
        const view = overlayCore.getManagementBarViewModel({
            userEnabled,
            readState: readIndicatorState,
            enabledLabel: getUiMessage('liveFlowOn'),
            disabledLabel: getUiMessage('liveFlowOff')
        });
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
        bar.setAttribute('aria-label', getUiMessage('managementBarLabel'));

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

        bar.append(toggle, indicator);
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

    function applyPersistentSettings(settings, { initializeDisplay = false } = {}) {
        const snapshot = window.LiveFlowSettingsCore?.createSettingsSnapshot?.(settings);
        if (!snapshot) return;
        const fontMetricsChanged = runtimeSettings.fontSizeMode !== snapshot.fontSizeMode ||
            runtimeSettings.fontScalePercent !== snapshot.fontScalePercent;
        runtimeSettings = snapshot;
        if (initializeDisplay) userEnabled = snapshot.displayEnabled === true;
        displayLinkSettings = Object.freeze({
            autoEnableLiveFlowWhenNativeChatClosed: snapshot.autoEnableLiveFlowWhenNativeChatClosed,
            autoOpenNativeChatWhenLiveFlowDisabled: snapshot.autoOpenNativeChatWhenLiveFlowDisabled
        });
        if (overlaySurface) overlaySurface.style.opacity = String(snapshot.opacityPercent / 100);
        if (fontMetricsChanged) phase3Runtime?.markGeometryDirty(geometryCore.DIRTY_SIGNALS.FONT_METRICS);
    }

    function persistDisplayDefault(value) {
        const settingsCore = window.LiveFlowSettingsCore;
        const storageArea = globalThis.chrome?.storage?.local;
        if (!settingsCore || typeof value !== 'boolean') return;
        settingsCore.updateSettings(storageArea, runtimeSettings, { displayEnabled: value })
            .then(applyPersistentSettings);
    }

    function initializePersistentSettings() {
        const settingsCore = window.LiveFlowSettingsCore;
        const storageArea = globalThis.chrome?.storage?.local;
        if (!settingsCore) {
            persistentSettingsReady = true;
            return Promise.resolve();
        }
        globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
            if (areaName !== 'local' || !changes?.[settingsCore.STORAGE_KEY]) return;
            applyPersistentSettings(changes[settingsCore.STORAGE_KEY].newValue);
        });
        return settingsCore.getStoredSettings(storageArea).then((settings) => {
            applyPersistentSettings(settings, { initializeDisplay: true });
            persistentSettingsReady = true;
        });
    }

    function refreshManagementBarPlacement() {
        attachManagementBar();
    }

    function scheduleManagementBarAttachment(watchRoot) {
        if (!watchRoot || managementAttachmentTask) return;
        const task = { watchRoot, pageGeneration };
        managementAttachmentTask = task;
        window.queueMicrotask(() => {
            if (managementAttachmentTask !== task) return;
            managementAttachmentTask = null;
            if (task.pageGeneration !== pageGeneration || !isYouTubeWatchPage() ||
                !task.watchRoot.isConnected || document.querySelector(PLAYER_SELECTORS.watchRoot) !== task.watchRoot) return;
            attachManagementBar();
        });
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
        overlaySurface.style.opacity = String((runtimeSettings.opacityPercent ?? 80) / 100);
        overlayRoot.appendChild(overlaySurface);
        player.appendChild(overlayRoot);
        ensureSubtitleGeometryObservers(player);
        subtitleGeometryAdapter?.markDirty(geometryCore.DIRTY_SIGNALS.VIDEO_GEOMETRY);
        logInfo('Overlay attached');
        return true;
    }

    function applyOverlaySurfaceRect(surfaceRect) {
        if (!overlayRoot?.isConnected || !overlaySurface?.isConnected || !surfaceRect ||
            ![surfaceRect.left, surfaceRect.top, surfaceRect.width, surfaceRect.height].every(Number.isFinite) ||
            surfaceRect.width <= 0 || surfaceRect.height <= 0) return false;
        overlaySurface.style.left = `${surfaceRect.left}px`;
        overlaySurface.style.top = `${surfaceRect.top}px`;
        overlaySurface.style.width = `${surfaceRect.width}px`;
        overlaySurface.style.height = `${surfaceRect.height}px`;
        return true;
    }

    function readSubtitleGeometry() {
        const media = getCurrentMainMedia();
        if (!media || !geometryCore) {
            return Object.freeze({ state: 'UNKNOWN', exclusionRegions: Object.freeze([]), capabilityAvailable: false });
        }
        const videoRect = media.video.getBoundingClientRect();
        const selectors = '.ytp-caption-segment, .ytp-caption-window-container .captions-text';
        const candidates = Array.from(media.player.querySelectorAll(selectors)).map((element) => {
            const style = window.getComputedStyle(element);
            return {
                visible: element.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0,
                rect: element.getBoundingClientRect()
            };
        });
        return geometryCore.computeSubtitleGeometry({
            candidates,
            videoRect: { x: videoRect.left, y: videoRect.top, width: videoRect.width, height: videoRect.height },
            safetyMargin: PHASE3_UNTUNED_RUNTIME.subtitleMargin
        });
    }

    function isCaptionTrackEnabled(player) {
        return player?.querySelector?.('.ytp-subtitles-button[aria-pressed="true"]') !== null;
    }

    function disconnectSubtitleGeometryObservers() {
        subtitleMutationObserver?.disconnect();
        subtitleResizeObserver?.disconnect();
        subtitleMutationObserver = null;
        subtitleResizeObserver = null;
        subtitleObservedPlayer = null;
    }

    function ensureSubtitleGeometryObservers(player) {
        if (!player || subtitleObservedPlayer === player) return;
        disconnectSubtitleGeometryObservers();
        subtitleObservedPlayer = player;
        if (typeof MutationObserver === 'function') {
            subtitleMutationObserver = new MutationObserver(() => subtitleGeometryAdapter?.markDirty(geometryCore.DIRTY_SIGNALS.MUTATION));
            subtitleMutationObserver.observe(player, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-pressed'] });
        }
        if (typeof ResizeObserver === 'function') {
            subtitleResizeObserver = new ResizeObserver(() => subtitleGeometryAdapter?.markDirty(geometryCore.DIRTY_SIGNALS.RESIZE));
            subtitleResizeObserver.observe(player);
            const media = getCurrentMainMedia();
            if (media?.video) subtitleResizeObserver.observe(media.video);
        }
    }

    function isAdPlaybackActive(player) {
        return player?.classList?.contains('ad-showing') === true || player?.classList?.contains('ad-interrupting') === true;
    }

    function ensurePlaybackContextObserver(player) {
        if (!player || playbackContextObservedPlayer === player) return;
        playbackContextObserver?.disconnect();
        playbackContextObservedPlayer = player;
        playbackContextWasAd = isAdPlaybackActive(player);
        if (playbackContextWasAd) {
            window.postMessage({ source: 'liveflow-content-script', type: REPLAY_AD_ENTER_TYPE }, window.location.origin);
        }
        if (typeof MutationObserver !== 'function') return;
        playbackContextObserver = new MutationObserver(() => {
            const adActive = isAdPlaybackActive(player);
            if (adActive === playbackContextWasAd) return;
            playbackContextWasAd = adActive;
            cleanupOverlay();
            window.postMessage({
                source: 'liveflow-content-script',
                type: adActive ? REPLAY_AD_ENTER_TYPE : REPLAY_AD_EXIT_TYPE
            }, window.location.origin);
        });
        playbackContextObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    }

    function createDanmakuNode(normalized, settingsSnapshot = runtimeSettings) {
        const node = document.createElement('div');
        node.className = 'liveflow-danmaku';
        node.dataset.authorRole = normalized.authorRole;
        const fontScale = settingsSnapshot.fontSizeMode === 'manual' ? settingsSnapshot.fontScalePercent / 100 : 1;
        const fontSize = phase5Tuning.fontSize * fontScale;
        const lineHeight = phase5Tuning.lineHeight * fontScale;
        node.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;font:${fontSize}px/${lineHeight}px sans-serif;font-weight:600;will-change:transform;pointer-events:none;`;
        const special = normalized.messageType === 'superChat' || normalized.messageType === 'superSticker';
        if (special) {
            node.classList.add('liveflow-danmaku-special');
            node.dataset.messageType = normalized.messageType;
            const backgroundColor = normalized.colors.bodyBackgroundColor || normalized.colors.backgroundColor || normalized.colors.headerBackgroundColor;
            node.style.backgroundColor = overlayCore.withCssColorAlpha(backgroundColor, 0.8) || 'rgba(24, 24, 24, 0.8)';
            node.style.color = '#FFFFFF';
        }
        const specialHeader = special ? document.createElement('div') : null;
        const specialBody = special ? document.createElement('div') : null;
        if (specialHeader && specialBody) {
            specialHeader.className = 'liveflow-danmaku-special-header';
            specialBody.className = 'liveflow-danmaku-special-body';
            node.append(specialHeader, specialBody);
        }
        const headerTarget = specialHeader || node;
        const bodyTarget = specialBody || node;
        if (overlayCore.shouldRenderAvatar(normalized, settingsSnapshot)) {
            const avatar = document.createElement('img');
            avatar.className = 'liveflow-danmaku-avatar';
            avatar.alt = '';
            avatar.src = normalized.authorPhoto;
            avatar.width = 22;
            avatar.height = 22;
            headerTarget.appendChild(avatar);
        }
        if (special && normalized.authorName) {
            const author = document.createElement('span');
            author.className = 'liveflow-danmaku-author';
            author.textContent = normalized.authorName;
            headerTarget.appendChild(author);
        }
        if (special && normalized.purchaseAmountText) {
            const amount = document.createElement('span');
            amount.className = 'liveflow-danmaku-amount';
            amount.textContent = normalized.purchaseAmountText;
            if (normalized.colors.moneyChipBackgroundColor) amount.style.backgroundColor = normalized.colors.moneyChipBackgroundColor;
            headerTarget.appendChild(amount);
        }
        if (normalized.messageType === 'superSticker' && normalized.sticker?.url) {
            const sticker = document.createElement('img');
            sticker.className = 'liveflow-danmaku-sticker';
            sticker.src = normalized.sticker.url;
            sticker.alt = normalized.sticker.alt;
            sticker.width = 32;
            sticker.height = 32;
            bodyTarget.appendChild(sticker);
        }
        const content = document.createElement('span');
        content.className = 'liveflow-danmaku-message';
        for (const run of overlayCore.getRenderableMessageRuns(normalized, settingsSnapshot)) {
            if (run.type === 'text') content.appendChild(document.createTextNode(run.text));
            if (run.type === 'image') {
                const image = document.createElement('img');
                image.className = 'liveflow-danmaku-emoji';
                image.src = run.url;
                image.alt = run.alt;
                image.width = 29;
                image.height = 29;
                content.appendChild(image);
            }
        }
        if (content.childNodes.length > 0) bodyTarget.appendChild(content);
        return node;
    }

    function applySpecialFit(node, surfaceWidth) {
        if (!node?.classList?.contains('liveflow-danmaku-special')) return { result: 'FIT' };
        const header = node.querySelector('.liveflow-danmaku-special-header');
        const body = node.querySelector('.liveflow-danmaku-special-body');
        const message = node.querySelector('.liveflow-danmaku-message');
        if (!header || !body || !message || !Number.isFinite(surfaceWidth) || surfaceWidth <= 0) return null;
        const maximumWidth = Math.min(surfaceWidth * phase5Tuning.specialMaximumWidthFraction, phase5Tuning.specialMaximumWidthPx);
        node.style.maxWidth = 'none';
        message.style.fontSize = '';
        const baseBodyFontSize = Number.parseFloat(window.getComputedStyle(message).fontSize);
        const fit = schedulerFoundations.computeSpecialSingleLineFit({
            headerNaturalWidth: header.scrollWidth,
            bodyNaturalWidth: body.scrollWidth,
            maximumWidth,
            baseBodyFontSize,
            minimumBodyFontSize: phase5Tuning.specialMinimumBodyFontSize
        });
        if (!fit || fit.result === 'UNREPRESENTABLE_SPECIAL') return fit;
        node.style.maxWidth = `${maximumWidth}px`;
        if (fit.result === 'SCALED') message.style.fontSize = `${fit.bodyFontSize}px`;
        return fit;
    }

    function getCandidateProof(entry, geometryState, densityPolicy) {
        const media = getCurrentMainMedia();
        if (!media || !overlayCore.isMainContentPlaybackEligible(media.player, media.video)) return { blockedReason: 'OTHER' };
        const normalized = overlayCore.normalizeDanmakuMessage(entry.payload.message);
        if (!normalized) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
        entry.payload.settingsSnapshot = runtimeSettings;
        const playerRect = media.player.getBoundingClientRect();
        const videoRect = media.video.getBoundingClientRect();
        const surface = overlayCore.calculateVideoSurfaceRect(playerRect, videoRect);
        if (!surface) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
        if (!attachOverlay(media.player) || !overlaySurface) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
        if (!applyOverlaySurfaceRect(surface)) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
        const probe = createDanmakuNode(normalized, entry.payload.settingsSnapshot);
        overlaySurface.appendChild(probe);
        const specialFit = applySpecialFit(probe, surface.width);
        if (specialFit?.result === 'UNREPRESENTABLE_SPECIAL') {
            probe.remove();
            return { unrepresentableSpecial: true };
        }
        if (!specialFit) {
            probe.remove();
            return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
        }
        const measured = probe.getBoundingClientRect();
        probe.remove();
        const metrics = overlayCore.createRenderedTextMetrics(normalized.text, measured.width);
        const width = metrics?.renderedWidth;
        const height = measured.height;
        if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
        const laneSpan = 1;
        const laneCount = overlayCore.calculateLaneCount(surface.height, phase5Tuning.lineHeight, phase5Tuning.laneGap);
        const playbackRate = currentChatMode === 'replay' ? media.video.playbackRate : 1;
        const baseDuration = overlayCore.calculateCompensatedDanmakuDuration(surface.width, width);
        const factor = currentChatMode === 'replay' ? overlayCore.calculateReplayPlaybackRateFactor(playbackRate) : 1;
        const baseVelocity = overlayCore.calculateDanmakuSpeed({
            overlayWidth: surface.width,
            commentWidth: width,
            targetDurationMs: baseDuration && factor ? baseDuration * factor : null,
            minSpeed: phase5Tuning.minimumSpeed * playbackRate,
            maxSpeed: phase5Tuning.maximumSpeed * playbackRate
        });
        const velocity = window.LiveFlowPhase5Tuning.applyLengthAwareVelocity(baseVelocity, width, surface.width,
            phase5Tuning.lengthVelocity, phase5Tuning.maximumSpeed * playbackRate);
        if (!Number.isFinite(velocity)) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
        const now = performance.now();
        const activeComments = Array.from(activeDanmaku.values(), ({ trajectory }) => trajectory ? ({
            x: trajectory.startX - trajectory.velocity * Math.max(0, now - trajectory.startTimeMs) / 1000,
            y: trajectory.y,
            width: trajectory.width,
            height: trajectory.height,
            velocity: trajectory.velocity,
            anchorIndex: trajectory.anchorIndex
        }) : null).filter(Boolean);
        const usableLaneCount = Math.max(0, laneCount - laneSpan + 1);
        if (usableLaneCount === 0) return { blockedReason: 'NO_USABLE_LANE' };
        const captionsEnabled = isCaptionTrackEnabled(media.player);
        const reservedBottomLaneStart = captionsEnabled ? Math.max(0, laneCount - 2) : laneCount;
        const primaryCandidates = [];
        for (let lane = 0; lane <= laneCount - laneSpan; lane += 1) {
            if (lane >= reservedBottomLaneStart) continue;
            const candidateGeometry = geometryCore.normalizeCandidateGeometry({
                renderedRect: {
                    x: videoRect.right - width,
                    y: videoRect.top + lane * (phase5Tuning.lineHeight + phase5Tuning.laneGap),
                    width,
                    height
                },
                videoRect: { x: videoRect.left, y: videoRect.top, width: videoRect.width, height: videoRect.height },
                actualVelocity: velocity,
                footprint: entry.footprint
            });
            if (candidateGeometry.safe && schedulerFoundations.isOutsideHardExclusions(candidateGeometry.rectangle, geometryState.exclusionRegions)) {
                primaryCandidates.push(Object.freeze({ rectangle: candidateGeometry.rectangle, lane, anchorIndex: lane * 2, laneSpan, specialFit }));
            }
        }
        if (primaryCandidates.length === 0) return { blockedReason: geometryState.exclusionRegions.length ? 'SUBTITLE_EXCLUSION' : 'CANDIDATE_GEOMETRY_INVALID' };
        const band = schedulerFoundations.selectDensityLaneBand(primaryCandidates, densityPolicy, phase5Tuning.laneBandFractions);
        const secondaryCandidates = [];
        const stride = phase5Tuning.interleavedAnchorStride[densityPolicy.density] || 0;
        if (stride > 0) {
            for (let lane = 0; lane + 1 < band.length; lane += stride) {
                const y = videoRect.top + (band[lane].lane + 0.5) * (phase5Tuning.lineHeight + phase5Tuning.laneGap);
                const candidateGeometry = geometryCore.normalizeCandidateGeometry({
                    renderedRect: { x: videoRect.right - width, y, width, height },
                    videoRect: { x: videoRect.left, y: videoRect.top, width: videoRect.width, height: videoRect.height },
                    actualVelocity: velocity,
                    footprint: entry.footprint
                });
                if (candidateGeometry.safe && schedulerFoundations.isOutsideHardExclusions(candidateGeometry.rectangle, geometryState.exclusionRegions)) {
                    secondaryCandidates.push(Object.freeze({ rectangle: candidateGeometry.rectangle, lane: band[lane].lane + 0.5,
                        anchorIndex: band[lane].anchorIndex + 1, laneSpan, specialFit, interleaved: true }));
                }
            }
        }
        return { candidates: window.LiveFlowPhase5Tuning.rankDensityRescuePlacements(
            band, secondaryCandidates, activeComments, entry.id, densityPolicy.density
        ), activeComments };
    }

    function ensurePhase3Runtime() {
        if (phase3Runtime) return phase3Runtime;
        if (!schedulerRuntimeCore || !geometryCore) return null;
        subtitleGeometryAuthority = geometryCore.createGeometryAuthority({ epsilon: PHASE3_UNTUNED_RUNTIME.geometryEpsilon });
        subtitleGeometryAdapter = geometryCore.createSubtitleGeometryAdapter({
            authority: subtitleGeometryAuthority,
            readGeometry: readSubtitleGeometry
        });
        subtitleGeometryAdapter.refresh();
        phase3Runtime = schedulerRuntimeCore.createSchedulerRuntime({
            clock: () => performance.now(),
            scheduleOneShot: (callback, delay) => window.setTimeout(callback, Math.max(0, Math.ceil(delay))),
            cancelOneShot: (timer) => window.clearTimeout(timer),
            generation: () => rendererGeneration,
            geometryAdapter: subtitleGeometryAdapter,
            candidateProof: getCandidateProof,
            launch: (entry, proof) => renderDanmaku(entry.message, entry.generation, entry.video, proof, entry.settingsSnapshot).status === 'rendered',
            observe: observeReplayScheduler,
            config: {
                maxPendingAge: overlayCore.DANMAKU_TARGET_DURATION_MS,
                maxPendingCount: overlayCore.DANMAKU_MAX_RENDER_QUEUE,
                pendingPressureCapacity: overlayCore.DANMAKU_MAX_RENDER_QUEUE,
                scanDepth: PHASE3_UNTUNED_RUNTIME.scanDepth,
                cohortMaximumItems: PHASE3_UNTUNED_RUNTIME.cohortMaximumItems,
                cohortMaximumSpan: overlayCore.DANMAKU_MAX_BATCH_SPREAD_MS,
                pacing: {
                    userBaseInterval: overlayCore.DANMAKU_DEFAULT_LAUNCH_CADENCE_MS,
                    minimumInterval: overlayCore.DANMAKU_MIN_LAUNCH_CADENCE_MS,
                    maximumRescueFraction: PHASE3_UNTUNED_RUNTIME.maximumRescueFraction
                },
                density: {
                    attackThresholds: PHASE3_UNTUNED_RUNTIME.attackThresholds,
                    releaseThresholds: PHASE3_UNTUNED_RUNTIME.releaseThresholds,
                    minimumAttackResidence: PHASE3_UNTUNED_RUNTIME.minimumAttackResidence,
                    releaseDwell: PHASE3_UNTUNED_RUNTIME.releaseDwell
                },
                collisionAllowances: phase5Tuning.collisionAllowances
            }
        });
        phase3RuntimeVideo = getCurrentMainMedia()?.video || null;
        return phase3Runtime;
    }

    function renderDanmaku(message, scheduledGeneration = rendererGeneration, scheduledVideo = null, launchProof = null,
        settingsSnapshot = runtimeSettings) {
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
        if (!overlayCore.isMainContentPlaybackEligible(player, video)) return { status: 'drop' };
        if (!attachOverlay(player) || !overlayRoot || !overlaySurface) return { status: 'drop' };
        const normalized = overlayCore.normalizeDanmakuMessage(message);
        if (!normalized) return { status: 'drop' };

        const surfaceRect = overlayCore.calculateVideoSurfaceRect(player.getBoundingClientRect(), video.getBoundingClientRect());
        if (!surfaceRect) return { status: 'drop' };
        if (!applyOverlaySurfaceRect(surfaceRect)) return { status: 'drop' };

        const laneCount = overlayCore.calculateLaneCount(surfaceRect.height, phase5Tuning.lineHeight, phase5Tuning.laneGap);
        if (laneCount <= 0) return { status: 'drop' };
        const anchorCount = Math.max(1, laneCount * 2 - 1);
        if (laneStates.length !== anchorCount) {
            laneStates = Array.from({ length: anchorCount }, (_, index) => laneStates[index] || null);
        }

        const now = performance.now();
        if (activeDanmaku.size >= overlayCore.DANMAKU_MAX_ACTIVE_COMMENTS) {
            const resumeAtMs = laneStates.reduce((earliest, lane) => {
                if (!Number.isFinite(lane?.endTimeMs) || lane.endTimeMs <= now) return earliest;
                return earliest === null || lane.endTimeMs < earliest ? lane.endTimeMs : earliest;
            }, null);
            return { status: resumeAtMs === null ? 'drop' : 'wait', resumeAtMs };
        }

        const node = createDanmakuNode(normalized, settingsSnapshot);
        const special = normalized.messageType === 'superChat' || normalized.messageType === 'superSticker';
        overlaySurface.appendChild(node);
        const specialFit = applySpecialFit(node, surfaceRect.width);
        if (!specialFit || specialFit.result === 'UNREPRESENTABLE_SPECIAL') {
            node.remove();
            return { status: 'drop' };
        }
        const renderedRect = node.getBoundingClientRect();
        const metrics = overlayCore.createRenderedTextMetrics(normalized.text, renderedRect.width);
        const commentWidth = metrics?.renderedWidth;
        const baseDurationMs = overlayCore.calculateCompensatedDanmakuDuration(surfaceRect.width, commentWidth);
        const playbackRate = currentChatMode === 'replay' ? video.playbackRate : 1;
        const replayFactor = currentChatMode === 'replay' ? overlayCore.calculateReplayPlaybackRateFactor(playbackRate) : 1;
        const targetDurationMs = baseDurationMs && replayFactor ? baseDurationMs * replayFactor : null;
        const baseSpeed = overlayCore.calculateDanmakuSpeed({
            overlayWidth: surfaceRect.width,
            commentWidth,
            targetDurationMs,
            minSpeed: phase5Tuning.minimumSpeed * playbackRate,
            maxSpeed: phase5Tuning.maximumSpeed * playbackRate
        });
        const speed = window.LiveFlowPhase5Tuning.applyLengthAwareVelocity(baseSpeed, commentWidth, surfaceRect.width,
            phase5Tuning.lengthVelocity, phase5Tuning.maximumSpeed * playbackRate);
        const laneSpan = 1;
        const anchorIndex = Number.isInteger(launchProof?.anchorIndex) && launchProof.anchorIndex >= 0 && launchProof.anchorIndex < anchorCount ? launchProof.anchorIndex : -1;
        if (anchorIndex < 0 || !Number.isFinite(launchProof?.lane)) {
            node.remove();
            return { status: 'drop' };
        }
        const motion = overlayCore.calculateDanmakuMotion({
            overlayWidth: surfaceRect.width,
            commentWidth,
            commentHeight: renderedRect.height,
            speed,
            startTimeMs: now
        });
        if (!motion || typeof node.animate !== 'function') {
            node.remove();
            return { status: 'drop' };
        }

        const token = Symbol('danmaku');
        const reservation = {
            token,
            startTimeMs: now,
            startX: motion.startX,
            commentWidth,
            commentHeight: renderedRect.height,
            speed,
            endTimeMs: now + motion.durationMs
        };
        if (!overlayCore.reserveLaneSpan(laneStates, anchorIndex, laneSpan, reservation)) {
            node.remove();
            return { status: 'drop' };
        }
        node.style.top = `${launchProof.lane * (phase5Tuning.lineHeight + phase5Tuning.laneGap)}px`;
        node.style.visibility = 'visible';
        const animation = node.animate([
            { transform: `translateX(${motion.startX}px)` },
            { transform: `translateX(${motion.endX}px)` }
        ], {
            duration: motion.durationMs,
            easing: 'linear',
            fill: 'forwards'
        });
        activeDanmaku.set(token, {
            animation,
            node,
            visualFootprint: Object.freeze({ width: commentWidth, height: renderedRect.height, anchorLane: launchProof.lane, logicalLaneSpan: 1 }),
            trajectory: Object.freeze({ startTimeMs: now, startX: video.getBoundingClientRect().right,
                y: video.getBoundingClientRect().top + launchProof.lane * (phase5Tuning.lineHeight + phase5Tuning.laneGap),
                width: commentWidth, height: renderedRect.height, velocity: speed, anchorIndex })
        });
        if (currentChatMode === 'replay') {
            window.postMessage({ source: 'liveflow-content-script', type: REPLAY_DISPLAYED_TYPE, pageLifecycleGeneration: currentPageLifecycleGeneration }, window.location.origin);
        }
        animation.finished.then(() => {
            activeDanmaku.delete(token);
            overlayCore.releaseLaneReservation(laneStates, token);
            node.remove();
        }).catch(() => {
            activeDanmaku.delete(token);
            overlayCore.releaseLaneReservation(laneStates, token);
            node.remove();
        });
        return { status: 'rendered' };
    }

    function scheduleDanmakuBatch(messages) {
        const inputCount = Array.isArray(messages) ? messages.length : 0;
        if (!isEffectiveDisplayActive()) {
            observeLivePresentationBatch({ input: inputCount, lifecycleSuppressed: inputCount, suppressedOther: inputCount });
            if (currentChatMode === 'replay') publishReplayBatchAccounting({
                inputCount, lifecycleDiscarded: inputCount, lifecycleDiscardedDisplayDisabled: inputCount
            });
            return;
        }
        const media = getCurrentMainMedia();
        if (!media || !overlayCore?.isMainContentPlaybackEligible?.(media.player, media.video)) {
            phase3Runtime?.clear();
            observeLivePresentationBatch({ input: inputCount, lifecycleSuppressed: inputCount,
                suppressedPaused: media?.video?.paused === true ? inputCount : 0,
                suppressedOther: media?.video?.paused === true ? 0 : inputCount });
            if (currentChatMode === 'replay') {
                const reasonField = !media ? 'lifecycleDiscardedMediaMissing'
                    : media.player?.classList?.contains?.('ad-showing') === true ? 'lifecycleDiscardedAdShowing'
                        : media.player?.classList?.contains?.('ad-interrupting') === true ? 'lifecycleDiscardedAdInterrupting'
                            : media.video?.ended === true ? 'lifecycleDiscardedMediaEnded'
                                : !Number.isFinite(media.video?.readyState) || media.video.readyState < 2
                                    ? 'lifecycleDiscardedMediaNotReady' : media.video?.paused === true
                                        ? 'lifecycleDiscardedMediaPaused' : 'lifecycleDiscardedMediaMissing';
                publishReplayBatchAccounting({ inputCount, lifecycleDiscarded: inputCount, [reasonField]: inputCount });
            }
            return;
        }
        if (currentChatMode === 'live' && livePresentationResumeGateActive) {
            const proximity = overlayCore?.classifyLiveEdgeProximity?.({
                currentTime: media.video.currentTime,
                seekable: snapshotTimeRanges(media.video.seekable),
                buffered: snapshotTimeRanges(media.video.buffered)
            }) || 'UNKNOWN';
            const gate = overlayCore?.reduceLivePresentationResumeGate?.(true, 'BATCH', proximity) ||
                Object.freeze({ active: true, allowLaunch: false, reason: 'UNKNOWN' });
            livePresentationResumeGateActive = gate.active;
            if (!gate.allowLaunch) {
                phase3Runtime?.clear();
                observeLivePresentationBatch({ input: inputCount, lifecycleSuppressed: inputCount,
                    suppressedBehindLive: gate.reason === 'BEHIND_LIVE' ? inputCount : 0,
                    suppressedUnknown: gate.reason === 'UNKNOWN' ? inputCount : 0 });
                return;
            }
        }
        if (phase3Runtime && phase3RuntimeVideo !== media.video) cleanupOverlay();
        const runtime = ensurePhase3Runtime();
        if (!runtime) {
            observeLivePresentationBatch({ input: inputCount, enqueueRejected: inputCount });
            if (currentChatMode === 'replay') publishReplayBatchAccounting({ inputCount, enqueueRejected: inputCount });
            return;
        }
        ensureSubtitleGeometryObservers(media.player);
        ensurePlaybackContextObserver(media.player);
        const scheduledGeneration = rendererGeneration;
        const scheduledVideo = media.video;
        const launchSettingsSnapshot = runtimeSettings;
        const visibleMessages = Array.isArray(messages)
            ? messages.filter((message) => overlayCore.isMessageVisibleForSettings(message, launchSettingsSnapshot))
            : [];
        let enqueuedCount = 0;
        visibleMessages.forEach((message, index) => {
            if (runtime.enqueue({
            message,
            generation: scheduledGeneration,
            pageLifecycleGeneration: currentPageLifecycleGeneration,
            video: scheduledVideo,
            settingsSnapshot: launchSettingsSnapshot
        }, {
            id: message.id || `${scheduledGeneration}:${performance.now()}:${index}`,
            enqueuedAt: performance.now(),
            rendererType: message.messageType === 'superChat'
                ? 'liveChatPaidMessageRenderer'
                : message.messageType === 'superSticker' ? 'liveChatPaidStickerRenderer' : 'liveChatTextMessageRenderer',
            footprint: message.messageType === 'superChat' || message.messageType === 'superSticker'
                ? { width: 520, height: 68, kind: 'SPECIAL' }
                : { width: 720, height: phase5Tuning.lineHeight, kind: 'NORMAL' }
            })) enqueuedCount += 1;
        });
        if (currentChatMode === 'replay') {
            publishReplayBatchAccounting({ inputCount, visibleCount: visibleMessages.length, enqueuedCount,
                visibilityFiltered: inputCount - visibleMessages.length, enqueueRejected: visibleMessages.length - enqueuedCount });
        }
        observeLivePresentationBatch({ input: inputCount, enqueued: enqueuedCount,
            visibilityFiltered: inputCount - visibleMessages.length,
            enqueueRejected: visibleMessages.length - enqueuedCount });
    }

    function snapshotTimeRanges(ranges) {
        if (!ranges || !Number.isInteger(ranges.length) || ranges.length < 0) return null;
        const snapshot = [];
        try {
            for (let index = 0; index < ranges.length; index += 1) {
                snapshot.push({ start: ranges.start(index), end: ranges.end(index) });
            }
        } catch {
            return null;
        }
        return snapshot;
    }

    function publishReplayBatchAccounting(fields) {
        window.postMessage({ source: 'liveflow-content-script', type: REPLAY_PIPELINE_DIAGNOSTIC_TYPE,
            pageLifecycleGeneration: currentPageLifecycleGeneration, ...fields }, window.location.origin);
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
        internalApiContext = event.data.context && typeof event.data.context === 'object'
            ? event.data.context
            : null;
        currentPageRevision = Number.isInteger(event.data.pageRevision) ? event.data.pageRevision : currentPageRevision;
        currentPageLifecycleGeneration = event.data.pageLifecycleGeneration;
        currentChatMode = ['live', 'replay'].includes(event.data.mode) ? event.data.mode : 'unknown';
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
        chatAvailable = event.data.chatAvailable === true;

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
        let exactIdDedupedCount = 0;
        messages.forEach((message) => {
            if (message.id && messageIds.has(message.id)) { exactIdDedupedCount += 1; return; }
            if (message.id) messageIds.add(message.id);
            currentMessages.push(message);
            newMessages.push(message);
        });
        if (currentMessages.length > MAX_MESSAGES) {
            currentMessages.splice(0, currentMessages.length - MAX_MESSAGES);
        }
        scheduleDanmakuBatch(newMessages);
        if (currentChatMode === 'replay' && exactIdDedupedCount > 0) publishReplayBatchAccounting({ exactIdDedupedCount });
        logInfo(`READ #${readNumber} completed: HTTP ${event.data.status}`);
        logInfo(`READ #${readNumber} parsed messages: ${event.data.parsedMessageCount ?? messages.length}`);
        if (event.data.nextContinuationAvailable) logInfo(`READ #${readNumber} next continuation available`);
    }

    function isYouTubeWatchPage() {
        return /(?:^|\.)youtube\.com\/(?:watch|live)(?:[/?]|$)/i.test(window.location.href);
    }

    function detectPage() {
        if (!persistentSettingsReady) return;
        if (!isYouTubeWatchPage()) return;
        const nextPageKey = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        if (currentPageKey !== nextPageKey) resetPageState();
        logInfo('YouTube watch page detected');
        attachManagementBar();
        evaluateNativeChatVisibility();
        requestInitialContinuation();
    }

    function handleNavigation() {
        if (!persistentSettingsReady) return;
        attachManagementBar();
        requestInitialContinuation();
    }

    function handleNavigationStart() {
        logInfo(`Navigation invalidate: rendererGeneration=${rendererGeneration}, queue=${phase3Runtime?.status().pendingCount || 0}, active=${activeDanmaku.size}, timer=${phase3Runtime?.status().armed === true}`);
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

    function handleVisibilityChange() {
        if (document.hidden) {
            acceptingReadResults = false;
            setReadIndicatorState('idle');
            cleanupOverlay();
            return;
        }
        if (!isYouTubeWatchPage()) return;
        readRequestedRevision = -1;
        acceptingReadResults = true;
        window.postMessage({
            source: 'liveflow-content-script',
            type: RESUME_READ_LOOP_TYPE,
            pageLifecycleGeneration: currentPageLifecycleGeneration,
            userEnabled: true
        }, window.location.origin);
    }

    function handlePageLifecycleInvalidated(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== NAVIGATION_INVALIDATED_TYPE) return;
        if (!Number.isInteger(event.data.pageRevision) || !Number.isInteger(event.data.pageLifecycleGeneration)) return;
        acceptingReadResults = false;
        minimumAcceptedPageRevision = Math.max(minimumAcceptedPageRevision, event.data.pageRevision);
        currentPageLifecycleGeneration = Math.max(currentPageLifecycleGeneration, event.data.pageLifecycleGeneration);
        internalApiContext = null;
        chatAvailable = false;
        readRequestedRevision = -1;
        currentMessages = [];
        currentChatMode = 'unknown';
        cleanupOverlay();
        logInfo(`Page lifecycle invalidated: revision=${event.data.pageRevision}, generation=${event.data.pageLifecycleGeneration}`);
    }

    function handleReadLifecycleDiagnostic(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== LIFECYCLE_DIAGNOSTIC_TYPE) return;
        const allowedEvents = new Set(['NAV_INVALIDATE', 'PAGE_STATE_REJECTED', 'NEW_PAGE_STATE', 'READ_START_REJECTED', 'READ_START', 'READ_REQUEST_BEGIN', 'READ_RESPONSE_RECEIVED', 'READ_STOP']);
        if (!allowedEvents.has(event.data.eventName)) return;
        const lifecycleSignal = ['request', 'yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'watch-root-mutation', 'visibility-resume'].includes(event.data.lifecycleSignal || event.data.eventSource)
            ? event.data.lifecycleSignal || event.data.eventSource
            : 'unknown';
        logInfo(`READ lifecycle: event=${event.data.eventName}, signal=${lifecycleSignal}, pageRevision=${event.data.pageRevision}, pageGeneration=${event.data.pageLifecycleGeneration}, readGeneration=${event.data.readGeneration}, active=${event.data.readActive}, inFlight=${event.data.requestInFlight}, reason=${event.data.rejectionReason || 'NONE'}, pageDataSeen=${event.data.navigationPageDataUpdated === true}, canReevaluate=${event.data.canReevaluate === true}, navigationTargetMatched=${event.data.navigationTargetMatched === true}, targetKnown=${event.data.targetKnown === true}, bootstrapKnown=${event.data.bootstrapKnown === true}, ownershipSource=${event.data.ownershipSource === 'WATCH_ROOT_SNAPSHOT' ? event.data.ownershipSource : 'NONE'}, ownershipContinuationAvailable=${event.data.ownershipContinuationAvailable === true}, ownershipSameSnapshot=${event.data.ownershipSameSnapshot === true}, watchRootObserved=${event.data.watchRootObserved === true}, watchRootRebound=${event.data.watchRootRebound === true}, pageTargetChanged=${event.data.pageTargetChanged === true}, bootstrapTargetMatched=${event.data.bootstrapTargetMatched === true}, supportingCandidates=${Number.isInteger(event.data.supportingCandidateCount) ? event.data.supportingCandidateCount : 0}, supportingMatches=${Number.isInteger(event.data.supportingMatchCount) ? event.data.supportingMatchCount : 0}, abortIssued=${event.data.abortIssued === true}, aborted=${event.data.aborted === true}, requestAfterInvalidation=${event.data.requestAfterInvalidation === true}, responseAfterInvalidation=${event.data.responseAfterInvalidation === true}, watchRootChanged=${event.data.watchRootChanged === true}, videoElementChanged=${event.data.videoElementChanged === true}`);
    }

    function handleGeometryChange() {
        subtitleGeometryAdapter?.markDirty(geometryCore.DIRTY_SIGNALS.VIDEO_GEOMETRY);
        if (geometryChangeQueued) return;
        geometryChangeQueued = true;
        window.queueMicrotask(() => {
            geometryChangeQueued = false;
            cleanupOverlay();
            refreshManagementBarPlacement();
        });
    }

    function handleReplayMediaContextChange(event) {
        const media = getCurrentMainMedia();
        if (!media || event.target !== media.video) return;
        if (currentChatMode === 'live' && ['pause', 'seeking'].includes(event.type)) {
            const gate = overlayCore?.reduceLivePresentationResumeGate?.(
                livePresentationResumeGateActive,
                event.type === 'pause' ? 'PAUSE' : 'SEEKING'
            );
            livePresentationResumeGateActive = gate?.active !== false;
            cleanupOverlay();
            return;
        }
        if (currentChatMode !== 'replay') return;
        if (event.type === 'seeking') {
            replaySchedulerDiagnostic = createReplaySchedulerDiagnostic();
            resetReplayLaunchGapDiagnostic();
            publishReplaySchedulerDiagnostic();
        }
        currentMessages = [];
        cleanupOverlay();
    }

    window.addEventListener('message', handleInitialContinuation);
    window.addEventListener('message', handleReadResult);
    window.addEventListener('message', handlePageLifecycleInvalidated);
    window.addEventListener('message', handleReadLifecycleDiagnostic);
    window.addEventListener('yt-navigate-start', handleNavigationStart);
    window.addEventListener('yt-navigate-finish', detectPage);
    window.addEventListener('yt-page-data-updated', handleNavigation);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('resize', handleGeometryChange);
    window.addEventListener('orientationchange', handleGeometryChange);
    window.addEventListener('pause', handleReplayMediaContextChange, true);
    window.addEventListener('seeking', handleReplayMediaContextChange, true);
    window.addEventListener('ratechange', handleReplayMediaContextChange, true);
    document.addEventListener('fullscreenchange', handleGeometryChange);
    window.visualViewport?.addEventListener('resize', handleGeometryChange);
    window.visualViewport?.addEventListener('scroll', handleGeometryChange);

    initializePersistentSettings().then(() => {
        if (isYouTubeWatchPage()) detectPage();
    });
})();
