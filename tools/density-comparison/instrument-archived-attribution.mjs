// Generated MAIN only. Reuse scope ownership/eviction; WeakMap cannot retain evicted scopes.
function once(source, before, after) {
    if (source.split(before).length !== 2) throw Error('Archived attribution anchor missing/ambiguous');
    return source.replace(before, after);
}
export function instrumentArchivedAttribution(main) {
    main = main.replaceAll('\r\n', '\n');
    main = once(main, '    const diagnosticScopes = window.LiveFlowDiagnosticScopeCore.createScopes(', `    const archivedAttribution = new WeakMap();
    function archivedAttributionSnapshot(diagnostic, terminal = false, closureValid = false) {
        try {
            if (archivedAttribution.has(diagnostic)) return archivedAttribution.get(diagnostic);
            const ledger = replayAccountingStatus(diagnostic, false);
            const snapshot = Object.freeze({
                profile: 'ARCHIVED_ATTRIBUTION_V1', terminalObserved: terminal,
                closure: terminal ? (closureValid ? 'TERMINAL_VALIDATED' : 'TERMINAL_INVALID') : 'NOT_CLOSED',
                accountingComplete: ledger.accountingComplete, accountingValid: ledger.accountingComplete &&
                    Object.values(ledger.stages).every(s => s.valid === true) && ledger.lostUnaccounted === 0 && ledger.overflowUnaccounted === 0,
                lostUnaccounted: ledger.lostUnaccounted, overflowUnaccounted: ledger.overflowUnaccounted,
                temporal: Object.freeze({ ...ledger.stages.temporal }),
                due: diagnostic.bridged, future: diagnostic.temporalPending,
                seekRemoval: diagnostic.temporalRemovalReasons.SEEK,
                terminalReasons: Object.freeze(Object.fromEntries(['HIDDEN', 'AD', 'NAVIGATION', 'SEEK', 'FAIL_CLOSED',
                    'READ_START_RESET', 'REANCHOR_REPLACED', 'NO_FRESH_CHAIN', 'USER_DISABLED', 'PAGEHIDE',
                    'MODE_TRANSITION', 'RATE_CHANGE', 'EXPLICIT', 'OTHER'].map(reason => [reason, diagnostic.temporalRemovalReasons[reason]]))),
                pending: diagnostic.temporalPending, unclassified: diagnostic.temporalUnclassified,
                pendingUnclassified: diagnostic.temporalPendingUnclassified, dueAwaitingBridge: diagnostic.temporalDueAwaitingBridge,
                scheduler: Object.freeze({ ...ledger.stages.scheduler }),
                schedulerReasons: Object.freeze({ stale: diagnostic.stalePruned, capacity: diagnostic.capacityDropped,
                    emergency: diagnostic.emergencyPendingDropped, lifecycle: diagnostic.schedulerLifecycleDiscarded,
                    structural: diagnostic.schedulerStructuralDiscarded }), collectorFault: false
            });
            if (terminal) archivedAttribution.set(diagnostic, snapshot);
            return snapshot;
        } catch {
            const failed = Object.freeze({ profile: 'ARCHIVED_ATTRIBUTION_V1', collectorFault: true, closure: 'INCOMPLETE' });
            if (terminal) { try { archivedAttribution.set(diagnostic, failed); } catch { /* Diagnostic collector only. */ } }
            return failed;
        }
    }
    const diagnosticScopes = window.LiveFlowDiagnosticScopeCore.createScopes(`);
    const start = main.indexOf('    function replayDiagnosticClosureValid(diagnostic) {');
    const end = main.indexOf('\n    }\n', start) + 7;
    if (start < 0 || end < start) throw Error('Closure function missing');
    const original = main.slice(start, end);
    let patched = once(original, '        return status.accountingComplete', '        const valid = status.accountingComplete');
    patched = once(patched, '\n    }', '\n        archivedAttributionSnapshot(diagnostic, true, valid);\n        return valid;\n    }');
    main = main.slice(0, start) + patched + main.slice(end);
    main = once(main, '            return { ...scope, scheduler: ledger.stages.scheduler, lostUnaccounted: ledger.lostUnaccounted,',
        `            const attribution = archivedAttributionSnapshot(value);
            const attributionIncomplete = scope.state === 'INCOMPLETE' || attribution.collectorFault ||
                (scope.epoch !== status.epoch && attribution.terminalObserved !== true);
            return { ...scope, archivedAttribution: Object.freeze({ ...attribution,
                lifecycle: scope.lifecycle, epoch: scope.epoch, sequence: scope.sequence,
                sequenceCompleteness: attributionIncomplete ? 'INCOMPLETE' :
                    attribution.terminalObserved ? 'COMPLETE' : 'OPEN',
                state: attributionIncomplete ? 'INCOMPLETE' : scope.state }),
                scheduler: ledger.stages.scheduler, lostUnaccounted: ledger.lostUnaccounted,`);
    main = once(main, '            scope.epoch !== status.epoch && !scope.accountingValid) };',
        "            (scope.epoch !== status.epoch && !scope.accountingValid) || scope.archivedAttribution.state === 'INCOMPLETE') };");
    return main;
}
