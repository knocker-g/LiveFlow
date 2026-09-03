const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_VISIBLE_MESSAGES, mergeMessagesById, getVisibleMessages, formatMessageText } = require('../src/overlay-core.js');

const { ChatMessage, extractChatMessagesFromResponse, extractContinuationFromResponse, extractContinuationInfoFromResponse, getContinuationTypes, extractInitialLiveChatContinuation, normalizeInternalApiContext, buildLiveChatReadRequest, summarizeLiveChatResponse, canAttemptOneShotRead, getPageRevisionState, canIssueSecondRead, getReadDelayMs, inspectLiveChatBootstrap, inspectGetWatchResponse, extractYtInitialDataFromHtml, extractInnertubeContextFromHtml, inspectPcContextBootstrapHtml, summarizePcWatchBootstrapHtml, summarizeWatchHtmlProfile, summarizeYtInitialDataEmbedding, resolveInitialLiveChatContinuation, canStartMobileBootstrapRead, summarizeLiveChatRequestProfile, compareLiveChatRequestProfiles, findContinuationInObject } = require('../src/chat-read-core.js');

const sampleResponse = {
    continuationContents: {
        liveChatContinuation: {
            actions: [
                {
                    addChatItemAction: {
                        item: {
                            liveChatTextMessageRenderer: {
                                id: 'msg-1',
                                timestampUsec: '1710000000000000',
                                authorName: { simpleText: 'Alice' },
                                authorExternalChannelId: 'UC-abc',
                                authorPhoto: { thumbnails: [{ url: 'https://example.com/a.jpg' }] },
                                authorBadges: [{ liveChatAuthorBadgeRenderer: { tooltip: 'member' } }],
                                message: {
                                    runs: [{ text: 'Hello' }, { text: ' world' }]
                                }
                            }
                        }
                    }
                }
            ],
            continuations: [
                { nextContinuationData: { continuation: 'next-token-1' } }
            ]
        }
    }
};

test('ChatMessage converts text message renderer into model', () => {
    const renderer = sampleResponse.continuationContents.liveChatContinuation.actions[0].addChatItemAction.item.liveChatTextMessageRenderer;
    const message = ChatMessage.fromRenderer(renderer);

    assert.equal(message.id, 'msg-1');
    assert.equal(message.authorName, 'Alice');
    assert.equal(message.message, 'Hello world');
    assert.equal(message.timestampUsec, '1710000000000000');
    assert.equal(message.authorPhoto, 'https://example.com/a.jpg');
    assert.equal(message.badges.length, 1);
    assert.equal(message.messageType, 'text');
    assert.equal(message.authorExternalChannelId, 'UC-abc');
});

test('extractChatMessagesFromResponse returns chat data from measured response format', () => {
    const messages = extractChatMessagesFromResponse(sampleResponse);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].message, 'Hello world');
    assert.equal(messages[0].authorName, 'Alice');
});

test('extractContinuationFromResponse reads next continuation without exposing token in logs', () => {
    const continuation = extractContinuationFromResponse(sampleResponse);

    assert.equal(continuation, 'next-token-1');
});

test('extractContinuationFromResponse supports every measured continuation data type', () => {
    for (const type of ['nextContinuationData', 'invalidationContinuationData', 'timedContinuationData', 'reloadContinuationData']) {
        const response = { continuationContents: { liveChatContinuation: { continuations: [{ [type]: { continuation: 'dummy-token', timeoutMs: 1200 } }] } } };
        assert.equal(extractContinuationFromResponse(response), 'dummy-token');
        assert.deepEqual(extractContinuationInfoFromResponse(response), { continuation: 'dummy-token', timeoutMs: 1200, type });
        assert.deepEqual(getContinuationTypes(response), [type]);
    }
});

test('extractContinuationFromResponse returns null when no supported continuation exists', () => {
    assert.equal(extractContinuationFromResponse({ continuationContents: { liveChatContinuation: { continuations: [{}] } } }), null);
    assert.equal(extractContinuationInfoFromResponse({}), null);
    assert.deepEqual(getContinuationTypes({}), []);
});

