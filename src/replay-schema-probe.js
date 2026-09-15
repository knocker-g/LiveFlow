(function () {
    const core = window.LiveFlowReplayProbeCore;
    if (!core) return;
    const RUNTIME_MARKER = '__LIVEFLOW_REPLAY_PROBE_RUNTIME_V2__';
    const isTop = window === window.top;
    if (window[RUNTIME_MARKER]) return;
    if (isTop && typeof window.LiveFlowReplayProbe?.disable === 'function') {
        try { window.LiveFlowReplayProbe.disable(); } catch { /* stale diagnostic isolation */ }
    }
    const collector = core.createReplayProbeCollector();
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const xhrState = new WeakMap();
    const CHANNEL = 'LIVEFLOW_REPLAY_SHAPE_PROBE_V1';
    const DIAGNOSTIC_CHANNEL = 'LIVEFLOW_REPLAY_CREDENTIALLESS_DIAGNOSTIC_V1';
    const MAX_FRAMES = 8;
    const MAX_TEMPLATE_BODY_CHARS = 65536;
    const DIAGNOSTIC_TIMEOUT_MS = 10000;
    const BRIDGE_TIMEOUT_MS = 12000;
    const frameSequences = new Map();
    const diagnosticFrames = new Set();
    const diagnosticFrameStates = new Map();
    const pendingDiagnostics = new Map();
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
    let diagnosticTemplate = null;
    let diagnosticInFlight = false;
    let diagnosticInvocation = 0;
    let lastExecutedInvocation = 0;
    let lastDiagnosticResult = null;
    let diagnosticState = 'no-replay-request';
    let diagnosticStateSequence = 0;

    function directChildren() { try { return Array.from({ length: Math.min(window.frames.length, MAX_FRAMES) }, (_, index) => window.frames[index]); } catch { return []; } }
    function isDirectChild(source) { return directChildren().includes(source); }
    function post(target, message) { try { target.postMessage({ channel: CHANNEL, ...message }, '*'); } catch { /* diagnostic isolation */ } }
    function broadcast(command) { directChildren().forEach((child) => post(child, { command, generation })); }
    function headerNames(value) { try { return value ? [...new Headers(value).keys()] : []; } catch { return []; } }
    function authPresence(names) {
        const lowered = names.filter((name) => typeof name === 'string').map((name) => name.toLowerCase());
        return { cookieSeen: lowered.includes('cookie') ? true : 'unknown', authorizationSeen: lowered.includes(`author${'ization'}`) ? true : 'unknown' };
    }
    function safeDiagnosticResult(reason, overrides = {}) {
        return Object.freeze({ executed: false, credentials: 'omit', requestCount: 0, httpStatusClass: 'not-executed', jsonParsed: false, replayShapeObserved: false, replayTimingPathObserved: false, continuationShapeObserved: false, reason, ...overrides });
    }
    function normalizeFrameResult(value) {
        const statuses = new Set(['2xx', 'non-2xx', 'timeout', 'network-error', 'not-executed']);
        const reasons = new Set(['COMPLETE', 'HTTP_STOP', 'INVALID_JSON', 'TIMEOUT', 'NETWORK_ERROR', 'NO_TEMPLATE', 'IN_PROGRESS', 'PASSIVE_PROBE_DISABLED']);
        if (!value || ![true, false].includes(value.executed) || ![0, 1].includes(value.requestCount) || value.credentials !== 'omit' || !statuses.has(value.httpStatusClass) || !reasons.has(value.reason)) return safeDiagnosticResult('INVALID_FRAME_RESULT');
        return safeDiagnosticResult(value.reason, { executed: value.executed, requestCount: value.requestCount, httpStatusClass: value.httpStatusClass, jsonParsed: value.jsonParsed === true, replayShapeObserved: value.replayShapeObserved === true, replayTimingPathObserved: value.replayTimingPathObserved === true, continuationShapeObserved: value.continuationShapeObserved === true });
    }
    const DIAGNOSTIC_STATES = new Set(['no-replay-request', 'replay-request-observed', 'capture-pending', 'request-clone-failed', 'body-read-failed', 'body-source-unsupported', 'body-too-large', 'body-shape-rejected', 'method-rejected', 'origin-rejected', 'stale-generation', 'template-ready', 'in-flight', 'disabled']);
    function setDiagnosticState(value) {
        if (!DIAGNOSTIC_STATES.has(value)) return;
        diagnosticState = value;
        if (!isTop && enabled) {
            diagnosticStateSequence += 1;
            post(window.parent, { channel: DIAGNOSTIC_CHANNEL, command: 'state', generation, sequence: diagnosticStateSequence, state: value });
        }
    }
    function captureDiagnosticTemplate(details, expectedGeneration = generation) {
        try {
            if (!enabled || diagnosticInFlight || core.replayEndpoint(details.url) !== '/youtubei/v1/live_chat/get_live_chat_replay') return;
            setDiagnosticState('replay-request-observed');
            if (expectedGeneration !== generation) { setDiagnosticState('stale-generation'); return; }
            if (String(details.method || '').toUpperCase() !== 'POST') { setDiagnosticState('method-rejected'); return; }
            if (typeof details.body !== 'string') { setDiagnosticState('body-source-unsupported'); return; }
            if (details.body.length < 2 || details.body.length > MAX_TEMPLATE_BODY_CHARS) { setDiagnosticState('body-too-large'); return; }
            const requestUrl = new URL(String(details.url), window.location?.href || 'https://www.youtube.com/');
            if (requestUrl.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(requestUrl.hostname)) { setDiagnosticState('origin-rejected'); return; }
            const parsed = JSON.parse(details.body);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.continuation !== 'string' || parsed.continuation.length === 0 || !parsed.context || typeof parsed.context !== 'object') { setDiagnosticState('body-shape-rejected'); return; }
            diagnosticTemplate = { url: requestUrl.href, body: details.body };
            setDiagnosticState('template-ready');
            if (!isTop) post(window.parent, { channel: DIAGNOSTIC_CHANNEL, command: 'ready', generation });
        } catch { setDiagnosticState('body-shape-rejected'); }
    }
    function prepareRequestTemplateCapture(input, init) {
        try {
            if (!enabled || init.body !== undefined || core.replayEndpoint(input?.url) !== '/youtubei/v1/live_chat/get_live_chat_replay') return null;
            setDiagnosticState('replay-request-observed');
            if (String(init.method || input.method || '').toUpperCase() !== 'POST') { setDiagnosticState('method-rejected'); return null; }
            if (typeof input?.clone !== 'function') { setDiagnosticState('request-clone-failed'); return null; }
            setDiagnosticState('capture-pending');
            return { request: input.clone(), generation };
        } catch { setDiagnosticState('request-clone-failed'); return null; }
    }
    function completeRequestTemplateCapture(pending) {
        if (!pending) return;
        try {
            Promise.resolve(pending.request.text()).then((body) => captureDiagnosticTemplate({ url: pending.request.url, method: pending.request.method, body }, pending.generation)).catch(() => { if (pending.generation === generation) setDiagnosticState('body-read-failed'); });
        } catch { if (pending.generation === generation) setDiagnosticState('body-read-failed'); }
    }
    function summarizeDiagnosticJson(value) {
        const shape = core.collectResponseShape(value);
        const liveChatPath = shape.responseTopLevelKeys.some((entry) => entry.key === 'continuationContents') && shape.continuationPaths.some((entry) => entry.path.includes('liveChatContinuation'));
        return {
            replayShapeObserved: liveChatPath && shape.actionNames.includes('replayChatItemAction'),
            replayTimingPathObserved: shape.replayTimingCandidates.some((entry) => /replayChatItemAction\.videoOffsetTimeMsec$/.test(entry.path)),
            continuationShapeObserved: shape.continuationDataNames.includes('liveChatReplayContinuationData') && shape.continuationPaths.some((entry) => /liveChatReplayContinuationData\.continuation$/.test(entry.path))
        };
    }
    async function executeCredentiallessDiagnostic() {
        if (!enabled || diagnosticInFlight || !diagnosticTemplate) return safeDiagnosticResult(!enabled ? 'PASSIVE_PROBE_DISABLED' : diagnosticInFlight ? 'IN_PROGRESS' : 'NO_TEMPLATE');
        diagnosticInFlight = true;
        const template = diagnosticTemplate;
        diagnosticTemplate = null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DIAGNOSTIC_TIMEOUT_MS);
        try {
            const response = await originalFetch.call(window, template.url, { method: 'POST', body: template.body, credentials: 'omit', headers: { 'Content-Type': 'application/json' }, signal: controller.signal });
            const statusClass = response?.ok ? '2xx' : 'non-2xx';
            if (!response?.ok) return safeDiagnosticResult('HTTP_STOP', { executed: true, requestCount: 1, httpStatusClass: statusClass });
            let value;
            try { value = await response.json(); } catch { return safeDiagnosticResult('INVALID_JSON', { executed: true, requestCount: 1, httpStatusClass: statusClass }); }
            return safeDiagnosticResult('COMPLETE', { executed: true, requestCount: 1, httpStatusClass: statusClass, jsonParsed: true, ...summarizeDiagnosticJson(value) });
        } catch (error) {
            return safeDiagnosticResult(error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', { executed: true, requestCount: 1, httpStatusClass: error?.name === 'AbortError' ? 'timeout' : 'network-error' });
        } finally { clearTimeout(timeout); diagnosticInFlight = false; }
    }
    function sendReport(kind, payload) {
        if (!enabled || isTop) return;
        sequence += 1;
        post(window.parent, { command: 'report', generation, sequence, kind, payload });
    }
    function recordRequest(details) {
        if (details.body !== undefined) captureDiagnosticTemplate(details);
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
            let pendingTemplate = null;
            try {
                const input = args[0]; const init = args[1] || {};
                pendingTemplate = prepareRequestTemplateCapture(input, init);
                observed = recordRequest({ url: typeof input === 'string' ? input : input?.url, method: init.method || input?.method || 'GET', body: init.body, headerNames: [...headerNames(input?.headers), ...headerNames(init.headers)] });
            } catch { /* diagnostic isolation */ }
            const result = originalFetch.apply(this, args);
            completeRequestTemplateCapture(pendingTemplate);
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
    function enable(nextGeneration = generation || 1) {
        if (nextGeneration !== generation) { diagnosticTemplate = null; lastExecutedInvocation = 0; diagnosticState = 'no-replay-request'; diagnosticStateSequence = 0; }
        enabled = true; generation = nextGeneration; sequence = 0; collector.enable(); installHooks(); broadcast('enable');
    }
    function disable() {
        broadcast('disable'); enabled = false; removeHooks(); collector.disable(); diagnosticTemplate = null; diagnosticFrames.clear(); diagnosticFrameStates.clear(); diagnosticState = 'disabled';
        for (const [invocation, pending] of pendingDiagnostics) { if (pending.timeout) clearTimeout(pending.timeout); if (pending.resolve) pending.resolve(safeDiagnosticResult('PASSIVE_PROBE_DISABLED')); pendingDiagnostics.delete(invocation); }
    }
    function reset() { collector.reset(); frameSequences.clear(); diagnosticFrames.clear(); diagnosticFrameStates.clear(); diagnosticTemplate = null; lastDiagnosticResult = null; diagnosticState = 'no-replay-request'; diagnosticStateSequence = 0; }
    function summary() {
        for (const source of [...frameSequences.keys()]) if (!isDirectChild(source)) frameSequences.delete(source);
        const currentFrameCount = Math.min(frameSequences.size, MAX_FRAMES);
        const value = { ...collector.summary(), observedFrameCount: currentFrameCount, replayFrameObserved: currentFrameCount > 0 };
        console.log('[LiveFlow replay shape summary]', JSON.stringify(value, null, 2)); return value;
    }
    function onMessage(event) {
        try {
            const data = event.data;
            if (!data || typeof data.command !== 'string') return;
            if (data.channel === DIAGNOSTIC_CHANNEL) {
                if (!isTop && event.source === window.parent && data.command === 'run' && data.generation === generation && Number.isSafeInteger(data.invocation) && data.invocation > lastExecutedInvocation) {
                    lastExecutedInvocation = data.invocation;
                    for (const source of [...diagnosticFrames]) if (!isDirectChild(source)) diagnosticFrames.delete(source);
                    const source = diagnosticTemplate ? null : diagnosticFrames.values().next().value;
                    if (source) {
                        pendingDiagnostics.set(data.invocation, { source, relay: true });
                        post(source, { channel: DIAGNOSTIC_CHANNEL, command: 'run', generation, invocation: data.invocation });
                    } else {
                        executeCredentiallessDiagnostic().then((result) => post(window.parent, { channel: DIAGNOSTIC_CHANNEL, command: 'result', generation, invocation: data.invocation, result })).catch(() => {});
                    }
                    return;
                }
                if (enabled && isDirectChild(event.source) && data.generation === generation) {
                    if (data.command === 'state' && Number.isSafeInteger(data.sequence) && DIAGNOSTIC_STATES.has(data.state)) {
                        const previous = diagnosticFrameStates.get(event.source);
                        if (!previous || data.sequence > previous.sequence) {
                            diagnosticFrameStates.set(event.source, { sequence: data.sequence, state: data.state });
                            if (!isTop) setDiagnosticState(data.state);
                        }
                        return;
                    }
                    if (data.command === 'ready') {
                        if (diagnosticFrames.size < MAX_FRAMES) diagnosticFrames.add(event.source);
                        if (!isTop) post(window.parent, { channel: DIAGNOSTIC_CHANNEL, command: 'ready', generation });
                        return;
                    }
                    if (data.command === 'result' && Number.isSafeInteger(data.invocation)) {
                        const pending = pendingDiagnostics.get(data.invocation);
                        if (!pending || pending.source !== event.source) return;
                        if (pending.timeout) clearTimeout(pending.timeout);
                        pendingDiagnostics.delete(data.invocation); diagnosticFrames.delete(event.source);
                        const result = normalizeFrameResult(data.result);
                        if (!isTop && pending.relay) post(window.parent, { channel: DIAGNOSTIC_CHANNEL, command: 'result', generation, invocation: data.invocation, result });
                        else { lastDiagnosticResult = result; pending.resolve(result); }
                        return;
                    }
                }
                return;
            }
            if (data.channel !== CHANNEL) return;
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
        const passiveApi = Object.freeze({ enable() { generation += 1; reset(); enable(generation); return summary(); }, disable() { disable(); return summary(); }, reset() { reset(); if (enabled) collector.enable(); return summary(); }, summary });
        const diagnosticApi = Object.freeze({
            async run() {
                if (!enabled) return safeDiagnosticResult('PASSIVE_PROBE_DISABLED');
                if (diagnosticInFlight || pendingDiagnostics.size > 0) return safeDiagnosticResult('IN_PROGRESS');
                if (diagnosticTemplate) { lastDiagnosticResult = await executeCredentiallessDiagnostic(); return lastDiagnosticResult; }
                for (const source of [...diagnosticFrames]) if (!isDirectChild(source)) diagnosticFrames.delete(source);
                const source = diagnosticFrames.values().next().value;
                if (!source) return safeDiagnosticResult('NO_TEMPLATE');
                diagnosticInvocation += 1;
                const invocation = diagnosticInvocation;
                return new Promise((resolve) => {
                    const timeout = setTimeout(() => { pendingDiagnostics.delete(invocation); diagnosticFrames.delete(source); lastDiagnosticResult = safeDiagnosticResult('FRAME_TIMEOUT', { executed: 'unknown', requestCount: 'unknown' }); resolve(lastDiagnosticResult); }, BRIDGE_TIMEOUT_MS);
                    pendingDiagnostics.set(invocation, { source, resolve, timeout });
                    post(source, { channel: DIAGNOSTIC_CHANNEL, command: 'run', generation, invocation });
                });
            },
            status() {
                for (const source of [...diagnosticFrames]) if (!isDirectChild(source)) diagnosticFrames.delete(source);
                for (const source of [...diagnosticFrameStates.keys()]) if (!isDirectChild(source)) diagnosticFrameStates.delete(source);
                const inFlight = diagnosticInFlight || pendingDiagnostics.size > 0;
                const ready = enabled && !inFlight && Boolean(diagnosticTemplate || diagnosticFrames.size);
                const childState = [...diagnosticFrameStates.values()].sort((a, b) => b.sequence - a.sequence)[0]?.state;
                const readyReason = !enabled ? 'disabled' : inFlight ? 'in-flight' : ready ? 'template-ready' : childState || diagnosticState;
                return Object.freeze({ enabled, ready, inFlight, lastResult: lastDiagnosticResult, readyReason });
            }
        });
        window.LiveFlowReplayProbe = passiveApi;
        window.LiveFlowReplayCredentiallessDiagnostic = diagnosticApi;
        if (globalThis !== window) {
            globalThis.LiveFlowReplayProbe = passiveApi;
            globalThis.LiveFlowReplayCredentiallessDiagnostic = diagnosticApi;
        }
    }
    try { Object.defineProperty(window, RUNTIME_MARKER, { value: true, configurable: false, enumerable: false }); } catch { /* public APIs are already initialized */ }
})();
