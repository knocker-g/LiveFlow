(function (global) {
    const DEFAULT_LIMITS = Object.freeze({ maxDepth: 6, maxArrayItems: 1, maxObjectKeys: 30, maxNodes: 500, maxOutputChars: 12000, maxActions: 100, maxShapes: 100, maxSummaryChars: 120000 });

    function safeSchemaKey(key) {
        return typeof key === 'string' && /^[A-Za-z_$][A-Za-z_$]*$/.test(key) && key.length <= 64 ? key : '<dynamic-key>';
    }

    function sanitizeShape(value, options = {}) {
        const limits = { ...DEFAULT_LIMITS, ...options };
        const seen = new WeakSet();
        let nodes = 0;
        function visit(current, depth) {
            nodes += 1;
            if (nodes > limits.maxNodes) return '<node-limit>';
            if (current === null) return 'null';
            if (Array.isArray(current)) {
                if (depth >= limits.maxDepth) return '<max-depth>';
                const result = { type: 'array', length: current.length === 0 ? 'empty' : 'non-empty' };
                if (current.length > 0 && limits.maxArrayItems > 0) result.element = visit(current[0], depth + 1);
                return result;
            }
            const type = typeof current;
            if (['string', 'number', 'boolean', 'bigint', 'undefined'].includes(type)) return type;
            if (type !== 'object') return 'unsupported';
            if (depth >= limits.maxDepth) return '<max-depth>';
            if (seen.has(current)) return '<circular>';
            seen.add(current);
            const result = {};
            const keys = Object.keys(current);
            const selected = keys.slice(0, Math.max(0, limits.maxObjectKeys));
            for (const rawKey of selected) {
                const key = safeSchemaKey(rawKey);
                if (key === '<dynamic-key>' && Object.hasOwn(result, key)) continue;
                result[key] = visit(current[rawKey], depth + 1);
            }
            if (keys.length > selected.length) result['<truncated-keys>'] = 'present';
            return result;
        }
        try {
            const shape = visit(value, 0);
            return JSON.stringify(shape).length <= limits.maxOutputChars ? shape : { '<output-limit>': 'present' };
        } catch {
            return { '<sanitizer-error>': 'present' };
        }
    }

    function stableStringify(value) {
        if (!value || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }

    function fingerprintShape(value) {
        const input = stableStringify(value);
        let hash = 2166136261;
        for (let index = 0; index < input.length; index += 1) {
            hash ^= input.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `shape-${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    function findNamedShapes(value, predicate, limits) {
        const matches = [];
        const seen = new WeakSet();
        function visit(current, depth) {
            if (!current || typeof current !== 'object' || depth > limits.maxDepth || seen.has(current)) return;
            seen.add(current);
            if (Array.isArray(current)) {
                current.slice(0, limits.maxArrayItems).forEach((item) => visit(item, depth + 1));
                return;
            }
            Object.keys(current).slice(0, limits.maxObjectKeys).forEach((key) => {
                if (predicate(key)) matches.push({ key: safeSchemaKey(key), value: current[key] });
                visit(current[key], depth + 1);
            });
        }
        visit(value, 0);
        return matches;
    }

    function createSchemaCollector({ logger = console.log, limits = {} } = {}) {
        const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
        const entries = new Map();
        const badgeShapes = new Map();
        const messageRunShapes = new Map();
        let enabled = false;
        let shapeLimitReached = false;
        function shapeCount() {
            return entries.size + badgeShapes.size + messageRunShapes.size;
        }
        function remember(map, shape) {
            const fingerprint = fingerprintShape(shape);
            if (map.has(fingerprint)) return false;
            if (shapeCount() >= effectiveLimits.maxShapes) {
                shapeLimitReached = true;
                return false;
            }
            map.set(fingerprint, { fingerprint, shape });
            return true;
        }
        function collect(response) {
            if (!enabled) return { observed: 0, duplicate: 0 };
            try {
                const actions = response?.continuationContents?.liveChatContinuation?.actions;
                if (!Array.isArray(actions)) return { observed: 0, duplicate: 0 };
                let observed = 0;
                let duplicate = 0;
                for (const action of actions.slice(0, effectiveLimits.maxActions)) {
                    if (!action || typeof action !== 'object' || Array.isArray(action)) continue;
                    const actionType = safeSchemaKey(Object.keys(action)[0] || 'UNKNOWN');
                    const renderers = findNamedShapes(action, (key) => /Renderer$/.test(key), effectiveLimits);
                    const nestedActionTypes = [...new Set(findNamedShapes(action, (key) => /Action$/.test(key), effectiveLimits).map((record) => record.key))].slice(0, effectiveLimits.maxObjectKeys);
                    for (const record of renderers.length ? renderers : [{ key: 'NONE', value: action }]) {
                        const fields = sanitizeShape(record.value, effectiveLimits);
                        const base = { actionType, nestedActionTypes, rendererType: record.key, fields };
                        const fingerprint = fingerprintShape(base);
                        if (entries.has(fingerprint)) { duplicate += 1; continue; }
                        if (shapeCount() >= effectiveLimits.maxShapes) {
                            shapeLimitReached = true;
                            continue;
                        }
                        entries.set(fingerprint, { ...base, fingerprint });
                        observed += 1;
                        logger('[LiveFlow schema]', JSON.stringify({ actionType, rendererType: record.key, fingerprint }));
                    }
                    findNamedShapes(action, (key) => key === 'authorBadges', effectiveLimits).forEach((record) => remember(badgeShapes, sanitizeShape(record.value, effectiveLimits)));
                    findNamedShapes(action, (key) => key === 'runs', effectiveLimits).forEach((record) => remember(messageRunShapes, sanitizeShape(record.value, effectiveLimits)));
                }
                return { observed, duplicate };
            } catch {
                return { observed: 0, duplicate: 0, failed: true };
            }
        }
        function getSummary() {
            const summary = { enabled, observedShapeCount: entries.size, totalShapeCount: shapeCount(), shapeLimitReached, summaryTruncated: false, actionRendererShapes: [...entries.values()], badgeStructures: [...badgeShapes.values()], messageRunStructures: [...messageRunShapes.values()] };
            const maxSummaryChars = Math.max(256, effectiveLimits.maxSummaryChars);
            while (JSON.stringify(summary).length > maxSummaryChars) {
                const collection = [summary.messageRunStructures, summary.badgeStructures, summary.actionRendererShapes].find((items) => items.length > 0);
                if (!collection) break;
                collection.pop();
                summary.summaryTruncated = true;
            }
            return summary;
        }
        return Object.freeze({
            enable() { enabled = true; return getSummary(); },
            disable() { enabled = false; return getSummary(); },
            reset() { entries.clear(); badgeShapes.clear(); messageRunShapes.clear(); shapeLimitReached = false; return getSummary(); },
            collect,
            getSummary,
            printSummary() { const summary = getSummary(); logger(JSON.stringify(summary, null, 2)); return summary; }
        });
    }

    const api = { DEFAULT_LIMITS, safeSchemaKey, sanitizeShape, fingerprintShape, createSchemaCollector };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowSchemaDiagnosticsCore = api;
    if (typeof window !== 'undefined') global.LiveFlowSchemaDiagnostics = createSchemaCollector();
})(typeof window !== 'undefined' ? window : globalThis);