test('extractContinuationInfoFromResponse ignores invalid timeout values', () => {
    const response = { continuationContents: { liveChatContinuation: { continuations: [{ invalidationContinuationData: { continuation: 'dummy-token', timeoutMs: '1200' } }] } } };
    assert.deepEqual(extractContinuationInfoFromResponse(response), { continuation: 'dummy-token', timeoutMs: null, type: 'invalidationContinuationData' });
});

test('findContinuationInObject reports the source path while keeping the token in memory', () => {
    const result = findContinuationInObject({
        engagementPanels: [{
            liveChatPanel: {
                continuation: 'initial-token-1'
            }
        }]
    });

    assert.equal(result.path, 'root.engagementPanels.0.liveChatPanel');
    assert.equal(result.value, 'initial-token-1');
});

test('extractInitialLiveChatContinuation reads the measured PC page-data path', () => {
    const initialData = {
        contents: {
            twoColumnWatchNextResults: {
                conversationBar: {
                    liveChatRenderer: {
                        continuations: [{
                            reloadContinuationData: { continuation: 'initial-token-1' }
                        }]
                    }
                }
            }
        }
    };

    assert.equal(extractInitialLiveChatContinuation(initialData), 'initial-token-1');
});

test('extractInitialLiveChatContinuation safely returns empty for missing renderer', () => {
    assert.equal(extractInitialLiveChatContinuation({ contents: {} }), '');
});

test('extractInitialLiveChatContinuation safely returns empty for empty continuations', () => {
    assert.equal(extractInitialLiveChatContinuation({
        contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: { continuations: [] } } } }
    }), '');
});

test('extractInitialLiveChatContinuation safely returns empty without reload data', () => {
    assert.equal(extractInitialLiveChatContinuation({
        contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: { continuations: [{}] } } } }
    }), '');
});

test('normalizeInternalApiContext keeps supported client fields from INNERTUBE_CONTEXT', () => {
    const context = normalizeInternalApiContext({
        client: {
            clientName: 'WEB',
            clientVersion: 'test-version',
            hl: 'ja',
            gl: 'JP',
            visitorData: 'dummy-visitor-data',
            browserName: 'Chrome'
        },
        ignoredSecretLikeField: 'not-copied'
    });

    assert.deepEqual(context, {
        client: {
            clientName: 'WEB',
            clientVersion: 'test-version',
            hl: 'ja',
            gl: 'JP',
            visitorData: 'dummy-visitor-data',
            browserName: 'Chrome'
        }
    });
    assert.equal(context.ignoredSecretLikeField, undefined);
});

test('normalizeInternalApiContext accepts a client-shaped ytcfg fallback', () => {
    assert.deepEqual(normalizeInternalApiContext({
        clientName: 'WEB',
        clientVersion: 'test-version',
        hl: 'ja'
    }), {
        client: {
            clientName: 'WEB',
            clientVersion: 'test-version',
            hl: 'ja'
        }
    });
});

test('normalizeInternalApiContext safely returns null for missing config', () => {
    assert.equal(normalizeInternalApiContext(null), null);
    assert.equal(normalizeInternalApiContext({}), null);
});

test('buildLiveChatReadRequest requires context and continuation', () => {
    const request = buildLiveChatReadRequest({ client: { clientName: 'WEB' } }, 'dummy-continuation');

    assert.deepEqual(request, {
        context: { client: { clientName: 'WEB' } },
        continuation: 'dummy-continuation'
    });
    assert.equal(buildLiveChatReadRequest(null, 'dummy-continuation'), null);
    assert.equal(buildLiveChatReadRequest({ client: {} }, ''), null);
});

