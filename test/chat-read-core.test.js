const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MAX_VISIBLE_MESSAGES, mergeMessagesById, getVisibleMessages, formatMessageText } = require('../src/overlay-core.js');

const core = require('../src/chat-read-core.js');
const { ChatMessage, normalizeMessageRuns, extractChatMessagesFromResponse, extractReplayChatMessagesFromResponse, extractReplayContinuationInfo, parseReplayOffsetMsec, validateReplayChatReadResponse, selectReplayDueMessages, selectBoundedReplayDueMessages, canRestartReplayAtCurrentPosition, extractContinuationFromResponse, extractContinuationInfoFromResponse, getContinuationTypes, extractInitialLiveChatContinuation, normalizeInternalApiContext, buildLiveChatReadRequest, summarizeLiveChatResponse, canAttemptOneShotRead, getPageRevisionState, canIssueSecondRead, getReadDelayMs, validateLiveChatReadResponse, isSuccessfulHttpStatus, canStartReadLoop, canScheduleNextRead, extractWatchTargetIdentity, evaluateBootstrapTarget, canEstablishPageLifecycle, canReevaluatePageLifecycle, canSignalOwnershipReevaluation, canResumeReadAfterVisibility, LIVEFLOW_MIN_READ_DELAY_MS, LIVEFLOW_MAX_TIMER_DELAY_MS } = core;
const pageStateSource = fs.readFileSync(path.join(__dirname, '../src/page-state-main.js'), 'utf8');

test('armed development diagnostic does not block normal Replay seek restart', () => {
    const restartBody = pageStateSource.match(/function restartReplayFromCurrentPosition\([^]*?\n    \}/)?.[0] || '';
    assert.match(restartBody, /canRestartReplayAtCurrentPosition/);
    assert.match(restartBody, /startReadLoop\(generation\)/);
    assert.doesNotMatch(restartBody, /replayPlayerSeekDiagnostic\.armed[^]*?return/);
});

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

test('initial Replay mode is established from the watch snapshot without Native Chat iframe state', () => {
    const fixture = (isReplay) => ({
        contents: {
            twoColumnWatchNextResults: {
                conversationBar: {
                    liveChatRenderer: { isReplay, continuations: [{ reloadContinuationData: { continuation: 'opaque' } }] }
                }
            }
        }
    });
    assert.equal(core.classifyInitialChatMode(fixture(true)), 'replay');
    assert.equal(core.classifyInitialChatMode(fixture(false)), 'live');
    assert.equal(core.classifyInitialChatMode({ contents: {} }), 'unknown');
});

test('same-target Premiere live to Archive Replay is a dedicated mode transition', () => {
    assert.equal(core.classifySameTargetChatModeTransition({
        previousMode: 'live', nextMode: 'replay', previousTargetIdentity: 'video-a', nextTargetIdentity: 'video-a'
    }), 'LIVE_TO_REPLAY');
    assert.equal(core.classifySameTargetChatModeTransition({
        previousMode: 'replay', nextMode: 'replay', previousTargetIdentity: 'video-a', nextTargetIdentity: 'video-a'
    }), 'NONE', 'duplicate Replay observations are idempotent');
    assert.equal(core.classifySameTargetChatModeTransition({
        previousMode: 'live', nextMode: 'replay', previousTargetIdentity: 'video-a', nextTargetIdentity: 'video-b'
    }), 'NONE', 'target replacement remains owned by the navigation lifecycle');
    assert.equal(core.classifySameTargetChatModeTransition({
        previousMode: 'live', nextMode: 'unknown', previousTargetIdentity: 'video-a', nextTargetIdentity: 'video-a'
    }), 'NONE', 'unknown mode fails closed');
});

test('initial Replay startup coverage is threshold-free and brackets the captured player time', () => {
    const messages = [
        { replayOffsetMsec: 1000 },
        { replayOffsetMsec: 5000 }
    ];
    assert.equal(core.classifyReplayInitialStartupCoverage(messages, 0), 'ALIGNED');
    assert.equal(core.classifyReplayInitialStartupCoverage(messages, 3000), 'ALIGNED');
    assert.equal(core.classifyReplayInitialStartupCoverage(messages, 8000), 'OUTSIDE');
    assert.equal(core.classifyReplayInitialStartupCoverage(messages, 500), 'OUTSIDE');
    assert.equal(core.classifyReplayInitialStartupCoverage([], 3000), 'UNKNOWN');
    assert.equal(core.classifyReplayInitialStartupCoverage([{ replayOffsetMsec: NaN }], 3000), 'UNKNOWN');
    assert.equal(core.classifyReplayInitialStartupCoverage(messages, -1), 'UNKNOWN');
});

test('Replay accounting detects clean conservation and every unaccounted boundary', () => {
    assert.deepEqual(core.computeReplayAccountingLoss({
        bridged: 100, enqueued: 100, selected: 90, stale: 5, pending: 5, displayed: 90
    }), { bridge: 0, scheduler: 0, display: 0, total: 0, valid: true });
    assert.deepEqual(core.computeReplayAccountingLoss({
        bridged: 100, enqueued: 98, selected: 90, stale: 3, pending: 2, displayed: 88
    }), { bridge: 2, scheduler: 3, display: 2, total: 7, valid: true });
    assert.equal(core.computeReplayAccountingLoss({ bridged: -1 }).valid, false);
});

function completeReplayFixture(overrides = {}) {
    return {
        receivedActions: 12, parsed: 10, parseFailed: 2,
        displayable: 9, invalid: 1, unsupported: 0,
        dueClassified: 5, futureClassified: 3, beforeStartFiltered: 1,
        dueBridged: 5, futurePromoted: 0, futureQueued: 3,
        enqueued: 5, schedulerEligible: 5, selected: 4, schedulerRetained: 1,
        launched: 4, displayed: 4,
        ...overrides
    };
}

test('Replay stage ledger conserves every boundary and never treats retained work as lost', () => {
    const ledger = core.computeReplayAccountingLedger(completeReplayFixture());
    assert.equal(ledger.valid, true);
    assert.equal(ledger.lostUnaccounted, 0);
    assert.equal(ledger.stages.future.retained, 3);
    assert.equal(ledger.stages.scheduler.retained, 1);
    assert.equal(ledger.stages.scheduler.lost, 0);
});

test('Replay stage ledger attributes explicit drops and detects synthetic unaccounted loss', () => {
    const explicit = core.computeReplayAccountingLedger(completeReplayFixture({
        displayable: 10, invalid: 0, futureClassified: 4, futureQueued: 3, capacityDropped: 1,
        schedulerEligible: 5, selected: 3, staleDropped: 1, schedulerRetained: 1,
        launched: 3, displayed: 2, rendererDropped: 1
    }));
    assert.equal(explicit.valid, true);
    assert.equal(explicit.lostUnaccounted, 0);
    assert.equal(explicit.stages.future.explicitRemoval, 1);
    assert.equal(explicit.stages.renderer.explicitRemoval, 1);

    const lost = core.computeReplayAccountingLedger(completeReplayFixture({ displayed: 3 }));
    assert.equal(lost.valid, false);
    assert.equal(lost.stages.renderer.lost, 1);
    assert.equal(lost.lostUnaccounted, 1);
});

test('Replay blank classifier covers sparse, acquisition, and each downstream loss stage', () => {
    const classify = core.classifyReplayBlankCause;
    assert.equal(classify({ currentWindowDisplayed: 1 }), 'UNKNOWN');
    assert.equal(classify({ sourceSparse: true }), 'SOURCE_SPARSE');
    assert.equal(classify({ acquisitionForward: true }), 'ACQUISITION_GAP');
    assert.equal(classify({ currentWindowInput: 3, beforeStartFiltered: 3 }), 'BEFORE_START_FILTER');
    assert.equal(classify({ currentWindowDisplayable: 3, futureQueued: 3 }), 'PENDING_NOT_PROMOTED');
    assert.equal(classify({ staleDropped: 2 }), 'STALE_DROP');
    assert.equal(classify({ capacityDropped: 2 }), 'CAPACITY_DROP');
    assert.equal(classify({ schedulerRetained: 2 }), 'SCHEDULER_BLOCKED');
    assert.equal(classify({ schedulerExplicitDrop: 2 }), 'SCHEDULER_DROP');
    assert.equal(classify({ selected: 2, launched: 1 }), 'RENDERER_NOT_DISPLAYED');
    assert.equal(classify({ lifecycleDiscarded: 1 }), 'LIFECYCLE_DISCARD');
    assert.equal(classify({ lostUnaccounted: 1 }), 'UNACCOUNTED_LOSS');
});

test('Mid-Replay synthetic scenarios A-E distinguish source, acquisition, and pipeline blank causes', () => {
    const scenarios = {
        A: { currentWindowInput: 4, currentWindowDisplayable: 4, currentWindowDue: 4, currentWindowDisplayed: 4 },
        B: { sourceSparse: true },
        C: { currentWindowInput: 4, currentWindowDisplayable: 4, currentWindowDue: 4, schedulerRetained: 4 },
        D: { currentWindowDisplayable: 4, futureQueued: 4, acquisitionForward: true },
        E: { acquisitionForward: true, coverageGap: true }
    };
    assert.deepEqual(Object.fromEntries(Object.entries(scenarios).map(([key, value]) => [key, core.classifyReplayBlankCause(value)])), {
        A: 'UNKNOWN', B: 'SOURCE_SPARSE', C: 'SCHEDULER_BLOCKED', D: 'PENDING_NOT_PROMOTED', E: 'ACQUISITION_GAP'
    });
});

test('seek versus normal differential reports the first diverging pipeline boundary', () => {
    const seek = { currentWindowInput: 5, currentWindowDisplayable: 5, currentWindowDue: 5,
        currentWindowEnqueued: 5, currentWindowSelected: 5, currentWindowDisplayed: 5 };
    assert.deepEqual(core.compareReplayPipelinePaths({ ...seek, currentWindowInput: 0 }, seek),
        { firstDifference: 'currentWindowInput', equal: false });
    assert.deepEqual(core.compareReplayPipelinePaths(seek, seek), { firstDifference: 'NONE', equal: true });
});

test('density accounting fixtures derive ratios with zero unexplained loss', () => {
    const rows = [
        ['LOW', 20, 20, 0, 0], ['MEDIUM', 60, 54, 6, 0], ['HIGH_BURST', 120, 90, 20, 10]
    ].map(([density, input, displayed, staleDropped, capacityDropped]) => {
        const ledger = core.computeReplayAccountingLedger({
            ...completeReplayFixture(), receivedActions: input, parsed: input, parseFailed: 0, displayable: input,
            invalid: 0, dueClassified: input - capacityDropped, futureClassified: capacityDropped,
            beforeStartFiltered: 0, dueBridged: input - capacityDropped, futureQueued: 0, capacityDropped,
            enqueued: input - capacityDropped, schedulerEligible: input - capacityDropped,
            selected: displayed, staleDropped, schedulerRetained: input - capacityDropped - displayed - staleDropped,
            launched: displayed, displayed
        });
        return { density, ratio: displayed / input, lost: ledger.lostUnaccounted, valid: ledger.valid };
    });
    assert.deepEqual(rows.map(({ density, lost, valid }) => ({ density, lost, valid })), [
        { density: 'LOW', lost: 0, valid: true }, { density: 'MEDIUM', lost: 0, valid: true },
        { density: 'HIGH_BURST', lost: 0, valid: true }
    ]);
    assert.deepEqual(rows.map(({ ratio }) => ratio), [1, 0.9, 0.75]);
});

