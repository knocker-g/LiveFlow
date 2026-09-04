const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_VISIBLE_MESSAGES, mergeMessagesById, getVisibleMessages, formatMessageText } = require('../src/overlay-core.js');

const { ChatMessage, extractChatMessagesFromResponse, extractContinuationFromResponse, extractContinuationInfoFromResponse, getContinuationTypes, extractInitialLiveChatContinuation, normalizeInternalApiContext, buildLiveChatReadRequest, summarizeLiveChatResponse, canAttemptOneShotRead, getPageRevisionState, canIssueSecondRead, getReadDelayMs } = require('../src/chat-read-core.js');

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
