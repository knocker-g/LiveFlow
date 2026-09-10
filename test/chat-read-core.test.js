const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MAX_VISIBLE_MESSAGES, mergeMessagesById, getVisibleMessages, formatMessageText } = require('../src/overlay-core.js');

const { ChatMessage, normalizeMessageRuns, extractChatMessagesFromResponse, extractContinuationFromResponse, extractContinuationInfoFromResponse, getContinuationTypes, extractInitialLiveChatContinuation, normalizeInternalApiContext, buildLiveChatReadRequest, summarizeLiveChatResponse, canAttemptOneShotRead, getPageRevisionState, canIssueSecondRead, getReadDelayMs, validateLiveChatReadResponse, isSuccessfulHttpStatus, canStartReadLoop, canScheduleNextRead, extractWatchTargetIdentity, evaluateBootstrapTarget, canEstablishPageLifecycle, canReevaluatePageLifecycle, canSignalOwnershipReevaluation, LIVEFLOW_MIN_READ_DELAY_MS, LIVEFLOW_MAX_TIMER_DELAY_MS } = require('../src/chat-read-core.js');

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
    assert.deepEqual(message.authorBadges, ['member']);
    assert.equal(message.messageType, 'text');
    assert.equal(message.authorRole, 'guest');
    assert.deepEqual(message.messageRuns, [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }]);
    assert.equal(message.authorExternalChannelId, 'UC-abc');
});

test('text renderer normalization ignores malformed runs and safely falls back to Guest', () => {
    const message = ChatMessage.fromRenderer({
        id: 'mixed',
        authorName: { runs: [{ text: 'Bob' }] },
        message: { runs: [{ text: 'safe' }, null, { emoji: { image: {} } }, { text: ' text' }] },
        authorPhoto: { thumbnails: [] }
    });
    assert.equal(message.message, 'safe text');
    assert.deepEqual(message.messageRuns, [{ type: 'text', text: 'safe' }, { type: 'text', text: ' text' }]);
    assert.equal(message.authorPhoto, '');
    assert.equal(message.authorRole, 'guest');
});

test('unknown and malformed renderer actions are ignored', () => {
    const response = {
        continuationContents: { liveChatContinuation: { actions: [
            { addChatItemAction: { item: { unknownRenderer: { id: 'unknown' } } } },
            { replaceChatItemAction: { replacementItem: {} } },
            null
        ] } }
    };
    assert.deepEqual(extractChatMessagesFromResponse(response), []);
});

test('observed text runs preserve mixed text and custom emoji order', () => {
    const runs = normalizeMessageRuns([
        { text: 'before' },
        { emoji: { image: { thumbnails: [{ url: 'https://example.com/emoji.png' }], accessibility: { accessibilityData: { label: 'wave' } } }, shortcuts: [':wave:'], isCustomEmoji: true } },
        { text: 'after' }
    ]);
    assert.deepEqual(runs, [
        { type: 'text', text: 'before' },
        { type: 'image', url: 'https://example.com/emoji.png', alt: 'wave', isCustomEmoji: true },
        { type: 'text', text: 'after' }
    ]);
});

test('emoji normalization rejects malformed and unsafe images and uses observed shortcut fallback', () => {
    assert.deepEqual(normalizeMessageRuns([
        { emoji: { image: { thumbnails: [{ url: 'javascript:alert(1)' }] }, shortcuts: [':bad:'] } },
        { emoji: { image: { thumbnails: [{ url: 'https://example.com/safe.png' }] }, shortcuts: [':safe:'] } },
        { emoji: null }
    ]), [{ type: 'image', url: 'https://example.com/safe.png', alt: ':safe:', isCustomEmoji: false }]);
    assert.equal(normalizeMessageRuns([{ emoji: { image: { thumbnails: [{ url: 'https://example.com/safe.png' }] }, shortcuts: ['x'.repeat(500)] } }])[0].alt.length, 160);
});

test('observed Super Chat renderer normalizes amount, author, runs, avatar, and colors', () => {
    const response = { continuationContents: { liveChatContinuation: { actions: [{ addChatItemAction: { item: {
        liveChatPaidMessageRenderer: {
            id: 'paid', timestampUsec: '1', authorName: { simpleText: 'Alice' },
            authorPhoto: { thumbnails: [{ url: 'https://example.com/avatar.png' }] },
            purchaseAmountText: { simpleText: '$5' }, message: { runs: [{ text: 'Thanks' }] },
            headerBackgroundColor: 0xff112233, bodyTextColor: 0xffffffff,
            trackingParams: 'ignored', contextMenuEndpoint: { ignored: true }
        }
    } } }] } } };
    const [message] = extractChatMessagesFromResponse(response);
    assert.equal(message.messageType, 'superChat');
    assert.equal(message.authorName, 'Alice');
    assert.equal(message.purchaseAmountText, '$5');
    assert.equal(message.message, 'Thanks');
    assert.equal(message.authorPhoto, 'https://example.com/avatar.png');
    assert.deepEqual(message.colors, { headerBackgroundColor: 0xff112233, bodyTextColor: 0xffffffff });
    assert.equal('trackingParams' in message, false);
    assert.equal('contextMenuEndpoint' in message, false);
});

