(function () {
    const core = window.LiveFlowChatFrameRoleCore;
    if (!core) return;
    const MARKER = '__LIVEFLOW_CHAT_FRAME_ROLE_V1__';
    if (window[MARKER]) return;
    const CHANNEL = 'LIVEFLOW_CHAT_FRAME_ROLE_V1';
    const MAX_FRAMES = 8;
    const isTop = window === window.top;

    function post(target, message) {
        try { target.postMessage({ channel: CHANNEL, ...message }, window.location.origin); } catch { /* fail closed */ }
    }

    if (!isTop) {
        function report(generation) {
            if (!Number.isSafeInteger(generation) || generation < 0) return;
            post(window.parent, {
                command: 'role',
                generation,
                role: core.classifyChatFramePath(window.location.pathname)
            });
        }
        window.addEventListener('message', (event) => {
            if (event.source !== window.parent || event.origin !== window.location.origin) return;
            if (event.data?.channel !== CHANNEL || event.data.command !== 'request') return;
            report(event.data.generation);
        });
        post(window.parent, { command: 'ready' });
        Object.defineProperty(window, MARKER, { value: true, enumerable: false });
        return;
    }

    let generation = -1;
    const reports = new Map();
    function directChildren() {
        try { return Array.from({ length: Math.min(window.frames.length, MAX_FRAMES) }, (_, index) => window.frames[index]); } catch { return []; }
    }
    function broadcast() {
        if (generation < 0) return;
        directChildren().forEach((child) => post(child, { command: 'request', generation }));
    }
    function currentOwnedFrames(watchRoot) {
        try {
            if (!watchRoot?.isConnected || document.querySelector('ytd-watch-flexy') !== watchRoot) return [];
            return [...watchRoot.querySelectorAll('ytd-live-chat-frame iframe')]
                .filter((frame) => frame?.isConnected && watchRoot.contains(frame))
                .slice(0, MAX_FRAMES);
        } catch { return []; }
    }
    function beginGeneration(nextGeneration) {
        if (!Number.isSafeInteger(nextGeneration) || nextGeneration < 0) return false;
        if (generation === nextGeneration) return true;
        const initialGeneration = generation < 0;
        generation = nextGeneration;
        reports.clear();
        // On initial load, already-created frames may have announced readiness
        // before page-state starts. After SPA invalidation, never bless the old
        // document with the new generation; wait for the navigated frame's new
        // document-start readiness handshake instead.
        if (initialGeneration) broadcast();
        return true;
    }
    function snapshot(watchRoot, expectedGeneration) {
        const frames = currentOwnedFrames(watchRoot);
        const matched = frames.map((frame) => ({ frame, report: reports.get(frame.contentWindow) }))
            .find(({ report }) => report?.generation === expectedGeneration);
        const role = matched?.report?.role;
        return Object.freeze({
            role: ['LIVE_CHAT', 'REPLAY_CHAT'].includes(role) ? role : 'UNSUPPORTED',
            ownedFramePresent: frames.length > 0,
            sourceMatchesOwnedFrame: Boolean(matched),
            frameConnected: Boolean(matched?.frame?.isConnected),
            generationCurrent: generation === expectedGeneration && matched?.report?.generation === expectedGeneration
        });
    }
    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin || !directChildren().includes(event.source)) return;
        const data = event.data;
        if (data?.channel !== CHANNEL) return;
        if (data.command === 'ready') {
            post(event.source, { command: 'request', generation });
            return;
        }
        if (data.command !== 'role' || data.generation !== generation || !['LIVE_CHAT', 'REPLAY_CHAT', 'UNSUPPORTED'].includes(data.role)) return;
        reports.set(event.source, { generation, role: data.role });
        window.dispatchEvent(new CustomEvent('liveflow-chat-frame-role-change', { detail: { generation } }));
    });
    const api = Object.freeze({ beginGeneration, snapshot });
    window.LiveFlowChatFrameRole = api;
    Object.defineProperty(window, MARKER, { value: true, enumerable: false });
})();
