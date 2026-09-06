(function () {
    const INSTALLATION_KEY = '__liveflowNativeChatLayoutInstalled';
    if (window[INSTALLATION_KEY]) return;
    window[INSTALLATION_KEY] = true;

    const SELECTORS = Object.freeze({
        watchRoot: 'ytd-watch-flexy',
        nativeChat: 'ytd-live-chat-frame#chat, ytd-live-chat-frame',
        managementBar: '#liveflow-management-bar'
    });
    const STYLE_ID = 'liveflow-native-chat-layout-style';
    const ACTIVE_ATTRIBUTE = 'data-liveflow-native-chat-layout';
    const HEIGHT_PROPERTY = '--liveflow-native-chat-max-height';
    const MANAGEMENT_HEIGHT_PROPERTY = '--liveflow-management-height';
    const core = window.LiveFlowNativeChatLayoutCore;
    let activeChat = null;
    let observer = null;
    let animationFrame = null;
    let destroyed = false;

    function isPcWatchPage() {
        return /(?:^|\.)youtube\.com\/(?:watch|live)(?:[/?]|$)/i.test(window.location.href);
    }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            [${ACTIVE_ATTRIBUTE}="active"] {
                height: var(${HEIGHT_PROPERTY}) !important;
                max-height: var(${HEIGHT_PROPERTY}) !important;
                min-height: 0 !important;
                flex: 0 1 var(${HEIGHT_PROPERTY}) !important;
                overflow: hidden !important;
            }
            [${ACTIVE_ATTRIBUTE}="active"] iframe#chatframe {
                height: 100% !important;
                max-height: 100% !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function clearActiveLayout() {
        if (!activeChat) return;
        activeChat.removeAttribute(ACTIVE_ATTRIBUTE);
        activeChat.style.removeProperty(HEIGHT_PROPERTY);
        activeChat = null;
    }

    function readManagementReservedHeight() {
        const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(MANAGEMENT_HEIGHT_PROPERTY));
        return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    function getViewportMetrics() {
        return core.selectViewportMetrics({
            visualViewport: window.visualViewport,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight
        });
    }

    function nodeAffectsLayout(node) {
        return node?.nodeType === 1 && (
            node.matches?.(`${SELECTORS.nativeChat}, ${SELECTORS.managementBar}`) ||
            Boolean(node.querySelector?.(`${SELECTORS.nativeChat}, ${SELECTORS.managementBar}`))
        );
    }

    function ensureWatchObserver(root) {
        if (observer?.__liveflowRoot === root) return;
        if (observer) observer.disconnect();
        observer = null;
        if (!root) return;
        observer = new MutationObserver((mutations) => {
            if (mutations.some((mutation) =>
                [...mutation.addedNodes, ...mutation.removedNodes].some(nodeAffectsLayout)
            )) scheduleLayout();
        });
        observer.__liveflowRoot = root;
        observer.observe(root, { childList: true, subtree: true });
    }

    function applyLayout() {
        animationFrame = null;
        if (destroyed || !core || !isPcWatchPage()) {
            clearActiveLayout();
            return;
        }

        const root = document.querySelector(SELECTORS.watchRoot);
        ensureWatchObserver(root);
        const chat = root?.querySelector(SELECTORS.nativeChat) || null;
        if (!chat) {
            clearActiveLayout();
            return;
        }

        const viewport = getViewportMetrics();
        const layout = core.calculateNativeChatLayout({
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            viewportOffsetTop: viewport.offsetTop,
            chatTop: chat.getBoundingClientRect().top,
            managementReservedHeight: readManagementReservedHeight(),
            managementAlreadyIncludedInChatTop: Boolean(root.querySelector(SELECTORS.managementBar))
        });
        if (!layout.active) {
            clearActiveLayout();
            return;
        }

        if (activeChat && activeChat !== chat) clearActiveLayout();
        activeChat = chat;
        ensureStyle();
        chat.style.setProperty(HEIGHT_PROPERTY, `${layout.maxChatHeightPx}px`);
        chat.setAttribute(ACTIVE_ATTRIBUTE, 'active');
    }

    function scheduleLayout() {
        if (destroyed || animationFrame !== null) return;
        animationFrame = window.requestAnimationFrame(applyLayout);
    }

    function handleNavigationStart() {
        clearActiveLayout();
        if (observer) observer.disconnect();
        observer = null;
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }

    function handleNavigationFinish() {
        scheduleLayout();
    }

    function destroy() {
        destroyed = true;
        clearActiveLayout();
        if (observer) observer.disconnect();
        observer = null;
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
        window.removeEventListener('resize', scheduleLayout);
        window.removeEventListener('yt-navigate-start', handleNavigationStart);
        window.removeEventListener('yt-navigate-finish', handleNavigationFinish);
        window.visualViewport?.removeEventListener('resize', scheduleLayout);
        window.visualViewport?.removeEventListener('scroll', scheduleLayout);
        window[INSTALLATION_KEY] = false;
    }

    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('yt-navigate-start', handleNavigationStart);
    window.addEventListener('yt-navigate-finish', handleNavigationFinish);
    window.addEventListener('pagehide', destroy, { once: true });
    window.visualViewport?.addEventListener('resize', scheduleLayout);
    window.visualViewport?.addEventListener('scroll', scheduleLayout);
    scheduleLayout();
})();
