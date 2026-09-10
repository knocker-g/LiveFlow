(function (global) {
    const STORAGE_KEY = 'liveflowSettingsV1';
    const SETTINGS_VERSION = 1;
    const DEFAULT_SETTINGS = Object.freeze({
        version: SETTINGS_VERSION,
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
        showGuest: true,
        showSuperChat: true,
        showSuperSticker: true,
        showAvatars: true,
        emojiImages: true,
        autoEnableLiveFlowWhenNativeChatClosed: true,
        autoOpenNativeChatWhenLiveFlowDisabled: true
    });
    const BOOLEAN_KEYS = Object.freeze([
        'showGuest', 'showMember', 'showModerator', 'showOwner', 'showYou',
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
        normalized.fontSizeMode = source.fontSizeMode === 'manual' ? 'manual' : 'auto';
        normalized.fontScalePercent = clampNumber(source.fontScalePercent, 70, 150, DEFAULT_SETTINGS.fontScalePercent);
        normalized.commentDurationMs = clampNumber(source.commentDurationMs, 4000, 12000, DEFAULT_SETTINGS.commentDurationMs);
        normalized.opacityPercent = clampNumber(source.opacityPercent, 0, 100, DEFAULT_SETTINGS.opacityPercent);
        normalized.version = SETTINGS_VERSION;
        return normalized;
    }

    function getStoredSettings(storageArea) {
        if (!storageArea || typeof storageArea.get !== 'function') return Promise.resolve(normalizeSettings());
        return new Promise((resolve) => {
            try {
                storageArea.get(STORAGE_KEY, (result) => resolve(normalizeSettings(result?.[STORAGE_KEY])));
            } catch {
                resolve(normalizeSettings());
            }
        });
    }

    function persistSettings(storageArea, value) {
        const normalized = normalizeSettings(value);
        if (!storageArea || typeof storageArea.set !== 'function') return Promise.resolve(normalized);
        return new Promise((resolve) => {
            try {
                storageArea.set({ [STORAGE_KEY]: normalized }, () => resolve(normalized));
            } catch {
                resolve(normalized);
            }
        });
    }

    function updateSettings(storageArea, current, patch) {
        return persistSettings(storageArea, { ...normalizeSettings(current), ...(patch || {}) });
    }

    function resetSettings(storageArea) {
        return persistSettings(storageArea, DEFAULT_SETTINGS);
    }

    const api = {
        STORAGE_KEY,
        SETTINGS_VERSION,
        DEFAULT_SETTINGS,
        CAPABILITIES,
        normalizeSettings,
        getStoredSettings,
        persistSettings,
        updateSettings,
        resetSettings
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowSettingsCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
