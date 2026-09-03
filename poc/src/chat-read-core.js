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

    function inspectLiveChatBootstrap(initialData, playerResponse, maxDepth = 8) {
        const targetKeys = new Set([
            'liveChatRenderer',
            'liveChatContinuation',
            'continuationContents',
            'conversationBar',
            'reloadContinuationData',
            'invalidationContinuationData',
            'timedContinuationData',
            'nextContinuationData'
        ]);
        const records = [];
        const visited = new WeakSet();

        function walk(value, path, depth) {
            if (!value || typeof value !== 'object' || depth > maxDepth || visited.has(value)) return;
            visited.add(value);

            for (const [key, child] of Object.entries(value)) {
                const childPath = `${path}.${key}`;
                if (targetKeys.has(key)) {
                    records.push({
                        path: childPath,
                        key,
                        type: Array.isArray(child) ? 'array' : typeof child,
                        arrayLength: Array.isArray(child) ? child.length : null,
                        liveChatCandidate: childPath.includes('.liveChatRenderer') ||
                            childPath.includes('.liveChatContinuation') ||
                            childPath.includes('.continuationContents')
                    });
                }
                walk(child, childPath, depth + 1);
            }
        }

        walk(initialData, 'initialData', 0);
        walk(playerResponse, 'playerResponse', 0);
        const liveChatCandidates = records.filter((record) => record.liveChatCandidate);
        const continuationCandidates = liveChatCandidates.filter((record) => /ContinuationData$/.test(record.key));

        return {
            hasTwoColumnWatchNextResults: Boolean(initialData?.contents?.twoColumnWatchNextResults),
            hasSingleColumnWatchNextResults: Boolean(initialData?.contents?.singleColumnWatchNextResults),
            hasLiveChatRenderer: records.some((record) => record.key === 'liveChatRenderer'),
            liveChatCandidatePaths: liveChatCandidates.map((record) => record.path),
            continuationCandidateCount: continuationCandidates.length,
            continuationCandidateTypes: [...new Set(continuationCandidates.map((record) => record.key))],
            matchedPaths: records.map(({ path, key, type, arrayLength }) => ({ path, key, type, arrayLength }))
        };
    }

    function inspectGetWatchResponse(response, maxDepth = 8) {
        const result = inspectLiveChatBootstrap(response, null, maxDepth);
        return {
            source: 'get_watch',
            hasLiveChatRenderer: result.hasLiveChatRenderer,
            hasLiveChatContinuation: result.matchedPaths.some((record) => record.key === 'liveChatContinuation'),
            liveChatCandidateCount: result.continuationCandidateCount,
            liveChatCandidatePaths: result.liveChatCandidatePaths,
            continuationTypesUnderLiveChat: result.continuationCandidateTypes,
            matchedLiveChatKeys: result.matchedPaths
                .filter((record) => record.liveChatCandidate)
                .map(({ path, key, type, arrayLength }) => ({ path, key, type, arrayLength }))
        };
    }

    function extractYtInitialDataFromHtml(html) {
        if (typeof html !== 'string' || !html) return null;
        const marker = /(?:var\s+)?ytInitialData\s*=\s*/g;
        let match;

        while ((match = marker.exec(html)) !== null) {
            const start = html.indexOf('{', match.index + match[0].length);
            if (start < 0) continue;
            let depth = 0;
            let quote = '';
            let escaped = false;

            for (let index = start; index < html.length; index += 1) {
                const character = html[index];
                if (quote) {
                    if (escaped) escaped = false;
                    else if (character === '\\') escaped = true;
                    else if (character === quote) quote = '';
                    continue;
                }
                if (character === '"' || character === "'") {
                    quote = character;
                    continue;
                }
                if (character === '{') depth += 1;
                if (character === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        try {
                            return JSON.parse(html.slice(start, index + 1));
                        } catch (error) {
                            break;
                        }
                    }
                }
            }
        }

        return null;
    }

    function extractInnertubeContextFromHtml(html) {
        if (typeof html !== 'string' || !html) return null;
        const marker = /(?:"|')?INNERTUBE_CONTEXT(?:"|')?\s*[:=]\s*/g;
        let match;

        while ((match = marker.exec(html)) !== null) {
            const start = html.indexOf('{', match.index + match[0].length);
            if (start < 0) continue;
            let depth = 0;
            let quote = '';
            let escaped = false;

            for (let index = start; index < html.length; index += 1) {
                const character = html[index];
                if (quote) {
                    if (escaped) escaped = false;
                    else if (character === '\\') escaped = true;
                    else if (character === quote) quote = '';
                    continue;
                }
                if (character === '"' || character === "'") {
                    quote = character;
                    continue;
                }
                if (character === '{') depth += 1;
                if (character === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        try {
                            return normalizeInternalApiContext(JSON.parse(html.slice(start, index + 1)));
                        } catch (error) {
                            break;
                        }
                    }
                }
            }
        }

        return null;
    }

    function summarizePcWatchBootstrapHtml(html) {
        const initialData = extractYtInitialDataFromHtml(html);
        const result = inspectLiveChatBootstrap(initialData, null);
        const contextSummary = inspectPcContextBootstrapHtml(html);
        return {
            source: 'pc-watch-document',
            htmlAvailable: typeof html === 'string' && html.length > 0,
            ytInitialDataFound: Boolean(initialData),
            hasTwoColumnWatchNextResults: result.hasTwoColumnWatchNextResults,
            hasLiveChatRenderer: result.hasLiveChatRenderer,
            liveChatCandidatePaths: result.liveChatCandidatePaths,
            continuationCandidateCount: result.continuationCandidateCount,
            continuationCandidateTypes: result.continuationCandidateTypes,
            contextSummary
        };
    }

    function inspectPcContextBootstrapHtml(html) {
        const source = typeof html === 'string' ? html : '';
        const fieldNames = [
            'INNERTUBE_CONTEXT',
            'INNERTUBE_CONTEXT_CLIENT_NAME',
            'INNERTUBE_CONTEXT_CLIENT_VERSION',
            'VISITOR_DATA',
            'HL',
            'GL'
        ];
        const presentFields = fieldNames.filter((field) => source.includes(field));

        return {
            configMarkerPresent: /ytcfg(?:\.set|\.data_|\.get)/i.test(source),
            presentFields,
            contextObjectCandidate: presentFields.includes('INNERTUBE_CONTEXT')
        };
    }

    function summarizeYtInitialDataEmbedding(html) {
        const source = typeof html === 'string' ? html : '';
        const matches = source.match(/ytInitialData/g) || [];
        const markerIndex = source.indexOf('ytInitialData');
        const afterMarker = markerIndex >= 0 ? source.slice(markerIndex + 'ytInitialData'.length) : '';
        const firstNonWhitespace = afterMarker.match(/\S/)?.[0] || '';
        const scriptTypes = [];
        const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
        let scriptMatch;

        while ((scriptMatch = scriptPattern.exec(source)) !== null) {
            if (!scriptMatch[2].includes('ytInitialData')) continue;
            const typeMatch = scriptMatch[1].match(/\btype\s*=\s*["']([^"']+)["']/i);
            scriptTypes.push(typeMatch ? typeMatch[1].toLowerCase() : 'normal');
        }

        const tokenTypes = { '=': 'equals', ':': 'colon', '{': 'open-brace', '(': 'open-paren', '"': 'quote', "'": 'quote' };
        return {
            markerPresent: matches.length > 0,
            assignmentForms: {
                varAssignment: /\bvar\s+ytInitialData\s*=/.test(source),
                letAssignment: /\blet\s+ytInitialData\s*=/.test(source),
                constAssignment: /\bconst\s+ytInitialData\s*=/.test(source),
                bareAssignment: /(?:^|[^.\w])ytInitialData\s*=/.test(source),
                windowDotAssignment: /window\.ytInitialData\s*=/.test(source),
                windowBracketDoubleAssignment: /window\["ytInitialData"\]\s*=/.test(source),
                windowBracketSingleAssignment: /window\['ytInitialData'\]\s*=/.test(source),
                jsonParseAssignment: /JSON\.parse\s*\(\s*["']/i.test(source),
                applicationJsonCandidate: scriptTypes.includes('application/json')
            },
            markerOccurrenceBucket: matches.length > 1 ? 'multiple' : matches.length === 1 ? 'single' : 'none',
            objectStartFoundAfterMarker: markerIndex >= 0 && source.indexOf('{', markerIndex + 'ytInitialData'.length) >= 0,
            firstNonWhitespaceTokenType: tokenTypes[firstNonWhitespace] || (firstNonWhitespace ? 'other' : 'none'),
            scriptContextTypes: [...new Set(scriptTypes)]
        };
    }

    function summarizeWatchHtmlProfile(html) {
        const source = typeof html === 'string' ? html : '';
        const initialData = extractYtInitialDataFromHtml(source);
        const renderer = initialData?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
        const continuation = renderer?.continuations?.[0];
        const htmlLengthBucket = source.length < 100000 ? 'small' : source.length < 500000 ? 'medium' : 'large';

        return {
            htmlLengthBucket,
            hasYtInitialDataMarker: /(?:var\s+)?ytInitialData\s*=\s*/.test(source),
            ytInitialDataParseSucceeded: Boolean(initialData),
            hasTwoColumnWatchNextResults: Boolean(initialData?.contents?.twoColumnWatchNextResults),
            hasSingleColumnWatchNextResults: Boolean(initialData?.contents?.singleColumnWatchNextResults),
            hasConversationBar: Boolean(initialData?.contents?.twoColumnWatchNextResults?.conversationBar),
            hasLiveChatRenderer: Boolean(renderer),
            hasContinuationArray: Array.isArray(renderer?.continuations),
            hasReloadContinuationData: Boolean(continuation?.reloadContinuationData),
            hasInitialLiveChatContinuation: Boolean(continuation?.reloadContinuationData?.continuation),
            hasInnertubeContext: source.includes('INNERTUBE_CONTEXT'),
            hasYtcfg: /ytcfg(?:\.set|\.data_|\.get)/i.test(source),
            hasDesktopWatchMarkers: ['twoColumnWatchNextResults', 'ytd-watch-flexy', 'liveChatRenderer'].some((marker) => source.includes(marker)),
            hasMobileWatchMarkers: ['singleColumnWatchNextResults', 'slimVideoMetadataSectionRenderer'].some((marker) => source.includes(marker)),
            hasConsentMarker: /consent|consent\.youtube/i.test(source),
            hasLoginInterstitialMarker: /sign.?in|login|accounts\.google/i.test(source),
            hasErrorPageMarker: /error-page|video unavailable|this video is unavailable/i.test(source)
        };
    }

    function resolveInitialLiveChatContinuation({ isMobile, pageContinuation, bootstrapContinuation }) {
        const pageValue = typeof pageContinuation === 'string' ? pageContinuation : '';
        const bootstrapValue = typeof bootstrapContinuation === 'string' ? bootstrapContinuation : '';

        if (!isMobile && pageValue) {
            return { continuation: pageValue, source: 'page' };
        }
        if (isMobile && bootstrapValue) {
            return { continuation: bootstrapValue, source: 'pc-bootstrap' };
        }

        return null;
    }

    function canStartMobileBootstrapRead({ isMobile, pageKeyMatches, hasContinuation, hasContext, loopActive }) {
        return isMobile === true &&
            pageKeyMatches === true &&
            hasContinuation === true &&
            hasContext === true &&
            loopActive === false;
    }

    function summarizeLiveChatRequestProfile({ context, headers } = {}) {
        const contextValue = context && typeof context === 'object' ? context : {};
        const clientValue = contextValue.client && typeof contextValue.client === 'object'
            ? contextValue.client
            : {};
        const headerNames = headers && typeof headers === 'object'
            ? Object.keys(headers).map((name) => name.toLowerCase()).sort()
            : [];

        return {
            contextRootFields: Object.keys(contextValue).sort(),
            clientFields: Object.keys(clientValue).sort(),
            headerNames
        };
    }

    function compareLiveChatRequestProfiles(pcProfile = {}, mobileProfile = {}) {
        const difference = (left = [], right = []) => left.filter((field) => !right.includes(field));
        return {
            onlyInPcContextRoot: difference(pcProfile.contextRootFields, mobileProfile.contextRootFields),
            onlyInMobileContextRoot: difference(mobileProfile.contextRootFields, pcProfile.contextRootFields),
            onlyInPcClient: difference(pcProfile.clientFields, mobileProfile.clientFields),
            onlyInMobileClient: difference(mobileProfile.clientFields, pcProfile.clientFields),
            onlyInPcHeaders: difference(pcProfile.headerNames, mobileProfile.headerNames),
            onlyInMobileHeaders: difference(mobileProfile.headerNames, pcProfile.headerNames)
        };
    }

    function findContinuationInObject(value, path = 'root', visited = new WeakSet()) {
        if (!value || typeof value !== 'object') {
            return null;
        }

        if (visited.has(value)) {
            return null;
        }
        visited.add(value);

        if (typeof value.continuation === 'string' && value.continuation) {
            return { value: value.continuation, path };
        }

        for (const [key, child] of Object.entries(value)) {
            const result = findContinuationInObject(child, `${path}.${key}`, visited);
            if (result) {
                return result;
            }
        }

        return null;
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
        getReadDelayMs,
        inspectLiveChatBootstrap,
        inspectGetWatchResponse,
        extractYtInitialDataFromHtml,
        extractInnertubeContextFromHtml,
        inspectPcContextBootstrapHtml,
        summarizeYtInitialDataEmbedding,
        summarizeWatchHtmlProfile,
        summarizePcWatchBootstrapHtml,
        resolveInitialLiveChatContinuation,
        canStartMobileBootstrapRead,
        summarizeLiveChatRequestProfile,
        compareLiveChatRequestProfiles,
        findContinuationInObject
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    global.LiveFlowChatReadCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