test('Replay accounting telemetry is bounded and exposes no raw timing, identity, or authority', () => {
    assert.deepEqual([0, 1, 5, 11].map(core.classifyReplayCount), ['ZERO', 'FEW', 'SOME', 'MANY']);
    assert.deepEqual(core.REPLAY_BLANK_CAUSES, [
        'SOURCE_SPARSE', 'ACQUISITION_GAP', 'BEFORE_START_FILTER', 'STALE_DROP', 'CAPACITY_DROP',
        'PENDING_NOT_PROMOTED', 'SCHEDULER_BLOCKED', 'SCHEDULER_DROP', 'RENDERER_NOT_DISPLAYED',
        'LIFECYCLE_DISCARD', 'UNACCOUNTED_LOSS', 'UNKNOWN'
    ]);
    const serialized = JSON.stringify(core.computeReplayAccountingLedger(completeReplayFixture()));
    assert.doesNotMatch(serialized, /timestamp|offset|continuation|messageId|token/i);
});

test('runtime observer keeps normal flow idle and requires repeated event observations to confirm blank', () => {
    const reports = [];
    const observer = core.createReplayRuntimeObserver({ report: (event) => reports.push(event) });
    observer.observe({ currentWindowDisplayable: 2, currentWindowDisplayed: 2 }, 'displayed');
    assert.equal(observer.status().state, 'IDLE');
    observer.observe({ currentWindowDisplayable: 4, currentWindowDisplayed: 2, futureQueued: 2 }, 'temporal-classification');
    assert.equal(observer.status().state, 'SUSPECTED');
    observer.observe({ currentWindowDisplayable: 6, currentWindowDisplayed: 2, futureQueued: 4 }, 'timeupdate');
    assert.equal(observer.status().state, 'CONFIRMED');
    assert.equal(reports.filter(({ type }) => type === 'BLANK_CONFIRMED').length, 1);
});

test('runtime observer freezes confirmed evidence and records event-driven recovery', () => {
    const observer = core.createReplayRuntimeObserver({ maximumEpisodes: 2 });
    observer.observe({ currentWindowDisplayable: 2, currentWindowDisplayed: 0, schedulerRetained: 2 }, 'scheduler');
    observer.observe({ currentWindowDisplayable: 4, currentWindowDisplayed: 0, schedulerRetained: 4 }, 'scheduler');
    observer.observe({ currentWindowDisplayable: 4, currentWindowDisplayed: 1 }, 'displayed');
    const episodes = observer.recentEpisodes();
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].state, 'RECOVERED');
    assert.equal(episodes[0].recoveryBoundary, 'DISPLAYED');
    assert.equal(episodes[0].displayedResumed, true);
});

test('runtime observer classifies fixed blank causes without creating sparse episodes', () => {
    const sparse = core.createReplayRuntimeObserver();
    sparse.observe({ sourceSparse: true, currentWindowDisplayable: 0, currentWindowDisplayed: 0 }, 'response-accepted');
    sparse.observe({ sourceSparse: true, currentWindowDisplayable: 0, currentWindowDisplayed: 0 }, 'timeupdate');
    assert.equal(sparse.status().activeEpisode.blankCause, 'SOURCE_SPARSE');
    const acquisition = core.createReplayRuntimeObserver();
    acquisition.observe({ acquisitionForward: true, coverageGap: true }, 'response-accepted');
    acquisition.observe({ acquisitionForward: true, coverageGap: true }, 'timeupdate');
    assert.equal(acquisition.status().activeEpisode.blankCause, 'ACQUISITION_GAP');
    for (const fixture of [
        { futureQueued: 2, expected: 'PENDING_NOT_PROMOTED' },
        { schedulerRetained: 2, expected: 'SCHEDULER_BLOCKED' },
        { schedulerExplicitDrop: 2, expected: 'SCHEDULER_DROP' },
        { selected: 2, launched: 0, expected: 'RENDERER_NOT_DISPLAYED' },
        { lifecycleDiscarded: 2, expected: 'LIFECYCLE_DISCARD' },
        { lostUnaccounted: 2, expected: 'UNACCOUNTED_LOSS' }
    ]) {
        const observer = core.createReplayRuntimeObserver();
        const snapshot = { ...fixture, currentWindowDisplayable: 2, currentWindowDisplayed: 0 };
        observer.observe(snapshot, 'first');
        const second = { ...snapshot, currentWindowDisplayable: 4 };
        for (const key of ['schedulerExplicitDrop', 'selected', 'lifecycleDiscarded', 'lostUnaccounted']) {
            if (Number.isInteger(second[key])) second[key] *= 2;
        }
        observer.observe(second, 'second');
        assert.equal(observer.status().activeEpisode.blankCause, fixture.expected);
    }
});

test('runtime observer attributes a new blank from interval deltas instead of prior cumulative drops', () => {
    const observer = core.createReplayRuntimeObserver();
    observer.observe({
        currentWindowInput: 100, currentWindowDisplayable: 100, currentWindowDue: 100,
        currentWindowEnqueued: 100, currentWindowSelected: 100, currentWindowDisplayed: 100,
        schedulerBlocked: 50, lifecycleDiscarded: 4, staleDropped: 3
    }, 'prior-activity');
    observer.observe({
        currentWindowInput: 102, currentWindowDisplayable: 102, currentWindowDue: 100,
        currentWindowEnqueued: 100, currentWindowSelected: 100, currentWindowDisplayed: 100,
        schedulerBlocked: 50, lifecycleDiscarded: 4, staleDropped: 3, futureQueued: 2
    }, 'new-gap');
    observer.observe({
        currentWindowInput: 104, currentWindowDisplayable: 104, currentWindowDue: 100,
        currentWindowEnqueued: 100, currentWindowSelected: 100, currentWindowDisplayed: 100,
        schedulerBlocked: 50, lifecycleDiscarded: 4, staleDropped: 3, futureQueued: 4
    }, 'new-gap-confirmed');
    const episode = observer.status().activeEpisode;
    assert.equal(episode.firstMissingBoundary, 'DUE');
    assert.equal(episode.blankCause, 'PENDING_NOT_PROMOTED');
});

test('runtime observer compares NORMAL failure with SEEK success at the first boundary', () => {
    const observer = core.createReplayRuntimeObserver();
    observer.observe({ path: 'NORMAL', currentWindowInput: 0, currentWindowDisplayable: 0, currentWindowDue: 0,
        currentWindowEnqueued: 0, currentWindowSelected: 0, currentWindowDisplayed: 0 }, 'normal');
    const status = observer.observe({ path: 'SEEK', currentWindowInput: 4, currentWindowDisplayable: 4, currentWindowDue: 4,
        currentWindowEnqueued: 4, currentWindowSelected: 4, currentWindowDisplayed: 4 }, 'seek');
    assert.deepEqual(status.differential, { firstDifference: 'currentWindowInput', equal: false });
});

test('runtime density observer classifies activity, fidelity, and dominant drop reason', () => {
    const fixtures = [
        [2, 'LOW'], [8, 'MEDIUM'], [20, 'HIGH'], [40, 'BURST']
    ];
    for (const [displayable, expected] of fixtures) {
        const observer = core.createReplayRuntimeObserver();
        const status = observer.observe({ displayable, schedulerSelected: displayable, launched: displayable,
            displayed: displayable, currentWindowDisplayed: displayable }, 'density');
        assert.equal(status.density.inputActivity, expected);
        assert.equal(status.density.densityFidelityClass, 'PRESERVED');
    }
    const observer = core.createReplayRuntimeObserver();
    const reduced = observer.observe({ displayable: 100, schedulerSelected: 40, launched: 40, displayed: 40,
        collisionDropped: 45, staleDropped: 15, currentWindowDisplayed: 40 }, 'density');
    assert.equal(reduced.density.densityFidelityClass, 'SEVERELY_REDUCED');
    assert.equal(reduced.density.dominantDropReason, 'COLLISION');
    for (const [field, expected] of [['staleDropped', 'STALE'], ['capacityDropped', 'CAPACITY'],
        ['readabilityDropped', 'READABILITY']]) {
        assert.equal(core.dominantReplayDropReason({ [field]: 3 }), expected);
    }
});

test('runtime episode history is bounded and observer source has no timer, polling, or production mutation', () => {
    const observer = core.createReplayRuntimeObserver({ maximumEpisodes: 2 });
    for (let index = 0; index < 3; index += 1) {
        const base = index * 10;
        observer.observe({ currentWindowDisplayable: base + 2, currentWindowDisplayed: index }, 'first');
        observer.observe({ currentWindowDisplayable: base + 4, currentWindowDisplayed: index }, 'second');
        observer.observe({ currentWindowDisplayable: base + 4, currentWindowDisplayed: index + 1 }, 'displayed');
    }
    assert.equal(observer.recentEpisodes().length, 2);
    const source = core.createReplayRuntimeObserver.toString();
    assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame|fetch\s*\(|enqueue|consume|invalidate/);
    assert.doesNotMatch(JSON.stringify(observer.printSummary()), /timestamp|offset|continuation|messageId|token/i);
});

test('runtime observer reports each continuous warning once instead of per event', () => {
    const reports = [];
    const observer = core.createReplayRuntimeObserver({ report: (event) => reports.push(event.type) });
    observer.observe({ displayable: 40, schedulerSelected: 10, launched: 10, displayed: 10,
        collisionDropped: 30, lostUnaccounted: 1 }, 'first');
    observer.observe({ displayable: 80, schedulerSelected: 20, launched: 20, displayed: 20,
        collisionDropped: 60, lostUnaccounted: 2 }, 'second');
    assert.equal(reports.filter((type) => type === 'ACCOUNTING_WARNING').length, 1);
    assert.equal(reports.filter((type) => type === 'DENSITY_WARNING').length, 1);
    observer.observe({ displayable: 81, schedulerSelected: 21, launched: 21, displayed: 21,
        collisionDropped: 60, lostUnaccounted: 2 }, 'clear');
    observer.observe({ displayable: 121, schedulerSelected: 31, launched: 31, displayed: 31,
        collisionDropped: 90, lostUnaccounted: 3 }, 'new-warning');
    assert.equal(reports.filter((type) => type === 'ACCOUNTING_WARNING').length, 2);
    assert.equal(reports.filter((type) => type === 'DENSITY_WARNING').length, 2);
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

test('Replay parser strictly unwraps observed actions and shares rich normalization', () => {
    const response = { continuationContents: { liveChatContinuation: {
        actions: [{ replayChatItemAction: { videoOffsetTimeMsec: '1250', actions: [
            { addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'text', message: { runs: [{ text: 'hello' }, { emoji: { image: { thumbnails: [{ url: 'https://example.test/e.png' }] } } }] } } } } },
            { addChatItemAction: { item: { liveChatPaidMessageRenderer: { id: 'paid', message: { runs: [{ text: 'paid' }] }, purchaseAmountText: { simpleText: '$1' } } } } },
            { addChatItemAction: { item: { liveChatPaidStickerRenderer: { id: 'sticker', sticker: { thumbnails: [{ url: 'https://example.test/s.png' }] }, purchaseAmountText: { simpleText: '$2' } } } } }
        ] } }],
        continuations: [{ liveChatReplayContinuationData: { continuation: 'next', timeUntilLastMessageMsec: 1200 } }]
    } } };
    const messages = extractReplayChatMessagesFromResponse(response);
    assert.deepEqual(messages.map((message) => message.messageType), ['text', 'superChat', 'superSticker']);
    assert.ok(messages.every((message) => message.replayOffsetMsec === 1250));
    assert.equal(messages[0].messageRuns[1].type, 'image');
    assert.deepEqual(extractReplayContinuationInfo(response), { continuation: 'next', timeoutMs: 1200, type: 'liveChatReplayContinuationData' });
    assert.equal(validateReplayChatReadResponse(response).ok, true);
});

test('Replay parser rejects malformed offsets and continuation timing', () => {
    for (const value of ['', '-1', '1.5', 'x', 1, null]) assert.equal(parseReplayOffsetMsec(value), null);
    assert.equal(parseReplayOffsetMsec('0'), 0);
    const malformed = { continuationContents: { liveChatContinuation: { actions: [{ replayChatItemAction: { videoOffsetTimeMsec: '-1', actions: [] } }], continuations: [{ liveChatReplayContinuationData: { continuation: 'next', timeUntilLastMessageMsec: '10' } }] } } };
    assert.deepEqual(extractReplayChatMessagesFromResponse(malformed), []);
    assert.equal(validateReplayChatReadResponse(malformed).ok, false);
});