test('summarizeLiveChatResponse reports structure without exposing response values', () => {
    assert.deepEqual(summarizeLiveChatResponse(sampleResponse), {
        liveChatContinuation: true,
        actions: true,
        actionCount: 1,
        continuations: true,
        nextContinuationAvailable: true,
        continuationTypes: ['nextContinuationData']
    });
    assert.deepEqual(summarizeLiveChatResponse({}), {
        liveChatContinuation: false,
        actions: false,
        actionCount: 0,
        continuations: false,
        nextContinuationAvailable: false,
        continuationTypes: []
    });
});

test('canAttemptOneShotRead permits a new revision and rejects duplicate attempts', () => {
    assert.equal(canAttemptOneShotRead(1, -1), true);
    assert.equal(canAttemptOneShotRead(1, 1), false);
    assert.equal(canAttemptOneShotRead(0, 0), false);
    assert.equal(canAttemptOneShotRead('1', -1), false);
});

test('getPageRevisionState does not change revision for duplicate same-URL events', () => {
    assert.deepEqual(getPageRevisionState('watch-a', 3, 'watch-a'), {
        key: 'watch-a', revision: 3, changed: false
    });
    assert.deepEqual(getPageRevisionState('watch-a', 3, 'watch-b'), {
        key: 'watch-b', revision: 4, changed: true
    });
});

test('canIssueSecondRead requires a successful parsed first response with next continuation', () => {
    const valid = {
        firstOk: true,
        responseParsed: true,
        hasNextContinuation: true,
        responseRevision: 2,
        currentRevision: 2,
        readCount: 1
    };

    assert.equal(canIssueSecondRead(valid), true);
    assert.equal(canIssueSecondRead({ ...valid, firstOk: false }), false);
    assert.equal(canIssueSecondRead({ ...valid, responseParsed: false }), false);
    assert.equal(canIssueSecondRead({ ...valid, hasNextContinuation: false }), false);
    assert.equal(canIssueSecondRead({ ...valid, responseRevision: 1 }), false);
    assert.equal(canIssueSecondRead({ ...valid, readCount: 2 }), false);
});

test('getReadDelayMs respects valid timeout and safely handles invalid values', () => {
    assert.equal(getReadDelayMs(1500), 1500);
    assert.equal(getReadDelayMs(0), 100);
    assert.equal(getReadDelayMs(-1), 1000);
    assert.equal(getReadDelayMs(Number.NaN), 1000);
    assert.equal(getReadDelayMs('1500'), 1000);
});

