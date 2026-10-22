(function (global) {
    const STORAGE_KEY = 'liveflowSettingsV1';
    const SETTINGS_VERSION = 1;
    const DEFAULT_SETTINGS = Object.freeze({
        version: SETTINGS_VERSION,
        displayEnabled: true,
        showGuest: true,
        showMember: true,
        showModerator: true,
        showOwner: true,
        showYou: true,
        showSuperChat: true,
        showSuperSticker: true,
        showMembership: true,
        showAvatars: true,
        showPinnedComments: true,
        fontSizeMode: 'auto',
        fontScalePercent: 100,
        commentDurationMs: 8000,
        opacityPercent: 80,
        emojiImages: true,
        adaptiveDensity: true,
        avoidSubtitles: true,
        autoEnableLiveFlowWhenNativeChatClosed: true,
        autoOpenNativeChatWhenLiveFlowDisabled: true
    });
    const CAPABILITIES = Object.freeze({
        displayEnabled: true,
        showAvatars: true,
        opacityPercent: true,
        emojiImages: true,
        autoEnableLiveFlowWhenNativeChatClosed: true,
        autoOpenNativeChatWhenLiveFlowDisabled: true
    });
    const LEGACY_SEMANTIC_KEYS = Object.freeze([
        'showGuest', 'showMember', 'showModerator', 'showOwner', 'showYou',
        'showSuperChat', 'showSuperSticker', 'showMembership'
    ]);
    const BOOLEAN_KEYS = Object.freeze([
        'displayEnabled', 'showGuest', 'showMember', 'showModerator', 'showOwner', 'showYou',
        'showSuperChat', 'showSuperSticker', 'showMembership', 'showAvatars',
        'showPinnedComments', 'emojiImages', 'adaptiveDensity', 'avoidSubtitles',
        'autoEnableLiveFlowWhenNativeChatClosed', 'autoOpenNativeChatWhenLiveFlowDisabled'
    ]);

    function clampNumber(value, min, max, fallback) {
        return typeof value === 'number' && Number.isFinite(value)
            ? Math.min(max, Math.max(min, value))
            : fallback;
    }

    function normalizeSettings(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const normalized = { ...DEFAULT_SETTINGS };
        for (const key of BOOLEAN_KEYS) {
            normalized[key] = typeof source[key] === 'boolean' ? source[key] : DEFAULT_SETTINGS[key];
        }
        // v1 preserves these fields for storage compatibility, but semantic classes are never user-filtered.
        for (const key of LEGACY_SEMANTIC_KEYS) normalized[key] = true;
        normalized.fontSizeMode = source.fontSizeMode === 'manual' ? 'manual' : 'auto';
        normalized.fontScalePercent = clampNumber(source.fontScalePercent, 70, 150, DEFAULT_SETTINGS.fontScalePercent);
        normalized.commentDurationMs = clampNumber(source.commentDurationMs, 4000, 12000, DEFAULT_SETTINGS.commentDurationMs);
        normalized.opacityPercent = clampNumber(source.opacityPercent, 0, 100, DEFAULT_SETTINGS.opacityPercent);
        normalized.version = SETTINGS_VERSION;
        return normalized;
    }

    function createSettingsSnapshot(value) {
        const normalized = normalizeSettings(value);
        return Object.freeze({
            schemaVersion: SETTINGS_VERSION,
            displayEnabled: normalized.displayEnabled,
            showAvatars: normalized.showAvatars,
            showPinnedComments: normalized.showPinnedComments,
            fontSizeMode: normalized.fontSizeMode,
            fontScalePercent: normalized.fontScalePercent,
            opacityPercent: normalized.opacityPercent,
            emojiImages: normalized.emojiImages,
            avoidSubtitles: normalized.avoidSubtitles,
            autoEnableLiveFlowWhenNativeChatClosed: normalized.autoEnableLiveFlowWhenNativeChatClosed,
            autoOpenNativeChatWhenLiveFlowDisabled: normalized.autoOpenNativeChatWhenLiveFlowDisabled
        });
    }

    // Keep persistence outcomes out of both storage and the runtime SettingsSnapshot.
    // Existing consumers still receive safe normalized preferences on storage failure.
    const operationStatuses = new WeakMap();
    const writeQueues = new WeakMap();
    const UNKNOWN_OPERATION = Object.freeze({ status: 'UNKNOWN', persisted: false });
    function operationResult(settings, status) {
        operationStatuses.set(settings, Object.freeze({ status, persisted: status === 'SAVED' }));
        return settings;
    }
    function getSettingsOperationStatus(settings) {
        return operationStatuses.get(settings) || UNKNOWN_OPERATION;
    }
    function rawObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    function readRawSettings(storageArea) {
        if (!storageArea || typeof storageArea.get !== 'function') return Promise.resolve({ ok: false, status: 'UNAVAILABLE' });
        return new Promise(resolve => {
            try {
                storageArea.get(STORAGE_KEY, result => {
                    try {
                        if (global.chrome?.runtime?.lastError) return resolve({ ok: false, status: 'READ_FAILED' });
                        resolve({ ok: true, raw: rawObject(result?.[STORAGE_KEY]), status: 'LOADED' });
                    } catch { resolve({ ok: false, status: 'READ_FAILED' }); }
                });
            } catch { resolve({ ok: false, status: 'READ_FAILED' }); }
        });
    }
    async function getStoredSettings(storageArea) {
        const result = await readRawSettings(storageArea);
        return operationResult(normalizeSettings(result.raw), result.status);
    }
    function ownedPatch(value) {
        const source = rawObject(value), patch = {};
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (key !== 'version' && Object.hasOwn(source, key)) patch[key] = source[key];
        }
        return patch;
    }
    function writeSettings(storageArea, current, value, reset = false) {
        const patch = ownedPatch(value);
        const safe = normalizeSettings({ ...normalizeSettings(current), ...patch });
        if (!storageArea || typeof storageArea.set !== 'function') return Promise.resolve(operationResult(safe, 'UNAVAILABLE'));
        const task = async () => {
            // Explicit Reset alone may replace unknown/future fields. Ordinary edits
            // must not overwrite storage when its freshest value could not be read.
            const latest = reset ? { ok: true, raw: {} } : await readRawSettings(storageArea);
            if (!latest.ok) return operationResult(safe, latest.status);
            const normalized = normalizeSettings({ ...latest.raw, ...patch });
            const version = Number.isSafeInteger(latest.raw.version) && latest.raw.version > SETTINGS_VERSION
                ? latest.raw.version : SETTINGS_VERSION;
            const stored = reset ? { ...DEFAULT_SETTINGS } : { ...latest.raw, ...normalized, version };
            return new Promise(resolve => {
                try {
                    storageArea.set({ [STORAGE_KEY]: stored }, () => {
                        try { resolve(operationResult(normalized, global.chrome?.runtime?.lastError ? 'WRITE_FAILED' : 'SAVED')); }
                        catch { resolve(operationResult(safe, 'WRITE_FAILED')); }
                    });
                } catch { resolve(operationResult(safe, 'WRITE_FAILED')); }
            });
        };
        // Context-local ordering only. Cross-context writers still obey Chrome's
        // last-completed-write-wins contract, with no distributed lock or retries.
        const next = (writeQueues.get(storageArea) || Promise.resolve()).then(task)
            .catch(() => operationResult(safe, 'WRITE_FAILED'));
        writeQueues.set(storageArea, next.then(() => undefined));
        return next;
    }
    function persistSettings(storageArea, value) {
        return writeSettings(storageArea, undefined, value);
    }

    function updateSettings(storageArea, current, patch) {
        return writeSettings(storageArea, current, patch);
    }

    function resetSettings(storageArea) {
        return writeSettings(storageArea, DEFAULT_SETTINGS, DEFAULT_SETTINGS, true);
    }

    const api = {
        STORAGE_KEY,
        SETTINGS_VERSION,
        DEFAULT_SETTINGS,
        CAPABILITIES,
        normalizeSettings,
        createSettingsSnapshot,
        getStoredSettings,
        getSettingsOperationStatus,
        persistSettings,
        updateSettings,
        resetSettings
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowSettingsCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
