(function () {
    const core = globalThis.LiveFlowSettingsCore;
    const storageArea = globalThis.chrome?.storage?.local;
    const definitions = [
        ['comments-controls', 'showGuest', 'guestComments', 'checkbox'],
        ['comments-controls', 'showMember', 'memberComments', 'checkbox'],
        ['comments-controls', 'showModerator', 'moderatorComments', 'checkbox'],
        ['comments-controls', 'showOwner', 'ownerComments', 'checkbox'],
        ['comments-controls', 'showYou', 'yourComments', 'checkbox'],
        ['comments-controls', 'showSuperChat', 'superChatComments', 'checkbox'],
        ['comments-controls', 'showSuperSticker', 'superStickerComments', 'checkbox'],
        ['comments-controls', 'showMembership', 'membershipComments', 'checkbox'],
        ['comments-controls', 'showAvatars', 'showAvatars', 'checkbox'],
        ['comments-controls', 'showPinnedComments', 'showPinnedComments', 'checkbox'],
        ['appearance-controls', 'fontSizeMode', 'fontSize', 'select'],
        ['appearance-controls', 'commentDurationMs', 'commentSpeed', 'range'],
        ['appearance-controls', 'opacityPercent', 'opacity', 'range'],
        ['appearance-controls', 'emojiImages', 'emojiImages', 'checkbox'],
        ['adaptive-controls', 'adaptiveDensity', 'adaptiveDensity', 'checkbox'],
        ['adaptive-controls', 'avoidSubtitles', 'avoidSubtitles', 'checkbox'],
        ['native-chat-controls', 'autoEnableLiveFlowWhenNativeChatClosed', 'chatClosedEnablesLiveFlow', 'checkbox'],
        ['native-chat-controls', 'autoOpenNativeChatWhenLiveFlowDisabled', 'liveFlowOffOpensChat', 'checkbox']
    ];
    let settings = core.normalizeSettings();

    function message(key, fallback = '') {
        try {
            const value = globalThis.chrome?.i18n?.getMessage?.(key);
            return typeof value === 'string' && value.trim() ? value : fallback;
        } catch {
            return fallback;
        }
    }

    function createControl([containerId, key, labelKey, type]) {
        const label = document.createElement('label');
        label.className = 'setting';
        label.dataset.ready = String(core.CAPABILITIES[key] === true);
        const text = document.createElement('span');
        text.textContent = message(labelKey, labelKey);
        const control = type === 'select' ? document.createElement('select') : document.createElement('input');
        control.id = `setting-${key}`;
        control.dataset.setting = key;
        if (type === 'select') {
            const option = document.createElement('option');
            option.value = 'auto';
            option.textContent = message('automatic', 'Auto');
            control.append(option);
        } else {
            control.type = type;
            if (key === 'commentDurationMs') { control.min = '4000'; control.max = '12000'; control.step = '1000'; }
            if (key === 'opacityPercent') { control.min = '0'; control.max = '100'; control.step = '5'; }
        }
        control.disabled = core.CAPABILITIES[key] !== true;
        control.setAttribute('aria-label', text.textContent);
        label.append(text, control);
        document.getElementById(containerId).append(label);
        return control;
    }

    function render() {
        for (const [, key, , type] of definitions) {
            const control = document.getElementById(`setting-${key}`);
            if (type === 'checkbox') control.checked = settings[key] === true;
            else control.value = String(settings[key]);
        }
    }

    function showStatus(key) {
        document.getElementById('save-status').textContent = message(key, key === 'settingsSaved' ? 'Saved' : '');
    }

    async function handleChange(event) {
        const control = event.currentTarget;
        if (control.disabled) return;
        const value = control.type === 'checkbox' ? control.checked : Number(control.value);
        settings = await core.updateSettings(storageArea, settings, { [control.dataset.setting]: value });
        render();
        showStatus('settingsSaved');
    }

    async function initialize() {
        document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = message(node.dataset.i18n, node.textContent); });
        const controls = definitions.map(createControl);
        controls.forEach((control) => control.addEventListener('change', handleChange));
        settings = await core.getStoredSettings(storageArea);
        render();
        document.getElementById('reset-settings').addEventListener('click', async () => {
            if (!globalThis.confirm(message('resetConfirmation', 'Reset all settings?'))) return;
            settings = await core.resetSettings(storageArea);
            render();
            showStatus('settingsReset');
        });
    }

    initialize();
})();
