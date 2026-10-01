(function (global) {
    function classifyChatFramePath(pathname) {
        if (pathname === '/live_chat') return 'LIVE_CHAT';
        if (pathname === '/live_chat_replay') return 'REPLAY_CHAT';
        return 'UNSUPPORTED';
    }

    const api = Object.freeze({ classifyChatFramePath });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowChatFrameRoleCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
