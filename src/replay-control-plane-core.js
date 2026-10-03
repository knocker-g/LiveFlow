(function (global) {
    'use strict';

    const enumOf = (values) => Object.freeze(Object.fromEntries(values.map((value) => [value, value])));

    const AuthorityKind = enumOf(['BOOTSTRAP', 'SEQUENTIAL', 'REANCHOR']);
    const AuthorityState = enumOf(['OBSERVED_UNUSED', 'CONSUMED', 'INVALID']);
    const ReplayPhase = enumOf(['STOPPED', 'BOOTSTRAPPING', 'READING', 'BUFFER_PAUSED', 'REANCHORING', 'SUSPENDED']);
    const SuspendedReason = enumOf(['HIDDEN', 'AD', 'MEDIA_PAUSED']);
    const CapabilityState = enumOf(['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN']);
    const CapabilityName = enumOf([
        'replayMessages', 'bootstrapRead', 'sequentialRead', 'reanchorRead',
        'playerTiming', 'targetIdentity', 'mainContentOwnership'
    ]);
    const ReplayEvent = enumOf([
        'LIFECYCLE_START', 'BOOTSTRAP_AUTHORIZED', 'BOOTSTRAP_SUCCEEDED', 'BOOTSTRAP_FAILED', 'INITIAL_ALIGNMENT_REQUIRED',
        'SEQUENTIAL_AUTHORIZED', 'SEQUENTIAL_SUCCEEDED', 'SEQUENTIAL_FAILED',
        'BUFFER_HIGH_WATERMARK', 'BUFFER_LOW_WATERMARK', 'EARLY_RESUME_ELIGIBLE', 'EARLY_RESUME_COMPLETED',
        'SEEK_STARTED', 'SEEK_COMPLETED', 'REANCHOR_AUTHORIZED', 'REANCHOR_SUCCEEDED', 'REANCHOR_FAILED',
        'HIDDEN_ENTER', 'VISIBLE_ENTER', 'AD_ENTER', 'AD_EXIT_READY', 'MEDIA_PAUSE', 'MEDIA_PLAY',
        'PLAYBACK_RATE_CHANGED', 'TARGET_CHANGED', 'NAVIGATION', 'DISABLE', 'GENERATION_INVALIDATED',
        'CAPABILITY_LOST', 'AUTHORITY_FAILURE'
    ]);
    const AuthorityAction = enumOf([
        'KEEP', 'INVALIDATE_ACTIVE', 'INVALIDATE_ALL', 'SAVE_SEQUENTIAL',
        'RESTORE_SAVED', 'ACCEPT_FRESH_SEQUENTIAL', 'RETAIN_ELIGIBLE_REANCHOR', 'NONE'
    ]);
    const PendingAction = enumOf(['KEEP', 'CLEAR', 'RECLASSIFY', 'NONE']);
    const RequestIntent = enumOf(['REQUEST_BOOTSTRAP', 'REQUEST_SEQUENTIAL', 'REQUEST_REANCHOR', 'NONE']);
    const TransitionFailure = enumOf(['NONE', 'NO_OP', 'FORBIDDEN_EVENT', 'CAPABILITY_REQUIRED_UNAVAILABLE', 'AUTHORITY_FAILURE']);
    const ShadowMismatch = enumOf([
        'NONE', 'PHASE_MISMATCH', 'FORBIDDEN_LEGACY_TRANSITION', 'AUTHORITY_KIND_MISMATCH',
        'CAPABILITY_PATH_MISMATCH', 'LEGACY_IMPLICIT_BOOTSTRAP', 'RAW_DEFERRED_START_PATH'
    ]);

    const enumValues = (value) => new Set(Object.values(value));
    const AUTHORITY_KINDS = enumValues(AuthorityKind);
    const AUTHORITY_STATES = enumValues(AuthorityState);
    const PHASES = enumValues(ReplayPhase);
    const SUSPEND_REASONS = enumValues(SuspendedReason);
    const CAPABILITY_STATES = enumValues(CapabilityState);
    const CAPABILITY_NAMES = Object.values(CapabilityName);
    const EVENTS = enumValues(ReplayEvent);
    const authorityRecords = new WeakMap();
    const consumedRegistryRecords = new WeakMap();
    const requestGrantRecords = new WeakMap();

    function validInteger(value) {
        return Number.isSafeInteger(value) && value >= 0;
    }

    function validTarget(value) {
        return typeof value === 'string' && value.length > 0 && value !== 'UNKNOWN';
    }

    function createAuthorityBinding(value = {}) {
        if (!validInteger(value.lifecycleId) || !validInteger(value.revision) ||
            !validTarget(value.targetId) || !validInteger(value.generation)) {
            return Object.freeze({ ok: false, binding: null, reason: 'AUTHORITY_BINDING_INVALID' });
        }
        return Object.freeze({
            ok: true,
            binding: Object.freeze({
                lifecycleId: value.lifecycleId,
                revision: value.revision,
                targetId: value.targetId,
                generation: value.generation
            }),
            reason: 'NONE'
        });
    }

    function isAuthorityBinding(value) {
        return Boolean(value && validInteger(value.lifecycleId) && validInteger(value.revision) &&
            validTarget(value.targetId) && validInteger(value.generation));
    }

    function authorityBindingsEqual(left, right) {
        return isAuthorityBinding(left) && isAuthorityBinding(right) &&
            left.lifecycleId === right.lifecycleId && left.revision === right.revision &&
            left.targetId === right.targetId && left.generation === right.generation;
    }

    function authorityDiagnostic(authority, currentBinding = null) {
        const record = authorityRecords.get(authority);
        if (!record) return Object.freeze({
            authorityKind: 'NONE', authorityState: 'INVALID', authorityProvenance: 'UNKNOWN',
            authorityCurrent: false, authorityBindingValid: false
        });
        return Object.freeze({
            authorityKind: record.kind,
            authorityState: record.state,
            authorityProvenance: record.provenance,
            authorityCurrent: currentBinding ? authorityBindingsEqual(record.binding, currentBinding) : false,
            authorityBindingValid: isAuthorityBinding(record.binding)
        });
    }

    function createReplayAuthority({ kind, opaqueToken, binding, provenance } = {}) {
        if (!AUTHORITY_KINDS.has(kind) || typeof opaqueToken !== 'string' || opaqueToken.length === 0 ||
            !isAuthorityBinding(binding) || typeof provenance !== 'string' || provenance.length === 0) {
            return Object.freeze({ ok: false, authority: null, reason: 'AUTHORITY_INVALID' });
        }
        const authority = Object.freeze({
            diagnostic(currentBinding) { return authorityDiagnostic(authority, currentBinding); },
            toJSON() { return authorityDiagnostic(authority); }
        });
        authorityRecords.set(authority, {
            kind, opaqueToken, binding: Object.freeze({ ...binding }), provenance, state: AuthorityState.OBSERVED_UNUSED
        });
        return Object.freeze({ ok: true, authority, reason: 'NONE' });
    }

    function transitionAuthority(authority, action, currentBinding) {
        const record = authorityRecords.get(authority);
        if (!record) return Object.freeze({ ok: false, reason: 'AUTHORITY_INVALID' });
        if (!authorityBindingsEqual(record.binding, currentBinding)) return Object.freeze({ ok: false, reason: 'AUTHORITY_STALE' });
        if (record.state !== AuthorityState.OBSERVED_UNUSED) {
            return Object.freeze({ ok: false, reason: record.state === AuthorityState.CONSUMED ? 'AUTHORITY_CONSUMED' : 'AUTHORITY_INVALID' });
        }
        if (action === 'CONSUME') record.state = AuthorityState.CONSUMED;
        else if (action === 'INVALIDATE') record.state = AuthorityState.INVALID;
        else return Object.freeze({ ok: false, reason: 'AUTHORITY_INVALID_TRANSITION' });
        return Object.freeze({ ok: true, reason: 'NONE', diagnostic: authorityDiagnostic(authority, currentBinding) });
    }

    function invalidateAuthority(authority) {
        const record = authorityRecords.get(authority);
        if (!record) return Object.freeze({ ok: false, reason: 'AUTHORITY_INVALID' });
        if (record.state !== AuthorityState.OBSERVED_UNUSED) {
            return Object.freeze({ ok: false, reason: record.state === AuthorityState.CONSUMED ? 'AUTHORITY_CONSUMED' : 'AUTHORITY_INVALID' });
        }
        record.state = AuthorityState.INVALID;
        return Object.freeze({ ok: true, reason: 'NONE', diagnostic: authorityDiagnostic(authority) });
    }

    function createConsumedAuthorityRegistry() {
        const registry = Object.freeze({
            has(opaqueToken) {
                const record = consumedRegistryRecords.get(registry);
                return typeof opaqueToken === 'string' && opaqueToken.length > 0 && record?.tokens.has(opaqueToken) === true;
            },
            diagnostic() {
                const record = consumedRegistryRecords.get(registry);
                return Object.freeze({ consumedCount: record?.tokens.size || 0 });
            }
        });
        consumedRegistryRecords.set(registry, { tokens: new Set() });
        return registry;
    }

    function authorizeAuthorityRequest({ authority, expectedKind, currentBinding, consumedRegistry } = {}) {
        const record = authorityRecords.get(authority);
        const registry = consumedRegistryRecords.get(consumedRegistry);
        if (!record || !registry) return Object.freeze({ ok: false, grant: null, reason: 'AUTHORITY_INVALID' });
        if (record.kind !== expectedKind) return Object.freeze({ ok: false, grant: null, reason: 'AUTHORITY_KIND_MISMATCH' });
        if (!authorityBindingsEqual(record.binding, currentBinding)) return Object.freeze({ ok: false, grant: null, reason: 'AUTHORITY_STALE' });
        if (record.state !== AuthorityState.OBSERVED_UNUSED) {
            return Object.freeze({ ok: false, grant: null, reason: record.state === AuthorityState.CONSUMED ? 'AUTHORITY_CONSUMED' : 'AUTHORITY_INVALID' });
        }
        if (registry.tokens.has(record.opaqueToken)) return Object.freeze({ ok: false, grant: null, reason: 'AUTHORITY_REPEATED' });
        record.state = AuthorityState.CONSUMED;
        registry.tokens.add(record.opaqueToken);
        const grant = Object.freeze({
            diagnostic() { return Object.freeze({ authorizedKind: record.kind, state: requestGrantRecords.get(grant)?.claimed ? 'CLAIMED' : 'AUTHORIZED' }); },
            toJSON() { return this.diagnostic(); }
        });
        requestGrantRecords.set(grant, { kind: record.kind, opaqueToken: record.opaqueToken, claimed: false });
        return Object.freeze({ ok: true, grant, reason: 'NONE' });
    }

    function inspectAuthorityRequestEligibility({ authority, expectedKind, currentBinding, consumedRegistry } = {}) {
        const record = authorityRecords.get(authority);
        const registry = consumedRegistryRecords.get(consumedRegistry);
        if (!record || !registry) return Object.freeze({ ok: false, reason: 'AUTHORITY_INVALID' });
        if (record.kind !== expectedKind) return Object.freeze({ ok: false, reason: 'AUTHORITY_KIND_MISMATCH' });
        if (!authorityBindingsEqual(record.binding, currentBinding)) return Object.freeze({ ok: false, reason: 'AUTHORITY_STALE' });
        if (record.state !== AuthorityState.OBSERVED_UNUSED) {
            return Object.freeze({ ok: false, reason: record.state === AuthorityState.CONSUMED ? 'AUTHORITY_CONSUMED' : 'AUTHORITY_INVALID' });
        }
        if (registry.tokens.has(record.opaqueToken)) return Object.freeze({ ok: false, reason: 'AUTHORITY_REPEATED' });
        return Object.freeze({ ok: true, reason: 'NONE' });
    }

    function claimAuthorityRequestGrant(grant, expectedKind) {
        const record = requestGrantRecords.get(grant);
        if (!record || record.claimed || record.kind !== expectedKind) {
            return Object.freeze({ ok: false, opaqueToken: null, reason: !record ? 'GRANT_INVALID' : record.claimed ? 'GRANT_CONSUMED' : 'AUTHORITY_KIND_MISMATCH' });
        }
        record.claimed = true;
        return Object.freeze({ ok: true, opaqueToken: record.opaqueToken, reason: 'NONE' });
    }

    function createCapabilitySnapshot({ binding, evidenceEpoch, capabilities = {} } = {}) {
        if (!isAuthorityBinding(binding) || !validInteger(evidenceEpoch) || !capabilities || typeof capabilities !== 'object') {
            return Object.freeze({ ok: false, snapshot: null, reason: 'CAPABILITY_SNAPSHOT_INVALID' });
        }
        const normalized = {};
        for (const name of CAPABILITY_NAMES) {
            const state = capabilities[name];
            normalized[name] = CAPABILITY_STATES.has(state) ? state : CapabilityState.UNKNOWN;
        }
        const snapshot = Object.freeze({
            binding: Object.freeze({ ...binding }),
            evidenceEpoch,
            capabilities: Object.freeze(normalized)
        });
        return Object.freeze({ ok: true, snapshot, reason: 'NONE' });
    }

    const PATH_DEPENDENCIES = Object.freeze({
        BOOTSTRAP: Object.freeze(['bootstrapRead', 'targetIdentity', 'mainContentOwnership', 'playerTiming']),
        BOOTSTRAP_RESPONSE: Object.freeze(['replayMessages', 'sequentialRead']),
        SEQUENTIAL: Object.freeze(['sequentialRead', 'targetIdentity', 'mainContentOwnership', 'playerTiming']),
        SEQUENTIAL_RESPONSE: Object.freeze(['replayMessages', 'sequentialRead']),
        BUFFER_RESUME: Object.freeze(['sequentialRead', 'targetIdentity', 'mainContentOwnership', 'playerTiming']),
        EARLY_RESUME: Object.freeze(['sequentialRead', 'targetIdentity', 'mainContentOwnership', 'playerTiming']),
        REANCHOR: Object.freeze(['reanchorRead', 'targetIdentity', 'mainContentOwnership', 'playerTiming']),
        REANCHOR_RESPONSE: Object.freeze(['replayMessages', 'sequentialRead']),
        HIDDEN_RECOVERY: Object.freeze(['reanchorRead', 'targetIdentity', 'mainContentOwnership', 'playerTiming']),
        AD_RECOVERY: Object.freeze(['reanchorRead', 'targetIdentity', 'mainContentOwnership', 'playerTiming']),
        MEDIA_PAUSED_RESUME: Object.freeze(['targetIdentity', 'mainContentOwnership', 'playerTiming', 'sequentialRead'])
    });

    function canUseCapabilityPath(path, snapshot, currentBinding = null) {
        const required = PATH_DEPENDENCIES[path];
        if (!required || !snapshot || !isAuthorityBinding(snapshot.binding) ||
            (currentBinding && !authorityBindingsEqual(snapshot.binding, currentBinding))) {
            return Object.freeze({ allowed: false, reason: 'CAPABILITY_SNAPSHOT_INVALID', unavailable: Object.freeze([]) });
        }
        const unavailable = required.filter((name) => snapshot.capabilities?.[name] !== CapabilityState.SUPPORTED)
            .map((name) => Object.freeze({ name, state: CAPABILITY_STATES.has(snapshot.capabilities?.[name]) ? snapshot.capabilities[name] : CapabilityState.UNKNOWN }));
        return Object.freeze({
            allowed: unavailable.length === 0,
            reason: unavailable.length === 0 ? 'NONE' : 'CAPABILITY_REQUIRED_UNAVAILABLE',
            unavailable: Object.freeze(unavailable)
        });
    }

    function classifyForegroundHiddenDurationMs(elapsedMs) {
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'UNKNOWN';
        if (elapsedMs <= 5000) return 'VERY_SHORT';
        if (elapsedMs <= 30000) return 'SHORT';
        if (elapsedMs <= 120000) return 'MEDIUM';
        return 'LONG';
    }

    function evaluateForegroundRetainedDiagnosticEligibility(facts = {}) {
        const required = ['armed', 'captured', 'hiddenObserved', 'visibleObserved', 'bindingCurrent',
            'ownershipCurrent', 'capabilityAllowed', 'documentVisible', 'noAd', 'noSeek', 'noNavigation',
            'noReadRequest', 'noReanchorRequest', 'noDiagnosticConflict', 'noDiagnosticRequest',
            'controlStopped', 'tokenAvailable', 'contextAvailable'];
        if (facts.terminal === true || facts.requestCount !== 0) return Object.freeze({ allowed: false, reason: 'ALREADY_CONSUMED' });
        if (required.some((name) => facts[name] !== true)) {
            return Object.freeze({ allowed: false, reason: facts.bindingCurrent === false ? 'STALE_BINDING' : 'VISIBLE_PRECONDITION_FAILED' });
        }
        return Object.freeze({ allowed: true, reason: 'NONE' });
    }

    function evaluateForegroundRecoveryEligibility(facts = {}) {
        const requiredTrue = [
            'visible', 'replayTarget', 'lifecycleCurrent', 'revisionCurrent', 'targetCurrent',
            'authorityAvailable', 'authorityUnused', 'authorityBindingCurrent', 'authorityUnconsumed',
            'noAd', 'noSeek', 'ownershipCurrent', 'playerTimingValid', 'noRequestConflict',
            'capabilityAllowed', 'controlSuspendedHidden'
        ];
        for (const key of requiredTrue) {
            if (facts[key] !== true) return Object.freeze({ allowed: false, reason: key });
        }
        return Object.freeze({ allowed: true, reason: 'ELIGIBLE' });
    }

    function createReplayState(phase = ReplayPhase.STOPPED, suspendedReason = null, resumeTarget = null) {
        if (!PHASES.has(phase)) return null;
        if (phase !== ReplayPhase.SUSPENDED) {
            if (suspendedReason !== null || resumeTarget !== null) return null;
            return Object.freeze({ phase });
        }
        if (!SUSPEND_REASONS.has(suspendedReason)) return null;
        if (suspendedReason === SuspendedReason.MEDIA_PAUSED) {
            if (![ReplayPhase.READING, ReplayPhase.BUFFER_PAUSED].includes(resumeTarget)) return null;
            return Object.freeze({ phase, suspendedReason, resumeTarget });
        }
        if (resumeTarget !== null) return null;
        return Object.freeze({ phase, suspendedReason });
    }

    function result(nextState, authorityAction = 'NONE', pendingAction = 'NONE', requestIntent = 'NONE', failure = 'NONE') {
        return Object.freeze({ nextState, authorityAction, pendingAction, requestIntent, failure });
    }

    function noOp(state) {
        return result(state, AuthorityAction.KEEP, PendingAction.KEEP, RequestIntent.NONE, TransitionFailure.NO_OP);
    }

    function stopped(failure = TransitionFailure.NONE) {
        return result(createReplayState(ReplayPhase.STOPPED), AuthorityAction.INVALIDATE_ALL, PendingAction.CLEAR, RequestIntent.NONE, failure);
    }

    function reduceReplayControlState(state, event, facts = {}) {
        if (!state || !PHASES.has(state.phase) || !EVENTS.has(event)) {
            return stopped(TransitionFailure.FORBIDDEN_EVENT);
        }
        if (event === ReplayEvent.PLAYBACK_RATE_CHANGED) return noOp(state);
        if (['NAVIGATION', 'TARGET_CHANGED', 'DISABLE', 'GENERATION_INVALIDATED'].includes(event)) {
            return stopped(TransitionFailure.NONE);
        }
        if (event === ReplayEvent.CAPABILITY_LOST) {
            return facts.optional === true ? noOp(state) : stopped(TransitionFailure.CAPABILITY_REQUIRED_UNAVAILABLE);
        }
        if (event === ReplayEvent.AUTHORITY_FAILURE) return stopped(TransitionFailure.AUTHORITY_FAILURE);
        if (event === ReplayEvent.HIDDEN_ENTER) {
            if (state.phase === ReplayPhase.STOPPED) return noOp(state);
            return result(createReplayState(ReplayPhase.SUSPENDED, SuspendedReason.HIDDEN), AuthorityAction.RETAIN_ELIGIBLE_REANCHOR, PendingAction.CLEAR);
        }
        if (event === ReplayEvent.AD_ENTER) {
            if (state.phase === ReplayPhase.STOPPED) return noOp(state);
            if (state.phase === ReplayPhase.SUSPENDED && state.suspendedReason === SuspendedReason.HIDDEN) return noOp(state);
            return result(createReplayState(ReplayPhase.SUSPENDED, SuspendedReason.AD), AuthorityAction.INVALIDATE_ALL, PendingAction.CLEAR);
        }

        switch (state.phase) {
        case ReplayPhase.STOPPED:
            if (event === ReplayEvent.LIFECYCLE_START) return result(createReplayState(ReplayPhase.BOOTSTRAPPING), AuthorityAction.NONE, PendingAction.CLEAR);
            return event === ReplayEvent.DISABLE ? stopped() : result(state, AuthorityAction.NONE, PendingAction.NONE, RequestIntent.NONE, TransitionFailure.FORBIDDEN_EVENT);
        case ReplayPhase.BOOTSTRAPPING:
            if (event === ReplayEvent.BOOTSTRAP_AUTHORIZED) return result(state, AuthorityAction.KEEP, PendingAction.KEEP, RequestIntent.REQUEST_BOOTSTRAP);
            if (event === ReplayEvent.BOOTSTRAP_SUCCEEDED) return result(createReplayState(ReplayPhase.READING), AuthorityAction.ACCEPT_FRESH_SEQUENTIAL, PendingAction.RECLASSIFY);
            if (event === ReplayEvent.INITIAL_ALIGNMENT_REQUIRED) return result(createReplayState(ReplayPhase.REANCHORING), AuthorityAction.INVALIDATE_ACTIVE, PendingAction.CLEAR);
            if (['BOOTSTRAP_FAILED', 'SEEK_STARTED', 'SEEK_COMPLETED'].includes(event)) return stopped();
            break;
        case ReplayPhase.READING:
            if (event === ReplayEvent.SEQUENTIAL_AUTHORIZED) return result(state, AuthorityAction.KEEP, PendingAction.KEEP, RequestIntent.REQUEST_SEQUENTIAL);
            if (event === ReplayEvent.SEQUENTIAL_SUCCEEDED) return result(state, AuthorityAction.ACCEPT_FRESH_SEQUENTIAL, PendingAction.RECLASSIFY);
            if (event === ReplayEvent.BUFFER_HIGH_WATERMARK) return result(createReplayState(ReplayPhase.BUFFER_PAUSED), AuthorityAction.SAVE_SEQUENTIAL, PendingAction.KEEP);
            if (event === ReplayEvent.EARLY_RESUME_COMPLETED) return result(createReplayState(ReplayPhase.BUFFER_PAUSED), AuthorityAction.SAVE_SEQUENTIAL, PendingAction.KEEP);
            if (['SEEK_STARTED', 'SEEK_COMPLETED'].includes(event)) return result(createReplayState(ReplayPhase.REANCHORING), AuthorityAction.INVALIDATE_ACTIVE, PendingAction.CLEAR);
            if (event === ReplayEvent.REANCHOR_AUTHORIZED) return result(createReplayState(ReplayPhase.REANCHORING), AuthorityAction.INVALIDATE_ACTIVE, PendingAction.CLEAR, RequestIntent.REQUEST_REANCHOR);
            if (event === ReplayEvent.MEDIA_PAUSE) return result(createReplayState(ReplayPhase.SUSPENDED, SuspendedReason.MEDIA_PAUSED, ReplayPhase.READING), AuthorityAction.KEEP, PendingAction.KEEP);
            if (event === ReplayEvent.SEQUENTIAL_FAILED) return stopped();
            break;
        case ReplayPhase.BUFFER_PAUSED:
            if ([ReplayEvent.BUFFER_LOW_WATERMARK, ReplayEvent.EARLY_RESUME_ELIGIBLE].includes(event)) {
                return result(createReplayState(ReplayPhase.READING), AuthorityAction.RESTORE_SAVED, PendingAction.KEEP, RequestIntent.REQUEST_SEQUENTIAL);
            }
            if (['SEEK_STARTED', 'SEEK_COMPLETED'].includes(event)) return result(createReplayState(ReplayPhase.REANCHORING), AuthorityAction.INVALIDATE_ALL, PendingAction.CLEAR);
            if (event === ReplayEvent.MEDIA_PAUSE) return result(createReplayState(ReplayPhase.SUSPENDED, SuspendedReason.MEDIA_PAUSED, ReplayPhase.BUFFER_PAUSED), AuthorityAction.KEEP, PendingAction.KEEP);
            if (event === ReplayEvent.SEQUENTIAL_FAILED) return stopped();
            break;
        case ReplayPhase.REANCHORING:
            if (event === ReplayEvent.REANCHOR_AUTHORIZED) return result(state, AuthorityAction.KEEP, PendingAction.CLEAR, RequestIntent.REQUEST_REANCHOR);
            if (event === ReplayEvent.REANCHOR_SUCCEEDED) return result(createReplayState(ReplayPhase.READING), AuthorityAction.ACCEPT_FRESH_SEQUENTIAL, PendingAction.RECLASSIFY);
            if (event === ReplayEvent.SEEK_STARTED || event === ReplayEvent.SEEK_COMPLETED) return result(state, AuthorityAction.INVALIDATE_ACTIVE, PendingAction.CLEAR);
            if (event === ReplayEvent.REANCHOR_FAILED) return stopped();
            break;
        case ReplayPhase.SUSPENDED:
            if (state.suspendedReason === SuspendedReason.HIDDEN) {
                if (event === ReplayEvent.VISIBLE_ENTER) {
                    return facts.adActive === true
                        ? result(createReplayState(ReplayPhase.SUSPENDED, SuspendedReason.AD), AuthorityAction.INVALIDATE_ALL, PendingAction.CLEAR)
                        : facts.recoveryEligible === true
                            ? result(createReplayState(ReplayPhase.REANCHORING), AuthorityAction.KEEP, PendingAction.CLEAR)
                            : stopped(TransitionFailure.AUTHORITY_FAILURE);
                }
                if (['MEDIA_PAUSE', 'SEEK_STARTED', 'SEEK_COMPLETED'].includes(event)) return noOp(state);
            } else if (state.suspendedReason === SuspendedReason.AD) {
                if (event === ReplayEvent.AD_EXIT_READY) {
                    return facts.hidden === true
                        ? result(createReplayState(ReplayPhase.SUSPENDED, SuspendedReason.HIDDEN), AuthorityAction.INVALIDATE_ALL, PendingAction.CLEAR)
                        : result(createReplayState(ReplayPhase.REANCHORING), AuthorityAction.INVALIDATE_ACTIVE, PendingAction.CLEAR);
                }
                if (['MEDIA_PAUSE', 'SEEK_STARTED', 'SEEK_COMPLETED'].includes(event)) return noOp(state);
            } else if (state.suspendedReason === SuspendedReason.MEDIA_PAUSED) {
                if (event === ReplayEvent.MEDIA_PLAY) return result(createReplayState(state.resumeTarget), AuthorityAction.KEEP, PendingAction.KEEP);
                if (event === ReplayEvent.SEEK_STARTED || event === ReplayEvent.SEEK_COMPLETED) return result(createReplayState(ReplayPhase.REANCHORING), AuthorityAction.INVALIDATE_ALL, PendingAction.CLEAR);
            }
            break;
        }
        return result(state, AuthorityAction.NONE, PendingAction.NONE, RequestIntent.NONE, TransitionFailure.FORBIDDEN_EVENT);
    }

    function evaluateInitialReplayAlignment({ targetOffsetMsec, coverage, reanchorEligible, attempted } = {}) {
        if (!Number.isSafeInteger(targetOffsetMsec) || targetOffsetMsec < 0) {
            return Object.freeze({ action: 'HOLD', reason: 'PLAYER_TIMING_UNKNOWN' });
        }
        if (targetOffsetMsec === 0 || coverage === 'ALIGNED') {
            return Object.freeze({ action: 'COMMIT_BOOTSTRAP', reason: 'ALIGNED' });
        }
        if (coverage !== 'OUTSIDE' && coverage !== 'UNKNOWN') {
            return Object.freeze({ action: 'HOLD', reason: 'COVERAGE_UNKNOWN' });
        }
        if (attempted === true) return Object.freeze({ action: 'HOLD', reason: 'ATTEMPT_USED' });
        if (reanchorEligible !== true) return Object.freeze({ action: 'HOLD', reason: 'AUTHORITY_UNAVAILABLE' });
        return Object.freeze({ action: 'ALIGN_ONCE', reason: coverage });
    }

    function retainSequentialAuthorityForMediaPause(savedAuthority, observedAuthority) {
        return savedAuthority || observedAuthority || null;
    }

    function createShadowController(initialState = createReplayState(ReplayPhase.STOPPED)) {
        let state = initialState || createReplayState(ReplayPhase.STOPPED);
        let transitionCount = 0;
        let mismatchCount = 0;
        let latestMismatch = ShadowMismatch.NONE;
        function dispatch(event, facts = {}, legacyPhase = null) {
            const transition = reduceReplayControlState(state, event, facts);
            transitionCount += 1;
            if (transition.failure !== TransitionFailure.FORBIDDEN_EVENT) state = transition.nextState;
            if (legacyPhase && PHASES.has(legacyPhase) && legacyPhase !== state.phase) {
                latestMismatch = ShadowMismatch.PHASE_MISMATCH;
                mismatchCount += 1;
            } else if (transition.failure === TransitionFailure.FORBIDDEN_EVENT) {
                latestMismatch = ShadowMismatch.FORBIDDEN_LEGACY_TRANSITION;
                mismatchCount += 1;
            } else latestMismatch = ShadowMismatch.NONE;
            return status();
        }
        function status() {
            return Object.freeze({
                shadowPhase: state.phase,
                shadowSuspendedReason: state.suspendedReason || 'NONE',
                shadowResumeTarget: state.resumeTarget || 'NONE',
                transitionCount,
                mismatchCount,
                latestMismatch
            });
        }
        function compareCapability(path, snapshot, currentBinding, legacyAllowed) {
            const evaluation = canUseCapabilityPath(path, snapshot, currentBinding);
            if (evaluation.allowed !== (legacyAllowed === true)) {
                latestMismatch = ShadowMismatch.CAPABILITY_PATH_MISMATCH;
                mismatchCount += 1;
            }
            return Object.freeze({ shadowAllowed: evaluation.allowed, legacyAllowed: legacyAllowed === true });
        }
        return Object.freeze({ dispatch, status, compareCapability });
    }

    const api = Object.freeze({
        AuthorityKind, AuthorityState, ReplayPhase, SuspendedReason, CapabilityState, CapabilityName,
        ReplayEvent, AuthorityAction, PendingAction, RequestIntent, TransitionFailure, ShadowMismatch,
        PATH_DEPENDENCIES, createAuthorityBinding, isAuthorityBinding, authorityBindingsEqual,
        createReplayAuthority, transitionAuthority, invalidateAuthority, authorityDiagnostic,
        createConsumedAuthorityRegistry, authorizeAuthorityRequest, inspectAuthorityRequestEligibility, claimAuthorityRequestGrant,
        createCapabilitySnapshot, canUseCapabilityPath, classifyForegroundHiddenDurationMs,
        evaluateForegroundRetainedDiagnosticEligibility,
        evaluateForegroundRecoveryEligibility,
        createReplayState, reduceReplayControlState, evaluateInitialReplayAlignment,
        retainSequentialAuthorityForMediaPause, createShadowController
    });

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowReplayControlPlaneCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
