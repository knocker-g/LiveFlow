'use strict';

(function () {
const nativeAdapters = new WeakMap();
const nativeSamples = new WeakMap();
// Construct only in the extension's ISOLATED realm. Never pass page constructors.
// Capture native prototype operations once; observed elements' own expandos and
// getters are never consulted. No runtime work occurs on module import.
function captureNativeAccess(realm) {
    const get = (type, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(realm[type].prototype, key);
        if (!descriptor || typeof descriptor.get !== 'function') throw new TypeError('NATIVE_ACCESS_UNAVAILABLE');
        return receiver => Reflect.apply(descriptor.get, receiver, []);
    };
    const method = (type, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(realm[type].prototype, key);
        if (!descriptor || typeof descriptor.value !== 'function') throw new TypeError('NATIVE_ACCESS_UNAVAILABLE');
        return (receiver, ...args) => Reflect.apply(descriptor.value, receiver, args);
    };
    const query = method('Element', 'querySelectorAll');
    const queryDocument = method('Document', 'querySelectorAll');
    const length = get('NodeList', 'length'), item = method('NodeList', 'item');
    const contains = method('DOMTokenList', 'contains'), classList = get('Element', 'classList');
    return Object.freeze({
        url: get('Document', 'URL'), hidden: get('Document', 'hidden'),
        visibility: get('Document', 'visibilityState'), ownerDocument: get('Node', 'ownerDocument'),
        connected: get('Node', 'isConnected'), contains: method('Node', 'contains'),
        closest: method('Element', 'closest'), child: get('HTMLIFrameElement', 'contentDocument'),
        queryDocument, query, length, item,
        hasClass: (element, name) => contains(classList(element), name),
        readyState: get('HTMLMediaElement', 'readyState'), ended: get('HTMLMediaElement', 'ended'),
        seeking: get('HTMLMediaElement', 'seeking'), paused: get('HTMLMediaElement', 'paused'),
        position: get('HTMLMediaElement', 'currentTime'), rate: get('HTMLMediaElement', 'playbackRate')
    });
}

// All dependencies and results are extension-private. readDocument/readRoute
// originate in the private browser-routed owner, never a message payload.
// This adapter observes facts; it has no Authority, executor or event listener.
function createNativeFactsAdapter({ document, route, targetId, mode, native,
    readDocument, readRoute, classifyChatFramePath, discoverMode = false }) {
    const validRoute = r => {
        let documentId;
        return r && Number.isSafeInteger(r.tabId) && r.tabId >= 0 && r.frameId === 0 &&
            typeof r.documentId === 'string' && (documentId = r.documentId,
                /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(documentId) ||
                (typeof documentId === 'string' && /^[0-9A-Fa-f]{32}$/.test(documentId) && !/^0{32}$/.test(documentId)));
    };
    if (!document || !validRoute(route) || typeof targetId !== 'string' || !targetId ||
        (!['live', 'replay'].includes(mode) && !(discoverMode === true && mode === null)) || !native || typeof readDocument !== 'function' ||
        typeof readRoute !== 'function' || typeof classifyChatFramePath !== 'function') return null;
    const originalRoute = Object.freeze({ tabId: route.tabId, frameId: 0, documentId: route.documentId });
    let held = null, terminal = null, observing = false, heldMode = null;
    const names = ['document', 'targetId', 'mode', 'watch', 'player', 'video', 'frame', 'childDocument',
        'visible', 'readyState', 'ended', 'ready', 'adActive', 'seeking', 'paused', 'position', 'rate'];
    const known = (value, basis) => Object.freeze({ state: 'KNOWN', value, basis });
    function denied(reason, fatal = false) {
        if (fatal && !terminal) terminal = reason;
        const facts = Object.fromEntries(names.map(k => [k, Object.freeze({ state: 'UNKNOWN', reason: terminal || reason })]));
        return Object.freeze({ outcome: terminal ? 'TERMINAL' : 'UNKNOWN', reason: terminal || reason, facts: Object.freeze(facts) });
    }
    function fail(reason, fatal = false) { throw { nativeFactsFailure: true, reason, fatal }; }
    function routeCurrent() {
        const r = readRoute();
        return readDocument() === document && validRoute(r) &&
            r.tabId === originalRoute.tabId && r.frameId === 0 && r.documentId === originalRoute.documentId;
    }
    function list(receiver, selector, top = false) {
        const nodes = top ? native.queryDocument(receiver, selector) : native.query(receiver, selector);
        const count = native.length(nodes);
        if (!Number.isSafeInteger(count) || count < 0) fail('INVALID_COLLECTION');
        return { count, at: i => native.item(nodes, i) };
    }
    function unique(receiver, selector, top, reason, max = 1) {
        const nodes = list(receiver, selector, top);
        if (nodes.count === 0) fail(reason + '_MISSING');
        if (nodes.count > max || nodes.count !== 1) fail(reason + '_AMBIGUOUS');
        return nodes.at(0);
    }
    function owned(element, parent) {
        return element && native.connected(element) === true && native.ownerDocument(element) === document &&
            native.contains(parent, element) === true;
    }
    function topURL() {
        const raw = native.url(document);
        if (typeof raw !== 'string') fail('DOCUMENT_URL_UNKNOWN');
        const url = new URL(raw);
        if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
            url.port || url.username || url.password) fail('DOCUMENT_URL_UNKNOWN');
        let target;
        if (url.pathname === '/watch') {
            const values = url.searchParams.getAll('v');
            if (values.length !== 1 || !values[0]) fail('TARGET_UNKNOWN');
            target = values[0];
        } else {
            const match = /^\/live\/([^/]+)$/.exec(url.pathname);
            if (!match) fail('TARGET_UNKNOWN');
            target = decodeURIComponent(match[1]);
        }
        if (target !== targetId) fail('TARGET_CHANGED', true);
        return { url, raw };
    }
    function selection(top) {
        if (held && (!owned(held.watch, document) || !owned(held.player, held.watch) ||
            !owned(held.video, held.player) || !owned(held.frame, held.watch))) fail('OWNER_BINDING_LOST', true);
        const watch = unique(document, 'ytd-watch-flexy', true, 'WATCH');
        const player = unique(watch, '#movie_player, .html5-video-player', false, 'PLAYER');
        const video = unique(player, 'video.html5-main-video, video', false, 'VIDEO');
        const frame = unique(watch, 'ytd-live-chat-frame iframe', false, 'FRAME', 8);
        if (!owned(watch, document) || !owned(player, watch) || !owned(video, player) || !owned(frame, watch) ||
            native.closest(video, 'ytd-miniplayer, #miniplayer') !== null || native.hasClass(player, 'ytp-player-minimized')) fail('OWNERSHIP_UNKNOWN');
        if (held && ['watch', 'player', 'video', 'frame'].some(k => ({ watch, player, video, frame })[k] !== held[k])) fail('OWNER_REPLACED', true);
        const child = native.child(frame);
        if (!child) fail('CHILD_INACCESSIBLE');
        if (held && child !== held.child) fail('CHILD_REPLACED', true);
        const raw = native.url(child);
        if (typeof raw !== 'string') fail('CHILD_URL_UNKNOWN');
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.origin !== top.url.origin || url.username || url.password) fail('CHILD_ORIGIN_UNKNOWN');
        const role = classifyChatFramePath(url.pathname);
        if (!['LIVE_CHAT', 'REPLAY_CHAT'].includes(role)) fail('MODE_UNKNOWN');
        const values = url.searchParams.getAll('v');
        const structuralReplay = values.length === 0 && role === 'REPLAY_CHAT';
        const structuralLive = values.length === 0 && role === 'LIVE_CHAT';
        if (!structuralReplay && !structuralLive && (values.length !== 1 || !values[0] || values[0] !== targetId)) fail('CHILD_TARGET_UNKNOWN');
        const observedMode = role === 'LIVE_CHAT' ? 'live' : 'replay';
        if ((mode !== null && observedMode !== mode) || (heldMode !== null && observedMode !== heldMode)) fail('MODE_CHANGED', true);
        return { watch, player, video, frame, child, raw, observedMode, structuralReplay, structuralLive };
    }
    function readFacts() {
        if (terminal) return denied(terminal);
        if (observing) return denied('REENTRANT_OBSERVATION', true);
        observing = true;
        try {
            if (!routeCurrent()) fail('DOCUMENT_CHANGED', true);
            const top = topURL(), s = selection(top), v = s.video;
            const hidden = native.hidden(document), visibility = native.visibility(document);
            const readyState = native.readyState(v), ended = native.ended(v), seeking = native.seeking(v);
            const paused = native.paused(v), position = native.position(v), rate = native.rate(v);
            const adShowing = native.hasClass(s.player, 'ad-showing');
            const adInterrupting = native.hasClass(s.player, 'ad-interrupting');
            if (typeof hidden !== 'boolean' || !['visible', 'hidden'].includes(visibility) || hidden !== (visibility === 'hidden') ||
                !Number.isInteger(readyState) || readyState < 0 || readyState > 4 ||
                ![ended, seeking, paused, adShowing, adInterrupting].every(x => typeof x === 'boolean') ||
                !Number.isFinite(position) || position < 0 || !Number.isFinite(rate) || rate <= 0) fail('MEDIA_UNKNOWN');
            if (!routeCurrent()) fail('DOCUMENT_CHANGED', true);
            const endTop = topURL(), end = selection(endTop);
            if (top.raw !== endTop.raw || s.raw !== end.raw ||
                s.structuralReplay !== end.structuralReplay ||
                s.structuralLive !== end.structuralLive ||
                ['watch', 'player', 'video', 'frame', 'child'].some(k => s[k] !== end[k])) fail('OBSERVATION_CHANGED', true);
            if (terminal) return denied(terminal);
            if (!held) held = Object.freeze({ watch: s.watch, player: s.player, video: v, frame: s.frame, child: s.child });
            if (heldMode === null) heldMode = s.observedMode;
            const facts = {
                document: known(document, 'BROWSER_DOCUMENT'), targetId: known(targetId, 'TOP_DOCUMENT_URL'),
                mode: known(s.observedMode, 'CHILD_DOCUMENT_PATH'), watch: known(s.watch, 'OWNED_DOM'),
                player: known(s.player, 'OWNED_DOM'), video: known(v, 'OWNED_DOM'), frame: known(s.frame, 'OWNED_DOM'),
                childDocument: known(s.child, 'NATIVE_CONTENT_DOCUMENT'), visible: known(!hidden, 'NATIVE_VISIBILITY'),
                readyState: known(readyState, 'NATIVE_MEDIA'), ended: known(ended, 'NATIVE_MEDIA'),
                ready: known(readyState >= 2 && !ended && !seeking, 'MEDIA_READINESS'),
                adActive: known(adShowing || adInterrupting, 'PLAYER_CLASS_INDICATOR'),
                seeking: known(seeking, 'NATIVE_MEDIA'), paused: known(paused, 'NATIVE_MEDIA'),
                position: known(position, 'NATIVE_MEDIA'), rate: known(rate, 'NATIVE_MEDIA')
            };
            const wait = hidden || readyState < 2 || ended || seeking || adShowing || adInterrupting;
            const sample = Object.freeze({
                outcome: s.structuralLive ? 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED' :
                    s.structuralReplay ? 'STRUCTURALLY_ASSOCIATED_TARGET_UNVERIFIED' : wait ? 'WAIT' : 'KNOWN',
                reason: wait ? 'MEDIA_NOT_ELIGIBLE' : 'NONE', facts: Object.freeze(facts),
                parentTargetEvidence: Object.freeze({ state: 'KNOWN', basis: 'ORIGINAL_TOP_ROUTE_MATCH' }),
                childAssociationEvidence: Object.freeze({ state: s.structuralLive ? 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED' :
                    s.structuralReplay ? 'Z_STRUCTURAL_UNVERIFIED' : 'V_MATCH',
                    childTargetIdentity: s.structuralReplay || s.structuralLive ? 'UNVERIFIED' : 'URL_V_MATCH' }),
                readiness: wait ? 'WAIT' : 'READY'
            });
            nativeSamples.set(sample, adapter);
            return sample;
        } catch (error) {
            return denied(error && error.nativeFactsFailure === true ? error.reason : 'NATIVE_ACCESS_FAILED',
                error && error.nativeFactsFailure === true && error.fatal === true);
        } finally { observing = false; }
    }
    const adapter = Object.freeze({ readFacts });
    nativeAdapters.set(adapter, { document, route: originalRoute }); return adapter;
}

