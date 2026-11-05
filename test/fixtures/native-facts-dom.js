'use strict';
const { captureNativeAccess, createNativeFactsAdapter } = require('../../src/native-facts.js');
const { classifyChatFramePath } = require('../../src/chat-frame-role-core.js');
// Branded native-access doubles: state cannot be obtained from element expandos.
function fixture() {
    const state = new WeakMap();
    let forbidden = 0, reads = 0, hook = null;
    const value = object => { if (!state.has(object)) throw new TypeError('Illegal receiver'); return state.get(object); };
    class Node {
        constructor(data = {}) { state.set(this, { connected: true, ...data }); }
        get ownerDocument() { return value(this).document; }
        get isConnected() { return value(this).connected; }
        contains(child) { return value(this).children?.includes(child) === true; }
    }
    class NodeList {
        constructor(items) { state.set(this, items); }
        get length() { return value(this).length; }
        item(i) { return value(this)[i] || null; }
    }
    class DOMTokenList {
        constructor(classes) { state.set(this, classes); }
        contains(name) { return value(this).has(name); }
    }
    class Element extends Node {
        querySelectorAll(selector) { return new NodeList(value(this).queries?.[selector] || []); }
        closest() { return value(this).miniplayer || null; }
        get classList() { return new DOMTokenList(value(this).classes || new Set()); }
    }
    class Document extends Node {
        get URL() { return value(this).url; }
        get hidden() { return value(this).hidden; }
        get visibilityState() { return value(this).visibility; }
        querySelectorAll(selector) { return new NodeList(value(this).queries?.[selector] || []); }
    }
    class HTMLIFrameElement extends Element {
        get contentDocument() { const s = value(this); if (s.denied) throw new Error('Denied'); return s.child; }
    }
    class HTMLMediaElement extends Element {
        get readyState() { reads++; if (hook) hook(); return value(this).readyState; }
        get ended() { return value(this).ended; }
        get seeking() { return value(this).seeking; }
        get paused() { return value(this).paused; }
        get currentTime() { return value(this).position; }
        get playbackRate() { return value(this).rate; }
    }
    const realm = { Node, NodeList, DOMTokenList, Element, Document, HTMLIFrameElement, HTMLMediaElement };
    const document = new Document({ url: 'https://www.youtube.com/watch?v=target', hidden: false, visibility: 'visible' });
    const child = new Document({ url: 'https://www.youtube.com/live_chat_replay?v=target' });
    const watch = new Element({ document }), player = new Element({ document });
    const video = new HTMLMediaElement({ document, readyState: 4, ended: false, seeking: false, paused: false, position: 0, rate: 1 });
    const frame = new HTMLIFrameElement({ document, child });
    value(document).queries = { 'ytd-watch-flexy': [watch] };
    value(document).children = [watch];
    value(watch).queries = { '#movie_player, .html5-video-player': [player], 'ytd-live-chat-frame iframe': [frame] };
    value(watch).children = [player, video, frame];
    value(player).queries = { 'video.html5-main-video, video': [video] };
    value(player).children = [video];
    for (const object of [document, child, watch, player, video, frame]) {
        for (const key of ['data', 'ytcfg', 'INNERTUBE_CONTEXT', 'src', 'contentWindow', 'role', 'generation']) {
            Object.defineProperty(object, key, { get() { forbidden++; throw new Error('Forbidden page getter'); } });
        }
    }
    const route = { tabId: 7, frameId: 0, documentId: '12345678-1234-1234-1234-123456789abc' };
    let currentDocument = document, currentRoute = { ...route };
    const options = { document, route, targetId: 'target', mode: 'replay', native: captureNativeAccess(realm),
        readDocument: () => currentDocument, readRoute: () => currentRoute, classifyChatFramePath };
    return { document, child, watch, player, video, frame, value, options, realm,
        adopt(object, data) { state.set(object, { connected: true, ...data }); },
        make: () => createNativeFactsAdapter(options),
        setDocument: x => { currentDocument = x; }, setRoute: x => { currentRoute = x; },
        setHook: x => { hook = x; }, counts: () => ({ forbidden, reads }) };
}

module.exports = { fixture };
