'use strict';

(function () {
// Dormant, fixed MAIN function. Self-contained for later packaged injection.
// MAIN is hostile: descriptor/prototype traps and replaced intrinsics can run code.
function extractBootstrap() {
    const fields = ['clientName', 'clientVersion', 'hl', 'gl', 'visitorData', 'userInterfaceTheme',
        'timeZone', 'utcOffsetMinutes', 'platform', 'clientFormFactor', 'browserName',
        'browserVersion', 'osName', 'osVersion', 'screenDensityFloat',
        'screenHeightPoints', 'screenPixelDensity', 'screenWidthPoints'];
    const stop = code => { throw code; };
    const object = value => value !== null && typeof value === 'object';
    function lookup(value, key, max = 2, watchData = false, initialC1 = false) {
        if (!object(value)) stop('INVALID_SOURCE');
        let node = value;
        for (let depth = 0; depth <= max; depth++) {
            const d = Object.getOwnPropertyDescriptor(node, key);
            if (d) {
                if (Object.prototype.hasOwnProperty.call(d, 'value')) return initialC1 ? { state: 'FOUND', value: d.value } : { present: true, value: d.value };
                if (watchData && depth === 1 && typeof d.get === 'function') return { present: true, value: d.get.call(value) };
                stop('ACCESSOR_FORBIDDEN');
            }
            node = Object.getPrototypeOf(node);
            if (node === null) return initialC1 ? { state: 'ABSENT' } : { present: false };
        }
        // Approved H3/H5 exception: only the first optional C1 selection may
        // advance on normal bound completion. Exceptions still propagate.
        if (initialC1) return { state: 'C1_BOUNDED_UNRESOLVED' };
        stop('PROTOTYPE_EXHAUSTED');
    }
    function required(value, key) {
        const result = lookup(value, key);
        if (!result.present) stop('INVALID_SOURCE');
        return result.value;
    }
    function text(value, cap, code, nonempty = false) {
        if (typeof value !== 'string' || (nonempty && !value.length)) stop(code);
        if (value.length > cap) stop('PRECHECK_LIMIT');
        // Fixed code-unit walk, no page TextEncoder or source serialization.
        let bytes = 0;
        for (let i = 0; i < value.length; i++) {
            const c = value.charCodeAt(i);
            if (c >= 0xd800 && c <= 0xdbff) {
                const next = value.charCodeAt(++i);
                if (!(next >= 0xdc00 && next <= 0xdfff)) stop('INVALID_STRING');
                bytes += 4;
            } else if (c >= 0xdc00 && c <= 0xdfff) stop('INVALID_STRING');
            else bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
        }
        if (bytes > cap) stop('PRECHECK_LIMIT');
        return value;
    }
    function leaf(key, value) {
        if (value === null || value === undefined || value === '') return { keep: false };
        const integer = key === 'clientName' || key === 'utcOffsetMinutes' || key === 'screenHeightPoints' || key === 'screenWidthPoints';
        const density = key === 'screenDensityFloat' || key === 'screenPixelDensity';
        if (typeof value === 'string' && (!integer || key === 'clientName') && !density) {
            return { keep: true, value: text(value, key === 'visitorData' ? 8192 : 1024, 'INVALID_CONTEXT') };
        }
        if (typeof value !== 'number' || !(integer ? Number.isSafeInteger(value) : density && Number.isFinite(value)) ||
            (key !== 'clientName' && key !== 'utcOffsetMinutes' && value < 0)) stop('INVALID_CONTEXT');
        return { keep: true, value };
    }
    function project(source, scalar = false) {
        if (!object(source)) stop('INVALID_CONTEXT');
        let selected = source;
        if (!scalar) {
            const client = lookup(source, 'client');
            if (client.present && object(client.value)) selected = client.value;
        }
        const client = Object.create(null);
        let count = 0, present = 0;
        const scalarKeys = ['INNERTUBE_CONTEXT_CLIENT_NAME', 'INNERTUBE_CONTEXT_CLIENT_VERSION', 'HL', 'GL', 'VISITOR_DATA'];
        const length = scalar ? 5 : fields.length;
        for (let i = 0; i < length; i++) {
            const d = lookup(selected, scalar ? scalarKeys[i] : fields[i]);
            if (!d.present) continue;
            present++;
            const result = leaf(fields[i], d.value);
            if (result.keep) { client[fields[i]] = result.value; count++; }
        }
        if (!count) {
            if (scalar && !present) return null;
            stop('INVALID_CONTEXT');
        }
        const context = Object.create(null);
        context.client = client;
        return context;
    }
    function selectContext() {
        const c1 = lookup(window, 'INNERTUBE_CONTEXT', 2, false, true);
        if (c1.state === 'FOUND') return { source: 'C1', context: project(c1.value) };
        if (c1.state !== 'ABSENT' && c1.state !== 'C1_BOUNDED_UNRESOLVED') stop('INVALID_SOURCE');
        const ytcfg = lookup(window, 'ytcfg');
        if (!ytcfg.present) stop('ABSENT_CONTEXT');
        if (!object(ytcfg.value)) stop('INVALID_SOURCE');
        const data = lookup(ytcfg.value, 'data_');
        if (!data.present) stop('ABSENT_CONTEXT');
        if (!object(data.value)) stop('INVALID_SOURCE');
        const c2 = lookup(data.value, 'INNERTUBE_CONTEXT');
        if (c2.present) return { source: 'C2', context: project(c2.value) };
        const c3 = project(data.value, true);
        if (!c3) stop('ABSENT_CONTEXT');
        return { source: 'C3', context: c3 };
    }
    try {
        const currentDocument = document;
        const root = currentDocument.querySelector('ytd-watch-flexy');
        if (!root || root.ownerDocument !== currentDocument || !root.isConnected) stop('INVALID_SOURCE');
        const snapshot = lookup(root, 'data', 1, true);
        if (!snapshot.present) stop('INVALID_SOURCE');
        const watch = snapshot.value;
        const endpoint = required(required(watch, 'currentVideoEndpoint'), 'watchEndpoint');
        const targetId = text(required(endpoint, 'videoId'), 1024, 'INVALID_TARGET', true);
        const contents = required(required(watch, 'contents'), 'twoColumnWatchNextResults');
        const renderer = required(required(contents, 'conversationBar'), 'liveChatRenderer');
        const replay = required(renderer, 'isReplay');
        if (replay !== true && replay !== false) stop('INVALID_MODE');
        const continuations = required(renderer, 'continuations');
        const token = required(required(required(continuations, '0'), 'reloadContinuationData'), 'continuation');
        const continuation = text(token, 32768, 'INVALID_CONTINUATION', true);
        const chosen = selectContext();
        if (document !== currentDocument || currentDocument.querySelector('ytd-watch-flexy') !== root ||
            root.ownerDocument !== currentDocument || !root.isConnected) stop('INVALID_SOURCE');
        const result = Object.create(null);
        result.status = 'OK'; result.source = chosen.source; result.targetId = targetId;
        result.mode = replay ? 'replay' : 'live'; result.continuation = continuation; result.context = chosen.context;
        return result;
    } catch (code) {
        const codes = ['ABSENT_CONTEXT', 'INVALID_SOURCE', 'ACCESSOR_FORBIDDEN', 'PROTOTYPE_EXHAUSTED',
            'INVALID_CONTEXT', 'INVALID_CONTINUATION', 'INVALID_TARGET', 'INVALID_MODE',
            'INVALID_STRING', 'PRECHECK_LIMIT', 'EXTRACTION_EXCEPTION'];
        const result = Object.create(null);
        result.status = 'ERROR';
        result.code = typeof code === 'string' && codes.includes(code) ? code : 'EXTRACTION_EXCEPTION';
        return result;
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = extractBootstrap;
})();
