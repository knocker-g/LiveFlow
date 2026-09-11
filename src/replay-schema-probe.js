(function () {
    const core = window.LiveFlowReplayProbeCore;
    if (!core || window.LiveFlowReplayProbe) return;
    const collector = core.createReplayProbeCollector();
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const xhrState = new WeakMap();
    let hooked = false;
    let video = null;
    let stablePlaybackTime = null;
    let seekStart = null;
    let activeRateOperation = null;
    let fetchHook = null;
    let openHook = null;
    let sendHook = null;
    let headerHook = null;

    function headerNames(value) {
        try { return value ? [...new Headers(value).keys()] : []; } catch { return []; }
    }
    function bindVideo() {
        const next = document.querySelector('ytd-watch-flexy #movie_player video');
        if (next === video) return;
        if (video) ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'timeupdate'].forEach((name) => video.removeEventListener(name, onVideoEvent));
        video = next || null;
        stablePlaybackTime = Number.isFinite(video?.currentTime) ? video.currentTime : null;
        if (video) ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'timeupdate'].forEach((name) => video.addEventListener(name, onVideoEvent));
        collector.setReplayUIObserved(Boolean(document.querySelector('ytd-watch-flexy ytd-live-chat-frame')));
    }
    function onVideoEvent(event) {
        try {
            if (event.type === 'timeupdate') {
                if (!video?.seeking && Number.isFinite(video?.currentTime)) stablePlaybackTime = video.currentTime;
                return;
            }
            collector.recordVideoEvent(event.type);
            if (event.type === 'pause') collector.startOperation('pauseResume');
            if (event.type === 'play') collector.finishOperation('pauseResume');
            if (event.type === 'seeking') seekStart = stablePlaybackTime;
            if (event.type === 'seeked' && seekStart !== null && Number.isFinite(video?.currentTime)) {
                const operation = video.currentTime >= seekStart ? 'forwardSeek' : 'backwardSeek';
                collector.finishOperation(operation);
                collector.cancelOperation(operation === 'forwardSeek' ? 'backwardSeek' : 'forwardSeek');
                stablePlaybackTime = video.currentTime;
                seekStart = null;
            }
            if (event.type === 'seeking' && seekStart !== null) { collector.startOperation('forwardSeek'); collector.startOperation('backwardSeek'); }
            if (event.type === 'ratechange') {
                if (activeRateOperation) collector.finishOperation(activeRateOperation);
                activeRateOperation = video?.playbackRate === 0.5 ? 'rate05' : video?.playbackRate === 2 ? 'rate20' : null;
                if (activeRateOperation) collector.startOperation(activeRateOperation);
            }
        } catch { /* diagnostic isolation */ }
    }
    function observeJsonResponse(response) {
        try { response.clone().json().then((value) => collector.observeResponse(value)).catch(() => {}); } catch { /* diagnostic isolation */ }
    }
    function installHooks() {
        if (hooked) return;
        hooked = true;
        fetchHook = function (...args) {
            let observed = false;
            try {
                const input = args[0]; const init = args[1] || {};
                const url = typeof input === 'string' ? input : input?.url;
                const method = init.method || input?.method || 'GET';
                observed = collector.observeRequest({ url, method, body: init.body, headerNames: [...headerNames(input?.headers), ...headerNames(init.headers)] });
            } catch { /* diagnostic isolation */ }
            const result = originalFetch.apply(this, args);
            if (observed) Promise.resolve(result).then(observeJsonResponse).catch(() => {});
            return result;
        };
        window.fetch = fetchHook;
        openHook = function (method, url, ...rest) {
            xhrState.set(this, { method, url, headerNames: [] });
            return originalOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.open = openHook;
        headerHook = function (name, value) {
            const state = xhrState.get(this); if (state && typeof name === 'string') state.headerNames.push(name);
            return originalSetRequestHeader.call(this, name, value);
        };
        XMLHttpRequest.prototype.setRequestHeader = headerHook;
        sendHook = function (body) {
            const state = xhrState.get(this);
            const observed = state && collector.observeRequest({ ...state, body });
            if (observed) this.addEventListener('load', () => {
                try {
                    const value = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                    collector.observeResponse(value);
                } catch { /* diagnostic isolation */ }
            }, { once: true });
            return originalSend.call(this, body);
        };
        XMLHttpRequest.prototype.send = sendHook;
        document.addEventListener('yt-navigate-finish', bindVideo);
        document.addEventListener('yt-page-data-updated', bindVideo);
        bindVideo();
    }
    function removeHooks() {
        if (!hooked) return;
        hooked = false;
        if (window.fetch === fetchHook) window.fetch = originalFetch;
        if (XMLHttpRequest.prototype.open === openHook) XMLHttpRequest.prototype.open = originalOpen;
        if (XMLHttpRequest.prototype.send === sendHook) XMLHttpRequest.prototype.send = originalSend;
        if (XMLHttpRequest.prototype.setRequestHeader === headerHook) XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
        document.removeEventListener('yt-navigate-finish', bindVideo);
        document.removeEventListener('yt-page-data-updated', bindVideo);
        if (video) ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'timeupdate'].forEach((name) => video.removeEventListener(name, onVideoEvent));
        video = null; stablePlaybackTime = null; seekStart = null; activeRateOperation = null;
    }
    window.LiveFlowReplayProbe = Object.freeze({
        enable() { collector.enable(); installHooks(); return collector.summary(); },
        disable() { removeHooks(); return collector.disable(); },
        reset() { return collector.reset(); },
        summary() { const value = collector.summary(); console.log('[LiveFlow replay shape summary]', JSON.stringify(value, null, 2)); return value; }
    });
})();
