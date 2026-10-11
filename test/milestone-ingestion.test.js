const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { extractChatMessagesFromResponse, extractReplayChatMessagesFromResponse } = require('../src/chat-read-core.js');
const overlayCore = require('../src/overlay-core.js');
const { createPendingItem } = require('../src/pending-selection.js');

// Synthetic schema fixture, not a service capture. message and membership headers are
// separate fields in https://github.com/LuanRT/YouTube.js/blob/main/src/parser/classes/livechat/items/LiveChatMembershipItem.ts
const renderer = {
    id: 'milestone-1', timestampUsec: '1710000000000000',
    authorName: { simpleText: 'Alice' }, authorExternalChannelId: 'UC-member',
    authorBadges: [{ liveChatAuthorBadgeRenderer: { tooltip: 'Member for 12 months' } }],
    headerPrimaryText: { runs: [{ text: 'Member for 12 months' }] },
    headerSubtext: { runs: [{ text: 'Membership tier' }] },
    message: { runs: [{ text: '  Thank you' }, { text: '\nfor ' }, { emoji: {
        image: { thumbnails: [{ url: 'https://example.com/heart.png' }] },
        shortcuts: [':heart:']
    } }, { text: ' everything  ' }] }
};
const action = (value) => ({ addChatItemAction: { item: { liveChatMembershipItemRenderer: value } } });
const response = (actions) => ({ continuationContents: { liveChatContinuation: { actions } } });
const expectedText = '  Thank you\nfor :heart: everything  ';

test('membership milestone body becomes a NORMAL text comment without membership header copy', () => {
    const messages = extractChatMessagesFromResponse(response([action(renderer)]));
    assert.equal(messages.length, 1, 'displayable milestone was discarded at renderer dispatch');
    const message = messages[0];
    assert.equal(message.message, expectedText);
    assert.equal(message.messageType, 'text');
    assert.equal(message.authorRole, 'guest');
    assert.deepEqual(message.authorBadges, ['Member for 12 months']);
    assert.equal(message.messageRuns.length, 4);
    assert.equal(overlayCore.normalizeDanmakuMessage(message).text, expectedText);
    assert.equal(overlayCore.normalizeDanmakuMessage(message).messageType, undefined);
});

test('membership without role evidence retains body; absent body does not turn headers into copy', () => {
    const [message] = extractChatMessagesFromResponse(response([action({ ...renderer, authorBadges: undefined,
        message: { runs: [{ text: 'x'.repeat(300) }] } })]));
    assert.ok(message);
    assert.equal(message.authorRole, 'guest');
    assert.equal(message.message, 'x'.repeat(300));
    const [empty] = extractChatMessagesFromResponse(response([action({ ...renderer, message: undefined })]));
    assert.ok(empty);
    assert.equal(empty.message, '');
    assert.equal(overlayCore.normalizeDanmakuMessage(empty), null);
});

test('Replay membership uses the shared Adapter and preserves temporal offset', () => {
    const [message] = extractReplayChatMessagesFromResponse(response([{ replayChatItemAction: {
        videoOffsetTimeMsec: '12500', actions: [action(renderer)]
    } }]));
    assert.ok(message);
    assert.equal(message.message, expectedText);
    assert.equal(message.messageType, 'text');
    assert.equal(message.replayOffsetMsec, 12500);
});

test('actual batch boundary gives milestone NORMAL enqueue and unweighted Source Activity parity', () => {
    const source = fs.readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8');
    const batch = source.match(/    function scheduleDanmakuBatch\([^]*?\n    \}/)[0];
    const activity = source.match(/    function observeCurrentWindowSourceActivity\([^]*?\n    \}/)[0];
    const enqueued = [];
    const observations = [];
    const video = { currentTime: 12.5, paused: false, ended: false, readyState: 4 };
    const media = { player: { classList: { contains: () => false } }, video };
    const runtime = {
        enqueue: (payload, options) => { enqueued.push(createPendingItem({ ...options, payload })); return true; },
        observeSourceActivity: (input) => { observations.push(input); return input; }
    };
    const context = vm.createContext({ overlayCore, currentChatMode: 'live',
        isEffectiveDisplayActive: () => true, getCurrentMainMedia: () => media,
        livePresentationResumeGateActive: false, phase3Runtime: runtime, phase3RuntimeVideo: video,
        ensurePhase3Runtime: () => runtime, ensureSubtitleGeometryObservers: () => {},
        ensurePlaybackContextObserver: () => {}, rendererGeneration: 1, currentPageLifecycleGeneration: 1,
        runtimeSettings: { showGuest: false, showMembership: false },
        phase5Tuning: { lineHeight: 30 }, performance: { now: () => 100 },
        observeLivePresentationBatch: () => {}, currentSourceActivityBinding: () => ({ generation: 1 }),
        PHASE3_UNTUNED_RUNTIME: { sourceActivityWindowMsec: 10000 }
    });
    vm.runInContext(`${activity}\n${batch}\nthis.schedule = scheduleDanmakuBatch;`, context);
    const [milestone] = extractChatMessagesFromResponse(response([action(renderer)]));
    assert.ok(milestone);
    const [normal] = extractChatMessagesFromResponse(response([{ addChatItemAction: { item: {
        liveChatTextMessageRenderer: { ...renderer, id: 'normal-1' }
    } } }]));
    context.schedule([milestone, normal]);
    assert.equal(enqueued.length, 2);
    for (const item of enqueued) {
        assert.equal(item.semanticClass, 'NORMAL');
        assert.equal(item.rendererType, 'liveChatTextMessageRenderer');
        assert.equal(item.footprint.kind, 'NORMAL');
        assert.equal(item.payload.message.authorRole, 'guest');
    }
    assert.equal(observations[0].facts.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(observations[0].facts)), [
        { mediaTimeMs: 12500, displayable: true, temporalClass: 'CURRENT_WINDOW' },
        { mediaTimeMs: 12500, displayable: true, temporalClass: 'CURRENT_WINDOW' }
    ]);
});
