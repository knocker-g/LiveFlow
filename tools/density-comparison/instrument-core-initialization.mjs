// Dev-only generated copies. Keep the original Core IIFE and CommonJS block intact.
function once(source, before, after) {
    if (source.split(before).length !== 2) throw Error('Core init trace anchor missing/ambiguous');
    return source.replace(before, after);
}
export function instrumentChatReadInitialization(source) {
    source = source.replaceAll('\r\n', '\n');
    source = once(source, '(function (global) {', `(function (global) {
    devCoreTarget = global;
    devCoreMark('CORE_ENTER');`);
    source = once(source, "    if (typeof module !== 'undefined' && module.exports) {", `    devCoreMark('API_READY');
    devCoreStage = 'COMMONJS_EXPORT';
    if (typeof module !== 'undefined' && module.exports) {`);
    source = once(source, '    global.LiveFlowChatReadCore = api;', `    devCoreMark('COMMONJS_EXPORT_COMPLETED');
    devCoreStage = 'WINDOW_PUBLICATION';
    global.LiveFlowChatReadCore = api;
    devCoreMark('WINDOW_PUBLICATION_COMPLETED', api);`);
    return `(function () {
    let devCoreTarget, devCoreStage = 'CORE_ENTER', devCoreFault = false;
    const devCoreRows = [];
    function devCoreMark(stage, published) {
        try {
            const row = { sequence: devCoreRows.length + 1, stage,
                target: devCoreTarget === globalThis ? 'GLOBAL_THIS' : 'OTHER' };
            if (stage === 'THREW') row.during = devCoreStage;
            if (stage === 'WINDOW_PUBLICATION_COMPLETED') {
                const d = Object.getOwnPropertyDescriptor(devCoreTarget, 'LiveFlowChatReadCore');
                row.ownDescriptor = !!d;
                row.dataDescriptor = !!d && Object.hasOwn(d, 'value');
                row.valueMatches = row.dataDescriptor && d.value === published;
            }
            if (devCoreRows.length < 5) devCoreRows.push(Object.freeze(row));
            else devCoreFault = true;
            const slot = Object.getOwnPropertyDescriptor(devCoreTarget, '__liveflowDevCoreInitialization');
            if (slot && (!Object.hasOwn(slot, 'value') || slot.configurable !== true)) return;
            Object.defineProperty(devCoreTarget, '__liveflowDevCoreInitialization', { configurable: true,
                value: Object.freeze({ profile: 'CHAT_READ_CORE_INIT_V1', capacity: 5,
                    collectorFault: devCoreFault, rows: Object.freeze(devCoreRows.slice()) }) });
        } catch { devCoreFault = true; }
    }
    try {
${source}
    } catch (error) {
        devCoreMark('THREW');
        throw error;
    }
})();
`;
}
export function instrumentCoreInitializationStatus(main) {
    main = main.replaceAll('\r\n', '\n');
    main = once(main, '    function initialTraceSnapshot() {', `    function chatReadCoreInitializationStatus() {
        try {
            const slot = Object.getOwnPropertyDescriptor(window, '__liveflowDevCoreInitialization');
            if (!slot) return Object.freeze({ profile: 'CHAT_READ_CORE_INIT_V1', stage: 'NOT_OBSERVED', rows: Object.freeze([]) });
            if (!Object.hasOwn(slot, 'value')) throw Error('Diagnostic slot');
            const raw = slot.value;
            const stages = ['CORE_ENTER', 'API_READY', 'COMMONJS_EXPORT_COMPLETED', 'WINDOW_PUBLICATION_COMPLETED', 'THREW'];
            if (raw?.profile !== 'CHAT_READ_CORE_INIT_V1' || raw.capacity !== 5 || !Array.isArray(raw.rows) || raw.rows.length > 5 ||
                raw.rows.some((r, i) => r.sequence !== i + 1 || !stages.includes(r.stage))) throw Error('Diagnostic shape');
            const rows = raw.rows.map(r => Object.freeze({ sequence: r.sequence, stage: r.stage,
                target: r.target === 'GLOBAL_THIS' ? 'GLOBAL_THIS' : 'OTHER',
                ...(r.stage === 'THREW' ? { during: ['CORE_ENTER', 'COMMONJS_EXPORT', 'WINDOW_PUBLICATION'].includes(r.during) ? r.during : 'UNKNOWN' } : {}),
                ...(r.stage === 'WINDOW_PUBLICATION_COMPLETED' ? { ownDescriptor: r.ownDescriptor === true,
                    dataDescriptor: r.dataDescriptor === true, valueMatches: r.valueMatches === true } : {}) }));
            const current = Object.getOwnPropertyDescriptor(window, 'LiveFlowChatReadCore');
            return Object.freeze({ profile: raw.profile, capacity: 5, collectorFault: raw.collectorFault === true,
                stage: rows.at(-1)?.stage || 'NOT_OBSERVED', rows: Object.freeze(rows),
                currentOwnDescriptor: !!current, currentDataDescriptor: !!current && Object.hasOwn(current, 'value') });
        } catch { return Object.freeze({ profile: 'CHAT_READ_CORE_INIT_V1', collectorFault: true, stage: 'NOT_OBSERVED', rows: Object.freeze([]) }); }
    }
    function initialTraceSnapshot() {`);
    return once(main, 'initialAuthorityTrace: initialTraceSnapshot(),',
        'chatReadCoreInitialization: chatReadCoreInitializationStatus(), initialAuthorityTrace: initialTraceSnapshot(),');
}