test('observed Super Sticker renderer normalizes bounded image source data', () => {
    const response = { continuationContents: { liveChatContinuation: { actions: [{ addChatItemAction: { item: {
        liveChatPaidStickerRenderer: {
            id: 'sticker', authorName: { simpleText: 'Bob' }, purchaseAmountText: { simpleText: '$2' },
            sticker: { thumbnails: [{ url: 'https://example.com/sticker.png' }], accessibility: { accessibilityData: { label: 'celebration' } } },
            backgroundColor: 0xff334455
        }
    } } }] } } };
    const [message] = extractChatMessagesFromResponse(response);
    assert.equal(message.messageType, 'superSticker');
    assert.equal(message.purchaseAmountText, '$2');
    assert.deepEqual(message.sticker, { url: 'https://example.com/sticker.png', alt: 'celebration' });
    assert.deepEqual(message.colors, { backgroundColor: 0xff334455 });
});

test('malformed sticker, ticker duplicate, gift view model, and unknown renderer fail safe', () => {
    const response = { continuationContents: { liveChatContinuation: { actions: [
        { addChatItemAction: { item: { liveChatPaidStickerRenderer: { id: 'bad', sticker: { thumbnails: [{ url: 'data:image/png;base64,bad' }] } } } } },
        { addLiveChatTickerItemAction: { item: { liveChatTickerPaidMessageItemRenderer: { showLiveChatItemEndpoint: { renderer: { liveChatPaidMessageRenderer: { id: 'ticker' } } } } } } },
        { addChatItemAction: { item: { giftMessageViewModel: { id: 'gift' } } } },
        { addChatItemAction: { item: { unknownRenderer: { id: 'unknown' } } } }
    ] } } };
    const messages = extractChatMessagesFromResponse(response);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].messageType, 'superSticker');
    assert.equal(messages[0].sticker, null);
    assert.equal(messages.some((message) => message.id === 'ticker' || message.id === 'gift'), false);
});