if (typeof module !== 'undefined' && module.exports) module.exports = Object.freeze({ captureNativeAccess, createNativeFactsAdapter,
    inspectNativeAdmission(adapter, sample, policy, livePolicy = 'STRICT_V') {
        if (!sample || nativeSamples.get(sample) !== adapter || sample.parentTargetEvidence?.state !== 'KNOWN') return null;
        const association = sample.childAssociationEvidence?.state;
        if (association !== 'V_MATCH' && !(association === 'Z_STRUCTURAL_UNVERIFIED' &&
            policy === 'ACCEPTED_Z' && sample.facts.mode?.value === 'replay' &&
            sample.outcome === 'STRUCTURALLY_ASSOCIATED_TARGET_UNVERIFIED') &&
            !(association === 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED' && livePolicy === 'ACCEPTED_LIVE_ZERO_V' &&
                sample.facts.mode?.value === 'live' && sample.outcome === 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED')) return null;
        return Object.freeze({ parentTargetEvidence: sample.parentTargetEvidence,
            childAssociationEvidence: sample.childAssociationEvidence, readiness: sample.readiness });
    },
    recognizeNativeFactsAdapter(adapter, document, route) {
        const original = nativeAdapters.get(adapter);
        return Boolean(original && original.document === document && route &&
            ['tabId','frameId','documentId'].every(key => original.route[key] === route[key]));
    } });
})();
