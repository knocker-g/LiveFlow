(() => {
    const SENSITIVE_HEADERS = /authorization|cookie|set-cookie|x-goog-authuser|x-goog-visitor-id|x-origin|x-youtube-bootstrap-logged-in|x-youtube-identity-token|sapisi?d|ssid|sid/i;
    const SENSITIVE_KEYS = /authorization|cookie|token|continuation|sid|ssid|sapisi?d|visitorData/i;

    function redactKey(key, value) {
        if (SENSITIVE_KEYS.test(key)) {
            if (typeof value === 'string') return `[redacted: length=${value.length}]`;
            return '[redacted]';
        }
        return value;
    }

    function summarizeObject(value, depth = 0) {
        if (depth > 4 || value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.slice(0, 20).map((item) => summarizeObject(item, depth + 1));

        return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, child]) => [
            key,
            redactKey(key, summarizeObject(child, depth + 1))
        ]));
    }

    function summarizeUrl(rawUrl) {
        const url = new URL(rawUrl, location.href);
        return {
            origin: url.origin,
            pathname: url.pathname,
            queryKeys: [...url.searchParams.keys()].sort()
        };
    }

    function summarizeHarEntry(entry) {
        const request = entry.request || {};
        const response = entry.response || {};
        const headerKeys = (request.headers || [])
            .filter(({ name }) => !SENSITIVE_HEADERS.test(name))
            .map(({ name }) => name.toLowerCase())
            .sort();

        let payloadSummary = { type: 'unavailable' };
        const postData = request.postData?.text;
        if (postData) {
            try {
                const body = JSON.parse(postData);
                payloadSummary = {
                    type: 'json',
                    topLevelKeys: Object.keys(body).sort(),
                    contextKeys: Object.keys(body.context || {}).sort(),
                    clientKeys: Object.keys(body.context?.client || {}).sort(),
                    continuationPresent: typeof body.continuation === 'string',
                    continuationLength: typeof body.continuation === 'string' ? body.continuation.length : 0,
                    bodyShape: summarizeObject(body)
                };
            } catch {
                payloadSummary = { type: 'non-json', length: postData.length };
            }
        }

        return {
            request: {
                url: summarizeUrl(request.url),
                method: request.method,
                headerKeys
            },
            payload: payloadSummary,
            response: {
                status: response.status,
                mimeType: response.content?.mimeType || ''
            },
            initiator: entry._initiator || entry.initiator || 'unavailable'
        };
    }

    window.LiveFlowSummarizeLiveChatNetwork = function (har) {
        const entries = har?.log?.entries || [];
        const matches = entries.filter((entry) => /\/youtubei\/v1\/live_chat\/get_live_chat(?:\?|$)/.test(entry.request?.url || ''));
        console.table(matches.map((entry) => {
            const summary = summarizeHarEntry(entry);
            return {
                method: summary.request.method,
                path: summary.request.url.pathname,
                queryKeys: summary.request.url.queryKeys.join(', '),
                status: summary.response.status,
                continuationPresent: summary.payload.continuationPresent,
                continuationLength: summary.payload.continuationLength,
                initiator: typeof summary.initiator === 'string' ? summary.initiator : 'object'
            };
        }));
        return matches.map(summarizeHarEntry);
    };

    console.log('[LiveFlow PoC] HAR summarizer loaded. Call LiveFlowSummarizeLiveChatNetwork(harObject).');
})();