test('inspectLiveChatBootstrap detects the PC live chat renderer path without values', () => {
    const result = inspectLiveChatBootstrap({
        contents: {
            twoColumnWatchNextResults: {
                conversationBar: {
                    liveChatRenderer: {
                        continuations: [{ reloadContinuationData: { continuation: 'secret-value' } }]
                    }
                }
            }
        }
    }, null);

    assert.equal(result.hasTwoColumnWatchNextResults, true);
    assert.equal(result.hasLiveChatRenderer, true);
    assert.equal(result.continuationCandidateCount, 1);
    assert.deepEqual(result.continuationCandidateTypes, ['reloadContinuationData']);
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('inspectLiveChatBootstrap detects Mobile single-column state without a live chat candidate', () => {
    const result = inspectLiveChatBootstrap({
        contents: {
            singleColumnWatchNextResults: {
                results: { results: { continuations: [{ reloadContinuationData: { continuation: 'secret-value' } }] } }
            }
        }
    }, null);

    assert.equal(result.hasSingleColumnWatchNextResults, true);
    assert.equal(result.hasLiveChatRenderer, false);
    assert.equal(result.continuationCandidateCount, 0);
    assert.deepEqual(result.liveChatCandidatePaths, []);
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('inspectLiveChatBootstrap is cycle-safe and honors max depth', () => {
    const cyclic = { liveChatRenderer: {} };
    cyclic.self = cyclic;
    const result = inspectLiveChatBootstrap(cyclic, null, 0);

    assert.equal(result.matchedPaths.length, 1);
    assert.equal(result.matchedPaths[0].path, 'initialData.liveChatRenderer');
});

test('inspectGetWatchResponse reports only Live Chat ancestry and never values', () => {
    const result = inspectGetWatchResponse({
        continuationContents: { liveChatContinuation: { continuations: [{ timedContinuationData: { continuation: 'secret-value' } }] } },
        unrelated: { reloadContinuationData: { continuation: 'other-secret' } }
    });

    assert.equal(result.source, 'get_watch');
    assert.equal(result.hasLiveChatContinuation, true);
    assert.equal(result.liveChatCandidateCount, 1);
    assert.deepEqual(result.continuationTypesUnderLiveChat, ['timedContinuationData']);
    assert.equal(result.matchedLiveChatKeys.some((item) => item.key === 'reloadContinuationData' && item.path.startsWith('initialData.unrelated')), false);
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
    assert.equal(JSON.stringify(result).includes('other-secret'), false);
});

test('extractYtInitialDataFromHtml safely extracts bootstrap JSON without executing it', () => {
    const html = '<script>var ytInitialData = {"contents":{"twoColumnWatchNextResults":{"conversationBar":{"liveChatRenderer":{"continuations":[{"reloadContinuationData":{"continuation":"secret-value"}}]}}}}};</script>';
    const data = extractYtInitialDataFromHtml(html);
    assert.equal(data.contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer !== undefined, true);
    assert.equal(summarizePcWatchBootstrapHtml(html).hasLiveChatRenderer, true);
    assert.equal(JSON.stringify(summarizePcWatchBootstrapHtml(html)).includes('secret-value'), false);
});

test('HTML bootstrap parser safely handles malformed and missing input', () => {
    assert.equal(extractYtInitialDataFromHtml('<script>var ytInitialData = {"contents":</script>'), null);
    assert.equal(extractYtInitialDataFromHtml('<html></html>'), null);
    assert.equal(summarizePcWatchBootstrapHtml(null).ytInitialDataFound, false);
});

test('inspectPcContextBootstrapHtml reports context keys without exposing values', () => {
    const result = inspectPcContextBootstrapHtml('ytcfg.set({INNERTUBE_CONTEXT:{client:{clientName:"WEB",visitorData:"secret"}},HL:"ja"});');
    assert.equal(result.configMarkerPresent, true);
    assert.deepEqual(result.presentFields, ['INNERTUBE_CONTEXT', 'HL']);
    assert.equal(result.contextObjectCandidate, true);
    assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('inspectPcContextBootstrapHtml returns false markers when HTML has no context bootstrap', () => {
    assert.deepEqual(inspectPcContextBootstrapHtml('<html><body>video</body></html>'), {
        configMarkerPresent: false,
        presentFields: [],
        contextObjectCandidate: false
    });
});

test('summarizeYtInitialDataEmbedding identifies assignment forms without source values', () => {
    const fixtures = [
        ['var ytInitialData = {"safe":true};', 'varAssignment'],
        ['let ytInitialData = {"safe":true};', 'letAssignment'],
        ['const ytInitialData = {"safe":true};', 'constAssignment'],
        ['ytInitialData = {"safe":true};', 'bareAssignment'],
        ['window.ytInitialData = {"safe":true};', 'windowDotAssignment'],
        ['window["ytInitialData"] = {"safe":true};', 'windowBracketDoubleAssignment'],
        ["window['ytInitialData'] = {\"safe\":true};", 'windowBracketSingleAssignment']
    ];
    fixtures.forEach(([html, key]) => {
        const result = summarizeYtInitialDataEmbedding(`<script>${html}</script>`);
        assert.equal(result.markerPresent, true);
        assert.equal(result.assignmentForms[key], true);
        assert.equal(result.objectStartFoundAfterMarker, true);
        assert.deepEqual(result.scriptContextTypes, ['normal']);
        assert.equal(JSON.stringify(result).includes('safe'), false);
    });
});

test('summarizeYtInitialDataEmbedding detects JSON.parse, application/json, malformed and missing HTML', () => {
    const result = summarizeYtInitialDataEmbedding('<script type="application/json">{"ytInitialData":{}}</script><script>var ytInitialData = JSON.parse("safe")</script>');
    assert.equal(result.assignmentForms.jsonParseAssignment, true);
    assert.equal(result.assignmentForms.applicationJsonCandidate, true);
    assert.deepEqual(result.scriptContextTypes, ['application/json', 'normal']);
    assert.equal(result.markerOccurrenceBucket, 'multiple');
    assert.equal(summarizeYtInitialDataEmbedding('<script>var ytInitialData = {').markerPresent, true);
    assert.equal(summarizeYtInitialDataEmbedding('<html></html>').markerPresent, false);
});

test('summarizeWatchHtmlProfile reports desktop bootstrap structure without values', () => {
    const summary = summarizeWatchHtmlProfile('<script>var ytInitialData = {"contents":{"twoColumnWatchNextResults":{"conversationBar":{"liveChatRenderer":{"continuations":[{"reloadContinuationData":{"continuation":"secret"}}]}}}}};</script>ytd-watch-flexy INNERTUBE_CONTEXT ytcfg.set');
    assert.equal(summary.htmlLengthBucket, 'small');
    assert.equal(summary.hasYtInitialDataMarker, true);
    assert.equal(summary.ytInitialDataParseSucceeded, true);
    assert.equal(summary.hasTwoColumnWatchNextResults, true);
    assert.equal(summary.hasConversationBar, true);
    assert.equal(summary.hasLiveChatRenderer, true);
    assert.equal(summary.hasContinuationArray, true);
    assert.equal(summary.hasReloadContinuationData, true);
    assert.equal(summary.hasInitialLiveChatContinuation, true);
    assert.equal(summary.hasDesktopWatchMarkers, true);
    assert.equal(summary.hasInnertubeContext, true);
    assert.equal(JSON.stringify(summary).includes('secret'), false);
});

test('summarizeWatchHtmlProfile distinguishes mobile structure and malformed HTML safely', () => {
    const mobile = summarizeWatchHtmlProfile('<script>var ytInitialData = {"contents":{"singleColumnWatchNextResults":{}}};</script>singleColumnWatchNextResults slimVideoMetadataSectionRenderer');
    assert.equal(mobile.hasSingleColumnWatchNextResults, true);
    assert.equal(mobile.hasTwoColumnWatchNextResults, false);
    assert.equal(mobile.hasLiveChatRenderer, false);
    assert.equal(mobile.hasMobileWatchMarkers, true);
    assert.equal(summarizeWatchHtmlProfile('<script>var ytInitialData = {"contents":</script>').ytInitialDataParseSucceeded, false);
});

test('extractInnertubeContextFromHtml extracts and normalizes context without executing HTML', () => {
    const context = extractInnertubeContextFromHtml('ytcfg.set({"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"dummy","visitorData":"secret"}}});');
    assert.deepEqual(context, { client: { clientName: 'WEB', clientVersion: 'dummy', visitorData: 'secret' } });
});

test('extractInnertubeContextFromHtml safely handles malformed and missing HTML', () => {
    assert.equal(extractInnertubeContextFromHtml('INNERTUBE_CONTEXT: {"client":'), null);
    assert.equal(extractInnertubeContextFromHtml('<html></html>'), null);
});

test('resolveInitialLiveChatContinuation selects the PC or Mobile bootstrap source', () => {
    assert.equal(resolveInitialLiveChatContinuation({ isMobile: false, pageContinuation: 'page-token', bootstrapContinuation: 'pc-token' }).source, 'page');
    assert.equal(resolveInitialLiveChatContinuation({ isMobile: true, pageContinuation: '', bootstrapContinuation: 'pc-token' }).source, 'pc-bootstrap');
    assert.equal(resolveInitialLiveChatContinuation({ isMobile: true, pageContinuation: 'page-token', bootstrapContinuation: '' }), null);
    assert.equal(JSON.stringify(resolveInitialLiveChatContinuation({ isMobile: true, pageContinuation: '', bootstrapContinuation: 'secret-token' })).includes('secret-token'), true);
});

test('canStartMobileBootstrapRead requires the current page and an inactive loop', () => {
    const valid = { isMobile: true, pageKeyMatches: true, hasContinuation: true, hasContext: true, loopActive: false };
    assert.equal(canStartMobileBootstrapRead(valid), true);
    assert.equal(canStartMobileBootstrapRead({ ...valid, isMobile: false }), false);
    assert.equal(canStartMobileBootstrapRead({ ...valid, pageKeyMatches: false }), false);
    assert.equal(canStartMobileBootstrapRead({ ...valid, hasContinuation: false }), false);
    assert.equal(canStartMobileBootstrapRead({ ...valid, hasContext: false }), false);
    assert.equal(canStartMobileBootstrapRead({ ...valid, loopActive: true }), false);
});

test('summarizeLiveChatRequestProfile returns field names only', () => {
    const profile = summarizeLiveChatRequestProfile({
        context: {
            adSignalsInfo: { value: 'ignored' },
            client: {
                clientName: 'WEB',
                clientVersion: 'dummy-version',
                visitorData: 'dummy-visitor-data'
            },
            request: {},
            user: {},
            webClientInfo: {}
        },
        headers: {
            'Content-Type': 'application/json',
            Origin: 'https://www.youtube.com',
            Authorization: 'secret'
        }
    });

    assert.deepEqual(profile, {
        contextRootFields: ['adSignalsInfo', 'client', 'request', 'user', 'webClientInfo'],
        clientFields: ['clientName', 'clientVersion', 'visitorData'],
        headerNames: ['authorization', 'content-type', 'origin']
    });
    assert.equal(JSON.stringify(profile).includes('secret'), false);
    assert.equal(JSON.stringify(profile).includes('dummy'), false);
});

test('compareLiveChatRequestProfiles returns PC/mobile field differences only', () => {
    assert.deepEqual(compareLiveChatRequestProfiles(
        {
            contextRootFields: ['adSignalsInfo', 'client', 'request'],
            clientFields: ['clientName', 'clientVersion', 'gl', 'visitorData'],
            headerNames: ['content-type', 'origin', 'x-youtube-client-name']
        },
        {
            contextRootFields: ['client'],
            clientFields: ['clientName', 'clientVersion', 'hl'],
            headerNames: ['content-type']
        }
    ), {
        onlyInPcContextRoot: ['adSignalsInfo', 'request'],
        onlyInMobileContextRoot: [],
        onlyInPcClient: ['gl', 'visitorData'],
        onlyInMobileClient: ['hl'],
        onlyInPcHeaders: ['origin', 'x-youtube-client-name'],
        onlyInMobileHeaders: []
    });
});

test('overlay helpers deduplicate messages and retain the newest bounded history', () => {
    const messages = mergeMessagesById([{ id: 'a', message: 'old' }], [{ id: 'a', message: 'duplicate' }, { id: 'b', message: 'new' }], 2);
    assert.deepEqual(messages, [{ id: 'a', message: 'old' }, { id: 'b', message: 'new' }]);
});

test('overlay helpers select newest non-empty messages and format author safely', () => {
    const messages = getVisibleMessages([{ id: 'a', message: '' }, { id: 'b', authorName: '', message: 'hello' }, { id: 'c', authorName: 'Alice', message: 'world' }], MAX_VISIBLE_MESSAGES);
    assert.deepEqual(messages.map(formatMessageText), ['hello', 'Alice: world']);
});

test('overlay helpers cap visible messages', () => {
    const messages = Array.from({ length: 25 }, (_, index) => ({ id: String(index), message: String(index) }));
    assert.equal(getVisibleMessages(messages, MAX_VISIBLE_MESSAGES).length, 20);
    assert.equal(getVisibleMessages(messages, MAX_VISIBLE_MESSAGES)[0].id, '5');
});
