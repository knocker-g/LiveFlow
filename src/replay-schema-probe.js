(function () {
    const core = window.LiveFlowReplayProbeCore;
    if (!core || window.LiveFlowReplayProbe) return;
    const collector = core.createReplayProbeCollector();
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const xhrState = new WeakMap();
    const CHANNEL = 'LIVEFLOW_REPLAY_SHAPE_PROBE_V1';
    const MAX_FRAMES = 8;
    const isTop = window === window.top;
    const frameSequences = new Map();
    let enabled = false;
    let generation = 0;
    let sequence = 0;
    let hooked = false;
    let video = null;
    let stablePlaybackTime = null;
    let seekStart = null;
    let activeRateOperation = null;
    let fetchHook = null;
    let openHook = null;
    let sendHook = null;
    let headerHook = null;

    function directChildren() { try { return Array.from({ length: Math.min(window.frames.length, MAX_FRAMES) }, (_, index) => window.frames[index]); } catch { return []; } }
    function isDirectChild(source) { return directChildren().includes(source); }
    function post(target, message) { try { target.postMessage({ channel: CHANNEL, ...message }, '*'); } catch { /* diagnostic isolation */ } }
    function broadcast(command) { directChildren().forEach((child) => post(child, { command, generation })); }
    function headerNames(value) { try { return value ? [...new Headers(value).keys()] : []; } catch { return []; } }
    function authPresence(names) {
        const lowered = names.filter((name) => typeof name === 'string').map((name) => name.toLowerCase());
        return { cookieSeen: lowered.includes('cookie') ? true : 'unknown', authorizationSeen: lowered.includes(`author${'ization'}`) ? true : 'unknown' };
    }
    function sendReport(kind, payload) {
        if (!enabled || isTop) return;
        sequence += 1;
        post(window.parent, { command: 'report', generation, sequence, kind, payload });
    }
    function recordRequest(details) {
        const path = core.replayEndpoint(details.url);
        const method = typeof details.method === 'string' ? details.method.toUpperCase().slice(0, 12) : 'UNKNOWN';
        const names = Array.isArray(details.headerNames) ? details.headerNames : [];
        const observed = collector.observeRequest(details);
        if (observed) sendReport('request', { path, method: ['GET', 'POST'].includes(method) ? method : 'UNKNOWN', requestTopLevelKeys: core.requestBodyShape(details.body), authPresence: authPresence(names) });
        return observed;
    }
    function recordResponse(value) {
        const shape = core.collectResponseShape(value);
        collector.observeSanitizedResponse(shape);
        sendReport('response', shape);
    }
    function observeJsonResponse(response) { try { response.clone().json().then(recordResponse).catch(() => {}); } catch { /* diagnostic isolation */ } }
    function bindVideo() {
        if (!isTop) return;
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
            if (event.type === 'timeupdate') { if (!video?.seeking && Number.isFinite(video?.currentTime)) stablePlaybackTime = video.currentTime; return; }
            collector.recordVideoEvent(event.type);
            if (event.type === 'pause') collector.startOperation('pauseResume');
            if (event.type === 'play') collector.finishOperation('pauseResume');
            if (event.type === 'seeking') seekStart = stablePlaybackTime;
            if (event.type === 'seeking' && seekStart !== null) { collector.startOperation('forwardSeek'); collector.startOperation('backwardSeek'); }
            if (event.type === 'seeked' && seekStart !== null && Number.isFinite(video?.currentTime)) {
                const operation = video.currentTime >= seekStart ? 'forwardSeek' : 'backwardSeek';
                collector.finishOperation(operation); collector.cancelOperation(operation === 'forwardSeek' ? 'backwardSeek' : 'forwardSeek');
                stablePlaybackTime = video.currentTime; seekStart = null;
            }
            if (event.type === 'ratechange') {
                if (activeRateOperation) collector.finishOperation(activeRateOperation);
                activeRateOperation = video?.playbackRate === 0.5 ? 'rate05' : video?.playbackRate === 2 ? 'rate20' : null;
                if (activeRateOperation) collector.startOperation(activeRateOperation);
            }
        } catch { /* diagnostic isolation */ }
    }
    function onNavigateStart() {
        if (!enabled || !isTop) return;
        generation += 1; reset(); collector.enable(); broadcast('enable');
    }
    function installHooks() {
        if (hooked) return;
        hooked = true;
        fetchHook = function (...args) {
            let observed = false;
            try {
                const input = args[0]; const init = args[1] || {};
                observed = recordRequest({ url: typeof input === 'string' ? input : input?.url, method: init.method || input?.method || 'GET', body: init.body, headerNames: [...headerNames(input?.headers), ...headerNames(init.headers)] });
            } catch { /* diagnostic isolation */ }
            const result = originalFetch.apply(this, args);
            if (observed) Promise.resolve(result).then(observeJsonResponse).catch(() => {});
            return result;
        };
        if (window.fetch === originalFetch) window.fetch = fetchHook;
        openHook = function (method, url, ...rest) { xhrState.set(this, { method, url, headerNames: [] }); return originalOpen.call(this, method, url, ...rest); };
        headerHook = function (name, value) { const state = xhrState.get(this); if (state && typeof name === 'string') state.headerNames.push(name); return originalSetRequestHeader.call(this, name, value); };
        sendHook = function (body) {
            const state = xhrState.get(this); const observed = state && recordRequest({ ...state, body });
            if (observed) this.addEventListener('load', () => { try { recordResponse(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* diagnostic isolation */ } }, { once: true });
            return originalSend.call(this, body);
        };
        if (XMLHttpRequest.prototype.open === originalOpen) XMLHttpRequest.prototype.open = openHook;
        if (XMLHttpRequest.prototype.setRequestHeader === originalSetRequestHeader) XMLHttpRequest.prototype.setRequestHeader = headerHook;
        if (XMLHttpRequest.prototype.send === originalSend) XMLHttpRequest.prototype.send = sendHook;
        document.addEventListener('yt-navigate-finish', bindVideo); document.addEventListener('yt-page-data-updated', bindVideo);
        if (isTop) document.addEventListener('yt-navigate-start', onNavigateStart);
        bindVideo();
    }
    function removeHooks() {
        if (!hooked) return;
        hooked = false;
        if (window.fetch === fetchHook) window.fetch = originalFetch;
        if (XMLHttpRequest.prototype.open === openHook) XMLHttpRequest.prototype.open = originalOpen;
        if (XMLHttpRequest.prototype.send === sendHook) XMLHttpRequest.prototype.send = originalSend;
        if (XMLHttpRequest.prototype.setRequestHeader === headerHook) XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
        document.removeEventListener('yt-navigate-finish', bindVideo); document.removeEventListener('yt-page-data-updated', bindVideo);
        if (isTop) document.removeEventListener('yt-navigate-start', onNavigateStart);
        if (video) ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'timeupdate'].forEach((name) => video.removeEventListener(name, onVideoEvent));
        video = null; stablePlaybackTime = null; seekStart = null; activeRateOperation = null;
    }
    function enable(nextGeneration = generation || 1) { enabled = true; generation = nextGeneration; sequence = 0; collector.enable(); installHooks(); broadcast('enable'); }
    function disable() { broadcast('disable'); enabled = false; removeHooks(); collector.disable(); }
    function reset() { collector.reset(); frameSequences.clear(); }
    function summary() {
        for (const source of [...frameSequences.keys()]) if (!isDirectChild(source)) frameSequences.delete(source);
        const currentFrameCount = Math.min(frameSequences.size, MAX_FRAMES);
        const value = { ...collector.summary(), observedFrameCount: currentFrameCount, replayFrameObserved: currentFrameCount > 0 };
        console.log('[LiveFlow replay shape summary]', JSON.stringify(value, null, 2)); return value;
    }
    function onMessage(event) {
        try {
            const data = event.data;
            if (!data || data.channel !== CHANNEL || typeof data.command !== 'string') return;
            if (!isTop && event.source === window.parent) {
                if (data.command === 'enable' && Number.isSafeInteger(data.generation)) enable(data.generation);
                if (data.command === 'disable') disable();
                return;
            }
            if (!isTop && enabled && isDirectChild(event.source)) {
                if (data.command === 'ready') { post(event.source, { command: 'enable', generation }); return; }
                if (data.command !== 'report' || data.generation !== generation || !Number.isSafeInteger(data.sequence)) return;
                if (data.kind === 'request' && collector.observeSanitizedRequest(data.payload)) sendReport('request', data.payload);
                if (data.kind === 'response' && collector.observeSanitizedResponse(data.payload)) sendReport('response', data.payload);
                return;
            }
            if (!isTop || !enabled || !isDirectChild(event.source)) return;
            if (data.command === 'ready') { frameSequences.delete(event.source); post(event.source, { command: 'enable', generation }); return; }
            if (data.command !== 'report' || data.generation !== generation || !Number.isSafeInteger(data.sequence)) return;
            const previous = frameSequences.get(event.source) || 0;
            if (data.sequence <= previous) return;
            if (!frameSequences.has(event.source) && frameSequences.size >= MAX_FRAMES) return;
            frameSequences.set(event.source, data.sequence);
            if (data.kind === 'request') collector.observeSanitizedRequest(data.payload);
            if (data.kind === 'response') collector.observeSanitizedResponse(data.payload);
        } catch { /* diagnostic isolation */ }
    }
    window.addEventListener('message', onMessage);
    if (!isTop) post(window.parent, { command: 'ready' });
    if (isTop) {
        window.LiveFlowReplayProbe = Object.freeze({ enable() { generation += 1; reset(); enable(generation); return summary(); }, disable() { disable(); return summary(); }, reset() { reset(); if (enabled) collector.enable(); return summary(); }, summary });
    }
})();
