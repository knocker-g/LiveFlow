const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatMessage, extractChatMessagesFromResponse, extractReplayChatMessagesFromResponse } = require('../src/chat-read-core.js');
const { normalizeDanmakuMessage } = require('../src/overlay-core.js');
const { classifySemanticClass } = require('../src/pending-selection.js');

// Synthetic fixtures based on parser source, not live-service captures:
// https://github.com/taizan-hokuto/pytchat/blob/master/pytchat/processors/default/renderer/base.py
// https://github.com/LuanRT/YouTube.js/blob/main/src/parser/classes/LiveChatAuthorBadge.ts
const badge = (fields) => ({ liveChatAuthorBadgeRenderer: fields });
const member = badge({ customThumbnail: { thumbnails: [{ url: 'https://example.com/member.png' }] }, tooltip: 'メンバー' });
const moderator = badge({ icon: { iconType: 'MODERATOR' }, tooltip: '任意の表示文言' });
const owner = badge({ icon: { iconType: 'OWNER' }, tooltip: '任意の表示文言' });
const renderer = (authorBadges) => ({ id: 'role-comment', authorName: { simpleText: 'Alice' },
    timestampUsec: '1710000000000000', message: { runs: [{ text: 'Keep this body' }] }, authorBadges });

for (const [role, evidence] of [['member', member], ['moderator', moderator], ['owner', owner]]) {
    test(`reliable ${role} author badge normalizes independently of message semantics`, () => {
        for (const messageType of ['text', 'superChat', 'superSticker']) {
            const message = ChatMessage.fromRenderer(renderer([evidence]), messageType);
            assert.equal(message.authorRole, role);
            assert.equal(message.message, 'Keep this body');
            assert.equal(message.messageType, messageType);
            assert.equal(normalizeDanmakuMessage(message).authorRole, role);
            assert.equal(classifySemanticClass({ rendererType: messageType === 'text' ? 'liveChatTextMessageRenderer'
                : messageType === 'superChat' ? 'liveChatPaidMessageRenderer' : 'liveChatPaidStickerRenderer',
                authorRole: message.authorRole }), messageType === 'text' ? 'NORMAL' : 'SPECIAL');
        }
    });
}

test('guest, tooltip-only, unrecognized, malformed and conflicting evidence never elevates', () => {
    const cases = [undefined, [], {}, [null], ['OWNER'], [{ icon: { iconType: 'OWNER' } }],
        [badge({ tooltip: 'Member' })], [badge({ tooltip: 'Owner', icon: { iconType: 'VERIFIED' } })],
        [badge({ icon: { iconType: 'owner' } })], [badge({ icon: { iconType: 'UNKNOWN_ROLE' } })],
        [badge({ customThumbnail: {} })], [badge({ customThumbnail: { thumbnails: [{ url: 'javascript:alert(1)' }] } })],
        [badge({ customThumbnail: { thumbnails: [{ url: 'https://example.com/member.png' }] }, icon: { iconType: 'UNKNOWN_ROLE' } })],
        [owner, moderator], [member, owner], [member, moderator]];
    for (const evidence of cases) {
        const message = ChatMessage.fromRenderer(renderer(evidence));
        assert.equal(message.authorRole, 'guest', JSON.stringify(evidence));
        assert.equal(message.message, 'Keep this body');
        assert.equal(normalizeDanmakuMessage(message).authorRole, 'guest');
    }
});

test('duplicate same-role and unrelated verified badge do not change reliable role', () => {
    for (const [role, evidence] of [['member', member], ['moderator', moderator], ['owner', owner]]) {
        assert.equal(ChatMessage.fromRenderer(renderer([evidence, evidence,
            badge({ icon: { iconType: 'VERIFIED' } })])).authorRole, role);
    }
});

test('shared Live and Replay Adapter preserves source ordering and offsets for normalized roles', () => {
    const actions = [member, moderator, owner].map((evidence, index) => ({ addChatItemAction: { item: {
        liveChatTextMessageRenderer: { ...renderer([evidence]), id: String(index) }
    } } }));
    const response = (actions) => ({ continuationContents: { liveChatContinuation: { actions } } });
    assert.deepEqual(extractChatMessagesFromResponse(response(actions)).map((m) => [m.id, m.authorRole]),
        [['0', 'member'], ['1', 'moderator'], ['2', 'owner']]);
    const replay = extractReplayChatMessagesFromResponse(response([{ replayChatItemAction: {
        videoOffsetTimeMsec: '12500', actions
    } }]));
    assert.deepEqual(replay.map((m) => [m.id, m.authorRole, m.replayOffsetMsec]),
        [['0', 'member', 12500], ['1', 'moderator', 12500], ['2', 'owner', 12500]]);
    const [milestone] = extractChatMessagesFromResponse(response([{ addChatItemAction: { item: {
        liveChatMembershipItemRenderer: renderer([member])
    } } }]));
    assert.equal(milestone.authorRole, 'member');
    assert.equal(milestone.messageType, 'text');
    assert.equal(milestone.message, 'Keep this body');
});
