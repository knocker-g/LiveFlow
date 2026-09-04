(function () {
    const REQUEST_TYPE = 'LIVEFLOW_REQUEST_INITIAL_CHAT_CONTINUATION';
    const RESPONSE_TYPE = 'LIVEFLOW_INITIAL_CHAT_CONTINUATION';
    const READ_REQUEST_TYPE = 'LIVEFLOW_REQUEST_CHAT_READ_ONCE';
    const READ_RESPONSE_TYPE = 'LIVEFLOW_CHAT_READ_ONCE_RESULT';
    const STOP_READ_LOOP_TYPE = 'LIVEFLOW_STOP_CHAT_READ_LOOP';
    let pageRevision = 0;
    let pageKey = '';
    let pageState = { continuation: '', context: null };
    let readAttemptedRevision = -1;
    let readCount = 0;
    let currentLoopGeneration = 0;
    let activeLoopGeneration = 0;
    let activeAbortController = null;
    let activeWaitTimer = null;
    let readRequestInFlight = false;

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

    function readContinuation() {
        return window.ytInitialData
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

    function respond() {
        const continuation = readContinuation();
        const context = readInternalApiContext();
        const nextPageKey = `${location.origin}${location.pathname}${location.search}`;
        const revisionState = window.LiveFlowChatReadCore?.getPageRevisionState?.(pageKey, pageRevision, nextPageKey);
        if (revisionState?.changed || (!revisionState && nextPageKey !== pageKey)) {
            stopReadLoop();
            pageKey = revisionState?.key || nextPageKey;
            pageRevision = revisionState?.revision || pageRevision + 1;
            readAttemptedRevision = -1;
            readCount = 0;
            pageState = { continuation: '', context: null };
        }
        pageState = {
            continuation: typeof continuation === 'string' ? continuation : '',
            context
        };
        window.postMessage({
            source: 'liveflow-page-state',
            type: RESPONSE_TYPE,
            continuation: pageState.continuation,
            context: pageState.context,
            pageRevision
        }, window.location.origin);
    }

    function postReadResult(result) {
        const { continuationInfo, messages, summary, ...safeResult } = result;
        window.postMessage({
            source: 'liveflow-page-state',
            type: READ_RESPONSE_TYPE,
            pageRevision,
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
                badges: message.badges,
                messageType: message.messageType,
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

    async function startReadLoop() {
        const core = window.LiveFlowChatReadCore;
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
        const context = pageState.context;
        let continuation = pageState.continuation;

        while (generation === currentLoopGeneration && revision === pageRevision && continuation) {
            readCount += 1;
            const abortController = new AbortController();
            activeAbortController = abortController;
            readRequestInFlight = true;
            let result;
            try {
                result = await performRead(continuation, context, readCount, revision, generation, abortController);
            } finally {
                readRequestInFlight = false;
            }
            if (activeAbortController === abortController) activeAbortController = null;
            if (!core.canScheduleNextRead({
                generation,
                currentGeneration: currentLoopGeneration,
                revision,
                currentRevision: pageRevision,
                aborted: abortController.signal.aborted,
                validationOk: Boolean(result?.ok)
            })) break;

            postReadResult(result);
            const continuationInfo = result.continuationInfo;
            continuation = continuationInfo.continuation;
            if (!await waitForNextRead(result.effectiveDelayMs, generation)) break;
        }

        if (activeLoopGeneration === generation) {
            activeLoopGeneration = 0;
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
            startReadLoop();
            return;
        }
        if (event.data.type === STOP_READ_LOOP_TYPE) {
            stopReadLoop();
            return;
        }
    });

    window.addEventListener('yt-navigate-finish', respond);
    window.addEventListener('yt-navigate-start', stopReadLoop);
    window.addEventListener('yt-page-data-updated', respond);
    window.addEventListener('pagehide', stopReadLoop);
    window.addEventListener('visibilitychange', () => {
        if (document.hidden) stopReadLoop();
    });
})();