test('player-seek schema attribution checks only the fixed continuation path and never returns values', () => {
    const classify = require('../src/chat-read-core.js').classifyPlayerSeekContinuationPresence;
    const present = { continuationContents: { liveChatContinuation: { continuations: [
        { playerSeekContinuationData: { continuation: 'private-player-seek-token' } }
    ] } } };
    const absent = { continuationContents: { liveChatContinuation: { continuations: [
        { liveChatReplayContinuationData: { continuation: 'private-replay-token' } }
    ] } } };
    assert.equal(classify(present), 'PRESENT');
    assert.equal(classify(absent), 'ABSENT');
    assert.equal(classify({ continuationContents: { liveChatContinuation: { continuations: 'invalid' } } }), 'INVALID_RESPONSE');
    assert.equal(classify(new Proxy({}, { get() { throw new Error('blocked'); } })), 'UNKNOWN');
    const output = JSON.stringify([classify(present), classify(absent)]);
    assert.equal(output.includes('private-player-seek-token'), false);
    assert.equal(output.includes('private-replay-token'), false);
});

test('player-seek schema attribution rejects stale, aborted, and already-observed responses', () => {
    const canAccept = require('../src/chat-read-core.js').canAcceptReplaySchemaDiagnostic;
    const valid = {
        armed: true, observed: false, mode: 'replay',
        armedLifecycleGeneration: 4, currentLifecycleGeneration: 4,
        armedRevision: 7, currentRevision: 7, responseRevision: 7,
        armedTargetIdentity: 'current-target', currentTargetIdentity: 'current-target',
        readGeneration: 3, currentReadGeneration: 3,
        aborted: false, navigationPending: false, targetCurrent: true
    };
    assert.equal(canAccept(valid), true);
    for (const patch of [
        { observed: true }, { mode: 'live' }, { currentLifecycleGeneration: 5 },
        { currentRevision: 8 }, { responseRevision: 6 }, { currentTargetIdentity: 'stale-target' },
        { currentReadGeneration: 4 }, { aborted: true }, { navigationPending: true }, { targetCurrent: false }
    ]) assert.equal(canAccept({ ...valid, ...patch }), false);
});

test('player-seek Active Gate validates only current video time and fixed response paths', () => {
    const { extractPlayerSeekContinuation, validatePlayerSeekOffset, summarizePlayerSeekDiagnosticResponse } = require('../src/chat-read-core.js');
    const response = { continuationContents: { liveChatContinuation: {
        actions: [{ replayChatItemAction: { videoOffsetTimeMsec: '101000', actions: [] } }],
        continuations: [
            { playerSeekContinuationData: { continuation: 'private-single-use-authority' } },
            { liveChatReplayContinuationData: { continuation: 'private-next-token', timeUntilLastMessageMsec: 1000 } }
        ]
    } } };
    assert.equal(extractPlayerSeekContinuation(response), 'private-single-use-authority');
    assert.equal(validatePlayerSeekOffset(100.999, 200), 100999);
    for (const [currentTime, duration] of [[-1, 10], [Number.NaN, 10], [11, 10], [Number.MAX_VALUE, Infinity]]) {
        assert.equal(validatePlayerSeekOffset(currentTime, duration), null);
    }
    assert.deepEqual(summarizePlayerSeekDiagnosticResponse(response, 100000), {
        replayShapeObserved: true, responseOffsetRelation: 'ALL_NEAR_OR_AFTER_TARGET', continuationShapeObserved: true
    });
    assert.equal(summarizePlayerSeekDiagnosticResponse(response, 104000).responseOffsetRelation, 'ALL_BEFORE_TARGET');
    assert.equal(summarizePlayerSeekDiagnosticResponse(response, 98000).responseOffsetRelation, 'ALL_NEAR_OR_AFTER_TARGET');
    assert.deepEqual(summarizePlayerSeekDiagnosticResponse({}, 100000), {
        replayShapeObserved: false, responseOffsetRelation: 'UNKNOWN', continuationShapeObserved: false
    });
});

test('player-seek Active Gate classifies the complete unordered response batch without exposing offsets', () => {
    const classify = require('../src/chat-read-core.js').summarizePlayerSeekDiagnosticResponse;
    const response = (offsets) => ({ continuationContents: { liveChatContinuation: {
        actions: offsets.map((videoOffsetTimeMsec) => ({ replayChatItemAction: { videoOffsetTimeMsec } })),
        continuations: [{ liveChatReplayContinuationData: { continuation: 'private-next' } }]
    } } });
    assert.equal(classify(response(['1000', '5000']), 10000).responseOffsetRelation, 'ALL_BEFORE_TARGET');
    assert.equal(classify(response(['1000', '9000']), 10000).responseOffsetRelation, 'CROSSES_TARGET');
    assert.equal(classify(response(['12000', '1000']), 10000).responseOffsetRelation, 'CROSSES_TARGET');
    assert.equal(classify(response(['9000', '10000']), 10000).responseOffsetRelation, 'ALL_NEAR_OR_AFTER_TARGET');
    assert.equal(classify(response(['15000', '13000']), 10000).responseOffsetRelation, 'ALL_NEAR_OR_AFTER_TARGET');
    assert.equal(classify(response(['11000', '1000', '9000']), 10000).responseOffsetRelation, 'CROSSES_TARGET');
    assert.equal(classify(response([]), 10000).responseOffsetRelation, 'NO_TIMESTAMPED_ACTIONS');
    assert.equal(classify(response(['bad', '-1', '9000']), 10000).responseOffsetRelation, 'ALL_NEAR_OR_AFTER_TARGET');
    assert.equal(classify(response(['bad', '-1']), 10000).responseOffsetRelation, 'NO_TIMESTAMPED_ACTIONS');
    assert.equal(classify(response(['9000']), Number.NaN).responseOffsetRelation, 'UNKNOWN');
    const serialized = JSON.stringify(classify(response(['1000', '9000']), 10000));
    for (const raw of ['1000', '9000', 'private-next', 'minimumOffset', 'maximumOffset']) assert.equal(serialized.includes(raw), false);
});

test('Replay re-anchor coverage distinguishes near and far sparse gaps without rejecting either shape', () => {
    const { classifyReplayReanchorCoverage, summarizePlayerSeekDiagnosticResponse } = require('../src/chat-read-core.js');
    const response = (offsets) => ({ continuationContents: { liveChatContinuation: {
        actions: offsets.map((videoOffsetTimeMsec) => ({ replayChatItemAction: { videoOffsetTimeMsec } })),
        continuations: [{ liveChatReplayContinuationData: { continuation: 'private-next' } }]
    } } });
    assert.equal(classifyReplayReanchorCoverage(response(['99000', '101000']), 100000), 'NEAR_AFTER_TARGET');
    assert.equal(classifyReplayReanchorCoverage(response(['70000', '101000']), 100000), 'CROSSES_TARGET');
    assert.equal(classifyReplayReanchorCoverage(response(['145000']), 100000), 'FAR_AFTER_TARGET');
    assert.equal(classifyReplayReanchorCoverage(response([]), 100000), 'NO_TIMESTAMPED_ACTIONS');
    assert.equal(classifyReplayReanchorCoverage(response(['50000']), 100000), 'UNKNOWN');
    assert.equal(summarizePlayerSeekDiagnosticResponse(response(['145000']), 100000).responseOffsetRelation, 'ALL_NEAR_OR_AFTER_TARGET');
    const serialized = JSON.stringify([
        classifyReplayReanchorCoverage(response(['99000', '101000']), 100000),
        classifyReplayReanchorCoverage(response(['145000']), 100000)
    ]);
    assert.equal(serialized.includes('99000'), false);
    assert.equal(serialized.includes('145000'), false);
});

test('Replay target-hole diagnostics separate crossing from near-window confirmation', () => {
    const summarize = require('../src/chat-read-core.js').summarizeReplayTargetHole;
    const response = (offsets) => ({ continuationContents: { liveChatContinuation: {
        actions: offsets.map((videoOffsetTimeMsec) => ({ replayChatItemAction: { videoOffsetTimeMsec } }))
    } } });
    assert.deepEqual(summarize(response(['99000', '101000']), 100000), {
        nearestBeforeTargetClass: 'IMMEDIATE', nearestAfterTargetClass: 'IMMEDIATE',
        targetBracketGapClass: 'TIGHT', currentWindowState: 'CONFIRMED_NEAR'
    });
    assert.deepEqual(summarize(response(['40000', '160000']), 100000), {
        nearestBeforeTargetClass: 'LONG_GAP', nearestAfterTargetClass: 'LONG_GAP',
        targetBracketGapClass: 'LARGE', currentWindowState: 'CROSSES_WITH_LARGE_GAP'
    });
    assert.equal(summarize(response(['99000', '160000']), 100000).currentWindowState, 'CONFIRMED_NEAR');
    assert.equal(summarize(response(['101000']), 100000).currentWindowState, 'AFTER_NEAR');
    assert.equal(summarize(response(['160000']), 100000).currentWindowState, 'AFTER_FAR');
    const serialized = JSON.stringify(summarize(response(['40000', '160000']), 100000));
    for (const raw of ['40000', '160000', '100000']) assert.equal(serialized.includes(raw), false);
});

test('near timestamped non-displayable action does not confirm displayable coverage', () => {
    const core = require('../src/chat-read-core.js');
    const response = { continuationContents: { liveChatContinuation: {
        actions: [
            { replayChatItemAction: { videoOffsetTimeMsec: '70000', actions: [{ removeChatItemAction: { targetItemId: 'private' } }] } },
            { replayChatItemAction: { videoOffsetTimeMsec: '101000', actions: [{ replaceChatItemAction: { targetItemId: 'private' } }] } },
            { replayChatItemAction: { videoOffsetTimeMsec: '160000', actions: [{ addChatItemAction: { item: {
                liveChatTextMessageRenderer: { id: 'displayable', message: { runs: [{ text: 'hello' }] } }
            } } }] } }
        ]
    } } };
    const messages = core.extractReplayChatMessagesFromResponse(response);
    assert.equal(core.summarizeReplayTargetHole(response, 100000).currentWindowState, 'CONFIRMED_NEAR');
    assert.equal(messages.length, 1);
    assert.equal(core.summarizeReplayDisplayableTargetHole(messages, 100000).currentWindowState, 'AFTER_FAR');
    assert.deepEqual(core.summarizeReplayDisplayableAccounting(messages, 100000), { count: 1, before: 0, due: 0, future: 1 });
    assert.equal(core.countReplayTimestampedActions(response), 3);
});

test('near displayable comment confirms both transport and displayable coverage', () => {
    const core = require('../src/chat-read-core.js');
    const messages = [{ id: 'near', replayOffsetMsec: 101000 }];
    const response = { continuationContents: { liveChatContinuation: { actions: [
        { replayChatItemAction: { videoOffsetTimeMsec: '101000' } }
    ] } } };
    assert.equal(core.summarizeReplayTargetHole(response, 100000).currentWindowState, 'AFTER_NEAR');
    assert.equal(core.summarizeReplayDisplayableTargetHole(messages, 100000).currentWindowState, 'AFTER_NEAR');
});

test('large sparse bracket accounting can contain filtered-before and future-after messages with zero due', () => {
    const before = Array.from({ length: 50 }, (_, index) => ({ id: `before-${index}`, replayOffsetMsec: 40000 + index }));
    const future = Array.from({ length: 150 }, (_, index) => ({ id: `future-${index}`, replayOffsetMsec: 160000 + index }));
    const selection = selectBoundedReplayDueMessages([...before, ...future], 100, 100, 100);
    assert.equal(selection.filteredCount, 50);
    assert.equal(selection.due.length, 0);
    assert.equal(selection.pending.length, 100);
    assert.equal(selection.capacityDropped, 50);
});

