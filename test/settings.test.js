const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    STORAGE_KEY,
    SETTINGS_VERSION,
    DEFAULT_SETTINGS,
    CAPABILITIES,
    normalizeSettings,
    getStoredSettings,
    persistSettings,
    updateSettings,
    resetSettings
} = require('../src/settings-core.js');

function createStorage(initial) {
    let state = initial;
    return {
        get(key, callback) { callback({ [key]: state }); },
        set(value, callback) { state = value[STORAGE_KEY]; callback(); },
        value() { return state; }
    };
}

test('v1 global settings defaults match the product model', () => {
    assert.equal(SETTINGS_VERSION, 1);
    assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
    for (const key of ['showGuest', 'showMember', 'showModerator', 'showOwner', 'showYou', 'showSuperChat', 'showSuperSticker', 'showMembership', 'showAvatars', 'showPinnedComments', 'emojiImages', 'adaptiveDensity', 'avoidSubtitles', 'autoEnableLiveFlowWhenNativeChatClosed', 'autoOpenNativeChatWhenLiveFlowDisabled']) {
        assert.equal(DEFAULT_SETTINGS[key], true);
    }
    assert.equal(DEFAULT_SETTINGS.opacityPercent, 80);
    assert.equal(DEFAULT_SETTINGS.fontSizeMode, 'auto');
    assert.equal(DEFAULT_SETTINGS.fontScalePercent, 100);
    assert.equal(DEFAULT_SETTINGS.commentDurationMs, 8000);
});

test('partial and malformed storage is merged, validated, and clamped', () => {
    const normalized = normalizeSettings({
        showGuest: false,
        showMember: 'false',
        fontSizeMode: 'unknown',
        fontScalePercent: 999,
        commentDurationMs: 1000,
        opacityPercent: Number.NaN,
        unknownKey: true
    });
    assert.equal(normalized.showGuest, false);
    assert.equal(normalized.showMember, true);
    assert.equal(normalized.fontSizeMode, 'auto');
    assert.equal(normalized.fontScalePercent, 150);
    assert.equal(normalized.commentDurationMs, 4000);
    assert.equal(normalized.opacityPercent, 80);
    assert.equal('unknownKey' in normalized, false);
});

test('settings persistence, updates, and reset use one global storage key', async () => {
    const storage = createStorage({ autoEnableLiveFlowWhenNativeChatClosed: false });
    const loaded = await getStoredSettings(storage);
    assert.equal(loaded.autoEnableLiveFlowWhenNativeChatClosed, false);
    assert.equal(loaded.showGuest, true);
    const updated = await updateSettings(storage, loaded, { autoOpenNativeChatWhenLiveFlowDisabled: false });
    assert.equal(updated.autoOpenNativeChatWhenLiveFlowDisabled, false);
    assert.deepEqual(storage.value(), updated);
    const persisted = await persistSettings(storage, { opacityPercent: 20 });
    assert.equal(persisted.opacityPercent, 20);
    assert.equal(persisted.showGuest, true);
    const reset = await resetSettings(storage);
    assert.deepEqual(reset, DEFAULT_SETTINGS);
    assert.deepEqual(storage.value(), DEFAULT_SETTINGS);
});

test('storage absence fails safely to defaults', async () => {
    assert.deepEqual(await getStoredSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(await persistSettings(undefined, { showGuest: false }), { ...DEFAULT_SETTINGS, showGuest: false });
});

test('only confirmed Guest, avatar, and linkage preferences are enabled capabilities', () => {
    assert.deepEqual(CAPABILITIES, {
        showGuest: true,
        showAvatars: true,
        autoEnableLiveFlowWhenNativeChatClosed: true,
        autoOpenNativeChatWhenLiveFlowDisabled: true
    });
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (key === 'version') continue;
        if (['showGuest', 'showAvatars', 'autoEnableLiveFlowWhenNativeChatClosed', 'autoOpenNativeChatWhenLiveFlowDisabled'].includes(key)) assert.equal(CAPABILITIES[key], true);
        else assert.notEqual(CAPABILITIES[key], true);
    }
});

test('popup is mobile-first, localized, and has no LiveFlow master switch', () => {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'popup/popup.css'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    assert.match(html, /comments-controls/);
    assert.match(html, /appearance-controls/);
    assert.match(html, /adaptive-controls/);
    assert.match(html, /native-chat-controls/);
    assert.match(html, /reset-settings/);
    assert.doesNotMatch(html + source, /masterEnabled|master-toggle|LiveFlow master/i);
    assert.match(css, /width:\s*340px/);
    assert.match(css, /max-width:\s*100vw/);
    assert.match(css, /min-height:\s*44px/);
    assert.match(source, /chrome\?\.i18n\?\.getMessage/);
    assert.match(source, /control\.disabled = core\.CAPABILITIES\[key\] !== true/);
    assert.match(source, /globalThis\.confirm\(message\('resetConfirmation'/);
    assert.match(source, /core\.updateSettings\(storageArea/);
});

test('manifest loads settings only in the isolated runtime and exposes the popup', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../manifest.json'), 'utf8'));
    const main = manifest.content_scripts.find((entry) => entry.world === 'MAIN');
    const isolated = manifest.content_scripts.find((entry) => entry.world === 'ISOLATED');
    assert.doesNotMatch(main.js.join('\n'), /settings-core/);
    assert.equal(isolated.js[0], 'src/settings-core.js');
    assert.equal(manifest.action.default_popup, 'popup/popup.html');
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
});

test('active runtime applies storage changes without reload or polling', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/youtube-chat.js'), 'utf8');
    assert.match(source, /chrome\?\.storage\?\.onChanged\?\.addListener/);
    assert.match(source, /applyPersistentSettings\(changes\[settingsCore\.STORAGE_KEY\]\.newValue\)/);
    assert.doesNotMatch(source, /setInterval|location\.reload/);
});
