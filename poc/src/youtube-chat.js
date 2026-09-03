(function () {
    const LOG_PREFIX = '[LiveFlow PoC]';
    const REQUEST_TYPE = 'LIVEFLOW_REQUEST_INITIAL_CHAT_CONTINUATION';
    const RESPONSE_TYPE = 'LIVEFLOW_INITIAL_CHAT_CONTINUATION';
    const READ_REQUEST_TYPE = 'LIVEFLOW_REQUEST_CHAT_READ_ONCE';
    const READ_RESPONSE_TYPE = 'LIVEFLOW_CHAT_READ_ONCE_RESULT';
    const STOP_READ_LOOP_TYPE = 'LIVEFLOW_STOP_CHAT_READ_LOOP';
    const MAX_MESSAGES = 500;
    const BOOTSTRAP_REQUEST_TYPE = 'GET_PC_WATCH_BOOTSTRAP_SUMMARY';
    let bootstrapRequestedPageKey = '';
    const overlayCore = window.LiveFlowOverlayCore;
    let overlayRoot = null;
    let overlayList = null;
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

    function cleanupOverlay() {
        overlayRoot?.remove();
        overlayRoot = null;
        overlayList = null;
    }

    function attachOverlay() {
        const player = getPlayer();
        if (!player) return false;

        if (overlayRoot?.isConnected && overlayRoot.parentElement === player) return true;
        cleanupOverlay();
        overlayRoot = document.createElement('div');
        overlayRoot.id = 'liveflow-overlay-root';
        overlayRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:20;display:flex;align-items:flex-end;justify-content:flex-end;padding:16px;box-sizing:border-box;';
        overlayList = document.createElement('div');
        overlayList.id = 'liveflow-message-list';
        overlayList.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:70%;max-height:60%;overflow:hidden;font:14px/1.35 sans-serif;color:#fff;text-shadow:0 1px 3px #000;';
        overlayRoot.appendChild(overlayList);
        player.appendChild(overlayRoot);
        logInfo('Overlay attached');
        return true;
    }

    function renderOverlay() {
        if (!attachOverlay() || !overlayList || !overlayCore) return;
        overlayList.replaceChildren();
        overlayCore.getVisibleMessages(currentMessages, overlayCore.MAX_VISIBLE_MESSAGES).forEach((message) => {
            const node = document.createElement('div');
            node.className = 'liveflow-message';
            node.textContent = overlayCore.formatMessageText(message);
            overlayList.appendChild(node);
        });
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
            const fields = Object.keys(internalApiContext.client || {}).sort();
            logInfo(`YouTube internal API context found (${fields.join(', ')})`);
        } else {
            logInfo('YouTube internal API context is not available');
        }

        const bootstrap = event.data.bootstrap;
        if (bootstrap && /Android|iPhone|Mobile/i.test(navigator.userAgent)) {
            logInfo(`Mobile bootstrap: two-column=${Boolean(bootstrap.hasTwoColumnWatchNextResults)}, single-column=${Boolean(bootstrap.hasSingleColumnWatchNextResults)}, live-chat-renderer=${Boolean(bootstrap.hasLiveChatRenderer)}, candidates=${bootstrap.continuationCandidateCount || 0}`);
        }

        renderOverlay();
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
        messages.forEach((message) => {
            if (message.id && messageIds.has(message.id)) return;
            if (message.id) messageIds.add(message.id);
            currentMessages.push(message);
        });
        if (currentMessages.length > MAX_MESSAGES) {
            currentMessages.splice(0, currentMessages.length - MAX_MESSAGES);
        }
        renderOverlay();
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

    function requestPcWatchBootstrap() {
        if (!/Android|iPhone|Mobile/i.test(navigator.userAgent)) return;
        const pageKey = `${location.pathname}${location.search}`;
        if (bootstrapRequestedPageKey === pageKey) return;
        const videoId = new URLSearchParams(location.search).get('v') || '';
        if (!videoId) return;
        bootstrapRequestedPageKey = pageKey;
        chrome.runtime.sendMessage({ type: BOOTSTRAP_REQUEST_TYPE, payload: { videoId } }).then((result) => {
            if (!result?.ok) {
                logInfo(`PC watch bootstrap fetch failed: ${result?.errorType || 'unknown'}`);
                return;
            }
            logInfo(`PC watch bootstrap fetch completed: HTTP ${result.status}`);
            const summary = result.summary || {};
            if (`${location.pathname}${location.search}` !== pageKey) return;
            if (summary.ytInitialDataFound) logInfo('PC watch bootstrap structure found');
            if (summary.hasLiveChatRenderer) logInfo('PC liveChatRenderer found');
            if (summary.hasInitialLiveChatContinuation) logInfo('PC initial live chat continuation found');
            if (summary.contextMarkers?.presentFields?.length > 0) {
                logInfo(`PC watch context markers found (${summary.contextMarkers.presentFields.join(', ')})`);
            }
            if (summary.htmlProfile) {
                logInfo(`PC watch HTML profile: ytInitialData=${summary.htmlProfile.hasYtInitialDataMarker}, parse=${summary.htmlProfile.ytInitialDataParseSucceeded}, two-column=${summary.htmlProfile.hasTwoColumnWatchNextResults}, single-column=${summary.htmlProfile.hasSingleColumnWatchNextResults}`);
                logInfo(`PC watch live-chat path: conversation-bar=${summary.htmlProfile.hasConversationBar}, live-chat-renderer=${summary.htmlProfile.hasLiveChatRenderer}, continuation=${summary.htmlProfile.hasInitialLiveChatContinuation}`);
            }
            if (summary.embeddingProfile) {
                logInfo(`PC watch ytInitialData embedding: marker=${summary.embeddingProfile.markerPresent}, forms=${Object.entries(summary.embeddingProfile.assignmentForms).filter(([, present]) => present).map(([name]) => name).join(', ') || 'none'}, scripts=${summary.embeddingProfile.scriptContextTypes.join(', ') || 'unknown'}`);
            }
            if (result.initialContinuation) {
                window.postMessage({
                    source: 'liveflow-content-script',
                    type: 'LIVEFLOW_MOBILE_PC_BOOTSTRAP_CONTINUATION',
                    pageKey,
                    continuation: result.initialContinuation,
                    pcContext: result.pcContext
                }, window.location.origin);
                logInfo('Mobile PC bootstrap continuation acquired');
                logInfo('Mobile PC bootstrap acquired');
            }
        }).catch(() => logInfo('PC watch bootstrap fetch failed: message-error'));
    }

    function detectPage() {
        if (!isYouTubeWatchPage()) return;
        const nextPageKey = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        if (currentPageKey !== nextPageKey) resetPageState();
        logInfo('YouTube watch page detected');
        requestInitialContinuation();
        requestPcWatchBootstrap();
    }

    function handleNavigation() {
        requestInitialContinuation();
        requestPcWatchBootstrap();
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
