(function (global) {
    const ENDPOINTS = new Set(['/live_chat_replay', '/youtubei/v1/live_chat/get_live_chat_replay']);
    const DEFAULT_LIMITS = Object.freeze({ maxDepth: 8, maxNodes: 1500, maxArrayItems: 1, maxObjectKeys: 40, maxTopLevelKeys: 40, maxTimingPaths: 30, maxContinuationPaths: 30, maxNames: 50, maxHistory: 50, maxSummaryChars: 30000 });

    function primitiveType(value) {
        if (value === null) return 'null';
        if (Array.isArray(value)) return 'array';
        const type = typeof value;
        return ['string', 'number', 'boolean', 'object', 'undefined'].includes(type) ? type : 'unsupported';
    }

    function safeKey(value) {
        return typeof value === 'string' && value.length <= 64 && /^[A-Za-z_$]+$/.test(value) ? value : null;
    }

    function replayEndpoint(value, base = 'https://www.youtube.com/') {
        try {
            const pathname = new URL(typeof value === 'string' ? value : value?.url, base).pathname;
            return ENDPOINTS.has(pathname) ? pathname : null;
        } catch { return null; }
    }

    function topLevelShape(value, limit = DEFAULT_LIMITS.maxTopLevelKeys) {
        try {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
            return Object.keys(value).map(safeKey).filter(Boolean).sort().slice(0, limit).map((key) => {
                try { return { key, type: primitiveType(value[key]) }; } catch { return { key, type: 'unavailable' }; }
            });
        } catch { return []; }
    }

    function requestBodyShape(body, limit) {
        try {
            const value = typeof body === 'string' ? JSON.parse(body) : body;
            return topLevelShape(value, limit);
        } catch { return []; }
    }

    function collectResponseShape(value, options = {}) {
        const limits = { ...DEFAULT_LIMITS, ...options };
        const seen = new WeakSet();
        const sets = { replayTimingCandidates: new Map(), continuationTimingPaths: new Map(), genericTimingPaths: new Map(), visualUiTimingPaths: new Map(), continuationPaths: new Map(), rendererNames: new Set(), actionNames: new Set(), viewModelNames: new Set(), continuationDataNames: new Set() };
        const observed = Object.fromEntries(Object.keys(sets).map((key) => [key, 0]));
        let nodes = 0;
        function addPath(category, path, type, maximum) {
            observed[category] += 1;
            if (sets[category].size < maximum) sets[category].set(`${path}:${type}`, { path, type });
        }
        function addName(category, name) {
            observed[category] += 1;
            if (sets[category].size < limits.maxNames) sets[category].add(name);
        }
        function visit(current, path, depth) {
            if (!current || typeof current !== 'object' || depth > limits.maxDepth || nodes >= limits.maxNodes || seen.has(current)) return;
            nodes += 1;
            seen.add(current);
            if (Array.isArray(current)) {
                current.slice(0, limits.maxArrayItems).forEach((entry) => visit(entry, `${path}[]`, depth + 1));
                return;
            }
            Object.keys(current).slice(0, limits.maxObjectKeys).forEach((rawKey) => {
                const key = safeKey(rawKey);
                if (!key) return;
                const child = current[rawKey];
                const childPath = path ? `${path}.${key}` : key;
                const lower = childPath.toLowerCase();
                const type = primitiveType(child);
                if (/Renderer$/.test(key)) addName('rendererNames', key);
                if (/Action$/.test(key)) addName('actionNames', key);
                if (/ViewModel$/.test(key)) addName('viewModelNames', key);
                if (/ContinuationData$/.test(key)) addName('continuationDataNames', key);
                if (lower.includes('continuation')) addPath('continuationPaths', childPath, type, limits.maxContinuationPaths);
                const timing = /(offset|time|timestamp)/i.test(key);
                const continuationTiming = /continuation/i.test(key) || /continuationdata|continuations\[\]/i.test(childPath);
                if (timing && continuationTiming) addPath('continuationTimingPaths', childPath, type, limits.maxTimingPaths);
                else if (timing && (lower.includes('replay') || lower.includes('action') || lower.includes('chatitem'))) addPath('replayTimingCandidates', childPath, type, limits.maxTimingPaths);
                else if (timing && /(timeout|polling|server)/i.test(lower)) addPath('genericTimingPaths', childPath, type, limits.maxTimingPaths);
                else if (timing && /(style|layout|animation|transition)/i.test(lower)) addPath('visualUiTimingPaths', childPath, type, limits.maxTimingPaths);
                visit(child, childPath, depth + 1);
            });
        }
        try { visit(value, '', 0); } catch { /* fail closed */ }
        const result = { responseTopLevelKeys: topLevelShape(value, limits.maxTopLevelKeys), nodesVisited: nodes };
        const timingRank = (entry) => /videoOffset/i.test(entry.path) ? 0 : /replay/i.test(entry.path) ? 1 : /chatitem|action/i.test(entry.path) ? 2 : 3;
        Object.keys(sets).forEach((key) => { result[key] = [...sets[key].values()].sort((a, b) => typeof a === 'string' ? a.localeCompare(b) : timingRank(a) - timingRank(b) || a.path.localeCompare(b.path)); });
        result.truncated = Object.fromEntries(Object.keys(sets).map((key) => [key, observed[key] > sets[key].size]));
        return result;
    }

    function createReplayProbeCollector({ limits = {} } = {}) {
        const effective = { ...DEFAULT_LIMITS, ...limits };
        const endpointCounts = new Map();
        const requestKeys = new Map();
        const responseKeys = new Map();
        const pathMaps = { replayTimingCandidates: new Map(), continuationTimingPaths: new Map(), genericTimingPaths: new Map(), continuationPaths: new Map() };
        const nameSets = { rendererNames: new Set(), actionNames: new Set(), viewModelNames: new Set(), continuationDataNames: new Set() };
        const history = [];
        const operations = { pauseResume: 0, forwardSeek: 0, backwardSeek: 0, rate05: 0, rate20: 0 };
        const operationStarts = new Map();
        let enabled = false;
        let explicitCookie = false;
        let explicitAuthHeader = false;
        let replayUIObserved = false;
        let categoryTruncated = false;
        let ignoredVisualTimingCount = 0;
        const totalRequests = () => [...endpointCounts.values()].reduce((sum, count) => sum + count, 0);
        const mergeRecords = (map, values, max) => values.forEach((entry) => { if (map.size < max) map.set(`${entry.path || entry.key}:${entry.type}`, entry); else categoryTruncated = true; });
        function observeRequest({ url, method = 'GET', body, headerNames = [] } = {}) {
            if (!enabled) return false;
            const path = replayEndpoint(url);
            if (!path) return false;
            const normalizedMethod = typeof method === 'string' ? method.toUpperCase().slice(0, 12) : 'UNKNOWN';
            const key = `${normalizedMethod} ${path}`;
            endpointCounts.set(key, (endpointCounts.get(key) || 0) + 1);
            requestBodyShape(body, effective.maxTopLevelKeys).forEach((entry) => requestKeys.set(`${entry.key}:${entry.type}`, entry));
            for (const name of headerNames) {
                if (typeof name !== 'string') continue;
                if (name.toLowerCase() === 'cookie') explicitCookie = true;
                if (name.toLowerCase() === `author${'ization'}`) explicitAuthHeader = true;
            }
            return true;
        }
        function observeResponse(value) {
            if (!enabled) return false;
            const shape = collectResponseShape(value, effective);
            shape.responseTopLevelKeys.forEach((entry) => responseKeys.set(`${entry.key}:${entry.type}`, entry));
            Object.entries(pathMaps).forEach(([key, map]) => mergeRecords(map, shape[key], key === 'continuationPaths' ? effective.maxContinuationPaths : effective.maxTimingPaths));
            ignoredVisualTimingCount += shape.visualUiTimingPaths.length;
            Object.entries(nameSets).forEach(([key, set]) => shape[key].forEach((name) => { if (set.size < effective.maxNames) set.add(name); else categoryTruncated = true; }));
            if (Object.values(shape.truncated).some(Boolean)) categoryTruncated = true;
            return true;
        }
        function recordVideoEvent(event) {
            if (!enabled || !['play', 'pause', 'seeking', 'seeked', 'ratechange'].includes(event)) return;
            history.push({ event, requestCount: totalRequests() });
            if (history.length > effective.maxHistory) history.shift();
        }
        function startOperation(name) { if (enabled && Object.hasOwn(operations, name)) operationStarts.set(name, totalRequests()); }
        function finishOperation(name) {
            if (!enabled || !operationStarts.has(name)) return;
            operations[name] += Math.max(0, totalRequests() - operationStarts.get(name));
            operationStarts.delete(name);
        }
        function summary() {
            const result = {
                enabled,
                endpoints: [...endpointCounts].map(([key, count]) => { const split = key.indexOf(' '); return { path: key.slice(split + 1), method: key.slice(0, split), count }; }),
                requestTopLevelKeys: [...requestKeys.values()].sort((a, b) => a.key.localeCompare(b.key)),
                responseTopLevelKeys: [...responseKeys.values()].sort((a, b) => a.key.localeCompare(b.key)),
                ...Object.fromEntries(Object.entries(pathMaps).map(([key, map]) => [key, [...map.values()].sort((a, b) => a.path.localeCompare(b.path))])),
                ...Object.fromEntries(Object.entries(nameSets).map(([key, set]) => [key, [...set].sort()])),
                authPresence: { cookieSeen: explicitCookie ? true : 'unknown', authorizationSeen: explicitAuthHeader ? true : 'unknown' },
                operationDeltas: Object.fromEntries(Object.entries(operations).map(([key, value]) => [key, value + (operationStarts.has(key) ? Math.max(0, totalRequests() - operationStarts.get(key)) : 0)])), eventHistory: [...history], replayUIObserved, replayEndpointObserved: endpointCounts.size > 0, ignoredTimingCounts: { visualUi: ignoredVisualTimingCount },
                truncated: { categories: categoryTruncated, history: history.length >= effective.maxHistory, summary: false }
            };
            const trimmable = [result.eventHistory, result.genericTimingPaths, result.continuationTimingPaths, result.continuationPaths, result.replayTimingCandidates, result.viewModelNames, result.continuationDataNames, result.rendererNames, result.actionNames, result.responseTopLevelKeys, result.requestTopLevelKeys];
            while (JSON.stringify(result).length > effective.maxSummaryChars) {
                const collection = trimmable.find((items) => items.length > 0);
                if (!collection) break;
                collection.pop();
                result.truncated.summary = true;
            }
            return result;
        }
        return Object.freeze({
            enable() { enabled = true; return summary(); }, disable() { enabled = false; operationStarts.clear(); return summary(); },
            reset() { endpointCounts.clear(); requestKeys.clear(); responseKeys.clear(); Object.values(pathMaps).forEach((map) => map.clear()); Object.values(nameSets).forEach((set) => set.clear()); history.length = 0; Object.keys(operations).forEach((key) => { operations[key] = 0; }); operationStarts.clear(); explicitCookie = false; explicitAuthHeader = false; replayUIObserved = false; categoryTruncated = false; ignoredVisualTimingCount = 0; return summary(); },
            observeRequest, observeResponse, recordVideoEvent, startOperation, finishOperation,
            cancelOperation(name) { operationStarts.delete(name); },
            setReplayUIObserved(value) { if (enabled && value === true) replayUIObserved = true; }, summary
        });
    }

    const api = { ENDPOINTS, DEFAULT_LIMITS, primitiveType, safeKey, replayEndpoint, topLevelShape, requestBodyShape, collectResponseShape, createReplayProbeCollector };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowReplayProbeCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
