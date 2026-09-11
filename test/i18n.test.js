const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'manifest.json'), 'utf8'));
const jaMessages = JSON.parse(fs.readFileSync(path.join(repositoryRoot, '_locales/ja/messages.json'), 'utf8'));
const enMessages = JSON.parse(fs.readFileSync(path.join(repositoryRoot, '_locales/en/messages.json'), 'utf8'));
const requiredKeys = [
    'extensionName',
    'extensionDescription',
    'managementBarLabel',
    'liveFlowOn',
    'liveFlowOff',
    'commentsSection',
    'appearanceSection',
    'adaptiveSection',
    'nativeChatSection',
    'otherSection',
    'chatClosedEnablesLiveFlow',
    'liveFlowOffOpensChat',
    'resetSettings',
    'resetConfirmation',
    'cancel',
    'confirmReset',
    'settingsSaved',
    'settingsReset'
];

test('Japanese and English locale catalogs have the same complete key set', () => {
    assert.deepEqual(Object.keys(jaMessages).sort(), Object.keys(enMessages).sort());
    for (const key of requiredKeys) {
        assert.equal(typeof jaMessages[key]?.message, 'string');
        assert.ok(jaMessages[key].message.trim());
        assert.equal(typeof enMessages[key]?.message, 'string');
        assert.ok(enMessages[key].message.trim());
    }
});

test('manifest uses Japanese as default locale and localized metadata keys', () => {
    assert.equal(manifest.default_locale, 'ja');
    assert.equal(manifest.name, '__MSG_extensionName__');
    assert.equal(manifest.description, '__MSG_extensionDescription__');
    assert.ok(jaMessages.extensionName);
    assert.ok(jaMessages.extensionDescription);
    assert.ok(enMessages.extensionName);
    assert.ok(enMessages.extensionDescription);
});

test('runtime UI locale keys are available in both catalogs', () => {
    for (const key of ['managementBarLabel', 'liveFlowOn', 'liveFlowOff', 'chatClosedEnablesLiveFlow', 'liveFlowOffOpensChat']) {
        assert.ok(jaMessages[key]?.message);
        assert.ok(enMessages[key]?.message);
    }
});
