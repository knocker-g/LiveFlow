(function (global) {
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
        const continuationTypes = [
            'nextContinuationData',
            'invalidationContinuationData',
            'timedContinuationData',
            'reloadContinuationData'
        ];

        for (const type of continuationTypes) {
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
        const types = ['nextContinuationData', 'invalidationContinuationData', 'timedContinuationData', 'reloadContinuationData'];

        return types.filter((type) => continuations.some((continuation) => Boolean(continuation?.[type])));
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

    function getReadDelayMs(timeoutMs, minimumMs = 100, fallbackMs = 1000) {
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
            return fallbackMs;
        }

        return Math.max(timeoutMs, minimumMs);
    }

    const api = {
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
        getReadDelayMs
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.LiveFlowChatReadCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
