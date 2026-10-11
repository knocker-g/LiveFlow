const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const overlayCore = require('../src/overlay-core.js');
const { ChatMessage } = require('../src/chat-read-core.js');
const source = fs.readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8');

function node() {
    return { className: '', dataset: {}, style: {}, childNodes: [],
        classList: { add() {} }, append(...children) { this.childNodes.push(...children); },
        appendChild(child) { this.childNodes.push(child); } };
}
function create(message) {
    const context = vm.createContext({ document: { createElement: node, createTextNode: (text) => ({ text }) },
        overlayCore, phase5Tuning: { fontSize: 28, lineHeight: 32 }, runtimeSettings: {} });
    vm.runInContext(source.match(/    function createDanmakuNode\([^]*?\n    \}/)[0] + '\nthis.create = createDanmakuNode;', context);
    return context.create(overlayCore.normalizeDanmakuMessage(message), {});
}

test('existing candidate maps normalized roles to three distinct CSS fills without guest changes', () => {
    for (const [role, color] of [['member', '#66e08a'], ['moderator', '#70b7ff'], ['owner', '#ffd75e']]) {
        const rule = source.match(new RegExp(`\\.liveflow-danmaku\\[data-author-role="${role}"\\] \\{([^}]+)\\}`))[1];
        assert.match(rule, new RegExp(`color: ${color};`));
        assert.match(rule, /paint-order: stroke fill;/, 'role fill must cover inward stroke at glyph junctions');
        assert.doesNotMatch(rule, /font|width|height|animation|position|lane/);
    }
    assert.match(source, /data-author-role="guest"\] \{ color: #fff; -webkit-text-stroke: 1\.1px #202020; paint-order: stroke fill/);
});

test('actual Presentation node receives Adapter roles and unknown fallback, with SPECIAL white override', () => {
    const evidence = {
        member: { customThumbnail: { thumbnails: [{ url: 'https://example.com/badge.png' }] } },
        moderator: { icon: { iconType: 'MODERATOR' } }, owner: { icon: { iconType: 'OWNER' } },
        guest: { tooltip: 'Owner' }
    };
    for (const [role, badge] of Object.entries(evidence)) {
        for (const type of ['text', 'superChat', 'superSticker']) {
            const message = ChatMessage.fromRenderer({ message: { runs: [{ text: 'Role visual candidate' }] },
                authorBadges: [{ liveChatAuthorBadgeRenderer: badge }] }, type);
            const rendered = create(message);
            assert.equal(rendered.dataset.authorRole, role);
            assert.equal(rendered.style.color, type === 'text' ? undefined : '#FFFFFF');
            assert.equal(rendered.dataset.messageType, type === 'text' ? undefined : type);
        }
    }
    assert.equal(create({ messageType: 'text', message: 'Unknown', authorRole: 'unrecognized' }).dataset.authorRole, 'guest');
    assert.match(source, /liveflow-danmaku\.liveflow-danmaku-special \{ -webkit-text-stroke: \.8px rgba\(0,0,0,\.85\); paint-order: stroke fill/);
});
