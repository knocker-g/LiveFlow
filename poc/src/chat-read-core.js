(function (global) {
    const LIVEFLOW_MIN_READ_DELAY_MS = 1000;
    const LIVEFLOW_MAX_TIMER_DELAY_MS = 2147483647;
    const SUPPORTED_CONTINUATION_TYPES = [
        'nextContinuationData',
        'invalidationContinuationData',
        'timedContinuationData',
        'reloadContinuationData'
    ];

    class ChatMessage {
        constructor({ id, authorName, message, timestampUsec, authorPhoto, badges, messageType, authorExternalChannelId }) {
            this.id = id || '';
            this.authorName = authorName || '';
            this.message = message || '';
            this.timestampUsec = timestampUsec || '';
            this.authorPhoto = authorPhoto || '';
            this.badges = Array.isArray(badges) ? badges : [];
            this.messageType = messageType || 'text';
            this.authorExternalChannelId = authorExternalChannelId || '';
        }

        static fromRenderer(renderer) {
            if (!renderer) {
                return new ChatMessage({});
            }

            const authorName = renderer.authorName?.simpleText ||
                renderer.authorName?.runs?.map((run) => run.text).join('') ||
                '';

            const textRuns = Array.isArray(renderer.message?.runs)
                ? renderer.message.runs
                : [];
            const messageText = textRuns.map((run) => run?.text || '').join('');

            const firstThumbnail = Array.isArray(renderer.authorPhoto?.thumbnails) && renderer.authorPhoto.thumbnails.length > 0
                ? renderer.authorPhoto.thumbnails[0].url || ''
                : '';

            const badges = Array.isArray(renderer.authorBadges)
                ? renderer.authorBadges.map((badge) => badge?.liveChatAuthorBadgeRenderer?.tooltip || badge?.tooltip || 'badge')
                : [];

            return new ChatMessage({
                id: renderer.id || '',
                authorName,
                message: messageText,
                timestampUsec: renderer.timestampUsec || '',
                authorPhoto: firstThumbnail,
                badges,
                messageType: 'text',
                authorExternalChannelId: renderer.authorExternalChannelId || ''
            });
        }
    }

    function extractChatMessagesFromResponse(response) {
        const actions = response?.continuationContents?.liveChatContinuation?.actions || [];

        return actions
            .map((action) => action?.addChatItemAction?.item?.liveChatTextMessageRenderer)
            .filter(Boolean)
            .map((renderer) => ChatMessage.fromRenderer(renderer));
    }

    function extractContinuationFromResponse(response) {
        return extractContinuationInfoFromResponse(response)?.continuation || null;
    }

    function extractContinuationInfoFromResponse(response) {
        const continuations = response?.continuationContents?.liveChatContinuation?.continuations || [];
        for (const type of SUPPORTED_CONTINUATION_TYPES) {
            for (const continuation of continuations) {
                const data = continuation?.[type];
                if (data?.continuation) {
                    const timeoutMs = typeof data.timeoutMs === 'number' && Number.isFinite(data.timeoutMs) && data.timeoutMs >= 0
                        ? data.timeoutMs
                        : null;
                    return { continuation: data.continuation, timeoutMs, type };
                }
            }
        }

        return null;
    }

    function getContinuationTypes(response) {
        const continuations = response?.continuationContents?.liveChatContinuation?.continuations || [];
        return SUPPORTED_CONTINUATION_TYPES.filter((type) => continuations.some((continuation) => Boolean(continuation?.[type])));
    }

    function extractInitialLiveChatContinuation(initialData) {
        const continuation = initialData
            ?.contents
            ?.twoColumnWatchNextResults
            ?.conversationBar
            ?.liveChatRenderer
            ?.continuations?.[0]
            ?.reloadContinuationData
            ?.continuation;

        return typeof continuation === 'string' && continuation ? continuation : '';
    }

    function normalizeInternalApiContext(source) {
        if (!source || typeof source !== 'object') {
            return null;
        }

        const sourceClient = source.client && typeof source.client === 'object'
            ? source.client
            : source;
        const clientKeys = [
            'clientName',
            'clientVersion',
            'hl',
            'gl',
            'visitorData',
            'userInterfaceTheme',
            'timeZone',
            'utcOffsetMinutes',
            'platform',
            'clientFormFactor',
            'browserName',
            'browserVersion',
            'osName',
            'osVersion',
            'screenDensityFloat',
            'screenHeightPoints',
            'screenPixelDensity',
            'screenWidthPoints'
        ];
        const client = {};

        for (const key of clientKeys) {
            const value = sourceClient[key];
            if (value !== undefined && value !== null && value !== '') {
                client[key] = value;
            }
        }

        return Object.keys(client).length > 0 ? { client } : null;
    }

    function buildLiveChatReadRequest(context, continuation) {
        if (!context || typeof context !== 'object' || !continuation) {
            return null;
        }

        return {
            context,
            continuation
        };
    }

    function summarizeLiveChatResponse(response) {
        const liveChatContinuation = response?.continuationContents?.liveChatContinuation;
        const actions = liveChatContinuation?.actions;
        const continuations = liveChatContinuation?.continuations;

        return {
            liveChatContinuation: Boolean(liveChatContinuation),
            actions: Array.isArray(actions),
            actionCount: Array.isArray(actions) ? actions.length : 0,
            continuations: Array.isArray(continuations),
            nextContinuationAvailable: Array.isArray(continuations) && Boolean(extractContinuationFromResponse(response)),
            continuationTypes: getContinuationTypes(response)
        };
    }

    function canAttemptOneShotRead(pageRevision, attemptedRevision) {
        return Number.isInteger(pageRevision) && pageRevision !== attemptedRevision;
    }

    function getPageRevisionState(currentKey, currentRevision, nextKey) {
        if (currentKey === nextKey) {
            return { key: currentKey, revision: currentRevision, changed: false };
        }

        return { key: nextKey, revision: currentRevision + 1, changed: true };
    }

    function canIssueSecondRead({ firstOk, responseParsed, hasNextContinuation, responseRevision, currentRevision, readCount }) {
        return firstOk === true &&
            responseParsed === true &&
            hasNextContinuation === true &&
            responseRevision === currentRevision &&
            readCount < 2;
    }

    function getReadDelayMs(timeoutMs) {
        if (typeof timeoutMs !== 'number' ||
            !Number.isFinite(timeoutMs) ||
            timeoutMs < 0 ||
            timeoutMs > LIVEFLOW_MAX_TIMER_DELAY_MS) {
            return null;
        }

        return Math.max(timeoutMs, LIVEFLOW_MIN_READ_DELAY_MS);
    }

    function validateLiveChatReadResponse(response) {
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
            return { ok: false, errorType: 'unexpected_response_shape' };
        }
        const liveChatContinuation = response.continuationContents?.liveChatContinuation;
        if (!liveChatContinuation || typeof liveChatContinuation !== 'object' || Array.isArray(liveChatContinuation)) {
            return { ok: false, errorType: 'missing_live_chat_continuation' };
        }
        if (!Array.isArray(liveChatContinuation.continuations)) {
            return { ok: false, errorType: 'missing_continuation' };
        }
        const continuationInfo = extractContinuationInfoFromResponse(response);
        if (!continuationInfo) {
            const hasUnknownType = liveChatContinuation.continuations.some((entry) =>
                entry && typeof entry === 'object' && Object.keys(entry).some((key) => !SUPPORTED_CONTINUATION_TYPES.includes(key))
            );
            return { ok: false, errorType: hasUnknownType ? 'unknown_continuation_type' : 'missing_continuation' };
        }
        if (typeof continuationInfo.continuation !== 'string' || !continuationInfo.continuation) {
            return { ok: false, errorType: 'missing_continuation' };
        }
        const effectiveDelayMs = getReadDelayMs(continuationInfo.timeoutMs);
        if (effectiveDelayMs === null) {
            return { ok: false, errorType: 'invalid_timeout' };
        }
        return { ok: true, continuationInfo, effectiveDelayMs };
    }

    function isSuccessfulHttpStatus(status) {
        return Number.isInteger(status) && status >= 200 && status < 300;
    }

    function canStartReadLoop({ activeLoopGeneration, requestInFlight, hasContinuation, hasContext, hidden }) {
        return activeLoopGeneration === 0 &&
            requestInFlight === false &&
            hasContinuation === true &&
            hasContext === true &&
            hidden === false;
    }

    function canScheduleNextRead({ generation, currentGeneration, revision, currentRevision, aborted, validationOk }) {
        return generation === currentGeneration &&
            revision === currentRevision &&
            aborted === false &&
            validationOk === true;
    }

    function extractWatchTargetIdentity(urlValue) {
        try {
            const url = new URL(urlValue, 'https://www.youtube.com');
            if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return '';
            if (url.pathname === '/watch') return url.searchParams.get('v') || '';
            const liveMatch = url.pathname.match(/^\/live\/([^/?#]+)/);
            return liveMatch?.[1] || '';
        } catch (error) {
            return '';
        }
    }

    function evaluateBootstrapTarget(targetIdentity, candidateIdentities) {
        const candidates = Array.isArray(candidateIdentities)
            ? candidateIdentities.filter((value) => typeof value === 'string' && value.length > 0)
            : [];
        const available = typeof targetIdentity === 'string' && targetIdentity.length > 0 && candidates.length > 0;
        return {
            available,
            matched: available && candidates.every((candidate) => candidate === targetIdentity)
        };
    }

    function canEstablishPageLifecycle({ navigationPending, pageDataUpdated, pageTargetChanged, bootstrapTargetMatched, pageStateUsable }) {
        if (navigationPending === true && pageDataUpdated !== true) return { ok: false, reason: 'NAVIGATION_PENDING' };
        if (navigationPending === true && pageTargetChanged !== true) return { ok: false, reason: 'TARGET_UNCHANGED' };
        if (bootstrapTargetMatched !== true) return { ok: false, reason: 'BOOTSTRAP_TARGET_MISMATCH' };
        if (pageStateUsable !== true) return { ok: false, reason: 'PAGE_STATE_STALE' };
        return { ok: true, reason: 'NONE' };
    }

    const api = {
        LIVEFLOW_MIN_READ_DELAY_MS,
        LIVEFLOW_MAX_TIMER_DELAY_MS,
        ChatMessage,
        extractChatMessagesFromResponse,
        extractContinuationFromResponse,
        extractContinuationInfoFromResponse,
        getContinuationTypes,
        extractInitialLiveChatContinuation,
        normalizeInternalApiContext,
        buildLiveChatReadRequest,
        summarizeLiveChatResponse,
        canAttemptOneShotRead,
        getPageRevisionState,
        canIssueSecondRead,
        getReadDelayMs,
        validateLiveChatReadResponse,
        isSuccessfulHttpStatus,
        canStartReadLoop,
        canScheduleNextRead,
        extractWatchTargetIdentity,
        evaluateBootstrapTarget,
        canEstablishPageLifecycle
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.LiveFlowChatReadCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
