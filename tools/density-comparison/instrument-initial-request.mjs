import fs from 'node:fs';
function once(source, before, after) {
    if (source.split(before).length !== 2) throw Error('Initial REQUEST anchor missing/ambiguous: ' + before.slice(0, 80));
    return source.replace(before, after);
}
export function instrumentInitialRequestMain(source) {
    source = once(source, '    function initialTraceSnapshot() {', `    function initialRequestMark(step, details = {}) {
        try { initialAuthorityTrace.record(step, { lifecycle: pageLifecycleGeneration, revision: pageRevision, generation: currentLoopGeneration, ...details }); }
        catch { try { initialAuthorityTrace.fault(); } catch { /* Passive only. */ } }
    }
    function initialRequestDispatchStatus() {
        try {
            const panel = document.getElementById('liveflow-dev-comparison');
            if (panel?.ownerDocument !== document || !panel.dataset.initialRequestTrace) return { crossWorldOrdering: 'UNORDERED', documentCorrespondence: 'NOT_OBSERVED', content: null };
            const bytes = panel.dataset.initialRequestTrace;
            if (bytes.length > 65536) throw Error('Diagnostic size');
            const raw = JSON.parse(bytes), identity = initialAuthorityTrace.snapshot().identity;
            const steps = ['CONTENT_REQUEST_TRACE_INSTALLED', 'CONTENT_SETTINGS_READY', 'CONTENT_DETECT_ENTRY', 'INITIAL_REQUEST_SEND_ENTRY', 'INITIAL_REQUEST_SEND_RETURN'];
            if (raw.identity?.sourceSHA !== identity.sourceSHA || raw.identity?.commonBuildID !== identity.commonBuildID ||
                raw.capacity !== 256 || !Number.isSafeInteger(raw.total) || raw.total < 0 ||
                !Array.isArray(raw.rows) || raw.rows.length > 256 || raw.rows.some(row => !steps.includes(row.step) || !Number.isSafeInteger(row.sequence) || row.sequence < 1)) throw Error('Diagnostic shape');
            const content = { profile: 'INITIAL_AUTHORITY_ORDER_V1', identity, capacity: 256, total: raw.total,
                truncated: raw.truncated === true, collectorFault: raw.collectorFault === true,
                rows: raw.rows.map(row => ({ sequence: row.sequence, step: row.step })) };
            return { crossWorldOrdering: 'UNORDERED', documentCorrespondence: 'CURRENT_DOCUMENT_DOM_EXPORT', content };
        } catch { return { crossWorldOrdering: 'UNORDERED', documentCorrespondence: 'INCONCLUSIVE', collectorFault: true, content: null }; }
    }
    function initialTraceSnapshot() {`);
    source = once(source, 'initialAuthorityTrace: initialTraceSnapshot() });',
        'initialAuthorityTrace: initialTraceSnapshot(), initialRequestDispatch: initialRequestDispatchStatus() });');
    // These exact anchors belong to the original MAIN message listener, not new listeners.
    source = once(source, "        if (event.source !== window || event.origin !== window.location.origin) return;",
        "        if (event.source !== window || event.origin !== window.location.origin) { initialRequestMark('INITIAL_DISPATCH_GUARD_REJECTED', { reason: 'WINDOW_OR_ORIGIN' }); return; }");
    source = once(source, "        if (event.data?.source !== 'liveflow-content-script') return;",
        "        if (event.data?.source !== 'liveflow-content-script') { initialRequestMark('INITIAL_DISPATCH_GUARD_REJECTED', { reason: 'SOURCE_GUARD' }); return; }");
    source = once(source, '        if (event.data.type === REQUEST_TYPE) {',
        "        if (event.data.type === REQUEST_TYPE) {\n            initialRequestMark('INITIAL_REQUEST_RECEIVED');");
    source = once(source, "    window.addEventListener('yt-navigate-finish',",
        "    initialRequestMark('MAIN_MESSAGE_LISTENER_READY');\n    window.addEventListener('yt-navigate-finish',");
    source = once(source, "        if (expectedLifecycleGeneration !== null && expectedLifecycleGeneration !== pageLifecycleGeneration) return false;",
        "        initialRequestMark('INITIAL_RESPOND_ENTRY');\n        if (expectedLifecycleGeneration !== null && expectedLifecycleGeneration !== pageLifecycleGeneration) { initialRequestMark('INITIAL_RESPOND_EARLY_RETURN', { reason: 'EXPECTED_LIFECYCLE' }); return false; }");
    source = once(source, '        if (!canReevaluate) return false;',
        "        initialRequestMark('INITIAL_RESPOND_REEVALUATION', { outcome: canReevaluate ? 'ALLOWED' : 'DENIED' });\n        if (!canReevaluate) { initialRequestMark('INITIAL_RESPOND_EARLY_RETURN', { reason: 'REEVALUATION_DISABLED' }); return false; }");
    return source;
}
export function instrumentInitialRequestContent(source, identity) {
    source = source.replaceAll('\r\n', '\n');
    const collector = fs.readFileSync(new URL('./initial-authority-trace.js', import.meta.url), 'utf8')
        .replace('module.exports = { createInitialAuthorityTrace };', '');
    source = once(source, '    const comparisonNodes = new WeakMap();', collector + `
    const contentInitialRequestTrace = createInitialAuthorityTrace(${JSON.stringify(identity)});
    function publishInitialRequestTrace() {
        try {
            const panel = document.getElementById('liveflow-dev-comparison');
            if (panel?.ownerDocument === document) panel.dataset.initialRequestTrace = JSON.stringify(contentInitialRequestTrace.snapshot());
        } catch { try { contentInitialRequestTrace.fault(); } catch { /* Passive only. */ } }
    }
    function contentInitialRequestMark(step) {
        try { contentInitialRequestTrace.record(step); }
        catch { try { contentInitialRequestTrace.fault(); } catch { /* Passive only. */ } }
        publishInitialRequestTrace();
    }
    contentInitialRequestMark('CONTENT_REQUEST_TRACE_INSTALLED');
    const comparisonNodes = new WeakMap();`);
    source = once(source, '        document.documentElement.append(panel);',
        '        document.documentElement.append(panel);\n        publishInitialRequestTrace();');
    source = once(source, '    function requestInitialContinuation() {',
        "    function requestInitialContinuation() {\n        contentInitialRequestMark('INITIAL_REQUEST_SEND_ENTRY');");
    // Preserve postMessage receiver/arguments, and record RETURN only if the original call returned.
    source = once(source, '            type: REQUEST_TYPE\n        }, window.location.origin);',
        "            type: REQUEST_TYPE\n        }, window.location.origin);\n        contentInitialRequestMark('INITIAL_REQUEST_SEND_RETURN');");
    source = once(source, '    function detectPage() {',
        "    function detectPage() {\n        contentInitialRequestMark('CONTENT_DETECT_ENTRY');");
    source = once(source, '            persistentSettingsReady = true;\n            return Promise.resolve();',
        "            persistentSettingsReady = true;\n            contentInitialRequestMark('CONTENT_SETTINGS_READY');\n            return Promise.resolve();");
    source = once(source, '            persistentSettingsReady = true;\n        });',
        "            persistentSettingsReady = true;\n            contentInitialRequestMark('CONTENT_SETTINGS_READY');\n        });");
    return source;
}
