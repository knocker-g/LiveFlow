(function (global) {
    const MAX_VISIBLE_MESSAGES = 20;

    function mergeMessagesById(currentMessages, incomingMessages, maxMessages = 500) {
        const messages = Array.isArray(currentMessages) ? currentMessages.slice() : [];
        const ids = new Set(messages.map((message) => message?.id).filter(Boolean));

        (Array.isArray(incomingMessages) ? incomingMessages : []).forEach((message) => {
            if (!message || (message.id && ids.has(message.id))) return;
            if (message.id) ids.add(message.id);
            messages.push(message);
        });

        return messages.slice(-maxMessages);
    }

    function getVisibleMessages(messages, limit = MAX_VISIBLE_MESSAGES) {
        if (!Array.isArray(messages) || limit <= 0) return [];
        return messages.filter((message) => message && typeof message.message === 'string' && message.message.trim()).slice(-limit);
    }

    function formatMessageText(message) {
        if (!message || typeof message.message !== 'string' || !message.message.trim()) return '';
        const author = typeof message.authorName === 'string' ? message.authorName.trim() : '';
        return author ? `${author}: ${message.message}` : message.message;
    }

    const api = { MAX_VISIBLE_MESSAGES, mergeMessagesById, getVisibleMessages, formatMessageText };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowOverlayCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