test('re-anchor short-gap future survives merge with a later long-gap sequential response', () => {
    const before = Array.from({ length: 49 }, (_, index) => ({ id: `before-${index}`, replayOffsetMsec: 99000 }));
    const shortFuture = Array.from({ length: 50 }, (_, index) => ({ id: `short-${index}`, replayOffsetMsec: 105000 + index }));
    const longFuture = Array.from({ length: 47 }, (_, index) => ({ id: `long-${index}`, replayOffsetMsec: 160000 + index }));
    const reanchor = selectBoundedReplayDueMessages([...before, ...shortFuture], 100, 100, 100);
    assert.equal(reanchor.pending.length, 50);
    const merged = selectBoundedReplayDueMessages([...reanchor.pending, ...longFuture], 100, 100, 100);
    assert.equal(merged.pending.length, 97);
    assert.equal(merged.capacityDropped, 0);
    assert.equal(require('../src/chat-read-core.js').classifyNearestReplayFuture(merged.pending, 100), 'SHORT_GAP');
    const promoted = selectBoundedReplayDueMessages(merged.pending, 105.25, 100, 100);
    assert.equal(promoted.due.length, 50);
    assert.equal(promoted.pending.length, 47);
});

test('BUFFER_PAUSED immediate future retains a temporal reevaluation path without a new response', () => {
    const flushBody = pageStateSource.match(/function flushReplayPending\([^]*?\n    \}/)?.[0] || '';
    const timeupdateBody = pageStateSource.match(/window\.addEventListener\('timeupdate'[^]*?\n    \}, true\);/)?.[0] || '';
    assert.match(timeupdateBody, /event\.target !== getCurrentMainVideo\(\)[^]*return;[^]*flushReplayPending/);
    assert.doesNotMatch(flushBody, /setTimeout|requestAnimationFrame/,
        'Temporal promotion has no independent wakeup once Acquisition is BUFFER_PAUSED');

    const item = { id: 'future-becomes-due', replayOffsetMsec: 57000 };
    const initial = selectBoundedReplayDueMessages([item], 55, 0, 100);
    assert.equal(core.classifyNearestReplayFuture(initial.pending, 55), 'IMMEDIATE');

    const wakeDelayMs = core.getReplayTemporalWakeDelayMs(initial.pending, 55, 0, 1);
    assert.equal(wakeDelayMs, 1750);
    let retained = initial.pending;
    let promoted = [];
    if (Number.isFinite(wakeDelayMs)) {
        const reevaluated = selectBoundedReplayDueMessages(retained, 58, 0, 100);
        retained = reevaluated.pending;
        promoted = reevaluated.due;
    }

    assert.equal(promoted.length, 1,
        'advancing playback must eventually promote an IMMEDIATE pending item without requiring a new Acquisition response');
    assert.equal(retained.length, 0);
});

test('Replay Temporal wake delay targets the earliest due boundary with existing tolerance', () => {
    const messages = [
        { id: 'later', replayOffsetMsec: 9000 },
        { id: 'earliest', replayOffsetMsec: 6000 },
        { id: 'before-start', replayOffsetMsec: 500 }
    ];
    assert.equal(core.getReplayTemporalWakeDelayMs(messages, 5, 1, 1), 750);
    assert.equal(core.getReplayTemporalWakeDelayMs(messages, 5, 1, 2), 375);
    assert.equal(core.getReplayTemporalWakeDelayMs([], 5, 1, 1), null);
    assert.equal(core.getReplayTemporalWakeDelayMs(messages, 5, 1, 0), null);
});

