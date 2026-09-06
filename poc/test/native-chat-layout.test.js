const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    calculateNativeChatLayout,
    selectViewportMetrics,
    NARROW_VIEWPORT_MAX_WIDTH_PX,
    MIN_NATIVE_CHAT_HEIGHT_PX
} = require('../src/native-chat-layout-core.js');

test('narrow viewport calculates Native Chat height from visible space', () => {
    assert.deepEqual(calculateNativeChatLayout({
        viewportWidth: 412,
        viewportHeight: 900,
        chatTop: 420
    }), {
        active: true,
        reason: 'narrow-viewport',
        maxChatHeightPx: 468
    });
});

test('wide viewport leaves the Native Chat layout untouched', () => {
    assert.deepEqual(calculateNativeChatLayout({
        viewportWidth: NARROW_VIEWPORT_MAX_WIDTH_PX + 1,
        viewportHeight: 900,
        chatTop: 420
    }), { active: false, reason: 'wide-viewport' });
});

test('visual viewport metrics include keyboard-driven height and offset', () => {
    assert.deepEqual(selectViewportMetrics({
        visualViewport: { width: 412, height: 480, offsetTop: 120 },
        innerWidth: 412,
        innerHeight: 900
    }), { width: 412, height: 480, offsetTop: 120 });
    assert.equal(calculateNativeChatLayout({
        viewportWidth: 412,
        viewportHeight: 480,
        viewportOffsetTop: 120,
        chatTop: 300
    }).maxChatHeightPx, 288);
});

test('layout falls back to the normal viewport when visualViewport is unavailable', () => {
    assert.deepEqual(selectViewportMetrics({ innerWidth: 700, innerHeight: 800 }), {
        width: 700,
        height: 800,
        offsetTop: 0
    });
});

test('invalid or insufficient available height safely produces no layout', () => {
    assert.equal(calculateNativeChatLayout({ viewportWidth: -1, viewportHeight: 800, chatTop: 300 }).active, false);
    assert.equal(calculateNativeChatLayout({ viewportWidth: 400, viewportHeight: 300, chatTop: 200 }).active, false);
    assert.equal(calculateNativeChatLayout({ viewportWidth: 400, viewportHeight: 800, chatTop: Number.NaN }).active, false);
    assert.equal(MIN_NATIVE_CHAT_HEIGHT_PX, 180);
});

test('management-area reservation reduces only the available Chat height', () => {
    const layout = calculateNativeChatLayout({
        viewportWidth: 400,
        viewportHeight: 900,
        chatTop: 400,
        managementReservedHeight: 48
    });
    assert.equal(layout.active, true);
    assert.equal(layout.maxChatHeightPx, 440);
});

test('management height is reserved exactly once when Chat top already includes the in-flow bar', () => {
    const layout = calculateNativeChatLayout({
        viewportWidth: 400,
        viewportHeight: 900,
        chatTop: 448,
        managementReservedHeight: 48,
        managementAlreadyIncludedInChatTop: true
    });
    assert.equal(layout.active, true);
    assert.equal(layout.maxChatHeightPx, 440);
});

test('transient visual viewport offsets cannot produce an extreme Chat height', () => {
    const layout = calculateNativeChatLayout({
        viewportWidth: 400,
        viewportHeight: 480,
        viewportOffsetTop: 500,
        chatTop: 400
    });
    assert.equal(layout.active, true);
    assert.equal(layout.maxChatHeightPx, 468);
});

test('keyboard shrink and close restore derive fresh heights from each visual viewport', () => {
    const keyboardOpen = calculateNativeChatLayout({
        viewportWidth: 412,
        viewportHeight: 480,
        viewportOffsetTop: 120,
        chatTop: 300,
        managementReservedHeight: 52,
        managementAlreadyIncludedInChatTop: true
    });
    const keyboardClosed = calculateNativeChatLayout({
        viewportWidth: 412,
        viewportHeight: 900,
        viewportOffsetTop: 0,
        chatTop: 420,
        managementReservedHeight: 52,
        managementAlreadyIncludedInChatTop: true
    });
    assert.equal(keyboardOpen.maxChatHeightPx, 288);
    assert.equal(keyboardClosed.maxChatHeightPx, 468);
});

test('portrait and landscape calculations never reuse prior geometry', () => {
    const portrait = calculateNativeChatLayout({ viewportWidth: 412, viewportHeight: 900, chatTop: 420 });
    const landscape = calculateNativeChatLayout({ viewportWidth: 780, viewportHeight: 412, chatTop: 190 });
    const portraitAgain = calculateNativeChatLayout({ viewportWidth: 412, viewportHeight: 900, chatTop: 420 });
    assert.equal(portrait.maxChatHeightPx, 468);
    assert.equal(landscape.maxChatHeightPx, 210);
    assert.deepEqual(portraitAgain, portrait);
});

test('runtime prevents duplicate installation and observer creation and cleans up SPA state', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/native-chat-layout.js'), 'utf8');
    assert.match(source, /if \(window\[INSTALLATION_KEY\]\) return;/);
    assert.match(source, /if \(observer\?\.__liveflowRoot === root\) return;/);
    assert.match(source, /nodeAffectsLayout/);
    assert.match(source, /addedNodes, \.\.\.mutation\.removedNodes/);
    assert.match(source, /managementAlreadyIncludedInChatTop: Boolean/);
    assert.match(source, /if \(activeChat && activeChat !== chat\) clearActiveLayout\(\)/);
    assert.doesNotMatch(source, /if \(observer\) \{\s*observer\.disconnect\(\);\s*observer = null;\s*\}/);
    assert.match(source, /observer\.disconnect\(\)/);
    assert.match(source, /addEventListener\('yt-navigate-start', handleNavigationStart\)/);
    assert.match(source, /addEventListener\('yt-navigate-finish', handleNavigationFinish\)/);
    assert.match(source, /visualViewport\?\.addEventListener\('resize', scheduleLayout\)/);
    assert.match(source, /visualViewport\?\.addEventListener\('scroll', scheduleLayout\)/);
    assert.match(source, /addEventListener\('pagehide', destroy/);
    assert.doesNotMatch(source, /setInterval\s*\(/);
});
