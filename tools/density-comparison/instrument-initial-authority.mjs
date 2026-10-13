// Patch only generated copies. Exact anchors fail closed on unrecognized source.
import fs from 'node:fs';
const collectorFile = new URL('./initial-authority-trace.js', import.meta.url);
function once(source, before, after) {
    if (source.split(before).length !== 2) throw Error('Initial trace anchor missing/ambiguous: ' + before.slice(0, 80));
    return source.replace(before, after);
}
function edit(source, name, transform) {
    let start = source.indexOf('    function ' + name + '(');
    if (start < 0) start = source.indexOf('    async function ' + name + '(');
    const end = source.indexOf('\n    }\n', start) + 7;
    if (start < 0 || end < start) throw Error('Initial trace function missing: ' + name);
    return source.slice(0, start) + transform(source.slice(start, end)) + source.slice(end);
}
function entry(source, name, statement) {
    return edit(source, name, s => {
        const end = s.indexOf('\n');
        if (!s.slice(0, end).endsWith(') {')) throw Error('Initial trace signature changed: ' + name);
        return s.slice(0, end + 1) + '        ' + statement + '\n' + s.slice(end + 1);
    });
}
const trace = (step, fields = '{}') => `initialTrace('${step}', ${fields});`;
export function instrumentInitialAuthorityTrace(main, core, identity) {
    main = main.replaceAll('\r\n', '\n'); core = core.replaceAll('\r\n', '\n');
    const collector = once(fs.readFileSync(collectorFile, 'utf8'), 'module.exports = { createInitialAuthorityTrace };', '');
    const setup = collector + `
    const initialAuthorityTrace = createInitialAuthorityTrace(${JSON.stringify(identity)});
    function initialTrace(step, details = {}) {
        try {
            initialAuthorityTrace.record(step, { lifecycle: pageLifecycleGeneration, revision: pageRevision,
                generation: currentLoopGeneration, epoch: diagnosticScopes.currentEpoch(),
                activeGeneration: activeLoopGeneration, visibility: document.hidden ? 'HIDDEN' : 'VISIBLE',
                phase: replayProductionControlState?.phase || 'UNKNOWN',
                inFlight: readRequestInFlight ? 'PRESENT' : 'ABSENT', ...details });
        } catch { initialAuthorityTrace.fault(); }
    }
    function initialTraceSnapshot() {
        try { return initialAuthorityTrace.snapshot(); }
        catch { initialAuthorityTrace.fault(); return { profile: 'INITIAL_AUTHORITY_ORDER_V1', collectorFault: true }; }
    }
    // No controller/Authority operation has run yet. Do not read the not-yet-initialized control state.
    try { initialAuthorityTrace.record('TRACE_INSTALLED', { lifecycle: pageLifecycleGeneration, revision: pageRevision,
        generation: currentLoopGeneration, epoch: diagnosticScopes.currentEpoch(), phase: 'NOT_INITIALIZED' }); }
    catch { initialAuthorityTrace.fault(); }
`;
    main = once(main, '    const replayControlShadow = replayControlPlaneCore?.createShadowController?.() || null;',
        setup + "    const replayControlShadow = replayControlPlaneCore?.createShadowController?.(undefined, (step, details) => initialTrace(step, details)) || null;");
    main = once(main, 'return replayControlShadow?.status?.() || Object.freeze({',
        'const initialShadowStatus = replayControlShadow?.status?.() || Object.freeze({');
    main = once(main, "                transitionCount: 0, mismatchCount: 0, latestMismatch: 'NONE'\n            });",
        "                transitionCount: 0, mismatchCount: 0, latestMismatch: 'NONE'\n            });\n            return Object.freeze({ ...initialShadowStatus, initialAuthorityTrace: initialTraceSnapshot() });");

    main = entry(main, 'acceptReplayBootstrapCandidate', trace('BOOTSTRAP_CANDIDATE'));
    main = once(main, '        if (event.data.type === READ_REQUEST_TYPE) {',
        '        if (event.data.type === READ_REQUEST_TYPE) {\n            ' + trace('READ_REQUEST_RECEIVED'));
    main = edit(main, 'respond', s => once(s,
        "        const currentVideo = watchRoot?.querySelector('#movie_player video.html5-main-video, #movie_player video') || null;",
        "        const currentVideo = watchRoot?.querySelector('#movie_player video.html5-main-video, #movie_player video') || null;\n        " +
        trace('WATCH_MEDIA_FACTS', "{ media: !currentVideo ? 'ABSENT' : currentVideo.paused ? 'PAUSED' : currentVideo.ended ? 'ENDED' : currentVideo.seeking ? 'SEEKING' : 'PLAYING' }")));
    main = edit(main, 'acceptReplayBootstrapCandidate', s => {
        s = once(s, 'if (replayBootstrapEligibilityLifecycleId === pageLifecycleGeneration) return false;',
            "if (replayBootstrapEligibilityLifecycleId === pageLifecycleGeneration) { " + trace('BOOTSTRAP_ONCE_REJECTED') + ' return false; }');
        return once(s, '        return Boolean(replayBootstrapAuthority);',
            "        " + trace('BOOTSTRAP_ACCEPTANCE', "{ outcome: replayBootstrapAuthority ? 'ACCEPTED' : 'REJECTED', authorityState: replayBootstrapAuthority ? 'OBSERVED_UNUSED' : 'INVALID', kind: 'BOOTSTRAP' }") + '\n        return Boolean(replayBootstrapAuthority);');
    });
    main = entry(main, 'authorizeReplayAuthority', trace('AUTHORIZATION_ENTRY', "{ kind: expectedKind, authorityState: authority ? 'PRESENT' : 'ABSENT' }"));
    main = edit(main, 'authorizeReplayAuthority', s => {
        s = once(s, 'replayReanchorLock || replayPlayerSeekDiagnosticLock) return null;',
            "replayReanchorLock || replayPlayerSeekDiagnosticLock) { " + trace('AUTHORIZATION_GUARD_REJECTED', '{ kind: expectedKind }') + ' return null; }');
        return once(s, '        return grantResult?.ok === true ? grantResult.grant : null;',
            '        ' + trace('AUTHORIZATION_RESULT', "{ kind: expectedKind, outcome: grantResult?.ok === true ? 'SUCCESS' : 'FAILURE', reason: grantResult?.reason, authorityState: grantResult?.ok === true ? 'CONSUMED' : 'UNKNOWN', grantState: grantResult?.ok === true ? 'AUTHORIZED' : 'NONE' }") + '\n        return grantResult?.ok === true ? grantResult.grant : null;');
    });
    main = entry(main, 'startReplayBootstrap', trace('BOOTSTRAP_START_ENTRY'));
    main = edit(main, 'startReplayBootstrap', s => {
        s = once(s, 'replayBootstrapEligibilityLifecycleId !== pageLifecycleGeneration) return false;',
            'replayBootstrapEligibilityLifecycleId !== pageLifecycleGeneration) { ' + trace('BOOTSTRAP_START_REJECTED') + ' return false; }');
        s = once(s, '        if (!grant) {', '        if (!grant) {\n            ' + trace('BOOTSTRAP_NO_GRANT'));
        s = once(s, '        if (video.paused) {', '        if (video.paused) {\n            ' + trace('BOOTSTRAP_MEDIA_DEFERRED', "{ media: 'PAUSED', authorityState: 'OBSERVED_UNUSED' }"));
        return once(s, "        if (snapshot) replayControlShadow?.compareCapability?.('BOOTSTRAP', snapshot, binding, true);",
            "        " + trace('BOOTSTRAP_ENVIRONMENT', "{ media: !video ? 'ABSENT' : video.paused ? 'PAUSED' : video.ended ? 'ENDED' : video.seeking ? 'SEEKING' : 'PLAYING', ownership: snapshot?.capabilities?.mainContentOwnership, currentness: snapshot?.capabilities?.targetIdentity }") + "\n        if (snapshot) replayControlShadow?.compareCapability?.('BOOTSTRAP', snapshot, binding, true);");
    });
    main = edit(main, 'invalidateAuthorityHandle', s => {
        s = once(s, "        if (authority?.diagnostic?.()?.authorityState === 'OBSERVED_UNUSED') {",
            "        const initialAuthorityDiagnostic = authority?.diagnostic?.();\n        const initialState = initialAuthorityDiagnostic?.authorityState;\n        if (initialState === 'OBSERVED_UNUSED') {");
        s = once(s, '            replayControlPlaneCore?.invalidateAuthority?.(authority);',
            "            const initialInvalidation = replayControlPlaneCore?.invalidateAuthority?.(authority);\n            " + trace('AUTHORITY_INVALIDATION', "{ kind: initialAuthorityDiagnostic?.authorityKind, beforeState: initialState, afterState: initialInvalidation?.ok === true ? 'INVALID' : 'UNKNOWN', outcome: initialInvalidation?.ok === true ? 'SUCCESS' : 'FAILURE' }") + "\n        } else {\n            " + trace('AUTHORITY_INVALIDATION', "{ kind: initialAuthorityDiagnostic?.authorityKind, beforeState: initialState, afterState: initialState, outcome: 'NO_OP' }"));
        return s;
    });
    main = entry(main, 'enterReplaySuspended', trace('SUSPEND_ENTRY', '{ reason }'));
    main = edit(main, 'invalidateReplayBootstrapAuthority', s => once(s, '        replayBootstrapAuthority = null;',
        '        replayBootstrapAuthority = null;\n        ' + trace('BOOTSTRAP_HANDLE_CLEARED')));
    main = entry(main, 'resumeReadAfterVisibility', trace('FOREGROUND_ENTRY'));
    main = edit(main, 'resumeReadAfterVisibility', s => {
        s = once(s, "document.visibilityState !== 'visible') return false;",
            "document.visibilityState !== 'visible') { " + trace('FOREGROUND_EARLY_REJECTED') + ' return false; }');
        s = once(s, '            if (replayAdActive) {', '            if (replayAdActive) {\n                ' + trace('FOREGROUND_AD_REJECTED'));
        s = once(s, '            replayForegroundRecoveryDiagnostic.retainedCurrentAtVisible = authorityEligibility?.ok === true;',
            '            ' + trace('FOREGROUND_ELIGIBILITY', "{ outcome: recovery.allowed === true ? 'ALLOWED' : 'DENIED', authorityState: authorityDiagnostic?.authorityState, currentness: authorityDiagnostic?.authorityCurrent === true ? 'CURRENT' : 'STALE', ownership: ownershipCurrent ? 'CURRENT' : 'STALE', capability: capabilityAllowed ? 'ALLOWED' : 'DENIED' }") + '\n            replayForegroundRecoveryDiagnostic.retainedCurrentAtVisible = authorityEligibility?.ok === true;');
        s = once(s, '            if (userEnabled !== true || navigationPending || recovery.allowed !== true) {',
            '            if (userEnabled !== true || navigationPending || recovery.allowed !== true) {\n                ' + trace('FOREGROUND_PRECONDITION_REJECTED'));
        return once(s, '            return queued;', '            ' + trace('FOREGROUND_RESULT', "{ outcome: queued ? 'STARTED' : 'REJECTED' }") + '\n            return queued;');
    });
    main = entry(main, 'startReadLoop', trace('READ_LOOP_ENTRY'));
    main = edit(main, 'startReadLoop', s => {
        const branches = [
            ["if (pageState.mode === 'replay' && replayProductionControlState?.phase === 'SUSPENDED') {", 'READ_LOOP_REJECTED_SUSPENDED'],
            ['if (requestedLifecycleGeneration !== pageLifecycleGeneration || navigationPending) {', 'READ_LOOP_REJECTED_LIFECYCLE'],
            ['\n        if (!isCurrentPageStateTarget()) {', 'READ_LOOP_REJECTED_TARGET'],
            ["if (pageState.mode === 'replay' && replayStartAuthority?.allowed !== true) {", 'READ_LOOP_REJECTED_GRANT'],
            ['if (readRequestInFlight || activeLoopGeneration !== 0 || replayReanchorLock) {', 'READ_LOOP_REJECTED_CONFLICT'],
            ["            hidden: document.hidden\n        })) {", 'READ_LOOP_REJECTED_PRECONDITION'],
            ['if (!video || video.paused || video.ended || !Number.isFinite(video.currentTime)) {', 'READ_LOOP_REJECTED_MEDIA']
        ];
        for (const [anchor, step] of branches) s = once(s, anchor, anchor + '\n            ' + trace(step,
            step === 'READ_LOOP_REJECTED_MEDIA' ? "{ media: !video ? 'ABSENT' : video.paused ? 'PAUSED' : video.ended ? 'ENDED' : 'INVALID_TIMING' }" : '{}'));
        s = once(s, "        const replayGrantKind = replayRequestGrant?.diagnostic?.().authorizedKind || 'NONE';",
            "        const replayGrantKind = replayRequestGrant?.diagnostic?.().authorizedKind || 'NONE';\n        " + trace('GRANT_KIND_AT_READ_LOOP', '{ kind: replayGrantKind }'));
        s = once(s, '        const generation = ++currentLoopGeneration;',
            "        " + trace('READ_LOOP_BASIC_GATES_ACCEPTED', "{ currentness: 'CURRENT' }") + '\n        const generation = ++currentLoopGeneration;');
        s = once(s, "            setReplayRestartStage('BOOTSTRAP_READY');", '            ' + trace('READ_LOOP_MEDIA_ACCEPTED', "{ media: video.seeking ? 'SEEKING' : 'PLAYING' }") + "\n            setReplayRestartStage('BOOTSTRAP_READY');");
        s = once(s, '                currentRequestGrant = null;',
            '                ' + trace('GRANT_CLAIM_RESULT', "{ kind: requestAuthorityKind, grantState: claimed?.ok === true ? 'CLAIMED' : 'UNKNOWN', outcome: claimed?.ok === true ? 'SUCCESS' : 'FAILURE', reason: claimed?.reason }") + '\n                currentRequestGrant = null;');
        return once(s, "            postLifecycleDiagnostic('READ_RESPONSE_RECEIVED', {",
            '            ' + trace('READ_RESULT', "{ outcome: result?.ok === true ? 'SUCCESS' : 'FAILURE', readCount, messageCount: result?.messages?.length }") + "\n            postLifecycleDiagnostic('READ_RESPONSE_RECEIVED', {");
    });
    main = entry(main, 'postLifecycleDiagnostic', trace('READ_LIFECYCLE_EVENT', '{ event: eventName, generation: details.readGeneration ?? currentLoopGeneration, reason: details.rejectionReason, readCount }'));
    main = entry(main, 'observeReplayControlShadow', "const initialBeforePhase = replayProductionControlState?.phase;");
    main = edit(main, 'observeReplayControlShadow', s => once(s, '        return replayControlShadow?.dispatch?.(event, facts, legacyPhase) || null;',
        '        ' + trace('CONTROL_TRANSITION', '{ event, beforePhase: initialBeforePhase, afterPhase: replayProductionControlState?.phase, failure: productionTransition?.failure }') + '\n        return replayControlShadow?.dispatch?.(event, facts, legacyPhase) || null;'));

    core = once(core, 'function createShadowController(initialState = createReplayState(ReplayPhase.STOPPED)) {',
        'function createShadowController(initialState = createReplayState(ReplayPhase.STOPPED), initialTraceObserver = null) {');
    core = edit(core, 'createShadowController', s => {
        s = once(s, '        function dispatch(event, facts = {}, legacyPhase = null) {',
            '        function dispatch(event, facts = {}, legacyPhase = null) {\n            const initialBeforePhase = state.phase, initialBeforeMismatch = mismatchCount;');
        s = once(s, '            return status();',
            "            const initialStatus = status();\n            try { initialTraceObserver?.('SHADOW_DISPATCH', { event, beforePhase: initialBeforePhase, afterPhase: state.phase, failure: transition.failure, mismatch: latestMismatch, transitionCount, mismatchCount, mismatchDelta: mismatchCount - initialBeforeMismatch }); } catch { /* Diagnostics never escape into Product. */ }\n            return initialStatus;");
        s = once(s, '        function compareCapability(path, snapshot, currentBinding, legacyAllowed) {',
            '        function compareCapability(path, snapshot, currentBinding, legacyAllowed) {\n            const initialBeforeMismatch = mismatchCount;');
        return once(s, '            return Object.freeze({ shadowAllowed: evaluation.allowed, legacyAllowed: legacyAllowed === true });',
            "            try { initialTraceObserver?.('SHADOW_CAPABILITY', { path, beforePhase: state.phase, afterPhase: state.phase, capability: evaluation.allowed ? 'ALLOWED' : 'DENIED', mismatch: latestMismatch, transitionCount, mismatchCount, mismatchDelta: mismatchCount - initialBeforeMismatch }); } catch { /* Diagnostics never escape into Product. */ }\n            return Object.freeze({ shadowAllowed: evaluation.allowed, legacyAllowed: legacyAllowed === true });");
    });
    return { main, core };
}
