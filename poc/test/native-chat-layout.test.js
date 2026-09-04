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

test('runtime prevents duplicate installation and observer creation and cleans up SPA state', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/native-chat-layout.js'), 'utf8');
    assert.match(source, /if \(window\[INSTALLATION_KEY\]\) return;/);
    assert.match(source, /if \(observer \|\| destroyed \|\| !isPcWatchPage\(\)\) return;/);
    assert.match(source, /observer\.disconnect\(\)/);
    assert.match(source, /addEventListener\('yt-navigate-start', handleNavigationStart\)/);
    assert.match(source, /addEventListener\('yt-navigate-finish', handleNavigationFinish\)/);
    assert.match(source, /visualViewport\?\.addEventListener\('resize', scheduleLayout\)/);
    assert.match(source, /visualViewport\?\.addEventListener\('scroll', scheduleLayout\)/);
    assert.match(source, /addEventListener\('pagehide', destroy/);
    assert.doesNotMatch(source, /setInterval\s*\(/);
});
