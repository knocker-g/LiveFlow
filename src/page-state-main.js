(function () {
    const REQUEST_TYPE = 'LIVEFLOW_REQUEST_INITIAL_CHAT_CONTINUATION';
    const RESPONSE_TYPE = 'LIVEFLOW_INITIAL_CHAT_CONTINUATION';
    const READ_REQUEST_TYPE = 'LIVEFLOW_REQUEST_CHAT_READ_ONCE';
    const READ_RESPONSE_TYPE = 'LIVEFLOW_CHAT_READ_ONCE_RESULT';
    const STOP_READ_LOOP_TYPE = 'LIVEFLOW_STOP_CHAT_READ_LOOP';
    const NAVIGATION_INVALIDATED_TYPE = 'LIVEFLOW_PAGE_LIFECYCLE_INVALIDATED';
    const LIFECYCLE_DIAGNOSTIC_TYPE = 'LIVEFLOW_READ_LIFECYCLE_DIAGNOSTIC';
    let pageRevision = 0;
    let pageKey = '';
    let pageState = { continuation: '', context: null, targetIdentity: '', bootstrapTargetMatched: false };
    let readAttemptedRevision = -1;
    let readCount = 0;
    let currentLoopGeneration = 0;
    let activeLoopGeneration = 0;
    let activeAbortController = null;
    let activeWaitTimer = null;
    let readRequestInFlight = false;
    let pageLifecycleGeneration = 0;
    let navigationPending = false;
    let navigationPageDataUpdated = false;
    let navigationCompletionTargetIdentity = '';
    let deferredReadStartGeneration = null;
    let lastEstablishedWatchRoot = null;
    let lastEstablishedVideo = null;
    let establishedTargetIdentity = '';
    let invalidatedTargetIdentity = '';
    let observedWatchRoot = null;
    let watchRootObserver = null;
    let ownershipReevaluationQueued = false;

    function getYtcfgValue(key) {
        try {
            if (typeof window.ytcfg?.get === 'function') {
                const value = window.ytcfg.get(key);
                if (value !== undefined && value !== null) return value;
            }
        } catch (error) {
            return undefined;
        }
        return window.ytcfg?.data_?.[key];
    }

    function readContinuation(initialData = window.ytInitialData) {
        return initialData
            ?.contents
            ?.twoColumnWatchNextResults
            ?.conversationBar
            ?.liveChatRenderer
            ?.continuations?.[0]
            ?.reloadContinuationData
            ?.continuation || '';
    }

    function readInternalApiContext() {
        const core = window.LiveFlowChatReadCore;
        const candidates = [
            window.INNERTUBE_CONTEXT,
            getYtcfgValue('INNERTUBE_CONTEXT')
        ];

        for (const candidate of candidates) {
            const normalized = core?.normalizeInternalApiContext?.(candidate);
            if (normalized) return normalized;
        }

        const fallback = {};
        const fallbackKeys = [
            'INNERTUBE_CONTEXT_CLIENT_NAME',
            'INNERTUBE_CONTEXT_CLIENT_VERSION',
            'HL',
            'GL',
            'VISITOR_DATA'
        ];
        const targetKeys = ['clientName', 'clientVersion', 'hl', 'gl', 'visitorData'];

        fallbackKeys.forEach((key, index) => {
            const value = getYtcfgValue(key);
            if (value !== undefined && value !== null && value !== '') {
                fallback[targetKeys[index]] = value;
            }
        });

        return core?.normalizeInternalApiContext?.(fallback) || null;
    }

    function postLifecycleInvalidated() {
        window.postMessage({
            source: 'liveflow-page-state',
            type: NAVIGATION_INVALIDATED_TYPE,
            pageRevision,
            pageLifecycleGeneration
        }, window.location.origin);
    }

    function readBootstrapTargetEvidence(watchSnapshot, watchRoot) {
        return {
            authoritative: watchSnapshot?.currentVideoEndpoint?.watchEndpoint?.videoId,
            supporting: [
                window.ytInitialPlayerResponse?.videoDetails?.videoId,
                watchRoot?.getAttribute?.('video-id')
            ]
        };
    }

    function readNavigationCompletionTarget(event) {
        const value = event?.detail?.response?.playerResponse?.videoDetails?.videoId;
        return typeof value === 'string' ? value : '';
    }

    function disconnectWatchRootObserver() {
        watchRootObserver?.disconnect();
        watchRootObserver = null;
        observedWatchRoot = null;
        ownershipReevaluationQueued = false;
    }

    function bindWatchRootObserver(watchRoot) {
        if (watchRoot === observedWatchRoot && watchRootObserver) return false;
        disconnectWatchRootObserver();
        if (!watchRoot) return false;

        const observedGeneration = pageLifecycleGeneration;
        observedWatchRoot = watchRoot;
        watchRootObserver = new MutationObserver(() => {
            const canSignalReevaluation = window.LiveFlowChatReadCore?.canSignalOwnershipReevaluation?.({
                navigationPending,
                pageEstablished: establishedTargetIdentity.length > 0,
                pageDataUpdatedSeen: navigationPageDataUpdated
            }) === true;
            if (!canSignalReevaluation || ownershipReevaluationQueued ||
                observedGeneration !== pageLifecycleGeneration || observedWatchRoot !== watchRoot) return;
            ownershipReevaluationQueued = true;
            window.queueMicrotask(() => {
                ownershipReevaluationQueued = false;
                const stillCanSignalReevaluation = window.LiveFlowChatReadCore?.canSignalOwnershipReevaluation?.({
                    navigationPending,
                    pageEstablished: establishedTargetIdentity.length > 0,
                    pageDataUpdatedSeen: navigationPageDataUpdated
                }) === true;
                if (!stillCanSignalReevaluation || observedGeneration !== pageLifecycleGeneration || observedWatchRoot !== watchRoot) return;
                respond({
                    ownershipMutation: true,
                    eventSource: 'watch-root-mutation',
                    expectedLifecycleGeneration: observedGeneration
                });
            });
        });
        watchRootObserver.observe(watchRoot, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['video-id', 'hidden']
        });
        return true;
    }

    function isCurrentPageStateTarget() {
        const targetIdentity = window.LiveFlowChatReadCore?.extractWatchTargetIdentity?.(window.location.href) || '';
        return targetIdentity.length > 0 &&
            pageState.bootstrapTargetMatched === true &&
            pageState.targetIdentity === targetIdentity;
    }

    function postLifecycleDiagnostic(eventName, details = {}) {
        window.postMessage({
            source: 'liveflow-page-state',
            type: LIFECYCLE_DIAGNOSTIC_TYPE,
            eventName,
            pageRevision,
            pageLifecycleGeneration,
            readGeneration: currentLoopGeneration,
            readActive: activeLoopGeneration !== 0,
            requestInFlight: readRequestInFlight,
            ...details
        }, window.location.origin);
    }

    function invalidatePageLifecycle(eventSource = 'yt-navigate-start') {
        const abortIssued = Boolean(activeAbortController);
        stopReadLoop();
        pageRevision += 1;
        pageLifecycleGeneration += 1;
        navigationPending = true;
        navigationPageDataUpdated = false;
        navigationCompletionTargetIdentity = '';
        disconnectWatchRootObserver();
        invalidatedTargetIdentity = establishedTargetIdentity;
        readAttemptedRevision = -1;
        readCount = 0;
        pageState = { continuation: '', context: null, targetIdentity: '', bootstrapTargetMatched: false };
        postLifecycleInvalidated();
        postLifecycleDiagnostic('NAV_INVALIDATE', { eventSource, abortIssued });
    }

    function respond({ pageDataUpdated = false, navigationFinished = false, ownershipMutation = false, eventSource = 'request', event = null, expectedLifecycleGeneration = null } = {}) {
        if (expectedLifecycleGeneration !== null && expectedLifecycleGeneration !== pageLifecycleGeneration) return;
        const nextPageKey = `${location.origin}${location.pathname}${location.search}`;
        const hadEstablishedPage = pageKey !== '';
        const revisionState = window.LiveFlowChatReadCore?.getPageRevisionState?.(pageKey, pageRevision, nextPageKey);
        if (revisionState?.changed || (!revisionState && nextPageKey !== pageKey)) {
            if (hadEstablishedPage && !navigationPending) {
                stopReadLoop();
                pageRevision = revisionState?.revision || pageRevision + 1;
                pageLifecycleGeneration += 1;
                navigationPending = true;
                navigationPageDataUpdated = false;
                navigationCompletionTargetIdentity = '';
                disconnectWatchRootObserver();
                invalidatedTargetIdentity = establishedTargetIdentity;
                postLifecycleInvalidated();
                postLifecycleDiagnostic('NAV_INVALIDATE', {
                    eventSource,
                    abortIssued: false
                });
            }
            pageKey = revisionState?.key || nextPageKey;
            readAttemptedRevision = -1;
            readCount = 0;
            pageState = { continuation: '', context: null, targetIdentity: '', bootstrapTargetMatched: false };
        }
        if (pageDataUpdated) navigationPageDataUpdated = true;
        if (navigationFinished) navigationCompletionTargetIdentity = readNavigationCompletionTarget(event);
        const watchRoot = document.querySelector('ytd-watch-flexy');
        const watchRootRebound = bindWatchRootObserver(watchRoot);
        const canReevaluate = window.LiveFlowChatReadCore?.canReevaluatePageLifecycle?.({
            navigationPending,
            pageDataUpdatedSeen: navigationPageDataUpdated,
            pageDataUpdated,
            navigationFinished,
            ownershipMutation
        }) === true;
        if (!canReevaluate) return;
        const watchSnapshot = watchRoot?.data;
        const continuation = readContinuation(watchSnapshot);
        const context = readInternalApiContext();
        const currentVideo = watchRoot?.querySelector('#movie_player video.html5-main-video, #movie_player video') || null;
        const watchRootChanged = lastEstablishedWatchRoot !== null && watchRoot !== lastEstablishedWatchRoot;
        const videoElementChanged = lastEstablishedVideo !== null && currentVideo !== lastEstablishedVideo;
        const core = window.LiveFlowChatReadCore;
        const targetIdentity = core?.extractWatchTargetIdentity?.(window.location.href) || '';
        const bootstrapTargetEvidence = readBootstrapTargetEvidence(watchSnapshot, watchRoot);
        const bootstrapTarget = core?.evaluateBootstrapTarget?.(
            targetIdentity,
            bootstrapTargetEvidence.authoritative,
            bootstrapTargetEvidence.supporting
        ) || { available: false, matched: false, supportingCandidateCount: 0, supportingMatchCount: 0 };
        const pageTargetChanged = invalidatedTargetIdentity.length === 0 || targetIdentity !== invalidatedTargetIdentity;
        const navigationTargetMatched = !navigationPending || (
            navigationCompletionTargetIdentity.length > 0 &&
            navigationCompletionTargetIdentity === targetIdentity
        );
        const establishment = core?.canEstablishPageLifecycle?.({
            navigationPending,
            pageDataUpdated: !navigationPending || navigationPageDataUpdated,
            navigationTargetMatched,
            pageTargetChanged,
            bootstrapTargetMatched: bootstrapTarget.matched,
            pageStateUsable: Boolean(continuation && context && watchRoot && currentVideo)
        }) || { ok: false, reason: 'PAGE_STATE_STALE' };
        if (!establishment.ok) {
            postLifecycleDiagnostic('PAGE_STATE_REJECTED', {
                rejectionReason: establishment.reason,
                lifecycleSignal: eventSource,
                navigationPageDataUpdated,
                canReevaluate,
                navigationTargetMatched,
                targetKnown: targetIdentity.length > 0,
                bootstrapKnown: bootstrapTarget.available,
                ownershipSource: 'WATCH_ROOT_SNAPSHOT',
                ownershipContinuationAvailable: Boolean(continuation),
                ownershipSameSnapshot: bootstrapTarget.matched && Boolean(continuation),
                watchRootObserved: Boolean(watchRootObserver),
                watchRootRebound,
                pageTargetChanged,
                bootstrapTargetMatched: bootstrapTarget.matched,
                supportingCandidateCount: bootstrapTarget.supportingCandidateCount,
                supportingMatchCount: bootstrapTarget.supportingMatchCount,
                watchRootChanged,
                videoElementChanged
            });
            return;
        }
        navigationPending = false;
        navigationPageDataUpdated = false;
        navigationCompletionTargetIdentity = '';
        establishedTargetIdentity = targetIdentity;
        invalidatedTargetIdentity = '';
        lastEstablishedWatchRoot = watchRoot;
        lastEstablishedVideo = currentVideo;
        pageState = {
            continuation: typeof continuation === 'string' ? continuation : '',
            context,
            targetIdentity,
            bootstrapTargetMatched: true
        };
        postLifecycleDiagnostic('NEW_PAGE_STATE', {
            eventSource,
            navigationPageDataUpdated: true,
            canReevaluate,
            navigationTargetMatched,
            targetKnown: true,
            bootstrapKnown: true,
            ownershipSource: 'WATCH_ROOT_SNAPSHOT',
            ownershipContinuationAvailable: true,
            ownershipSameSnapshot: true,
            watchRootObserved: Boolean(watchRootObserver),
            watchRootRebound,
            pageTargetChanged,
            bootstrapTargetMatched: true,
            supportingCandidateCount: bootstrapTarget.supportingCandidateCount,
            supportingMatchCount: bootstrapTarget.supportingMatchCount,
            watchRootChanged,
            videoElementChanged
        });
        window.postMessage({
            source: 'liveflow-page-state',
            type: RESPONSE_TYPE,
            continuation: pageState.continuation,
            context: pageState.context,
            pageRevision,
            pageLifecycleGeneration
        }, window.location.origin);
    }

    function postReadResult(result, lifecycleGeneration) {
        const { continuationInfo, messages, summary, ...safeResult } = result;
        window.postMessage({
            source: 'liveflow-page-state',
            type: READ_RESPONSE_TYPE,
            pageRevision: result.revision,
            pageLifecycleGeneration: lifecycleGeneration,
            ...safeResult,
            messages,
            continuationTypes: Array.isArray(summary?.continuationTypes) ? summary.continuationTypes : [],
            parsedMessageCount: Array.isArray(messages) ? messages.length : 0,
            nextContinuationAvailable: Boolean(continuationInfo?.continuation)
        }, window.location.origin);
    }

    function stopReadLoop() {
        currentLoopGeneration += 1;
        activeLoopGeneration = 0;
        if (activeAbortController) activeAbortController.abort();
        activeAbortController = null;
        if (activeWaitTimer !== null) window.clearTimeout(activeWaitTimer);
        activeWaitTimer = null;
        deferredReadStartGeneration = null;
    }

    function waitForNextRead(delay, generation) {
        return new Promise((resolve) => {
            activeWaitTimer = window.setTimeout(() => {
                activeWaitTimer = null;
                resolve(generation === currentLoopGeneration);
            }, delay);
        });
    }

    async function performRead(continuation, context, readNumber, revision, generation, abortController) {
        const requestBody = window.LiveFlowChatReadCore?.buildLiveChatReadRequest?.(
            context,
            continuation
        );
        if (!requestBody) {
            return { ok: false, status: null, errorType: 'missing_page_state', readNumber, revision };
        }

        try {
            const response = await fetch('/youtubei/v1/live_chat/get_live_chat?prettyPrint=false', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                credentials: 'omit',
                signal: abortController.signal
            });

            if (!window.LiveFlowChatReadCore?.isSuccessfulHttpStatus?.(response.status)) {
                return { ok: false, status: response.status, errorType: 'http_error', readNumber, revision };
            }

            let payload;
            try {
                payload = await response.json();
            } catch (error) {
                return { ok: false, status: response.status, errorType: 'invalid_json', readNumber, revision };
            }

            const parser = window.LiveFlowChatReadCore;
            try {
                window.LiveFlowSchemaDiagnostics?.collect?.(payload);
            } catch {
                // Development diagnostics must never affect READ or parsing.
            }
            let validation;
            let messages;
            let summary;
            try {
                validation = parser?.validateLiveChatReadResponse?.(payload) || { ok: false, errorType: 'parser_unavailable' };
                if (!validation.ok) {
                    return { ok: false, status: response.status, errorType: validation.errorType, readNumber, revision };
                }
                messages = parser.extractChatMessagesFromResponse(payload);
                summary = parser.summarizeLiveChatResponse(payload);
            } catch (error) {
                return { ok: false, status: response.status, errorType: 'parser_exception', readNumber, revision };
            }
            const normalizedMessages = messages.map((message) => ({
                id: message.id,
                authorName: message.authorName,
                message: message.message,
                timestampUsec: message.timestampUsec,
                authorPhoto: message.authorPhoto,
                authorBadges: message.authorBadges,
                badges: message.badges,
                messageType: message.messageType,
                authorRole: message.authorRole,
                messageRuns: message.messageRuns,
                authorExternalChannelId: message.authorExternalChannelId
            }));

            return {
                ok: true,
                status: response.status,
                readNumber,
                revision,
                generation,
                messages: normalizedMessages,
                continuationInfo: validation.continuationInfo,
                effectiveDelayMs: validation.effectiveDelayMs,
                summary
            };
        } catch (error) {
            return { ok: false, status: null, errorType: 'network_error', readNumber, revision };
        }
    }

    async function startReadLoop(requestedLifecycleGeneration) {
        const core = window.LiveFlowChatReadCore;
        if (requestedLifecycleGeneration !== pageLifecycleGeneration || navigationPending) return;
        if (!isCurrentPageStateTarget()) {
            postLifecycleDiagnostic('READ_START_REJECTED', {
                rejectionReason: 'BOOTSTRAP_TARGET_MISMATCH',
                targetKnown: Boolean(core?.extractWatchTargetIdentity?.(window.location.href)),
                bootstrapKnown: Boolean(pageState.targetIdentity),
                bootstrapTargetMatched: false
            });
            return;
        }
        if (readRequestInFlight || activeLoopGeneration !== 0) {
            deferredReadStartGeneration = requestedLifecycleGeneration;
            return;
        }
        if (!core?.canStartReadLoop?.({
            activeLoopGeneration,
            requestInFlight: readRequestInFlight,
            hasContinuation: Boolean(pageState.continuation),
            hasContext: Boolean(pageState.context),
            hidden: document.hidden
        })) return;

        const generation = ++currentLoopGeneration;
        activeLoopGeneration = generation;
        const revision = pageRevision;
        const lifecycleGeneration = pageLifecycleGeneration;
        const context = pageState.context;
        let continuation = pageState.continuation;
        postLifecycleDiagnostic('READ_START', { readGeneration: generation });

        while (generation === currentLoopGeneration && revision === pageRevision &&
            lifecycleGeneration === pageLifecycleGeneration && !navigationPending && continuation) {
            if (!isCurrentPageStateTarget()) {
                postLifecycleDiagnostic('READ_STOP', {
                    readGeneration: generation,
                    aborted: false,
                    responseAfterInvalidation: false,
                    rejectionReason: 'BOOTSTRAP_TARGET_MISMATCH'
                });
                break;
            }
            readCount += 1;
            const abortController = new AbortController();
            activeAbortController = abortController;
            readRequestInFlight = true;
            postLifecycleDiagnostic('READ_REQUEST_BEGIN', {
                readGeneration: generation,
                requestAfterInvalidation: lifecycleGeneration !== pageLifecycleGeneration || navigationPending
            });
            let result;
            try {
                result = await performRead(continuation, context, readCount, revision, generation, abortController);
            } finally {
                readRequestInFlight = false;
            }
            if (activeAbortController === abortController) activeAbortController = null;
            postLifecycleDiagnostic('READ_RESPONSE_RECEIVED', {
                readGeneration: generation,
                responseAfterInvalidation: lifecycleGeneration !== pageLifecycleGeneration
            });
            const canContinue = core.canScheduleNextRead({
                generation,
                currentGeneration: currentLoopGeneration,
                revision,
                currentRevision: pageRevision,
                aborted: abortController.signal.aborted,
                validationOk: Boolean(result?.ok)
            });
            if (!canContinue) {
                postLifecycleDiagnostic('READ_STOP', {
                    readGeneration: generation,
                    aborted: abortController.signal.aborted,
                    responseAfterInvalidation: lifecycleGeneration !== pageLifecycleGeneration
                });
                break;
            }

            postReadResult(result, lifecycleGeneration);
            const continuationInfo = result.continuationInfo;
            continuation = continuationInfo.continuation;
            if (!await waitForNextRead(result.effectiveDelayMs, generation)) break;
        }

        if (activeLoopGeneration === generation) {
            activeLoopGeneration = 0;
        }
        const deferredGeneration = deferredReadStartGeneration;
        deferredReadStartGeneration = null;
        if (deferredGeneration === pageLifecycleGeneration && !navigationPending) {
            window.queueMicrotask(() => startReadLoop(deferredGeneration));
        }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-content-script') return;
        if (event.data.type === REQUEST_TYPE) {
            respond();
            return;
        }
        if (event.data.type === READ_REQUEST_TYPE) {
            startReadLoop(event.data.pageLifecycleGeneration);
            return;
        }
        if (event.data.type === STOP_READ_LOOP_TYPE) {
            stopReadLoop();
            return;
        }
    });

    window.addEventListener('yt-navigate-finish', (event) => respond({ navigationFinished: true, eventSource: 'yt-navigate-finish', event }));
    window.addEventListener('yt-navigate-start', () => invalidatePageLifecycle('yt-navigate-start'));
    window.addEventListener('yt-page-data-updated', () => respond({ pageDataUpdated: true, eventSource: 'yt-page-data-updated' }));
    window.addEventListener('pagehide', () => {
        disconnectWatchRootObserver();
        stopReadLoop();
    });
    window.addEventListener('visibilitychange', () => {
        if (document.hidden) stopReadLoop();
    });
})();