test('Replay Temporal wake-up is single, binding-current, cancellable, and local-only', () => {
    const arm = pageStateSource.match(/function armReplayTemporalWakeup\([^]*?\n    \}/)?.[0] || '';
    const cancel = pageStateSource.match(/function cancelReplayTemporalWakeup\([^]*?\n    \}/)?.[0] || '';
    const flush = pageStateSource.match(/function flushReplayPending\([^]*?\n    \}/)?.[0] || '';
    assert.match(arm, /cancelReplayTemporalWakeup\(\)/);
    assert.match(arm, /replayTemporalWakeTimer = window\.setTimeout/);
    assert.equal((arm.match(/window\.setTimeout/g) || []).length, 1);
    assert.match(arm, /canRunReplayTemporalWakeup/);
    assert.match(arm, /sequenceCurrent: sequence === replayTemporalWakeSequence/);
    assert.match(arm, /generationCurrent: generation === currentLoopGeneration[^]*revisionCurrent: revision === pageRevision[^]*lifecycleCurrent: lifecycleGeneration === pageLifecycleGeneration/);
    assert.match(arm, /targetCurrent: targetIdentity === pageState\.targetIdentity && isCurrentPageStateTarget\(\)/);
    assert.match(arm, /mediaTimeAdvanced:[^]*video\.currentTime > armedCurrentTime/);
    assert.match(arm, /flushReplayPending\([^]*'temporal-wakeup'/);
    assert.match(cancel, /replayTemporalWakeSequence \+= 1[^]*clearTimeout/);
    assert.match(flush, /armReplayTemporalWakeup\([^]*if \(source === 'temporal-wakeup'\) return;[^]*evaluateReplayNormalResume/);
    assert.doesNotMatch(arm, /fetch|performRead|startReadLoop|authorize|authority|continuation|queueReplayReanchor/i);
    assert.doesNotMatch(cancel, /fetch|performRead|startReadLoop|authorize|authority|continuation/i);
});

test('Replay Temporal wake currentness fails closed for every stale or unsafe fact', () => {
    const valid = {
        sequenceCurrent: true, generationCurrent: true, revisionCurrent: true, lifecycleCurrent: true,
        targetCurrent: true, modeReplay: true, visible: true, navigationPending: false, adActive: false,
        seekActive: false, reanchorActive: false, diagnosticLock: false, controlSuspended: false,
        videoCurrent: true, mediaPaused: false, mediaEnded: false, mediaSeeking: false,
        playerTimingValid: true, mediaTimeAdvanced: true
    };
    assert.equal(core.canRunReplayTemporalWakeup(valid), true);
    for (const key of ['sequenceCurrent', 'generationCurrent', 'revisionCurrent', 'lifecycleCurrent', 'targetCurrent',
        'modeReplay', 'visible', 'videoCurrent', 'playerTimingValid', 'mediaTimeAdvanced']) {
        assert.equal(core.canRunReplayTemporalWakeup({ ...valid, [key]: false }), false, key);
    }
    for (const key of ['navigationPending', 'adActive', 'seekActive', 'reanchorActive', 'diagnosticLock',
        'controlSuspended', 'mediaPaused', 'mediaEnded', 'mediaSeeking']) {
        assert.equal(core.canRunReplayTemporalWakeup({ ...valid, [key]: true }), false, key);
    }
});

test('Replay Temporal wake-up cancellation covers lifecycle and media invalidation', () => {
    const stop = pageStateSource.match(/function stopReadLoop\([^]*?\n    \}/)?.[0] || '';
    const reanchor = pageStateSource.match(/function queueReplayReanchor\([^]*?\n    \}/)?.[0] || '';
    assert.match(stop, /cancelReplayTemporalWakeup\(\)/);
    assert.match(reanchor, /cancelReplayTemporalWakeup\(\)/);
    assert.match(pageStateSource, /addEventListener\('pause'[^]*cancelReplayTemporalWakeup\(\)[^]*suspendReplayForMediaPause/);
    assert.match(pageStateSource, /\['waiting', 'stalled'\][^]*cancelReplayTemporalWakeup/);
    assert.match(pageStateSource, /function resumeReplayTemporalWakeup[^]*flushReplayPending\([^]*'temporal-wakeup'/);
    assert.match(pageStateSource, /addEventListener\('playing', resumeReplayTemporalWakeup, true\)/);
    assert.match(pageStateSource, /addEventListener\('canplay', resumeReplayTemporalWakeup, true\)/);
});

test('Replay pending merge keeps nearest one hundred and drops only farthest future items', () => {
    const near = Array.from({ length: 80 }, (_, index) => ({ id: `near-${index}`, replayOffsetMsec: 101000 + index }));
    const far = Array.from({ length: 70 }, (_, index) => ({ id: `far-${index}`, replayOffsetMsec: 200000 + index }));
    const selection = selectBoundedReplayDueMessages([...far, ...near], 100, 100, 100);
    assert.equal(selection.pending.length, 100);
    assert.equal(selection.capacityDropped, 50);
    assert.equal(selection.pending.filter(({ id }) => id.startsWith('near-')).length, 80);
    assert.equal(selection.pending.filter(({ id }) => id.startsWith('far-')).length, 20);
});

test('Replay due items are promoted before future capacity limiting', () => {
    const due = Array.from({ length: 50 }, (_, index) => ({ id: `due-${index}`, replayOffsetMsec: 100000 }));
    const future = Array.from({ length: 150 }, (_, index) => ({ id: `future-cap-${index}`, replayOffsetMsec: 110000 + index }));
    const selection = selectBoundedReplayDueMessages([...future, ...due], 100, 100, 100);
    assert.equal(selection.due.length, 50);
    assert.equal(selection.pending.length, 100);
    assert.equal(selection.capacityDropped, 50);
});

test('Replay pending merge deduplicates only identical server message identities', () => {
    const first = { id: 'same-server-message', replayOffsetMsec: 105000, message: 'same' };
    const repeated = { ...first };
    const distinct = { id: 'distinct-server-message', replayOffsetMsec: 105000, message: 'same' };
    const selection = selectBoundedReplayDueMessages([first, repeated, distinct], 100, 100, 100);
    assert.equal(selection.pending.length, 2);
    assert.equal(selection.deduplicatedCount, 1);
});

test('sequential continuation progression rejects repeat and return-to-seen shapes', () => {
    const classify = require('../src/chat-read-core.js').classifySequentialContinuationProgress;
    const seen = new Set(['request-token', 'older-token']);
    assert.equal(classify('request-token', 'next-token', seen), 'ADVANCED');
    assert.equal(classify('request-token', 'request-token', seen), 'REPEATED');
    assert.equal(classify('request-token', 'older-token', seen), 'RETURNED_TO_SEEN');
    assert.equal(classify('request-token', '', seen), 'MISSING');
    assert.equal(classify('', 'next-token', seen), 'UNKNOWN');
});

test('Replay sequential continuation selection prefers the sole unconsumed fixed-type candidate', () => {
    const { selectReplaySequentialContinuationInfo } = require('../src/chat-read-core.js');
    const response = { continuationContents: { liveChatContinuation: { continuations: [
        { playerSeekContinuationData: { continuation: 'player-seek' } },
        { liveChatReplayContinuationData: { continuation: 'C1', timeUntilLastMessageMsec: 1000 } },
        { timedContinuationData: { continuation: 'timed', timeoutMs: 1000 } },
        { liveChatReplayContinuationData: { continuation: 'C3', timeUntilLastMessageMsec: 1200 } }
    ] } } };
    const selected = selectReplaySequentialContinuationInfo(response, 'C2', new Set(['C0', 'C1', 'C2']));
    assert.deepEqual(selected, {
        info: { continuation: 'C3', timeoutMs: 1200, type: 'liveChatReplayContinuationData' },
        state: 'SELECTED_UNUSED_AMONG_CONSUMED'
    });
    assert.equal(selectReplaySequentialContinuationInfo(response, 'C2', new Set(['C0', 'C1', 'C2', 'C3'])).state, 'ONLY_CONSUMED');
});

test('observed next Replay continuation remains unused until it becomes request authority', () => {
    const { selectReplaySequentialContinuationInfo, classifySequentialContinuationProgress } = require('../src/chat-read-core.js');
    const response = (next) => ({ continuationContents: { liveChatContinuation: {
        continuations: [{ liveChatReplayContinuationData: { continuation: next, timeUntilLastMessageMsec: 1000 } }]
    } } });
    const consumed = new Set(['C0']);
    const c1 = selectReplaySequentialContinuationInfo(response('C1'), 'C0', consumed);
    assert.equal(c1.state, 'SINGLE_UNUSED');
    assert.equal(classifySequentialContinuationProgress('C0', c1.info.continuation, consumed), 'ADVANCED');
    assert.equal(consumed.has('C1'), false);
    consumed.add('C1');
    const c2 = selectReplaySequentialContinuationInfo(response('C2'), 'C1', consumed);
    assert.equal(classifySequentialContinuationProgress('C1', c2.info.continuation, consumed), 'ADVANCED');
});

test('Replay SINGLE_UNUSED candidate advances before local presentation runway expires', () => {
    const { validateReplayChatReadResponse, getReplayCoverageAwareReadDelayMs } = require('../src/chat-read-core.js');
    const response = { continuationContents: { liveChatContinuation: {
        actions: [],
        continuations: [{ liveChatReplayContinuationData: {
            continuation: 'C1', timeUntilLastMessageMsec: 188000
        } }]
    } } };
    const validation = validateReplayChatReadResponse(response, {
        requestContinuation: 'C0', consumedContinuations: new Set(['C0'])
    });

    assert.equal(validation.ok, true);
    assert.equal(validation.continuationCandidateState, 'SINGLE_UNUSED');
    assert.equal(validation.continuationInfo.continuation, 'C1');
    assert.equal(validation.effectiveDelayMs, 188000);
    assert.equal(getReplayCoverageAwareReadDelayMs(validation.effectiveDelayMs, [
        { replayOffsetMsec: 105000 }, { replayOffsetMsec: 110000 }
    ], 100), 9000);
    assert.match(pageStateSource, /getReplayCoverageAwareReadDelayMs\?\.\([^]*replayPending[^]*getCurrentMainVideo\(\)\?\.currentTime/);
    assert.match(pageStateSource, /waitForNextRead\(nextReadDelayMs, generation\)/);
});

test('Replay coverage-aware cadence is bounded, fail-closed, and does not alter due timing', () => {
    const { getReplayCoverageAwareReadDelayMs, selectReplayDueMessages } = require('../src/chat-read-core.js');
    const future = [{ id: 'future', replayOffsetMsec: 110000 }];
    assert.equal(getReplayCoverageAwareReadDelayMs(5000, future, 100), 5000);
    assert.equal(getReplayCoverageAwareReadDelayMs(188000, [], 100), LIVEFLOW_MIN_READ_DELAY_MS);
    assert.equal(getReplayCoverageAwareReadDelayMs(188000, [{ replayOffsetMsec: Number.NaN }], 100), null);
    assert.equal(getReplayCoverageAwareReadDelayMs(188000, future, Number.NaN), null);
    assert.deepEqual(selectReplayDueMessages(future, 100, 100), { due: [], pending: future });
});

test('Replay validation advances C0 through C3 and rejects ambiguous unused candidates', () => {
    const { validateReplayChatReadResponse } = require('../src/chat-read-core.js');
    const response = (...next) => ({ continuationContents: { liveChatContinuation: {
        actions: [],
        continuations: next.map((continuation) => ({ liveChatReplayContinuationData: {
            continuation, timeUntilLastMessageMsec: 1000
        } }))
    } } });
    const consumed = new Set(['C0']);
    for (const [request, next] of [['C0', 'C1'], ['C1', 'C2'], ['C2', 'C3']]) {
        consumed.add(request);
        const validation = validateReplayChatReadResponse(response(next), {
            requestContinuation: request, consumedContinuations: consumed
        });
        assert.equal(validation.ok, true);
        assert.equal(validation.continuationInfo.continuation, next);
        assert.equal(consumed.has(next), false);
    }
    const ambiguous = validateReplayChatReadResponse(response('C4', 'C5'), {
        requestContinuation: 'C3', consumedContinuations: new Set(['C0', 'C1', 'C2', 'C3'])
    });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.errorType, 'ambiguous_replay_continuation');
});

test('Replay temporal progression distinguishes forward, overlap, same, and backward windows', () => {
    const classify = require('../src/chat-read-core.js').classifyReplayTemporalProgress;
    const messages = (...offsets) => offsets.map((replayOffsetMsec, index) => ({ id: String(index), replayOffsetMsec }));
    assert.deepEqual(classify(messages(1000, 2000), messages(3000, 4000)), { direction: 'FORWARD', coverage: 'NEWER_THAN_PRIOR' });
    assert.deepEqual(classify(messages(1000, 3000), messages(2000, 4000)), { direction: 'FORWARD', coverage: 'OVERLAPS_PRIOR' });
    assert.deepEqual(classify(messages(1000, 2000), messages(1000, 2000)), { direction: 'STALLED', coverage: 'SAME_WINDOW' });
    assert.deepEqual(classify(messages(3000, 4000), messages(1000, 2000)), { direction: 'BACKWARD', coverage: 'OLDER_THAN_PRIOR' });
});

test('Replay gap diagnostic classifies response edges, coverage progress, and acquisition lead', () => {
    const summarize = core.summarizeReplayResponseTemporalShape;
    const messages = (...offsets) => offsets.map((replayOffsetMsec, index) => ({ id: String(index), replayOffsetMsec }));
    assert.deepEqual(summarize([], 10, messages(1000)), {
        responseFirstMessageRelation: 'EMPTY', responseLastMessageRelation: 'EMPTY',
        responseCoverageProgress: 'UNKNOWN', acquisitionLeadClass: 'NONE'
    });
    assert.deepEqual(summarize(messages(9000, 10000, 15000, 50000), 10, messages(1000, 12000)), {
        responseFirstMessageRelation: 'BEFORE_CURRENT', responseLastMessageRelation: 'FAR_FUTURE',
        responseCoverageProgress: 'OVERLAP', acquisitionLeadClass: 'LONG_GAP'
    });
    assert.equal(summarize(messages(30000, 40000), 10, messages(1000, 2000)).responseCoverageProgress, 'NEWER');
    assert.equal(summarize(messages(1000, 2000), 10, messages(30000, 40000)).responseCoverageProgress, 'OLDER');
    assert.equal(summarize(messages(1000, 2000), 10, messages(1000, 2000)).responseCoverageProgress, 'SAME');
    assert.equal(summarize(messages(500, 50000), 10, messages(1000, 40000)).responseCoverageProgress, 'MIXED');
    assert.equal(core.classifyReplayMessageRelation(10200, 10), 'CURRENT_WINDOW');
    assert.equal(core.classifyReplayMessageRelation(15000, 10), 'NEAR_FUTURE');
});

test('Replay response shape can advance continuously while leaving current-window supply empty', () => {
    const currentTimeSeconds = 58;
    const previous = [{ replayOffsetMsec: 129807 }];
    const incoming = Array.from({ length: 26 }, (_, index) => ({
        id: `shape-${index}`,
        replayOffsetMsec: 130186 + Math.round((2018 * index) / 25)
    }));

    assert.deepEqual(core.summarizeReplayResponseTemporalShape(incoming, currentTimeSeconds, previous), {
        responseFirstMessageRelation: 'FAR_FUTURE',
        responseLastMessageRelation: 'FAR_FUTURE',
        responseCoverageProgress: 'NEWER',
        acquisitionLeadClass: 'LONG_GAP'
    });
    assert.equal(incoming[0].replayOffsetMsec - previous[0].replayOffsetMsec, 379);
    const selection = selectBoundedReplayDueMessages(incoming, currentTimeSeconds, 0, 100);
    assert.equal(selection.due.length, 0);
    assert.equal(selection.pending.length, 26);
});

test('Replay coverage-hole repair is single-shot and classifies current, near, and far-only results', () => {
    const input = {
        semanticHole: true, episodeSpent: false, authorityAvailable: true, authorityCurrent: true,
        authorityUnused: true, capabilityAllowed: true, requestInFlight: false, reanchorActive: false,
        lifecycleCurrent: true, revisionCurrent: true, targetCurrent: true, generationCurrent: true,
        playerTimingValid: true, mainContentOwnershipValid: true, visible: true,
        seekActive: false, adActive: false, navigationPending: false
    };
    const eligible = core.evaluateReplayCoverageHoleRepair(input);
    assert.deepEqual(eligible, { eligible: true, decision: 'AUTHORIZE' });
    assert.deepEqual(core.evaluateReplayCoverageHoleRepair({ ...input, episodeSpent: true }), { eligible: false, decision: 'SPENT' });
    for (const change of [{ requestInFlight: true }, { capabilityAllowed: false }, { targetCurrent: false }, { adActive: true }])
        assert.equal(core.evaluateReplayCoverageHoleRepair({ ...input, ...change }).eligible, false);
    assert.equal(core.classifyReplayCoverageHoleRepairResult([{ replayOffsetMsec: 50000 }], 50), 'SUCCESS');
    assert.equal(core.classifyReplayCoverageHoleRepairResult([{ replayOffsetMsec: 55000 }], 50), 'SUCCESS');
    assert.equal(core.classifyReplayCoverageHoleRepairResult([{ replayOffsetMsec: 70000 }], 50), 'NO_PROGRESS');
    let episode = core.transitionReplayCoverageHoleEpisode(null, 'HOLE_OBSERVED');
    episode = core.transitionReplayCoverageHoleEpisode(episode, 'AUTHORIZED');
    assert.deepEqual(episode, { active: true, spent: true });
    assert.deepEqual(core.transitionReplayCoverageHoleEpisode(episode, 'HOLE_CLEARED'), { active: false, spent: false });
});

test('Replay coverage-hole repair merge preserves valid future pending with exact dedupe and no early display', () => {
    const prior = [
        { id: 'near', replayOffsetMsec: 55000 },
        { id: 'far', replayOffsetMsec: 80000 }
    ];
    const repair = [
        { id: 'near', replayOffsetMsec: 55000 },
        { id: 'current', replayOffsetMsec: 50000 }
    ];
    const merged = core.selectBoundedReplayDueMessages([...prior, ...repair], 50, 0, 100);
    assert.deepEqual(merged.due.map(({ id }) => id), ['current']);
    assert.deepEqual(merged.pending.map(({ id }) => id), ['near', 'far']);
    assert.equal(merged.deduplicatedCount, 1);
    assert.equal(merged.capacityDropped, 0);
});

test('Replay gap evidence classifies every disposition without retaining raw observations', () => {
    const dispositions = [
        ['FILTERED_BEFORE_START', 'FILTERED'], ['BRIDGED_DUE', 'ALREADY_BRIDGED'],
        ['CAPACITY_DROPPED', 'CAPACITY'], ['EXACT_ID_DEDUPED', 'DEDUPE'], ['RETAINED', 'RETAINED']
    ];
    for (const [disposition, origin] of dispositions) {
        const state = core.updateReplayGapEvidence(core.createReplayGapEvidenceState(), [
            { id: 'private-id', replayOffsetMsec: disposition === 'FILTERED_BEFORE_START' ? 9500 : 10000, disposition }
        ], 10);
        assert.deepEqual(core.summarizeReplayGapOrigin(state), {
            gapBandObserved: true, gapBandObservedDisposition: disposition, gapOriginClass: origin
        });
        assert.doesNotMatch(JSON.stringify(state), /private-id|replayOffsetMsec|"id"/i);
    }
    const observedNoBand = core.updateReplayGapEvidence(core.createReplayGapEvidenceState(), [
        { replayOffsetMsec: 50000, disposition: 'RETAINED' }
    ], 10);
    assert.deepEqual(core.summarizeReplayGapOrigin(observedNoBand), {
        gapBandObserved: false, gapBandObservedDisposition: 'NEVER_OBSERVED', gapOriginClass: 'SOURCE_OR_UNOBSERVED'
    });
    let mixed = core.updateReplayGapEvidence(core.createReplayGapEvidenceState(), [
        { id: 'a', replayOffsetMsec: 10000, disposition: 'BRIDGED_DUE' },
        { id: 'b', replayOffsetMsec: 11000, disposition: 'RETAINED' }
    ], 10);
    assert.equal(core.summarizeReplayGapOrigin(mixed).gapOriginClass, 'MIXED');
    assert.equal(core.summarizeReplayGapOrigin(null).gapOriginClass, 'UNKNOWN');
});

test('Replay gap evidence is fixed-shape and capacity-nearest preservation detects true and false cases', () => {
    let state = core.createReplayGapEvidenceState();
    for (let index = 0; index < 300; index += 1) state = core.updateReplayGapEvidence(state, [], 10);
    assert.equal(state.observationPasses, 255);
    assert.deepEqual(Object.keys(state).sort(), [
        'bridgedDue', 'capacityDropped', 'exactIdDeduped', 'filteredBeforeStart', 'observationPasses', 'retained',
        'unknownDisposition'
    ]);
    const future = [{ replayOffsetMsec: 20000 }, { replayOffsetMsec: 30000 }, { replayOffsetMsec: 40000 }];
    assert.equal(core.isNearestReplayFuturePreserved(future, future.slice(0, 2)), true);
    assert.equal(core.isNearestReplayFuturePreserved(future, future.slice(1)), false);
    assert.equal(core.isNearestReplayFuturePreserved([], []), 'UNKNOWN');
});

test('Replay gap evidence distinguishes unknown disposition from known and mixed evidence', () => {
    const initial = core.createReplayGapEvidenceState();
    const unknown = core.updateReplayGapEvidence(initial, [
        { replayOffsetMsec: 10000, disposition: 'UNCLASSIFIED' }
    ], 10);
    assert.deepEqual(core.summarizeReplayGapOrigin(unknown), {
        gapBandObserved: true, gapBandObservedDisposition: 'UNKNOWN', gapOriginClass: 'UNKNOWN'
    });
    const mixed = core.updateReplayGapEvidence(unknown, [
        { replayOffsetMsec: 11000, disposition: 'RETAINED' }
    ], 10);
    assert.equal(core.summarizeReplayGapOrigin(mixed).gapOriginClass, 'MIXED');
    assert.equal(mixed.unknownDisposition, true);
    assert.equal(mixed.retained, true);
});

test('Replay gap persistence requires consecutive far-ahead response shapes and stays bounded', () => {
    const far = {
        acquisitionLeadClass: 'LONG_GAP',
        responseFirstMessageRelation: 'FAR_FUTURE',
        responseLastMessageRelation: 'FAR_FUTURE'
    };
    let state = core.createReplayGapPersistenceState();
    state = core.updateReplayGapPersistenceState(state, far);
    assert.deepEqual(state, { acquisitionLeadConsecutive: 1, farFutureResponseConsecutive: 1 });
    state = core.updateReplayGapPersistenceState(state, far);
    assert.deepEqual(state, { acquisitionLeadConsecutive: 2, farFutureResponseConsecutive: 2 });
    state = core.updateReplayGapPersistenceState(state, {
        acquisitionLeadClass: 'SHORT_GAP',
        responseFirstMessageRelation: 'CURRENT_WINDOW',
        responseLastMessageRelation: 'NEAR_FUTURE'
    });
    assert.deepEqual(state, { acquisitionLeadConsecutive: 0, farFutureResponseConsecutive: 0 });
    state = { acquisitionLeadConsecutive: 255, farFutureResponseConsecutive: 255 };
    assert.deepEqual(core.updateReplayGapPersistenceState(state, far), state);
});

test('bounded Replay selection reports passive dedupe and nearest-preservation evidence only', () => {
    const selection = selectBoundedReplayDueMessages([
        { id: 'due', replayOffsetMsec: 10000 },
        { id: 'near', replayOffsetMsec: 20000 },
        { id: 'near', replayOffsetMsec: 20000 },
        { id: 'far', replayOffsetMsec: 30000 }
    ], 10, 0, 1);
    assert.deepEqual(selection.due.map(({ id }) => id), ['due']);
    assert.deepEqual(selection.pending.map(({ id }) => id), ['near']);
    assert.deepEqual(selection.capacityDroppedItems.map(({ id }) => id), ['far']);
    assert.deepEqual(selection.deduplicatedItems.map(({ id }) => id), ['near']);
    assert.equal(selection.capacitySelectionNearestPreserved, true);
});

test('nearest Replay future uses fixed shape-only proximity buckets', () => {
    const classify = require('../src/chat-read-core.js').classifyNearestReplayFuture;
    const at = (offset) => [{ replayOffsetMsec: offset }];
    assert.equal(classify([], 100), 'NONE');
    assert.equal(classify(at(101000), 100), 'IMMEDIATE');
    assert.equal(classify(at(108000), 100), 'SHORT_GAP');
    assert.equal(classify(at(125000), 100), 'MEDIUM_GAP');
    assert.equal(classify(at(90000), 100), 'IMMEDIATE');
    assert.equal(classify(at(180000), 100), 'LONG_GAP');
    assert.equal(classify(at(240000), 100), 'VERY_LONG_GAP');
    assert.equal(classify([{ replayOffsetMsec: Number.NaN }], 100), 'UNKNOWN');
});

test('Replay buffer pause diagnostic exposes count-only hysteresis across future gap classes', () => {
    const classify = require('../src/chat-read-core.js').classifyReplayBufferPauseState;
    assert.deepEqual(classify({ paused: true, pendingCount: 100, nearestFutureClass: 'IMMEDIATE' }), {
        temporalState: 'NEAR_FUTURE_AVAILABLE', futureGapWhilePaused: false, resumeBlockedByCount: true
    });
    assert.deepEqual(classify({ paused: true, pendingCount: 66, nearestFutureClass: 'IMMEDIATE' }), {
        temporalState: 'NEAR_FUTURE_AVAILABLE', futureGapWhilePaused: false, resumeBlockedByCount: true
    });
    for (const nearestFutureClass of ['MEDIUM_GAP', 'LONG_GAP']) {
        assert.deepEqual(classify({ paused: true, pendingCount: 66, nearestFutureClass }), {
            temporalState: 'ONLY_FAR_FUTURE', futureGapWhilePaused: true, resumeBlockedByCount: true
        });
    }
    assert.deepEqual(classify({ paused: true, pendingCount: 50, nearestFutureClass: 'LONG_GAP' }), {
        temporalState: 'ONLY_FAR_FUTURE', futureGapWhilePaused: true, resumeBlockedByCount: false
    });
    assert.deepEqual(classify({ paused: true, pendingCount: 0, nearestFutureClass: 'NONE' }), {
        temporalState: 'EMPTY', futureGapWhilePaused: false, resumeBlockedByCount: false
    });
});

test('Replay buffer early resume eligibility is bounded and fail-closed', () => {
    const evaluate = require('../src/chat-read-core.js').evaluateReplayBufferEarlyResume;
    const valid = {
        paused: true, pauseReason: 'COUNT_PRESSURE', pendingCount: 66, maximumPending: 100,
        dueCount: 0, schedulerPendingCount: 0, nearestFutureClass: 'MEDIUM_GAP',
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true,
        requestInFlight: false, activeLoop: false, locked: false, suppressed: false
    };
    for (const nearestFutureClass of ['MEDIUM_GAP', 'LONG_GAP', 'VERY_LONG_GAP']) {
        assert.deepEqual(evaluate({ ...valid, nearestFutureClass }), { eligible: true, decision: 'ELIGIBLE' });
    }
    for (const nearestFutureClass of ['IMMEDIATE', 'SHORT_GAP']) {
        assert.deepEqual(evaluate({ ...valid, nearestFutureClass }), { eligible: false, decision: 'NEAR_FUTURE' });
    }
    assert.equal(evaluate({ ...valid, pendingCount: 50 }).decision, 'COUNT_NOT_IN_RANGE');
    assert.equal(evaluate({ ...valid, dueCount: 1 }).decision, 'DUE_PRESENT');
    assert.equal(evaluate({ ...valid, schedulerPendingCount: 1 }).decision, 'SCHEDULER_PENDING');
    assert.equal(evaluate({ ...valid, authorityAvailable: false }).decision, 'AUTHORITY_UNAVAILABLE');
    for (const change of [{ authorityCurrent: false }, { authorityUnused: false }])
        assert.equal(evaluate({ ...valid, ...change }).decision, 'AUTHORITY_INVALID');
    for (const change of [{ requestInFlight: true }, { activeLoop: true }])
        assert.equal(evaluate({ ...valid, ...change }).decision, 'REQUEST_IN_FLIGHT');
    assert.equal(evaluate({ ...valid, locked: true }).decision, 'LOCKED');
    assert.equal(evaluate({ ...valid, suppressed: true }).decision, 'SUPPRESSED');
    assert.equal(evaluate({ ...valid, nearestFutureClass: 'UNKNOWN' }).decision, 'UNKNOWN');
    assert.equal(evaluate({ ...valid, schedulerPendingCount: undefined }).decision, 'UNKNOWN');
});

test('Replay buffer early resume suppression survives re-pause until the low watermark', () => {
    const transition = require('../src/chat-read-core.js').transitionReplayEarlyResumeSuppression;
    let state = transition('CLEAR', 'COUNT_PRESSURE_PAUSED');
    assert.equal(state, 'CLEAR');
    state = transition(state, 'EARLY_RESUME_STARTED');
    assert.equal(state, 'USED_WAITING_FOR_LOW_WATERMARK');
    state = transition(state, 'COUNT_PRESSURE_PAUSED');
    assert.equal(state, 'USED_WAITING_FOR_LOW_WATERMARK');
    state = transition(state, 'LOW_WATERMARK_REACHED');
    assert.equal(state, 'CLEAR');
    assert.equal(transition('USED_WAITING_FOR_LOW_WATERMARK', 'INVALIDATE'), 'CLEAR');
    assert.equal(transition('UNKNOWN', 'LOW_WATERMARK_REACHED'), 'UNKNOWN');
});

test('one-shot suppression structurally leaves a source-active far-future buffer without current-window supply', () => {
    const evaluateEarly = core.evaluateReplayBufferEarlyResume;
    const evaluateNormal = core.evaluateReplayNormalResume;
    const transition = core.transitionReplayEarlyResumeSuppression;
    const initial = Array.from({ length: 67 }, (_, index) => ({ id: `initial-${index}`, replayOffsetMsec: 70000 + index * 1000 }));
    const first = evaluateEarly({
        paused: true, pauseReason: 'COUNT_PRESSURE', pendingCount: initial.length, maximumPending: 100,
        dueCount: 0, schedulerPendingCount: 0, nearestFutureClass: 'LONG_GAP',
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true,
        requestInFlight: false, activeLoop: false, locked: false, suppressed: false
    });
    assert.deepEqual(first, { eligible: true, decision: 'ELIGIBLE' });

    let suppression = transition('CLEAR', 'EARLY_RESUME_STARTED');
    const incoming = Array.from({ length: 17 }, (_, index) => ({ id: `incoming-${index}`, replayOffsetMsec: 140000 + index * 1000 }));
    const sourceIngressDelta = incoming.length;
    const atElevenSeconds = selectBoundedReplayDueMessages([...initial, ...incoming], 11, 0, 100);
    const nearestFutureClass = core.classifyNearestReplayFuture(atElevenSeconds.pending, 11);
    assert.equal(sourceIngressDelta, 17);
    assert.equal(atElevenSeconds.pending.length, 84);
    assert.equal(atElevenSeconds.due.length, 0);
    assert.equal(nearestFutureClass, 'LONG_GAP');
    assert.deepEqual(evaluateNormal({
        paused: true, pendingCount: atElevenSeconds.pending.length, maximumPending: 100,
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true
    }), { eligible: false, reason: 'ABOVE_LOW_WATERMARK' });
    assert.deepEqual(evaluateEarly({
        paused: true, pauseReason: 'COUNT_PRESSURE', pendingCount: atElevenSeconds.pending.length, maximumPending: 100,
        dueCount: atElevenSeconds.due.length, schedulerPendingCount: 0, nearestFutureClass,
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true,
        requestInFlight: false, activeLoop: false, locked: false, suppressed: suppression !== 'CLEAR'
    }), { eligible: false, decision: 'SUPPRESSED' });
    suppression = transition(suppression, 'COUNT_PRESSURE_PAUSED');
    assert.equal(suppression, 'USED_WAITING_FOR_LOW_WATERMARK');
    const presentationProgress = { enqueued: atElevenSeconds.due.length, selected: 0, launched: 0, displayed: 0 };
    assert.deepEqual(presentationProgress, { enqueued: 0, selected: 0, launched: 0, displayed: 0 });
});

test('runway depletion episodes rearm only after canonical current-window recovery', () => {
    const transition = core.transitionReplayRunwayDepletionEpisode;
    const evaluate = core.evaluateReplayBufferEarlyResume;
    const eligibleInput = {
        paused: true, pauseReason: 'COUNT_PRESSURE', pendingCount: 84, maximumPending: 100,
        dueCount: 0, schedulerPendingCount: 0, nearestFutureClass: 'LONG_GAP',
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true,
        requestInFlight: false, activeLoop: false, locked: false
    };
    let state = transition('UNKNOWN', 'RUNWAY_POSITIVE');
    state = transition(state, 'RUNWAY_DEPLETED');
    assert.equal(state, 'DEPLETED_AVAILABLE');
    let authorizedRequests = 0;
    const firstDepletion = evaluate({ ...eligibleInput, suppressed: state !== 'DEPLETED_AVAILABLE' });
    assert.deepEqual(firstDepletion, { eligible: true, decision: 'ELIGIBLE' });
    if (firstDepletion.eligible) authorizedRequests += 1;

    state = transition(state, 'EARLY_RESUME_STARTED');
    assert.equal(state, 'DEPLETED_SPENT');
    for (const event of ['RUNWAY_DEPLETED', 'RUNWAY_DEPLETED']) {
        state = transition(state, event);
        assert.equal(state, 'DEPLETED_SPENT', 'future-only ingress and response progress do not rearm');
        assert.equal(evaluate({ ...eligibleInput, suppressed: state !== 'DEPLETED_AVAILABLE' }).decision, 'SUPPRESSED');
    }
    assert.equal(authorizedRequests, 1);

    state = transition(state, 'RUNWAY_POSITIVE');
    assert.equal(state, 'POSITIVE');
    state = transition(state, 'RUNWAY_DEPLETED');
    assert.equal(state, 'DEPLETED_AVAILABLE');
    const laterDepletion = evaluate({ ...eligibleInput, suppressed: state !== 'DEPLETED_AVAILABLE' });
    assert.equal(laterDepletion.eligible, true);
    if (laterDepletion.eligible) authorizedRequests += 1;
    assert.equal(authorizedRequests, 2, 'one request per distinct positive-to-depleted episode');
    assert.equal(evaluate({ ...eligibleInput, authorityAvailable: false, suppressed: false }).decision, 'AUTHORITY_UNAVAILABLE');
    assert.equal(evaluate({ ...eligibleInput, authorityCurrent: false, suppressed: false }).decision, 'AUTHORITY_INVALID');
    assert.equal(evaluate({ ...eligibleInput, requestInFlight: true, suppressed: false }).decision, 'REQUEST_IN_FLIGHT');
    assert.equal(transition(state, 'INVALIDATE'), 'UNKNOWN');
    const accounting = { input: eligibleInput.pendingCount, retained: eligibleInput.pendingCount, explicitRemoval: 0 };
    const lostUnaccounted = accounting.input - accounting.retained - accounting.explicitRemoval;
    assert.equal(lostUnaccounted, 0);
});

test('runway depletion episode leaves normal low-watermark resume unchanged', () => {
    assert.deepEqual(core.evaluateReplayNormalResume({
        paused: true, pendingCount: 50, maximumPending: 100,
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true
    }), { eligible: true, reason: 'ELIGIBLE' });
});

test('Temporal starvation diagnostic classifies pending distribution without raw timing output', () => {
    const summary = core.summarizeReplayTemporalAvailability([
        { replayOffsetMsec: 12000 }, { replayOffsetMsec: 15000 }, { replayOffsetMsec: 45000 }
    ], 10, 0, 100);
    assert.deepEqual(summary, {
        known: true, totalPendingClass: 'LOW_WATERMARK_OR_LESS', dueCountClass: 'ZERO',
        nearFutureCountClass: 'FEW', nearestFutureClass: 'IMMEDIATE'
    });
    assert.equal(JSON.stringify(summary).includes('12000'), false);
});

test('Temporal starvation predicate is observational, complete, and fail-closed', () => {
    const valid = {
        bufferPaused: true, pauseReason: 'COUNT_PRESSURE', pendingCount: 66, maximumPending: 100, dueCount: 0,
        schedulerPending: false, schedulerLaunchable: false, nearestFutureClass: 'MEDIUM_GAP',
        savedSequentialAvailable: true, savedSequentialCurrent: true, savedSequentialUnused: true,
        requestActive: false, locked: false, lifecycleCurrent: true, visible: true, adActive: false, seekActive: false,
        navigationPending: false
    };
    assert.deepEqual(core.evaluateReplayTemporalStarvation(valid), {
        known: true, observed: true, hypotheticalEligible: true, blockedReason: 'ELIGIBLE'
    });
    for (const patch of [
        { dueCount: 1 }, { schedulerPending: true }, { schedulerLaunchable: true },
        { nearestFutureClass: 'SHORT_GAP' }, { savedSequentialAvailable: false },
        { savedSequentialCurrent: false }, { savedSequentialUnused: false }, { requestActive: true },
        { visible: false }, { adActive: true }, { seekActive: true }, { navigationPending: true }
    ]) assert.equal(core.evaluateReplayTemporalStarvation({ ...valid, ...patch }).observed, false);
    assert.deepEqual(core.evaluateReplayTemporalStarvation({ ...valid, schedulerPending: undefined }), {
        known: false, observed: false, hypotheticalEligible: false, blockedReason: 'UNKNOWN'
    });
});

test('Temporal coverage comparison reports bounded shape-only improvement', () => {
    const base = { known: true, dueCountClass: 'ZERO', nearFutureCountClass: 'ZERO', nearestFutureClass: 'LONG_GAP' };
    assert.equal(core.compareReplayTemporalCoverage(base, { ...base }), 'NO_CHANGE');
    assert.equal(core.compareReplayTemporalCoverage(base, { ...base, dueCountClass: 'ONE' }), 'DUE_APPEARED');
    assert.equal(core.compareReplayTemporalCoverage(base, { ...base, nearFutureCountClass: 'FEW' }), 'NEAR_FUTURE_IMPROVED');
    assert.equal(core.compareReplayTemporalCoverage(base, { ...base, nearestFutureClass: 'MEDIUM_GAP' }), 'NEAREST_MOVED_CLOSER');
    assert.equal(core.compareReplayTemporalCoverage(null, base), 'UNKNOWN');
});

test('Temporal starvation episode history is monotonic across response and re-pause snapshots', () => {
    let history = core.mergeReplayTemporalEpisodeHistory({}, {
        earlyResumeAttempted: true, earlyResumeStarted: true,
        earlyResumeCompleted: false, earlyResumeProgressResult: 'UNKNOWN'
    });
    assert.deepEqual(history, {
        earlyResumeAttempted: true, earlyResumeStarted: true, earlyResumeCompleted: false,
        earlyResumeProgressResult: 'UNKNOWN', earlyResumeBudgetUsed: 1, hypotheticalRescueBudgetRemaining: 1
    });
    history = core.mergeReplayTemporalEpisodeHistory(history, {
        earlyResumeAttempted: false, earlyResumeStarted: false,
        earlyResumeCompleted: true, earlyResumeProgressResult: 'NO_CHANGE'
    });
    assert.equal(history.earlyResumeAttempted, true);
    assert.equal(history.earlyResumeStarted, true);
    assert.equal(history.earlyResumeCompleted, true);
    assert.equal(history.earlyResumeProgressResult, 'NO_CHANGE');
    history = core.mergeReplayTemporalEpisodeHistory(history, {
        earlyResumeAttempted: false, earlyResumeStarted: false,
        earlyResumeCompleted: false, earlyResumeProgressResult: 'UNKNOWN'
    });
    assert.deepEqual(history, {
        earlyResumeAttempted: true, earlyResumeStarted: true, earlyResumeCompleted: true,
        earlyResumeProgressResult: 'NO_CHANGE', earlyResumeBudgetUsed: 1, hypotheticalRescueBudgetRemaining: 1
    });
});

test('Temporal episode coherence derives attempted and started from completed history', () => {
    const history = core.mergeReplayTemporalEpisodeHistory({}, { earlyResumeCompleted: true });
    assert.equal(history.earlyResumeAttempted, true);
    assert.equal(history.earlyResumeStarted, true);
    assert.equal(history.earlyResumeCompleted, true);
    assert.equal(history.earlyResumeBudgetUsed, 1);
    assert.equal(history.hypotheticalRescueBudgetRemaining, 1);
});

test('Hypothetical rescue uses episode history and reports the first actual blocking condition', () => {
    const valid = {
        episodeActive: true, bufferPausedNow: true, pauseReason: 'COUNT_PRESSURE',
        episodeEarlyResumeStarted: true, budgetRemaining: 1, dueCount: 0,
        schedulerPending: false, schedulerLaunchable: false,
        savedSequentialAvailable: true, savedSequentialCurrent: true, savedSequentialUnused: true,
        requestActive: false, lifecycleCurrent: true, visible: true, adActive: false,
        seekActive: false, navigationPending: false, nearestFutureClass: 'LONG_GAP'
    };
    assert.deepEqual(core.evaluateReplayHypotheticalRescue(valid), {
        known: true, eligible: true, blockedReason: 'ELIGIBLE'
    });
    assert.equal(core.evaluateReplayHypotheticalRescue({ ...valid, nearestFutureClass: 'SHORT_GAP' }).blockedReason,
        'TEMPORAL_COVERAGE_NOT_STARVED');
    assert.equal(core.evaluateReplayHypotheticalRescue({ ...valid, bufferPausedNow: false }).blockedReason, 'NOT_PAUSED');
    assert.equal(core.evaluateReplayHypotheticalRescue({ ...valid, savedSequentialAvailable: false }).blockedReason, 'NO_SAVED_SEQUENTIAL');
    assert.equal(core.evaluateReplayHypotheticalRescue({ ...valid, requestActive: true }).blockedReason, 'REQUEST_ACTIVE');
    assert.equal(core.evaluateReplayHypotheticalRescue({ ...valid, budgetRemaining: 0 }).blockedReason, 'BUDGET_EXHAUSTED');
    assert.equal(core.evaluateReplayHypotheticalRescue({ ...valid, episodeEarlyResumeStarted: false }).blockedReason, 'EARLY_RESUME_NOT_USED');
    assert.deepEqual(core.evaluateReplayHypotheticalRescue({ ...valid, schedulerPending: undefined }), {
        known: false, eligible: false, blockedReason: 'UNKNOWN'
    });
});

test('soft temporal lead shadow uses coverage-aware hysteresis without behavior effects', () => {
    const base = {
        normalSequentialContext: true, lifecycleCurrent: true, targetCurrent: true, videoCurrent: true,
        visible: true, adActive: false, seekActive: false, navigationPending: false, reanchorActive: false,
        temporalFactsKnown: true, retainedFutureAvailable: true, acquisitionLeadPersistent: true,
        responseFarFuturePersistent: true, acquisitionLeadClass: 'LONG_GAP',
        retainedNearestDistanceClass: 'LONG_GAP', pendingCount: 66
    };
    assert.equal(core.evaluateReplayTemporalLeadShadow(false, base).shadowDecision, 'WOULD_ENTER');
    for (const nearest of ['MEDIUM_GAP', 'LONG_GAP']) {
        assert.equal(core.evaluateReplayTemporalLeadShadow(true, { ...base, retainedNearestDistanceClass: nearest }).shadowDecision, 'WOULD_HOLD');
    }
    for (const nearest of ['SHORT_GAP', 'IMMEDIATE']) {
        assert.equal(core.evaluateReplayTemporalLeadShadow(true, { ...base, retainedNearestDistanceClass: nearest }).shadowResumeReason, 'NEAR_COVERAGE');
    }
    assert.equal(core.evaluateReplayTemporalLeadShadow(true, { ...base, pendingCount: 50 }).shadowResumeReason, 'LOW_WATERMARK');
    assert.equal(core.evaluateReplayTemporalLeadShadow(true, { ...base, retainedFutureAvailable: false }).shadowResumeReason, 'FUTURE_NONE');
    assert.equal(core.evaluateReplayTemporalLeadShadow(false, { ...base, temporalFactsKnown: false }).shadowDecision, 'NO_HOLD');
    assert.equal(core.evaluateReplayTemporalLeadShadow(true, { ...base, temporalFactsKnown: false }).shadowDecision, 'WOULD_RELEASE_UNKNOWN');
    for (const change of [{ visible: false }, { adActive: true }, { seekActive: true }, { navigationPending: true }, { lifecycleCurrent: false }]) {
        assert.equal(core.evaluateReplayTemporalLeadShadow(true, { ...base, ...change }).shadowResumeReason, 'ENVIRONMENT_CHANGED');
    }
});

test('Replay start authority forbids bootstrap fallback and preserves saved sequential resume', () => {
    const authorize = require('../src/chat-read-core.js').authorizeReplayReadStart;
    const paused = {
        lifecycleGeneration: 7,
        bootstrapConsumedLifecycleGeneration: 7,
        bufferPaused: true,
        savedSequentialAvailable: true
    };
    assert.deepEqual(authorize(paused), {
        allowed: false, authorityKind: 'NONE', source: 'NONE', reason: 'BUFFER_REQUIRES_SAVED_SEQUENTIAL'
    });
    assert.deepEqual(authorize({ ...paused, continuationOverride: 'opaque', continuationSource: 'BUFFER_RESUME' }), {
        allowed: true, authorityKind: 'SEQUENTIAL', source: 'BUFFER_RESUME', reason: 'NONE'
    });
    assert.deepEqual(authorize({ ...paused, bufferPaused: false, savedSequentialAvailable: false }), {
        allowed: false, authorityKind: 'NONE', source: 'NONE', reason: 'BOOTSTRAP_CONSUMED'
    });
    assert.deepEqual(authorize({ ...paused, lifecycleGeneration: 8, bufferPaused: false, savedSequentialAvailable: false }), {
        allowed: true, authorityKind: 'BOOTSTRAP', source: 'INITIAL_WATCH', reason: 'NONE'
    });
});

test('Replay normal buffer resume accepts zero or sub-low-watermark pending only with current unused sequential authority', () => {
    const evaluate = require('../src/chat-read-core.js').evaluateReplayNormalResume;
    const valid = {
        paused: true, maximumPending: 100,
        authorityAvailable: true, authorityCurrent: true, authorityUnused: true
    };
    for (const pendingCount of [49, 0]) {
        assert.deepEqual(evaluate({ ...valid, pendingCount }), { eligible: true, reason: 'ELIGIBLE' });
    }
    assert.equal(evaluate({ ...valid, pendingCount: 51 }).reason, 'ABOVE_LOW_WATERMARK');
    assert.equal(evaluate({ ...valid, pendingCount: 0, authorityAvailable: false }).reason, 'AUTHORITY_UNAVAILABLE');
    assert.equal(evaluate({ ...valid, pendingCount: 0, authorityCurrent: false }).reason, 'AUTHORITY_INVALID');
    assert.equal(evaluate({ ...valid, pendingCount: 0, authorityUnused: false }).reason, 'AUTHORITY_INVALID');
});

test('consumed or returned sequential authority cannot reopen same-lifecycle bootstrap', () => {
    const core = require('../src/chat-read-core.js');
    const consumed = new Set(['C0', 'C1']);
    assert.equal(core.classifySequentialContinuationProgress('C1', 'C0', consumed), 'RETURNED_TO_SEEN');
    assert.deepEqual(core.authorizeReplayReadStart({
        lifecycleGeneration: 4,
        bootstrapConsumedLifecycleGeneration: 4,
        bufferPaused: false,
        savedSequentialAvailable: false
    }), { allowed: false, authorityKind: 'NONE', source: 'NONE', reason: 'BOOTSTRAP_CONSUMED' });
    assert.deepEqual(core.selectReplaySequentialContinuationInfo({
        continuationContents: { liveChatContinuation: { continuations: [
            { liveChatReplayContinuationData: { continuation: 'C0', timeUntilLastMessageMsec: 1000 } },
            { liveChatReplayContinuationData: { continuation: 'C1', timeUntilLastMessageMsec: 1000 } }
        ] } }
    }, 'C2', new Set([...consumed, 'C2'])).state, 'ONLY_CONSUMED');
});

test('Replay future capacity remains nearest-first independently of response arrival order', () => {
    const near = Array.from({ length: 66 }, (_, index) => ({ id: `near-retained-${index}`, replayOffsetMsec: 120000 + index }));
    const far = Array.from({ length: 96 }, (_, index) => ({ id: `far-dropped-${index}`, replayOffsetMsec: 300000 + index }));
    const selection = selectBoundedReplayDueMessages([...far, ...near], 100, 100, 100);
    assert.equal(selection.pending.length, 100);
    assert.equal(selection.pending.filter(({ id }) => id.startsWith('near-retained-')).length, 66);
    assert.equal(selection.capacityDropped, 62);
    assert.ok(selection.capacityDroppedItems.every(({ id }) => id.startsWith('far-dropped-')));
});

test('diagnostic identity accounting does not inflate across repeated flushes', () => {
    const count = require('../src/chat-read-core.js').countNewReplayMessageIdentities;
    const first = { id: 'first-private-id' };
    const second = { id: 'second-private-id' };
    const seen = new Set();
    assert.equal(count([first, second], seen), 2);
    assert.equal(count([{ ...first }, { ...second }], seen), 0);
    assert.equal(count([second, { id: 'third-private-id' }], seen), 1);
});

test('player-seek Active Gate cleanup clears in-flight state for every terminal result', () => {
    const finalize = require('../src/chat-read-core.js').finalizePlayerSeekDiagnosticState;
    for (const result of [
        { http: 'TWO_XX', jsonParsed: true },
        { http: 'NON_2XX', jsonParsed: false },
        { http: 'TWO_XX', jsonParsed: false },
        { http: 'TIMEOUT', jsonParsed: false },
        { http: 'ABORTED', jsonParsed: false }
    ]) {
        const state = { inFlight: true, result };
        assert.equal(finalize(state), state);
        assert.equal(state.inFlight, false);
    }
});

test('player-seek Active Gate preconditions reject every stale or unsafe run', () => {
    const { canRunPlayerSeekDiagnostic: canRun, getPlayerSeekDiagnosticNotSentReason: reason } = require('../src/chat-read-core.js');
    const valid = {
        armed: true, ready: true, consumed: false, inFlight: false,
        productionRequestInFlight: false, diagnosticLocked: false, mode: 'replay', runtimeEnabled: true,
        hidden: false, navigationPending: false, armedLifecycleGeneration: 5, currentLifecycleGeneration: 5,
        armedRevision: 8, currentRevision: 8, armedReadGeneration: 3, currentReadGeneration: 3,
        targetMatches: true, targetCurrent: true, videoPresent: true, seeking: false, offsetValid: true
    };
    assert.equal(canRun(valid), true);
    assert.equal(canRun({ ...valid, currentReadGeneration: 99 }), true, 'a seek-created read generation must not invalidate same-target authority');
    for (const patch of [
        { armed: false }, { ready: false }, { consumed: true }, { inFlight: true },
        { productionRequestInFlight: true }, { diagnosticLocked: true }, { mode: 'live' },
        { runtimeEnabled: false }, { hidden: true }, { navigationPending: true },
        { currentLifecycleGeneration: 6 }, { currentRevision: 9 },
        { targetMatches: false }, { targetCurrent: false }, { videoPresent: false }, { seeking: true }, { offsetValid: false }
    ]) assert.equal(canRun({ ...valid, ...patch }), false);
    assert.equal(reason({ ...valid, seeking: true }), 'SEEKING');
    assert.equal(reason({ ...valid, targetMatches: false }), 'STALE_TARGET');
    assert.equal(reason({ ...valid, currentLifecycleGeneration: 6 }), 'STALE_LIFECYCLE');
    assert.equal(reason({ ...valid, mode: 'live' }), 'NOT_REPLAY');
    assert.equal(reason({ ...valid, consumed: true }), 'AUTHORITY_CONSUMED');
    assert.equal(reason({ ...valid, productionRequestInFlight: true }), 'PRODUCTION_IN_FLIGHT');
});

test('Replay mode and video-time selection fail closed and never catch up old comments', () => {
    const selection = selectReplayDueMessages([
        { id: 'old', replayOffsetMsec: 1000 }, { id: 'due', replayOffsetMsec: 5100 }, { id: 'future', replayOffsetMsec: 8000 }
    ], 5, 4);
    assert.deepEqual(selection.due.map((item) => item.id), ['due']);
    assert.deepEqual(selection.pending.map((item) => item.id), ['future']);
    const stale = require('../src/chat-read-core.js').replayBatchIsEntirelyStale;
    assert.equal(stale([{ replayOffsetMsec: 1000 }], 5), true);
    assert.equal(stale([{ replayOffsetMsec: 5000 }], 5), false);
});

test('Replay timing classifies every message before bounding future pending', () => {
    const messages = [
        { id: 'old', replayOffsetMsec: 1000 },
        { id: 'due-a', replayOffsetMsec: 5000 },
        { id: 'due-b', replayOffsetMsec: 5200 },
        { id: 'far-future', replayOffsetMsec: 12000 },
        { id: 'near-future', replayOffsetMsec: 8000 }
    ];
    const selection = selectBoundedReplayDueMessages(messages, 5, 4, 1);
    assert.deepEqual(selection.due.map((item) => item.id), ['due-a', 'due-b']);
    assert.deepEqual(selection.pending.map((item) => item.id), ['near-future']);
    assert.equal(selection.filteredCount, 1);
    assert.equal(selection.capacityDropped, 1);
});

test('Replay pending promotes on current video time without widening timing tolerance', () => {
    const item = { id: 'pending', replayOffsetMsec: 8000 };
    assert.deepEqual(selectBoundedReplayDueMessages([item], 5, 4, 100).pending, [item]);
    assert.deepEqual(selectBoundedReplayDueMessages([item], 8, 4, 100).due, [item]);
});

test('Replay restart requires the current playable video context and never applies to Live', () => {
    const valid = { mode: 'replay', userEnabled: true, hidden: false, videoPresent: true, paused: false, seeking: false, ended: false, currentTime: 120 };
    assert.equal(canRestartReplayAtCurrentPosition(valid), true);
    for (const patch of [
        { mode: 'live' }, { userEnabled: false }, { hidden: true }, { videoPresent: false },
        { paused: true }, { seeking: true }, { ended: true }, { currentTime: Number.NaN }
    ]) assert.equal(canRestartReplayAtCurrentPosition({ ...valid, ...patch }), false);
});

test('foreground resume requires the exact hidden-stop lifecycle and current ownership', () => {
    const valid = {
        visibilityState: 'visible', userEnabled: true, stopReason: 'visibility-hidden',
        requestedLifecycleGeneration: 4, currentLifecycleGeneration: 4, navigationPending: false,
        targetMatched: true, continuationAvailable: true, contextAvailable: true,
        watchRootCurrent: true, activeLoopGeneration: 0, requestInFlight: false
    };
    assert.equal(canResumeReadAfterVisibility(valid), true);
    for (const patch of [
        { visibilityState: 'hidden' }, { userEnabled: false }, { stopReason: 'pagehide' },
        { stopReason: 'navigation' }, { requestedLifecycleGeneration: 3 }, { navigationPending: true },
        { targetMatched: false }, { continuationAvailable: false }, { contextAvailable: false },
        { watchRootCurrent: false }, { activeLoopGeneration: 9 }, { requestInFlight: true }
    ]) assert.equal(canResumeReadAfterVisibility({ ...valid, ...patch }), false);
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
