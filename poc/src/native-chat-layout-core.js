(function (global) {
    const NARROW_VIEWPORT_MAX_WIDTH_PX = 800;
    const MIN_NATIVE_CHAT_HEIGHT_PX = 180;
    const VIEWPORT_BOTTOM_GAP_PX = 12;

    function selectViewportMetrics({ visualViewport, innerWidth, innerHeight } = {}) {
        if (visualViewport &&
            typeof visualViewport.width === 'number' &&
            typeof visualViewport.height === 'number' &&
            typeof visualViewport.offsetTop === 'number') {
            return {
                width: visualViewport.width,
                height: visualViewport.height,
                offsetTop: visualViewport.offsetTop
            };
        }
        return { width: innerWidth, height: innerHeight, offsetTop: 0 };
    }

    function calculateNativeChatLayout({
        viewportWidth,
        viewportHeight,
        viewportOffsetTop = 0,
        chatTop,
        managementReservedHeight = 0
    } = {}) {
        const values = [viewportWidth, viewportHeight, viewportOffsetTop, chatTop, managementReservedHeight];
        if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
            return { active: false, reason: 'invalid-metrics' };
        }
        if (viewportWidth <= 0 || viewportHeight <= 0 || viewportOffsetTop < 0 || chatTop < 0 || managementReservedHeight < 0) {
            return { active: false, reason: 'invalid-metrics' };
        }
        if (viewportWidth > NARROW_VIEWPORT_MAX_WIDTH_PX) {
            return { active: false, reason: 'wide-viewport' };
        }

        const visibleViewportBottom = viewportOffsetTop + viewportHeight;
        const availableHeight = visibleViewportBottom - chatTop - managementReservedHeight - VIEWPORT_BOTTOM_GAP_PX;
        if (!Number.isFinite(availableHeight) || availableHeight < MIN_NATIVE_CHAT_HEIGHT_PX) {
            return { active: false, reason: 'insufficient-height' };
        }

        return {
            active: true,
            reason: 'narrow-viewport',
            maxChatHeightPx: Math.floor(availableHeight)
        };
    }

    const api = {
        NARROW_VIEWPORT_MAX_WIDTH_PX,
        MIN_NATIVE_CHAT_HEIGHT_PX,
        VIEWPORT_BOTTOM_GAP_PX,
        selectViewportMetrics,
        calculateNativeChatLayout
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowNativeChatLayoutCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
