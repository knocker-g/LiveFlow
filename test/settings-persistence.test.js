const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const settingsSource = fs.readFileSync(require.resolve('../src/settings-core.js'), 'utf8');
const popupSource = fs.readFileSync(require.resolve('../popup/popup.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => value === undefined ? undefined : structuredClone(value);

function environment(initial, { manual = false, readError = false, writeError = false, throwRead = false, throwWrite = false } = {}) {
    let durable = copy(initial), gets = 0, writes = 0;
    const listeners = [];
    const pending = [], chrome = { runtime: {}, i18n: { getMessage: () => '' } };
    const withError = (failure, callback) => {
        if (failure) chrome.runtime.lastError = { message: 'PRIVATE_STORAGE_ERROR' };
        try { callback(); } finally { delete chrome.runtime.lastError; }
    };
    const area = {
        get(key, callback) { gets++; if (throwRead) throw Error('PRIVATE_GET');
            queueMicrotask(() => withError(readError, () => callback({ [key]: copy(durable) }))); },
        set(value, callback) { writes++; if (throwWrite) throw Error('PRIVATE_SET');
            const finish = () => {
                const previous = durable;
                const failed = typeof writeError === 'function' ? writeError() : writeError;
                if (!failed) {
                    durable = copy(value.liveflowSettingsV1);
                    for (const listener of listeners) listener({ liveflowSettingsV1: { oldValue: copy(previous), newValue: copy(durable) } }, 'local');
                }
                withError(failed, callback);
            };
            if (manual) pending.push(finish); else queueMicrotask(finish);
        }
    };
    chrome.storage = { local: area, onChanged: { addListener: listener => listeners.push(listener) } };
    const context = vm.createContext({ chrome, console });
    vm.runInContext(settingsSource, context);
    return { context, core: context.LiveFlowSettingsCore, area, pending, listeners,
        durable: () => durable, counts: () => ({ gets, writes }) };
}
function popup(env) {
    const nodes = new Map();
    function element(tag = 'div') {
        return { tagName: tag.toUpperCase(), dataset: {}, listeners: {}, children: [], textContent: '',
            set id(value) { this._id = value; nodes.set(value, this); }, get id() { return this._id; },
            append(...children) { this.children.push(...children); }, setAttribute() {}, focus() {},
            addEventListener(type, callback) { this.listeners[type] = callback; } };
    }
    for (const id of ['comments-controls', 'appearance-controls', 'adaptive-controls', 'native-chat-controls',
        'save-status', 'reset-confirmation', 'reset-settings', 'cancel-reset', 'confirm-reset']) {
        element().id = id;
    }
    env.context.document = { createElement: element, getElementById: id => nodes.get(id), querySelectorAll: () => [] };
    vm.runInContext(popupSource, env.context);
    return { nodes, status: () => nodes.get('save-status').textContent,
        change(key, value) { const control = nodes.get('setting-' + key); control.checked = value; control.value = String(value);
            return control.listeners.change({ currentTarget: control }); },
        reset: () => nodes.get('confirm-reset').listeners.click() };
}

test('future storage is read-only on load and unknown fields/version survive a known-field edit', async () => {
    const original = { version: 4, opacityPercent: 65, showAvatars: false, future: { palette: ['x', 'y'] } };
    const e = environment(original);
    const loaded = await e.core.getStoredSettings(e.area);
    assert.equal(loaded.opacityPercent, 65); assert.equal(e.counts().writes, 0);
    await e.core.updateSettings(e.area, loaded, { opacityPercent: 40 });
    assert.equal(e.durable().version, 4); assert.deepEqual(e.durable().future, original.future);
    assert.equal(e.durable().showAvatars, false); assert.equal(e.durable().opacityPercent, 40);
});

for (const failure of ['writeError', 'throwWrite', 'readError', 'throwRead']) {
    test('actual popup does not report Saved after ' + failure, async () => {
        const original = { version: 1, opacityPercent: 75, showAvatars: true };
        const e = environment(original, { [failure]: true }), p = popup(e);
        await tick(); await p.change('showAvatars', false);
        assert.notEqual(p.status(), 'Saved'); assert.match(p.status(), /unavailable|not saved/i);
        assert.deepEqual(e.durable(), original);
        assert.doesNotMatch(p.status(), /PRIVATE/);
        if (failure === 'readError' || failure === 'throwRead') assert.equal(e.counts().writes, 0);
    });
}

test('same-context rapid edits refresh durable data and cannot complete writes out of order', async () => {
    const e = environment({ version: 1, opacityPercent: 80, showAvatars: true, future: 9 }, { manual: true });
    const stale = await e.core.getStoredSettings(e.area);
    const one = e.core.updateSettings(e.area, stale, { showAvatars: false });
    const two = e.core.updateSettings(e.area, stale, { opacityPercent: 25 });
    await tick(); assert.equal(e.pending.length, 1);
    e.pending.shift()(); await tick(); assert.equal(e.pending.length, 1);
    e.pending.shift()(); await Promise.all([one, two]);
    assert.equal(e.durable().showAvatars, false); assert.equal(e.durable().opacityPercent, 25);
    assert.equal(e.durable().future, 9);
});

test('explicit reset during a pending edit is ordered and replaces unknown fields only at reset', async () => {
    const e = environment({ version: 4, future: 'retain-until-reset' }, { manual: true });
    const edit = e.core.updateSettings(e.area, {}, { opacityPercent: 20 });
    const reset = e.core.resetSettings(e.area);
    await tick(); assert.equal(e.pending.length, 1);
    e.pending.shift()(); await tick(); assert.equal(e.pending.length, 1);
    e.pending.shift()(); await Promise.all([edit, reset]);
    assert.deepEqual(e.durable(), copy(e.core.DEFAULT_SETTINGS));
});

test('actual popup rapid changes retain both preferences and show success only for latest ACK', async () => {
    const e = environment({ version: 1 }, { manual: true }), p = popup(e); await tick();
    const one = p.change('showAvatars', false), two = p.change('opacityPercent', 25);
    await tick(); assert.equal(p.status(), ''); assert.equal(e.pending.length, 1);
    e.pending.shift()(); await tick(); assert.equal(p.status(), '');
    e.pending.shift()(); await Promise.all([one, two]);
    assert.equal(e.durable().showAvatars, false); assert.equal(e.durable().opacityPercent, 25);
    assert.equal(p.status(), 'Saved');
});

test('old/current/malformed preferences migrate purely, locally and idempotently without writeback', async () => {
    for (const value of [null, [], 'invalid', { version: 0, opacityPercent: 35, showAvatars: false, showGuest: false },
        { version: 1, fontScalePercent: Infinity, opacityPercent: 25, emojiImages: false }]) {
        const e = environment(value), before = copy(value);
        const first = await e.core.getStoredSettings(e.area), second = e.core.normalizeSettings(first);
        assert.deepEqual(copy(first), copy(second)); assert.deepEqual(e.durable(), before);
        assert.equal(e.counts().writes, 0); assert.equal(first.version, 1);
        if (value?.opacityPercent) assert.equal(first.opacityPercent, value.opacityPercent);
        if (value?.showAvatars === false) assert.equal(first.showAvatars, false);
        if (value?.emojiImages === false) assert.equal(first.emojiImages, false);
        assert.equal(first.showGuest, true);
    }
});

test('runtime/protocol fields from callers never enter storage or immutable runtime snapshots', async () => {
    const e = environment({ version: 1, futurePreference: { theme: 'x' } });
    const secrets = { continuation: 'PRIVATE_TOKEN', authority: {}, generation: 12, pending: [1], url: 'PRIVATE_URL' };
    const saved = await e.core.updateSettings(e.area, secrets, { ...secrets, opacityPercent: 40 });
    const snapshot = e.core.createSettingsSnapshot({ ...saved, ...secrets });
    for (const key of Object.keys(secrets)) {
        assert.equal(Object.hasOwn(e.durable(), key), false); assert.equal(Object.hasOwn(snapshot, key), false);
    }
    assert.equal(Object.isFrozen(snapshot), true); assert.equal(snapshot.opacityPercent, 40);
    assert.deepEqual(e.durable().futurePreference, { theme: 'x' });
    assert.equal(Object.hasOwn(e.durable(), 'persisted'), false); assert.equal(Object.hasOwn(snapshot, 'persisted'), false);
    assert.equal(e.core.getSettingsOperationStatus(saved).persisted, true);
    assert.equal(e.core.getSettingsOperationStatus(snapshot).persisted, false);
});

test('failed write returns usable preferences and later writes proceed without replaying failed patches', async () => {
    let fail = true;
    const e = environment({ version: 1, opacityPercent: 80, future: 1 }, { writeError: () => fail });
    const failed = await e.core.updateSettings(e.area, {}, { opacityPercent: 30 });
    assert.equal(e.core.getSettingsOperationStatus(failed).status, 'WRITE_FAILED');
    assert.equal(e.core.getSettingsOperationStatus(failed).persisted, false);
    assert.equal(e.core.createSettingsSnapshot(failed).opacityPercent, 30);
    assert.equal(e.durable().opacityPercent, 80); assert.equal(e.counts().writes, 1);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|WRITE_FAILED|persisted/);
    fail = false;
    const saved = await e.core.updateSettings(e.area, failed, { showAvatars: false });
    assert.equal(e.core.getSettingsOperationStatus(saved).persisted, true);
    assert.equal(e.durable().opacityPercent, 80, 'Failed patch is not silently retried');
    assert.equal(e.durable().showAvatars, false); assert.equal(e.durable().future, 1);
});

test('popup reset is explicit, ordered after pending edits, and only acknowledged reset reports success', async () => {
    const e = environment({ version: 3, future: 4 }, { manual: true }), p = popup(e); await tick();
    assert.equal(e.counts().writes, 0);
    const edit = p.change('showAvatars', false), reset = p.reset();
    await tick(); assert.equal(e.pending.length, 1); e.pending.shift()(); await tick();
    assert.equal(p.status(), ''); e.pending.shift()(); await Promise.all([edit, reset]);
    assert.equal(p.status(), 'Settings reset'); assert.deepEqual(e.durable(), copy(e.core.DEFAULT_SETTINGS));
    const failed = environment({ version: 1, opacityPercent: 65 }, { writeError: true }), badPopup = popup(failed); await tick();
    await badPopup.reset(); assert.equal(badPopup.status(), 'Not saved'); assert.equal(failed.durable().opacityPercent, 65);
});

test('storage absence never claims persistence; popup controls are inactive until initial read completes', async () => {
    const e = environment({ version: 1 });
    const p = popup(e);
    assert.equal(p.nodes.get('setting-showAvatars').disabled, true);
    await tick(); assert.equal(p.nodes.get('setting-showAvatars').disabled, false);
    const result = await e.core.persistSettings(undefined, { opacityPercent: 30 });
    assert.equal(e.core.getSettingsOperationStatus(result).status, 'UNAVAILABLE');
    assert.equal(e.core.getSettingsOperationStatus(result).persisted, false);
});

test('cross-context last completed write wins and actual storage listeners converge without Authority/acquisition actions', async () => {
    const e = environment({ version: 1, opacityPercent: 80, showAvatars: true }, { manual: true });
    const other = vm.createContext({ chrome: e.context.chrome }); vm.runInContext(settingsSource, other);
    const runtimeSource = fs.readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8');
    const extract = name => runtimeSource.match(new RegExp(`function ${name}\\([^]*?\\n    \\}`))[0];
    for (const c of [e.context, other]) {
        c.window = { LiveFlowSettingsCore: c.LiveFlowSettingsCore };
        Object.assign(c, { runtimeSettings: c.LiveFlowSettingsCore.createSettingsSnapshot(), userEnabled: true,
            persistentSettingsReady: false, overlaySurface: { style: {} }, phase3Runtime: { markGeometryDirty() {} },
            authoritySentinel: Object.freeze({ current: true }),
            startReadLoop() { throw Error('UNAUTHORIZED_READ'); }, invalidateReplaySeekAuthority() { throw Error('UNAUTHORIZED_AUTHORITY'); } });
        vm.runInContext(extract('applyPersistentSettings') + '\n' + extract('initializePersistentSettings'), c);
        await c.initializePersistentSettings(); c.userEnabled = false;
    }
    const a = e.core.updateSettings(e.area, {}, { showAvatars: false });
    const b = other.LiveFlowSettingsCore.updateSettings(e.area, {}, { opacityPercent: 20 });
    await tick(); assert.equal(e.pending.length, 2, 'No cross-context lock/CAS is promised');
    e.pending[1](); e.pending[0](); e.pending.length = 0; await Promise.all([a, b]);
    assert.equal(e.durable().showAvatars, false); assert.equal(e.durable().opacityPercent, 80);
    for (const c of [e.context, other]) {
        assert.equal(c.runtimeSettings.showAvatars, false); assert.equal(c.runtimeSettings.opacityPercent, 80);
        assert.equal(c.userEnabled, false, 'Persistent defaults do not flip current tab Display');
        assert.equal(c.authoritySentinel.current, true);
    }
});

test('preferences survive fresh runtime startup while tab Display remains separate from persistent defaults', async () => {
    const e = environment({ version: 3, futurePreference: { theme: 'x' } });
    const saved = await e.core.updateSettings(e.area, {}, {
        displayEnabled: false, showAvatars: false, opacityPercent: 35, emojiImages: false
    });
    assert.equal(e.core.getSettingsOperationStatus(saved).persisted, true);
    const beforeRestart = copy(e.durable()), writesBeforeRestart = e.counts().writes;
    // Fresh global and Core instance share only the durable storage adapter.
    const restarted = vm.createContext({ chrome: e.context.chrome });
    vm.runInContext(settingsSource, restarted);
    restarted.window = { LiveFlowSettingsCore: restarted.LiveFlowSettingsCore };
    Object.assign(restarted, { runtimeSettings: restarted.LiveFlowSettingsCore.createSettingsSnapshot(),
        userEnabled: true, persistentSettingsReady: false, overlaySurface: { style: {} },
        phase3Runtime: { markGeometryDirty() { throw Error('UNEXPECTED_GEOMETRY_CHANGE'); } },
        startReadLoop() { throw Error('UNAUTHORIZED_READ'); },
        invalidateReplaySeekAuthority() { throw Error('UNAUTHORIZED_AUTHORITY'); } });
    const source = fs.readFileSync(require.resolve('../src/youtube-chat.js'), 'utf8');
    const extract = name => source.match(new RegExp(`function ${name}\\([^]*?\\n    \\}`))[0];
    vm.runInContext(extract('applyPersistentSettings') + '\n' + extract('initializePersistentSettings'), restarted);
    await restarted.initializePersistentSettings();
    assert.equal(restarted.persistentSettingsReady, true);
    for (const key of ['displayEnabled', 'showAvatars', 'opacityPercent', 'emojiImages']) {
        assert.equal(restarted.runtimeSettings[key], beforeRestart[key], key);
    }
    assert.equal(Object.isFrozen(restarted.runtimeSettings), true);
    assert.equal(restarted.overlaySurface.style.opacity, '0.35');
    assert.equal(restarted.userEnabled, false, 'Persistent default initializes a new tab');
    assert.equal(e.counts().writes, writesBeforeRestart, 'Startup performs no writeback or Reset');
    assert.deepEqual(e.durable(), beforeRestart);
    // A tab-local Display choice does not modify storage and survives later storage events.
    restarted.userEnabled = true;
    assert.deepEqual(e.durable(), beforeRestart);
    await e.core.updateSettings(e.area, saved, { opacityPercent: 20 });
    assert.equal(restarted.runtimeSettings.opacityPercent, 20);
    assert.equal(restarted.runtimeSettings.displayEnabled, false);
    assert.equal(restarted.userEnabled, true);
    assert.equal(e.durable().displayEnabled, false);
    assert.deepEqual(e.durable().futurePreference, beforeRestart.futurePreference);
});