test('normalized special fields cross the existing bridge without raw response fields', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/page-state-main.js'), 'utf8');
    for (const field of ['purchaseAmountText', 'sticker', 'colors']) assert.match(source, new RegExp(`${field}: message\\.${field}`));
    assert.doesNotMatch(source, /trackingParams: message|contextMenuEndpoint: message|clickTrackingParams: message/);
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

test('watch target identity distinguishes watch and live targets without exposing it to diagnostics', () => {
    assert.equal(extractWatchTargetIdentity('https://www.youtube.com/watch?v=target-a'), 'target-a');
    assert.equal(extractWatchTargetIdentity('https://www.youtube.com/live/target-b?feature=share'), 'target-b');
    assert.equal(extractWatchTargetIdentity('https://example.com/watch?v=target-a'), '');
    assert.equal(extractWatchTargetIdentity('not a target'), '');
});

test('bootstrap ownership requires the authoritative snapshot target to match', () => {
    assert.deepEqual(evaluateBootstrapTarget('target-b', 'target-b', ['target-a', 'target-b']), {
        available: true,
        matched: true,
        supportingCandidateCount: 2,
        supportingMatchCount: 1
    });
    assert.deepEqual(evaluateBootstrapTarget('target-b', 'target-a', ['target-b']), {
        available: true,
        matched: false,
        supportingCandidateCount: 1,
        supportingMatchCount: 1
    });
    assert.deepEqual(evaluateBootstrapTarget('target-b', '', ['target-b']), {
        available: false,
        matched: false,
        supportingCandidateCount: 1,
        supportingMatchCount: 1
    });
    assert.deepEqual(evaluateBootstrapTarget('', 'target-b', []), {
        available: false,
        matched: false,
        supportingCandidateCount: 0,
        supportingMatchCount: 0
    });
});

test('stale supporting candidates cannot permanently block an authoritative new-page bootstrap', () => {
    const transitional = evaluateBootstrapTarget('target-b', 'target-a', ['target-a', 'target-b']);
    assert.equal(transitional.matched, false);

    const established = evaluateBootstrapTarget('target-b', 'target-b', ['target-a', 'target-b']);
    assert.equal(established.matched, true);
    assert.equal(established.supportingCandidateCount, 2);
    assert.equal(established.supportingMatchCount, 1);
});

test('SPA lifecycle fails closed until target change, fresh page data, and matching bootstrap are established', () => {
    const valid = {
        navigationPending: true,
        pageDataUpdated: true,
        navigationTargetMatched: true,
        pageTargetChanged: true,
        bootstrapTargetMatched: true,
        pageStateUsable: true
    };
    assert.deepEqual(canEstablishPageLifecycle(valid), { ok: true, reason: 'NONE' });
    assert.equal(canEstablishPageLifecycle({ ...valid, pageDataUpdated: false }).reason, 'NAVIGATION_PENDING');
    assert.equal(canEstablishPageLifecycle({ ...valid, navigationTargetMatched: false }).reason, 'NAVIGATION_TARGET_MISMATCH');
    assert.equal(canEstablishPageLifecycle({ ...valid, pageTargetChanged: false }).reason, 'TARGET_UNCHANGED');
    assert.equal(canEstablishPageLifecycle({ ...valid, bootstrapTargetMatched: false }).reason, 'BOOTSTRAP_TARGET_MISMATCH');
    assert.equal(canEstablishPageLifecycle({ ...valid, pageStateUsable: false }).reason, 'PAGE_STATE_STALE');
});

test('pending SPA lifecycle reevaluates only on page-data or a later navigation-finish signal', () => {
    const pending = { navigationPending: true, pageDataUpdatedSeen: false, pageDataUpdated: false, navigationFinished: false };
    assert.equal(canReevaluatePageLifecycle(pending), false);
    assert.equal(canReevaluatePageLifecycle({ ...pending, navigationFinished: true }), false);
    assert.equal(canReevaluatePageLifecycle({ ...pending, pageDataUpdated: true }), true);
    assert.equal(canReevaluatePageLifecycle({ ...pending, pageDataUpdatedSeen: true, navigationFinished: true }), true);
    assert.equal(canReevaluatePageLifecycle({ ...pending, pageDataUpdatedSeen: true, ownershipMutation: true }), true);
    assert.equal(canReevaluatePageLifecycle({ ...pending, ownershipMutation: true }), false);
    assert.equal(canReevaluatePageLifecycle({ ...pending, navigationPending: false }), true);
});

test('same-snapshot ownership accepts only matching target with a continuation', () => {
    const lifecycle = {
        navigationPending: true,
        pageDataUpdated: true,
        navigationTargetMatched: true,
        pageTargetChanged: true,
        bootstrapTargetMatched: true,
        pageStateUsable: true
    };
    assert.equal(canEstablishPageLifecycle(lifecycle).ok, true);
    assert.equal(canEstablishPageLifecycle({ ...lifecycle, bootstrapTargetMatched: false }).reason, 'BOOTSTRAP_TARGET_MISMATCH');
    assert.equal(canEstablishPageLifecycle({ ...lifecycle, pageStateUsable: false }).reason, 'PAGE_STATE_STALE');
    assert.equal(canEstablishPageLifecycle({
        ...lifecycle,
        navigationPending: false,
        pageDataUpdated: false,
        navigationTargetMatched: false
    }).ok, true);
});

test('page-data and navigation-finish ordering both provide an event-driven second evaluation', () => {
    const pending = { navigationPending: true, pageDataUpdatedSeen: false, pageDataUpdated: false, navigationFinished: false };

    const pageDataFirst = canReevaluatePageLifecycle({ ...pending, pageDataUpdated: true });
    const finishSecond = canReevaluatePageLifecycle({ ...pending, pageDataUpdatedSeen: true, navigationFinished: true });
    assert.equal(pageDataFirst, true);
    assert.equal(finishSecond, true);

    const finishFirst = canReevaluatePageLifecycle({ ...pending, navigationFinished: true });
    const pageDataSecond = canReevaluatePageLifecycle({ ...pending, pageDataUpdated: true });
    assert.equal(finishFirst, false);
    assert.equal(pageDataSecond, true);
});

test('ownership mutation reevaluates an unestablished direct load without reopening an established lifecycle', () => {
    assert.equal(canSignalOwnershipReevaluation({
        navigationPending: false,
        pageEstablished: false,
        pageDataUpdatedSeen: false
    }), true);
    assert.equal(canSignalOwnershipReevaluation({
        navigationPending: false,
        pageEstablished: true,
        pageDataUpdatedSeen: false
    }), false);
    assert.equal(canSignalOwnershipReevaluation({
        navigationPending: true,
        pageEstablished: false,
        pageDataUpdatedSeen: false
    }), false);
    assert.equal(canSignalOwnershipReevaluation({
        navigationPending: true,
        pageEstablished: false,
        pageDataUpdatedSeen: true
    }), true);
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

test('getReadDelayMs applies a one-second safety floor without shortening YouTube timeout', () => {
    assert.equal(LIVEFLOW_MIN_READ_DELAY_MS, 1000);
    assert.equal(getReadDelayMs(0), 1000);
    assert.equal(getReadDelayMs(999), 1000);
    assert.equal(getReadDelayMs(1000), 1000);
    assert.equal(getReadDelayMs(1500), 1500);
});

test('getReadDelayMs rejects every invalid timeout without a fallback poll', () => {
    for (const timeout of [undefined, null, '1500', Number.NaN, Infinity, -1, LIVEFLOW_MAX_TIMER_DELAY_MS + 1]) {
        assert.equal(getReadDelayMs(timeout), null);
    }
});

test('HTTP policy accepts 2xx and stops every requested failure status', () => {
    assert.equal(isSuccessfulHttpStatus(200), true);
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503, 399, 600]) {
        assert.equal(isSuccessfulHttpStatus(status), false);
    }
});

function responseWithContinuation(type = 'timedContinuationData', continuation = 'next', timeoutMs = 1500) {
    return {
        continuationContents: {
            liveChatContinuation: {
                actions: [],
                continuations: [{ [type]: { continuation, timeoutMs } }]
            }
        }
    };
}

test('response validation accepts only a supported continuation with a valid timeout', () => {
    const result = validateLiveChatReadResponse(responseWithContinuation());
    assert.equal(result.ok, true);
    assert.equal(result.effectiveDelayMs, 1500);
    assert.equal(result.continuationInfo.type, 'timedContinuationData');
});

test('response validation fails closed on missing or unexpected structures', () => {
    assert.equal(validateLiveChatReadResponse(null).errorType, 'unexpected_response_shape');
    assert.equal(validateLiveChatReadResponse([]).errorType, 'unexpected_response_shape');
    assert.equal(validateLiveChatReadResponse({}).errorType, 'missing_live_chat_continuation');
    assert.equal(validateLiveChatReadResponse({ continuationContents: { liveChatContinuation: {} } }).errorType, 'missing_continuation');
    assert.equal(validateLiveChatReadResponse(responseWithContinuation('timedContinuationData', '')).errorType, 'missing_continuation');
    assert.equal(validateLiveChatReadResponse(responseWithContinuation('unknownContinuationData')).errorType, 'unknown_continuation_type');
});

test('response validation rejects missing and invalid timeout values', () => {
    const missingTimeout = responseWithContinuation();
    delete missingTimeout.continuationContents.liveChatContinuation.continuations[0].timedContinuationData.timeoutMs;
    assert.equal(validateLiveChatReadResponse(missingTimeout).errorType, 'invalid_timeout');
    for (const timeout of [null, '1500', Number.NaN, Infinity, -1, LIVEFLOW_MAX_TIMER_DELAY_MS + 1]) {
        assert.equal(validateLiveChatReadResponse(responseWithContinuation('timedContinuationData', 'next', timeout)).errorType, 'invalid_timeout');
    }
});

test('loop start policy rejects duplicates, in-flight requests, missing state, and hidden pages', () => {
    const valid = { activeLoopGeneration: 0, requestInFlight: false, hasContinuation: true, hasContext: true, hidden: false };
    assert.equal(canStartReadLoop(valid), true);
    assert.equal(canStartReadLoop({ ...valid, activeLoopGeneration: 1 }), false);
    assert.equal(canStartReadLoop({ ...valid, requestInFlight: true }), false);
    assert.equal(canStartReadLoop({ ...valid, hasContinuation: false }), false);
    assert.equal(canStartReadLoop({ ...valid, hasContext: false }), false);
    assert.equal(canStartReadLoop({ ...valid, hidden: true }), false);
});

test('stale, aborted, or invalid responses cannot schedule another READ', () => {
    const valid = { generation: 2, currentGeneration: 2, revision: 3, currentRevision: 3, aborted: false, validationOk: true };
    assert.equal(canScheduleNextRead(valid), true);
    assert.equal(canScheduleNextRead({ ...valid, currentGeneration: 4 }), false);
    assert.equal(canScheduleNextRead({ ...valid, currentRevision: 4 }), false);
    assert.equal(canScheduleNextRead({ ...valid, aborted: true }), false);
    assert.equal(canScheduleNextRead({ ...valid, validationOk: false }), false);
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
