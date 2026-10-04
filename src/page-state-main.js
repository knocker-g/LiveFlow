(function () {
    const REQUEST_TYPE = 'LIVEFLOW_REQUEST_INITIAL_CHAT_CONTINUATION';
    const RESPONSE_TYPE = 'LIVEFLOW_INITIAL_CHAT_CONTINUATION';
    const READ_REQUEST_TYPE = 'LIVEFLOW_REQUEST_CHAT_READ_ONCE';
    const READ_RESPONSE_TYPE = 'LIVEFLOW_CHAT_READ_ONCE_RESULT';
    const STOP_READ_LOOP_TYPE = 'LIVEFLOW_STOP_CHAT_READ_LOOP';
    const RESUME_READ_LOOP_TYPE = 'LIVEFLOW_RESUME_CHAT_READ_AFTER_VISIBILITY';
    const NAVIGATION_INVALIDATED_TYPE = 'LIVEFLOW_PAGE_LIFECYCLE_INVALIDATED';
    const LIFECYCLE_DIAGNOSTIC_TYPE = 'LIVEFLOW_READ_LIFECYCLE_DIAGNOSTIC';
    const REPLAY_DISPLAYED_TYPE = 'LIVEFLOW_REPLAY_DANMAKU_DISPLAYED';
    const REPLAY_AD_ENTER_TYPE = 'LIVEFLOW_REPLAY_AD_ENTER';
    const REPLAY_AD_EXIT_TYPE = 'LIVEFLOW_REPLAY_AD_EXIT';
    const REPLAY_PIPELINE_DIAGNOSTIC_TYPE = 'LIVEFLOW_REPLAY_PIPELINE_DIAGNOSTIC';
    let pageRevision = 0;
    let pageKey = '';
    let pageState = { continuation: '', context: null, targetIdentity: '', bootstrapTargetMatched: false, mode: 'unknown' };
    let readAttemptedRevision = -1;
    let readCount = 0;
    let currentLoopGeneration = 0;
    let activeLoopGeneration = 0;
    let activeAbortController = null;
    let activeWaitTimer = null;
    let readRequestInFlight = false;
    let pageLifecycleGeneration = 0;
    let navigationPending = false;
    let navigationPageDataUpdated = false;
    let navigationCompletionTargetIdentity = '';
    let deferredReadStartGeneration = null;
    let replayBootstrapAuthority = null;
    let replayBootstrapEligibilityLifecycleId = -1;
    let lastEstablishedWatchRoot = null;
    let lastEstablishedVideo = null;
    let establishedTargetIdentity = '';
    let invalidatedTargetIdentity = '';
    let observedWatchRoot = null;
    let watchRootObserver = null;
    let ownershipReevaluationQueued = false;
    let readStopReason = 'none';
    let deferredVisibilityResumeGeneration = null;
    let runtimeUserEnabled = true;
    let replayPending = [];
    let replayStartTimeSeconds = 0;
    let replayAcquisitionPausedForBuffer = false;
    const REPLAY_MAX_PENDING = 100;
    const REPLAY_REQUEST_TIMEOUT_MS = 15000;
    const REPLAY_RESTART_REASONS = new Set(['SEEK', 'RESUME', 'ENABLE', 'RATE_CHANGE', 'OTHER']);
    const REPLAY_RESTART_STAGES = new Set(['IDLE', 'WAITING_MEDIA', 'WAITING_FRAME_ROLE', 'WAITING_SNAPSHOT', 'BOOTSTRAP_READY', 'REQUESTING', 'RESPONSE_ACCEPTED', 'ADVANCING_STALE', 'CURRENT_WINDOW_REACHED', 'LAUNCH_READY', 'FAILED_CLOSED']);
    const REPLAY_STOP_REASONS = new Set(['NONE', 'PAUSED', 'SEEKING', 'DISABLED', 'HIDDEN', 'STALE_GENERATION', 'FRAME_ROLE_UNAVAILABLE', 'SNAPSHOT_UNAVAILABLE', 'NON_2XX', 'INVALID_RESPONSE', 'BUFFER_BOUND', 'NO_CURRENT_MESSAGES', 'OTHER']);
    let replayRestartSequence = 0;
    let replayRestartDiagnostic = createReplayRestartDiagnostic();
    let replayCredentiallessSchemaDiagnostic = createReplayCredentiallessSchemaDiagnostic();
    let replayPlayerSeekDiagnostic = createReplayPlayerSeekDiagnostic();
    let replayPlayerSeekDiagnosticAbortController = null;
    let replayPlayerSeekDiagnosticLock = false;
    let replaySeekAuthority = null;
    let replayReanchorLock = false;
    let replayReanchorAbortController = null;
    let replaySeekEpoch = 0;
    let replaySeekInProgress = false;
    let replaySeekNeedsReanchor = false;
    let replayLastAttemptedSeekEpoch = -1;
    let replayInitialAlignmentAttemptedLifecycleId = -1;
    let replayAdActive = false;
    let replayAdExitNeedsReanchor = false;
    const REPLAY_REANCHOR_FAILURE_REASONS = new Set(['NONE', 'NO_AUTHORITY', 'AUTHORITY_STALE', 'RELATION_ALL_BEFORE', 'RELATION_UNKNOWN', 'REANCHOR_SCHEMA_INVALID', 'NO_FRESH_CHAIN', 'OTHER']);
    let replayProductionReanchorReason = 'NONE';
    let replayPipelineDiagnostic = createReplayPipelineDiagnostic();
    let replayTemporalStarvationDiagnostic = createReplayTemporalStarvationDiagnostic();
    let replayGapOriginDiagnostic = createReplayGapOriginDiagnostic();
    let replayGapEvidence = window.LiveFlowChatReadCore?.createReplayGapEvidenceState?.() || null;
    let replayGapPersistence = window.LiveFlowChatReadCore?.createReplayGapPersistenceState?.() || {
        acquisitionLeadConsecutive: 0, farFutureResponseConsecutive: 0
    };
    let replayTemporalLeadShadowDiagnostic = createReplayTemporalLeadShadowDiagnostic();
    let replayEarlyResumeCoverageBefore = null;
    let replayPressureEpisodeActive = false;
    let replayEpisodeAdvancedBudgetUsed = 0;
    let replayEarlyResumeCompleted = false;
    let replayTimingDiagnosticSeen = createReplayTimingDiagnosticSeen();
    let replayAwaitingFirstFreshSequentialResponse = false;
    let replayPausedSequentialAuthority = null;
    let replayObservedSequentialAuthority = null;
    let replaySequentialResumeHandoff = false;
    let replayEarlyResumeSuppressionState = 'CLEAR';
    let replayRunwayDepletionEpisodeState = 'UNKNOWN';
    let replayTemporalWakeTimer = null;
    let replayTemporalWakeSequence = 0;
    let replayPreviousSequentialMessages = null;
    let replayForegroundRetainedDiagnostic = createReplayForegroundRetainedDiagnostic();
    let replayForegroundRetainedAbortController = null;
    let replayForegroundRecoveryDiagnostic = createReplayForegroundRecoveryDiagnostic();
    let replayForegroundRecoveryOwnedVideo = null;
    const replayControlPlaneCore = window.LiveFlowReplayControlPlaneCore;
    const replayControlShadow = replayControlPlaneCore?.createShadowController?.() || null;
    let replayProductionControlState = replayControlPlaneCore?.createReplayState?.('STOPPED') || null;
    let replayConsumedAuthorityRegistry = replayControlPlaneCore?.createConsumedAuthorityRegistry?.() || null;

    function observeReplayControlShadow(event, facts = {}, legacyPhase = null) {
        const productionTransition = replayControlPlaneCore?.reduceReplayControlState?.(
            replayProductionControlState, event, facts
        );
        if (productionTransition && productionTransition.failure !== 'FORBIDDEN_EVENT') {
            replayProductionControlState = productionTransition.nextState;
        }
        return replayControlShadow?.dispatch?.(event, facts, legacyPhase) || null;
    }

    function currentReplayAuthorityBinding(generation = currentLoopGeneration) {
        return replayControlPlaneCore?.createAuthorityBinding?.({
            lifecycleId: pageLifecycleGeneration,
            revision: pageRevision,
            targetId: pageState.targetIdentity,
            generation
        })?.binding || null;
    }

    function savedSequentialDiagnostic(binding = currentReplayAuthorityBinding()) {
        return replayPausedSequentialAuthority?.diagnostic?.(binding) || null;
    }

    function authorizeReplayAuthority(authority, expectedKind, binding, expectedActiveGeneration) {
        if (replayProductionControlState?.phase === 'SUSPENDED' || !binding || !replayConsumedAuthorityRegistry || readRequestInFlight ||
            activeLoopGeneration !== expectedActiveGeneration ||
            replayReanchorLock || replayPlayerSeekDiagnosticLock) return null;
        const grantResult = replayControlPlaneCore?.authorizeAuthorityRequest?.({
            authority,
            expectedKind,
            currentBinding: binding,
            consumedRegistry: replayConsumedAuthorityRegistry
        });
        return grantResult?.ok === true ? grantResult.grant : null;
    }

    function authorizeSequentialAuthority(authority, binding, expectedActiveGeneration) {
        return authorizeReplayAuthority(authority, 'SEQUENTIAL', binding, expectedActiveGeneration);
    }

    function authorizeSavedSequentialResume() {
        return authorizeSequentialAuthority(replayPausedSequentialAuthority, currentReplayAuthorityBinding(), 0);
    }

    function createSequentialAuthorityCandidate(opaqueToken, binding) {
        return replayControlPlaneCore?.createReplayAuthority?.({
            kind: 'SEQUENTIAL', opaqueToken, binding, provenance: 'ADAPTER_SEQUENTIAL'
        })?.authority || null;
    }

    function acceptReplayBootstrapCandidate(opaqueToken) {
        if (replayBootstrapEligibilityLifecycleId === pageLifecycleGeneration) return false;
        replayBootstrapEligibilityLifecycleId = pageLifecycleGeneration;
        const binding = currentReplayAuthorityBinding();
        replayBootstrapAuthority = replayControlPlaneCore?.createReplayAuthority?.({
            kind: 'BOOTSTRAP', opaqueToken, binding, provenance: 'ADAPTER_BOOTSTRAP'
        })?.authority || null;
        return Boolean(replayBootstrapAuthority);
    }

    function startReplayBootstrap(requestedLifecycleGeneration) {
        if (requestedLifecycleGeneration !== pageLifecycleGeneration || pageState.mode !== 'replay' ||
            replayBootstrapEligibilityLifecycleId !== pageLifecycleGeneration) return false;
        const binding = currentReplayAuthorityBinding();
        const grant = authorizeReplayAuthority(replayBootstrapAuthority, 'BOOTSTRAP', binding, 0);
        if (!grant) {
            observeReplayControlShadow('BOOTSTRAP_FAILED');
            setReplayRestartStage('FAILED_CLOSED', 'OTHER');
            return false;
        }
        const video = getCurrentMainVideo();
        const snapshot = replayControlPlaneCore?.createCapabilitySnapshot?.({
            binding, evidenceEpoch: pageRevision,
            capabilities: {
                bootstrapRead: 'SUPPORTED',
                targetIdentity: isCurrentPageStateTarget() ? 'SUPPORTED' : 'UNKNOWN',
                mainContentOwnership: video && video === getCurrentMainVideo() ? 'SUPPORTED' : 'UNKNOWN',
                playerTiming: Number.isFinite(video?.currentTime) ? 'SUPPORTED' : 'UNKNOWN'
            }
        })?.snapshot;
        if (snapshot) replayControlShadow?.compareCapability?.('BOOTSTRAP', snapshot, binding, true);
        startReadLoop(requestedLifecycleGeneration, 'INITIAL_WATCH', grant);
        return true;
    }

    function invalidateAuthorityHandle(authority) {
        if (authority?.diagnostic?.()?.authorityState === 'OBSERVED_UNUSED') {
            replayControlPlaneCore?.invalidateAuthority?.(authority);
        }
    }

    function createReplayForegroundRetainedDiagnostic() {
        return {
            armed: false, captured: false, hiddenObserved: false, visibleObserved: false,
            durationClass: 'UNKNOWN', requestStarted: false, requestCount: 0, result: 'NOT_ARMED',
            bindingCurrent: false, ownershipCurrent: false, responseValidated: false,
            relationAccepted: false, freshSequentialObserved: false, additionalRequests: 0,
            opaqueToken: '', lifecycleGeneration: -1, revision: -1, targetIdentity: '', readGeneration: -1,
            hiddenAt: null, terminal: false
        };
    }

    function createReplayForegroundRecoveryDiagnostic() {
        return {
            retainedAtHidden: false,
            retainedCurrentAtVisible: false,
            foregroundRecoveryStarted: false,
            foregroundRecoveryResult: 'NOT_ATTEMPTED',
            freshSequentialHandoff: false
        };
    }

    function replayForegroundRecoveryStatus() {
        return Object.freeze({ ...replayForegroundRecoveryDiagnostic });
    }

    function replayForegroundRetainedStatus() {
        const diagnostic = replayForegroundRetainedDiagnostic;
        return Object.freeze({
            armed: diagnostic.armed, captured: diagnostic.captured,
            hiddenObserved: diagnostic.hiddenObserved, visibleObserved: diagnostic.visibleObserved,
            durationClass: diagnostic.durationClass, requestStarted: diagnostic.requestStarted,
            requestCount: diagnostic.requestCount, result: diagnostic.result,
            bindingCurrent: diagnostic.bindingCurrent, ownershipCurrent: diagnostic.ownershipCurrent,
            responseValidated: diagnostic.responseValidated, relationAccepted: diagnostic.relationAccepted,
            freshSequentialObserved: diagnostic.freshSequentialObserved,
            additionalRequests: diagnostic.additionalRequests
        });
    }

    function classifyForegroundHiddenDuration(hiddenAt) {
        if (!Number.isFinite(hiddenAt)) return 'UNKNOWN';
        const elapsed = performance.now() - hiddenAt;
        return replayControlPlaneCore?.classifyForegroundHiddenDurationMs?.(elapsed) || 'UNKNOWN';
    }

    function captureReplayForegroundRetainedCandidate(payload, { mode, revision, generation, abortController, playerOffsetMs } = {}) {
        const diagnostic = replayForegroundRetainedDiagnostic;
        if (!diagnostic.armed || diagnostic.captured || diagnostic.terminal || playerOffsetMs !== null ||
            mode !== 'replay' || revision !== pageRevision || generation !== currentLoopGeneration ||
            abortController?.signal?.aborted === true || navigationPending || document.hidden || replayAdActive ||
            replaySeekInProgress || !isCurrentPageStateTarget()) return false;
        const video = getCurrentMainVideo();
        if (!video || video.paused || video.ended || video.seeking || !Number.isFinite(video.currentTime)) return false;
        const token = window.LiveFlowChatReadCore?.extractPlayerSeekContinuation?.(payload) || '';
        if (!token || replayConsumedAuthorityRegistry?.has?.(token)) return false;
        diagnostic.captured = true;
        diagnostic.opaqueToken = token;
        diagnostic.lifecycleGeneration = pageLifecycleGeneration;
        diagnostic.revision = pageRevision;
        diagnostic.targetIdentity = pageState.targetIdentity;
        diagnostic.readGeneration = generation;
        diagnostic.bindingCurrent = true;
        diagnostic.ownershipCurrent = true;
        diagnostic.result = 'CAPTURED';
        return true;
    }

    function observeReplayForegroundHidden() {
        const diagnostic = replayForegroundRetainedDiagnostic;
        if (!diagnostic.armed || !diagnostic.captured || diagnostic.terminal) return;
        diagnostic.hiddenObserved = true;
        diagnostic.visibleObserved = false;
        diagnostic.hiddenAt = performance.now();
        diagnostic.durationClass = 'UNKNOWN';
        diagnostic.result = 'HIDDEN_OBSERVED';
    }

    function observeReplayForegroundVisible() {
        const diagnostic = replayForegroundRetainedDiagnostic;
        if (!diagnostic.armed || !diagnostic.captured || !diagnostic.hiddenObserved || diagnostic.terminal) return;
        diagnostic.visibleObserved = true;
        diagnostic.durationClass = classifyForegroundHiddenDuration(diagnostic.hiddenAt);
    }

    function terminateReplayForegroundRetainedDiagnostic(result, abort = false) {
        const diagnostic = replayForegroundRetainedDiagnostic;
        if (!diagnostic.armed && !diagnostic.captured && !diagnostic.requestStarted) return;
        if (abort && replayForegroundRetainedAbortController) replayForegroundRetainedAbortController.abort();
        replayForegroundRetainedAbortController = null;
        diagnostic.opaqueToken = '';
        diagnostic.armed = false;
        diagnostic.terminal = true;
        diagnostic.result = result;
    }

    function enterReplaySuspended(reason) {
        if (pageState.mode !== 'replay' || !['HIDDEN', 'AD'].includes(reason)) return false;
        const effectiveReason = document.hidden || replayProductionControlState?.suspendedReason === 'HIDDEN' ? 'HIDDEN' : reason;
        const hiddenOwnedVideo = effectiveReason === 'HIDDEN' ? getCurrentMainVideo() : null;
        const retainReanchor = effectiveReason === 'HIDDEN' && replaySeekAuthorityEligibleForHidden(hiddenOwnedVideo);
        invalidateAuthorityHandle(replayBootstrapAuthority);
        replayBootstrapAuthority = null;
        invalidateAuthorityHandle(replayPausedSequentialAuthority);
        if (effectiveReason === 'HIDDEN') {
            const rehiddenRecovery = replayForegroundRecoveryDiagnostic.foregroundRecoveryStarted &&
                replayForegroundRecoveryDiagnostic.foregroundRecoveryResult !== 'SUCCESS';
            replayForegroundRecoveryDiagnostic = createReplayForegroundRecoveryDiagnostic();
            replayForegroundRecoveryDiagnostic.retainedAtHidden = retainReanchor;
            replayForegroundRecoveryOwnedVideo = retainReanchor ? hiddenOwnedVideo : null;
            if (rehiddenRecovery) replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'REHIDDEN_ABORTED';
            observeReplayForegroundHidden();
            if (!retainReanchor) {
                invalidateAuthorityHandle(replaySeekAuthority);
                replaySeekAuthority = null;
            }
            replayReanchorIntent = null;
            replaySeekInProgress = false;
            replaySeekNeedsReanchor = false;
            replayAdExitNeedsReanchor = false;
            if (replayReanchorAbortController) replayReanchorAbortController.abort();
            replayReanchorAbortController = null;
            if (replayForegroundRetainedAbortController) replayForegroundRetainedAbortController.abort();
        } else if (replayForegroundRecoveryDiagnostic.foregroundRecoveryStarted) {
            invalidateAuthorityHandle(replaySeekAuthority);
            replaySeekAuthority = null;
            replayForegroundRecoveryOwnedVideo = null;
            replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'AD_ACTIVE';
        }
        stopReadLoop(effectiveReason === 'HIDDEN' ? 'visibility-hidden' : 'ad-enter');
        observeReplayControlShadow(effectiveReason === 'HIDDEN' ? 'HIDDEN_ENTER' : 'AD_ENTER');
        return true;
    }

    function observeSuspendedRecoveryCapabilities() {
        const binding = currentReplayAuthorityBinding();
        if (!binding) return;
        const video = getCurrentMainVideo();
        const snapshot = replayControlPlaneCore?.createCapabilitySnapshot?.({
            binding, evidenceEpoch: pageRevision,
            capabilities: {
                reanchorRead: replaySeekAuthorityIsCurrent() ? 'SUPPORTED' : 'UNKNOWN',
                targetIdentity: isCurrentPageStateTarget() ? 'SUPPORTED' : 'UNKNOWN',
                mainContentOwnership: video && video === getCurrentMainVideo() ? 'SUPPORTED' : 'UNKNOWN',
                playerTiming: Number.isFinite(video?.currentTime) ? 'SUPPORTED' : 'UNKNOWN'
            }
        })?.snapshot;
        if (snapshot) replayControlShadow?.compareCapability?.('REANCHOR', snapshot, binding, replaySeekAuthorityIsCurrent());
    }

    function failClosedSavedSequentialResume() {
        const binding = currentReplayAuthorityBinding();
        if (binding && savedSequentialDiagnostic(binding)?.authorityState === 'OBSERVED_UNUSED') {
            replayControlPlaneCore?.transitionAuthority?.(replayPausedSequentialAuthority, 'INVALIDATE', binding);
        }
        replayPausedSequentialAuthority = null;
        replayAcquisitionPausedForBuffer = false;
        replayPending = [];
        replaySequentialResumeHandoff = false;
        replayPipelineDiagnostic.bufferPauseActive = false;
        replayPipelineDiagnostic.unreadSequentialAuthorityAvailable = false;
        replayPipelineDiagnostic.bufferSavedContinuationState = 'INVALID';
        setReplayRestartStage('FAILED_CLOSED', 'OTHER');
    }

    window.LiveFlowReplayControlPlaneShadowDiagnostic = Object.freeze({
        status() {
            return replayControlShadow?.status?.() || Object.freeze({
                shadowPhase: 'STOPPED', shadowSuspendedReason: 'NONE', shadowResumeTarget: 'NONE',
                transitionCount: 0, mismatchCount: 0, latestMismatch: 'NONE'
            });
        }
    });

    function createReplayTimingDiagnosticSeen() {
        return { filtered: new Set(), future: new Set(), due: new Set(), capacityDropped: new Set() };
    }

    function createReplayPipelineDiagnostic() {
        return {
            responsesObserved: 0, receivedActions: 0, messagesObserved: 0, parseFailed: 0,
            timingFiltered: 0, timingPending: 0, timingCapacityDropped: 0,
            replayPendingPromoted: 0, replayPendingFlushCalls: 0, replayPendingFlushFromTimeupdate: 0,
            ownedVideoTimeupdateObserved: 0, timingDueObserved: 0, timingFutureObserved: 0,
            pendingAuthorityMismatch: 0, pendingGenerationMismatch: 0, bridged: 0, enqueued: 0,
            uniqueTimingFiltered: 0, uniqueTimingFutureBuffered: 0, uniqueTimingDue: 0, uniqueTimingCapacityDropped: 0,
            nearestFutureClass: 'NONE', reanchorTemporalCoverage: 'UNKNOWN',
            reanchorAccepted: false, reanchorAcceptedRelation: 'NONE', freshChainStarted: false,
            freshChainSource: 'NONE', currentWindowConfirmed: false, transportTemporalCoverageConfirmed: false,
            nearestBeforeTargetClass: 'UNKNOWN', nearestAfterTargetClass: 'UNKNOWN',
            targetBracketGapClass: 'UNKNOWN', currentWindowState: 'UNKNOWN', reanchorProductionState: 'NOT_OBSERVED',
            displayableNearestBeforeTargetClass: 'UNKNOWN', displayableNearestAfterTargetClass: 'UNKNOWN',
            displayableTargetBracketGapClass: 'UNKNOWN', displayableCurrentWindowState: 'UNKNOWN',
            displayableCurrentWindowConfirmed: false, reanchorTimestampedActionCount: 0,
            reanchorDisplayableMessageCount: 0, reanchorDisplayableBefore: 0, reanchorDisplayableDue: 0,
            reanchorDisplayableFuture: 0, freshSequentialResponseObserved: false,
            freshSequentialDisplayableMessageCount: 0, freshSequentialDisplayableBefore: 0,
            freshSequentialDisplayableDue: 0, freshSequentialDisplayableFuture: 0,
            freshSequentialDisplayableNearestBeforeTargetClass: 'UNKNOWN',
            freshSequentialDisplayableNearestAfterTargetClass: 'UNKNOWN', freshSequentialDisplayableTargetBracketGapClass: 'UNKNOWN',
            freshSequentialDisplayableCurrentWindowState: 'UNKNOWN', freshSequentialDisplayableCurrentWindowConfirmed: false,
            replayPendingRetainedFromPriorResponse: 0, replayPendingAddedFromCurrentResponse: 0,
            replayPendingCapacityDroppedCurrentMerge: 0,
            firstFreshSequentialPriorPendingRetained: 0, firstFreshSequentialPendingAdded: 0,
            firstFreshSequentialCapacityDropped: 0,
            sequentialResponsesProcessed: 0, sequentialContinuationProgress: 'UNKNOWN',
            sequentialContinuationAdvanced: 0, sequentialContinuationRepeated: 0,
            sequentialContinuationReturnedToSeen: 0, sequentialContinuationMissing: 0,
            sequentialTemporalProgress: 'UNKNOWN', sequentialTemporalCoverageProgress: 'UNKNOWN',
            sequentialContinuationSource: 'OTHER', continuationSeenSemantics: 'REQUEST_CONSUMED_ONLY',
            sequentialContinuationCandidateState: 'INVALID', bufferSavedContinuationState: 'NONE',
            bufferPauseActive: false, bufferResumeStarted: false, bufferPauseReason: 'OTHER',
            bufferPauseTemporalState: 'UNKNOWN', bufferPauseStartNearestFutureClass: 'NONE',
            futureGapWhileBufferPaused: false, unreadSequentialAuthorityAvailable: false,
            bufferResumeBlockedByCount: false,
            earlyResumeEligible: false, earlyResumeAttempted: false, earlyResumeStarted: false,
            earlyResumeSuppressed: false, earlyResumeAttemptedCount: 0, earlyResumeStartedCount: 0,
            earlyResumeSuppressedCount: 0, bufferPauseEpochCount: 0,
            earlyResumeSuppressionState: 'CLEAR', earlyResumeDecision: 'NOT_PAUSED',
            maxObservedSequentialInFlight: 0,
            reanchorTimestampedActionsObserved: false, reanchorReplayContinuationObserved: false,
            reanchorPlayerSeekContinuationObserved: false,
            launched: 0, firstLaunchObserved: false, pendingCurrent: 0, opportunitiesArmed: 0, opportunitiesEvaluated: 0,
            stalePruned: 0, selectionNone: 0, collisionBlocked: 0, geometryUnknown: 0, generationInvalidated: 0,
            geometryInvalidated: 0, launchCommitted: 0, collisionActiveDanmaku: 0, collisionSubtitle: 0,
            launchAttempted: 0, launchRejected: 0, visibilityFiltered: 0, enqueueRejected: 0,
            bridgeInput: 0, bridgeDeduped: 0, lifecycleDiscarded: 0,
            lifecycleDiscardedDisplayDisabled: 0, lifecycleDiscardedMediaMissing: 0,
            lifecycleDiscardedMediaPaused: 0, lifecycleDiscardedMediaEnded: 0,
            lifecycleDiscardedMediaNotReady: 0, lifecycleDiscardedAdShowing: 0,
            lifecycleDiscardedAdInterrupting: 0,
            collisionCandidateGeometry: 0, collisionNoUsableLane: 0, collisionOther: 0,
            staleAfterCollision: 0, staleAfterPacing: 0, staleAfterSelectionMiss: 0,
            staleAlreadyOnEnqueue: 0, staleOther: 0, selectionNoneNoPending: 0,
            selectionNoneCollisionBlocked: 0, selectionNoneNoEligible: 0,
            launchGapClass: 'NONE', launchGapCause: 'UNKNOWN', launchGapDuePending: false,
            launchGapEligibleCandidate: false, launchGapActiveDanmaku: false, launchGapCollisionBlocked: false,
            launchGapSchedulerState: 'IDLE', launchGapDensityLevel: 'NORMAL', launchGapNearestFutureClass: 'NONE',
            schedulerState: 'IDLE'
        };
    }

    function createReplayTemporalStarvationDiagnostic() {
        return {
            episodeActive: false, episodeIdClass: 'NONE', pauseReason: 'OTHER', lowWatermarkReached: false,
            bufferPausedNow: false,
            totalPendingClass: 'EMPTY', dueCountClass: 'ZERO', nearFutureCountClass: 'ZERO', nearestFutureClass: 'NONE',
            schedulerPending: false, schedulerLaunchable: false,
            savedSequentialAvailable: false, savedSequentialCurrent: false, savedSequentialUnused: false,
            earlyResumeAttempted: false, earlyResumeStarted: false, earlyResumeCompleted: false,
            earlyResumeProgressResult: 'UNKNOWN', rescueSuppressionReason: 'NONE',
            temporalStarvationKnown: false, temporalStarvationObserved: false,
            hypotheticalRescueEligible: false, hypotheticalRescueBlockedReason: 'NOT_IN_EPISODE',
            earlyResumeBudgetUsed: 0, hypotheticalRescueBudgetRemaining: 2,
            temporalRescueAttempted: false, temporalRescueStarted: false, temporalRescueCompleted: false,
            temporalRescueResult: 'DISABLED', episodeAdvancedBudgetUsed: 0,
            temporalRescueBudgetRemaining: 0, responseValidated: false, progressionValid: false,
            freshSequentialObserved: false, coverageResult: 'NOT_APPLICABLE', thirdRescueSuppressed: false,
            maxInflightObserved: 0
        };
    }

    function createReplayGapOriginDiagnostic() {
        return {
            acquisitionLeadClass: 'UNKNOWN', retainedNearestDistanceClass: 'UNKNOWN',
            responseFirstMessageRelation: 'UNKNOWN', responseLastMessageRelation: 'UNKNOWN',
            responseCoverageProgress: 'UNKNOWN', gapBandObserved: false,
            gapBandObservedDisposition: 'NEVER_OBSERVED', capacitySelectionNearestPreserved: 'UNKNOWN',
            gapOriginClass: 'UNKNOWN', evidenceStateClass: 'EMPTY'
        };
    }

    function observeReplayGapPersistence(responseShape) {
        replayGapPersistence = window.LiveFlowChatReadCore?.updateReplayGapPersistenceState?.(
            replayGapPersistence, responseShape
        ) || replayGapPersistence;
    }

    function resetReplayGapOriginDiagnostic() {
        replayGapOriginDiagnostic = createReplayGapOriginDiagnostic();
        replayGapEvidence = window.LiveFlowChatReadCore?.createReplayGapEvidenceState?.() || null;
        replayGapPersistence = window.LiveFlowChatReadCore?.createReplayGapPersistenceState?.() || {
            acquisitionLeadConsecutive: 0, farFutureResponseConsecutive: 0
        };
        replayTemporalLeadShadowDiagnostic = createReplayTemporalLeadShadowDiagnostic();
    }

    function replayGapOriginStatus() {
        const video = getCurrentMainVideo();
        const currentTime = video?.currentTime;
        const retainedNearestDistanceClass = Number.isFinite(currentTime)
            ? window.LiveFlowChatReadCore?.classifyNearestReplayFuture?.(replayPending, currentTime) || 'UNKNOWN'
            : 'UNKNOWN';
        const origin = window.LiveFlowChatReadCore?.summarizeReplayGapOrigin?.(replayGapEvidence) || {
            gapBandObserved: false, gapBandObservedDisposition: 'UNKNOWN', gapOriginClass: 'UNKNOWN'
        };
        return Object.freeze({
            ...replayGapOriginDiagnostic,
            retainedNearestDistanceClass,
            gapBandObserved: origin.gapBandObserved === true,
            gapBandObservedDisposition: origin.gapBandObservedDisposition || 'UNKNOWN',
            gapOriginClass: origin.gapOriginClass || 'UNKNOWN',
            gapObservedFiltered: replayGapEvidence?.filteredBeforeStart === true,
            gapObservedBridgedDue: replayGapEvidence?.bridgedDue === true,
            gapObservedCapacityDropped: replayGapEvidence?.capacityDropped === true,
            gapObservedExactIdDeduped: replayGapEvidence?.exactIdDeduped === true,
            gapObservedRetained: replayGapEvidence?.retained === true,
            gapObservedUnknown: replayGapEvidence?.unknownDisposition === true,
            gapBandScope: 'LIFECYCLE_WIDE_MOVING',
            movingBandAmbiguity: replayGapEvidence?.observationPasses > 0,
            acquisitionLeadPersistent: replayGapPersistence.acquisitionLeadConsecutive >= 2,
            responseFarFuturePersistent: replayGapPersistence.farFutureResponseConsecutive >= 2
        });
    }

    function createReplayTemporalLeadShadowDiagnostic() {
        return {
            shadowHoldWouldEnter: false, shadowHoldActive: false, shadowHoldWouldResume: false,
            shadowDecision: 'NO_HOLD', shadowBlockedReason: 'NONE', shadowEntryReason: 'NONE', shadowResumeReason: 'NONE',
            acquisitionLeadClass: 'UNKNOWN', acquisitionLeadPersistent: false, responseFarFuturePersistent: false,
            retainedNearestDistanceClass: 'UNKNOWN', pendingClass: 'UNKNOWN', retainedFutureAvailable: false,
            temporalFactsKnown: false, hypotheticalSuppressedRequestCountClass: 'ZERO', holdObservationClass: 'ZERO',
            authorityAvailableDuringHold: false, authorityCurrentDuringHold: false, authorityStillCurrentAtResume: false,
            suppressedRequestObservations: 0, holdObservations: 0
        };
    }

    function updateReplayTemporalLeadShadowDiagnostic() {
        const gap = replayGapOriginStatus();
        const authority = savedSequentialDiagnostic();
        const priorActive = replayTemporalLeadShadowDiagnostic.shadowHoldActive === true;
        const evaluation = window.LiveFlowChatReadCore?.evaluateReplayTemporalLeadShadow?.(priorActive, {
            normalSequentialContext: pageState.mode === 'replay' && ['READING', 'BUFFER_PAUSED'].includes(replayProductionControlState?.phase),
            lifecycleCurrent: pageState.mode === 'replay', targetCurrent: isCurrentPageStateTarget(),
            videoCurrent: Boolean(getCurrentMainVideo()), visible: !document.hidden,
            adActive: replayAdActive, seekActive: replaySeekInProgress, navigationPending,
            reanchorActive: replayReanchorLock, temporalFactsKnown: gap.acquisitionLeadClass !== 'UNKNOWN' &&
                gap.retainedNearestDistanceClass !== 'UNKNOWN', retainedFutureAvailable: replayPending.length > 0,
            acquisitionLeadPersistent: gap.acquisitionLeadPersistent, responseFarFuturePersistent: gap.responseFarFuturePersistent,
            acquisitionLeadClass: gap.acquisitionLeadClass, retainedNearestDistanceClass: gap.retainedNearestDistanceClass,
            pendingCount: replayPending.length
        });
        if (!evaluation) return;
        const entered = !priorActive && evaluation.shadowHoldActive === true;
        const resumed = priorActive && evaluation.shadowHoldWouldResume === true;
        const suppressed = Math.min(255, replayTemporalLeadShadowDiagnostic.suppressedRequestObservations + (entered ? 1 : 0));
        const observations = Math.min(255, replayTemporalLeadShadowDiagnostic.holdObservations + (evaluation.shadowHoldActive ? 1 : 0));
        replayTemporalLeadShadowDiagnostic = {
            ...replayTemporalLeadShadowDiagnostic, ...evaluation,
            acquisitionLeadClass: gap.acquisitionLeadClass,
            acquisitionLeadPersistent: gap.acquisitionLeadPersistent,
            responseFarFuturePersistent: gap.responseFarFuturePersistent,
            retainedNearestDistanceClass: gap.retainedNearestDistanceClass,
            pendingClass: window.LiveFlowChatReadCore?.classifyReplayDiagnosticCount?.(replayPending.length) || 'UNKNOWN',
            retainedFutureAvailable: replayPending.length > 0,
            temporalFactsKnown: gap.acquisitionLeadClass !== 'UNKNOWN' && gap.retainedNearestDistanceClass !== 'UNKNOWN',
            suppressedRequestObservations: suppressed, holdObservations: observations,
            hypotheticalSuppressedRequestCountClass: window.LiveFlowChatReadCore?.classifyReplayDiagnosticCount?.(suppressed) || 'UNKNOWN',
            holdObservationClass: window.LiveFlowChatReadCore?.classifyReplayDiagnosticCount?.(observations) || 'UNKNOWN',
            authorityAvailableDuringHold: evaluation.shadowHoldActive ? Boolean(authority) : replayTemporalLeadShadowDiagnostic.authorityAvailableDuringHold,
            authorityCurrentDuringHold: evaluation.shadowHoldActive ? authority?.authorityCurrent === true : replayTemporalLeadShadowDiagnostic.authorityCurrentDuringHold,
            authorityStillCurrentAtResume: resumed ? authority?.authorityCurrent === true : false
        };
    }

    function updateReplayTemporalStarvationDiagnostic(dueCount = 0) {
        const video = getCurrentMainVideo();
        const availability = window.LiveFlowChatReadCore?.summarizeReplayTemporalAvailability?.(
            replayPending, video?.currentTime, dueCount, REPLAY_MAX_PENDING
        );
        const authority = savedSequentialDiagnostic();
        const schedulerPending = replayPipelineDiagnostic.pendingCurrent > 0;
        // Conservative read-only signal: any scheduler pending work blocks a hypothetical READ rescue.
        const schedulerLaunchable = schedulerPending;
        const evaluation = window.LiveFlowChatReadCore?.evaluateReplayTemporalStarvation?.({
            bufferPaused: replayAcquisitionPausedForBuffer,
            pauseReason: replayPipelineDiagnostic.bufferPauseReason,
            pendingCount: replayPending.length,
            maximumPending: REPLAY_MAX_PENDING,
            dueCount,
            schedulerPending,
            schedulerLaunchable,
            nearestFutureClass: availability?.nearestFutureClass,
            savedSequentialAvailable: Boolean(replayPausedSequentialAuthority),
            savedSequentialCurrent: authority?.authorityCurrent === true,
            savedSequentialUnused: authority?.authorityState === 'OBSERVED_UNUSED',
            requestActive: readRequestInFlight || activeLoopGeneration !== 0,
            lifecycleCurrent: pageState.mode === 'replay' && isCurrentPageStateTarget(),
            visible: !document.hidden,
            adActive: replayAdActive,
            seekActive: replaySeekInProgress,
            navigationPending
        });
        replayTemporalStarvationDiagnostic.totalPendingClass = availability?.totalPendingClass || 'UNKNOWN';
        replayTemporalStarvationDiagnostic.dueCountClass = availability?.dueCountClass || 'UNKNOWN';
        replayTemporalStarvationDiagnostic.nearFutureCountClass = availability?.nearFutureCountClass || 'UNKNOWN';
        replayTemporalStarvationDiagnostic.nearestFutureClass = availability?.nearestFutureClass || 'UNKNOWN';
        replayTemporalStarvationDiagnostic.schedulerPending = schedulerPending;
        replayTemporalStarvationDiagnostic.schedulerLaunchable = schedulerLaunchable;
        replayTemporalStarvationDiagnostic.savedSequentialAvailable = Boolean(replayPausedSequentialAuthority);
        replayTemporalStarvationDiagnostic.savedSequentialCurrent = authority?.authorityCurrent === true;
        replayTemporalStarvationDiagnostic.savedSequentialUnused = authority?.authorityState === 'OBSERVED_UNUSED';
        replayTemporalStarvationDiagnostic.bufferPausedNow = replayAcquisitionPausedForBuffer;
        const history = window.LiveFlowChatReadCore?.mergeReplayTemporalEpisodeHistory?.(
            replayTemporalStarvationDiagnostic,
            {
                earlyResumeAttempted: replayPipelineDiagnostic.earlyResumeAttempted,
                earlyResumeStarted: replayPipelineDiagnostic.earlyResumeStarted,
                earlyResumeCompleted: replayTemporalStarvationDiagnostic.earlyResumeCompleted,
                earlyResumeProgressResult: replayTemporalStarvationDiagnostic.earlyResumeProgressResult
            }
        );
        if (history) Object.assign(replayTemporalStarvationDiagnostic, history);
        replayTemporalStarvationDiagnostic.rescueSuppressionReason = replayEarlyResumeSuppressionState === 'USED_WAITING_FOR_LOW_WATERMARK'
            ? 'USED_WAITING_FOR_LOW_WATERMARK' : 'NONE';
        replayTemporalStarvationDiagnostic.temporalStarvationKnown = availability?.known === true && evaluation?.known === true;
        replayTemporalStarvationDiagnostic.temporalStarvationObserved = evaluation?.observed === true;
        const hypothetical = window.LiveFlowChatReadCore?.evaluateReplayHypotheticalRescue?.({
            episodeActive: replayTemporalStarvationDiagnostic.episodeActive,
            bufferPausedNow: replayTemporalStarvationDiagnostic.bufferPausedNow,
            pauseReason: replayTemporalStarvationDiagnostic.pauseReason,
            episodeEarlyResumeStarted: replayTemporalStarvationDiagnostic.earlyResumeStarted,
            budgetRemaining: replayTemporalStarvationDiagnostic.hypotheticalRescueBudgetRemaining,
            dueCount,
            schedulerPending,
            schedulerLaunchable,
            savedSequentialAvailable: replayTemporalStarvationDiagnostic.savedSequentialAvailable,
            savedSequentialCurrent: replayTemporalStarvationDiagnostic.savedSequentialCurrent,
            savedSequentialUnused: replayTemporalStarvationDiagnostic.savedSequentialUnused,
            requestActive: readRequestInFlight || activeLoopGeneration !== 0,
            lifecycleCurrent: pageState.mode === 'replay' && isCurrentPageStateTarget(),
            visible: !document.hidden,
            adActive: replayAdActive,
            seekActive: replaySeekInProgress,
            navigationPending,
            nearestFutureClass: availability?.nearestFutureClass
        });
        replayTemporalStarvationDiagnostic.hypotheticalRescueEligible = hypothetical?.eligible === true;
        replayTemporalStarvationDiagnostic.hypotheticalRescueBlockedReason = hypothetical?.blockedReason || 'UNKNOWN';
        return availability;
    }

    window.LiveFlowReplayTemporalStarvationDiagnostic = Object.freeze({
        status() { return Object.freeze({ ...replayTemporalStarvationDiagnostic }); }
    });
    window.LiveFlowReplayGapOriginDiagnostic = Object.freeze({ status: replayGapOriginStatus });
    window.LiveFlowReplayTemporalLeadShadowDiagnostic = Object.freeze({
        status() { return Object.freeze({ ...replayTemporalLeadShadowDiagnostic }); }
    });

    function observeReplayPipelineResponse(result) {
        if (!result?.ok || !Array.isArray(result.messages)) return;
        replayPipelineDiagnostic.responsesObserved += 1;
        const receivedActions = Number.isInteger(result.summary?.actionCount) && result.summary.actionCount >= 0
            ? result.summary.actionCount : result.messages.length;
        replayPipelineDiagnostic.receivedActions += receivedActions;
        replayPipelineDiagnostic.messagesObserved += result.messages.length;
        replayPipelineDiagnostic.parseFailed += Math.max(0, receivedActions - result.messages.length);
        observeReplayRuntimeAccounting('response-accepted');
    }

    function replayAccountingStatus() {
        const core = window.LiveFlowChatReadCore;
        const temporalDisplayable = replayPipelineDiagnostic.uniqueTimingFiltered + replayPipelineDiagnostic.bridged +
            replayPipelineDiagnostic.timingPending + replayPipelineDiagnostic.uniqueTimingCapacityDropped;
        const schedulerRetained = replayPipelineDiagnostic.pendingCurrent;
        const ledger = core?.computeReplayAccountingLedger?.({
            receivedActions: replayPipelineDiagnostic.receivedActions, parsed: replayPipelineDiagnostic.messagesObserved,
            parseFailed: replayPipelineDiagnostic.parseFailed,
            displayable: replayPipelineDiagnostic.messagesObserved,
            dueClassified: replayPipelineDiagnostic.bridged, futureClassified: replayPipelineDiagnostic.timingPending + replayPipelineDiagnostic.uniqueTimingCapacityDropped,
            beforeStartFiltered: replayPipelineDiagnostic.uniqueTimingFiltered,
            dueBridged: replayPipelineDiagnostic.bridged,
            futureQueued: replayPipelineDiagnostic.timingPending, capacityDropped: replayPipelineDiagnostic.uniqueTimingCapacityDropped,
            enqueued: replayPipelineDiagnostic.enqueued, bridgeFiltered: replayPipelineDiagnostic.visibilityFiltered,
            bridgeDeduped: replayPipelineDiagnostic.bridgeDeduped, lifecycleDiscarded: replayPipelineDiagnostic.lifecycleDiscarded,
            pendingExplicitDrop: replayPipelineDiagnostic.enqueueRejected,
            schedulerEligible: replayPipelineDiagnostic.enqueued, selected: replayPipelineDiagnostic.launchCommitted,
            staleDropped: replayPipelineDiagnostic.stalePruned, schedulerRetained,
            launched: replayPipelineDiagnostic.launchCommitted, displayed: replayPipelineDiagnostic.launched
        }) || { stages: {}, lostUnaccounted: 0, overflowUnaccounted: 0, valid: false };
        const currentWindow = {
            input: temporalDisplayable,
            displayable: temporalDisplayable,
            due: replayPipelineDiagnostic.bridged,
            enqueued: replayPipelineDiagnostic.enqueued,
            selected: replayPipelineDiagnostic.launchCommitted,
            displayed: replayPipelineDiagnostic.launched
        };
        const blankCause = core?.classifyReplayBlankCause?.({
            conservationValid: ledger.valid, lostUnaccounted: ledger.lostUnaccounted,
            lifecycleDiscarded: replayPipelineDiagnostic.lifecycleDiscarded,
            generationDiscarded: replayPipelineDiagnostic.pendingGenerationMismatch + replayPipelineDiagnostic.generationInvalidated,
            currentWindowInput: currentWindow.input, currentWindowDisplayable: currentWindow.displayable,
            currentWindowDue: currentWindow.due, currentWindowDisplayed: currentWindow.displayed,
            selected: replayPipelineDiagnostic.launchCommitted, launched: replayPipelineDiagnostic.launchCommitted,
            schedulerRetained, schedulerBlocked: replayPipelineDiagnostic.selectionNoneCollisionBlocked,
            staleDropped: replayPipelineDiagnostic.stalePruned, capacityDropped: replayPipelineDiagnostic.uniqueTimingCapacityDropped,
            futureQueued: replayPipelineDiagnostic.timingPending,
            beforeStartFiltered: replayPipelineDiagnostic.uniqueTimingFiltered,
            acquisitionForward: replayPipelineDiagnostic.sequentialTemporalProgress === 'FORWARD',
            coverageGap: ['LONG_GAP', 'VERY_LONG_GAP'].includes(replayPipelineDiagnostic.nearestFutureClass)
        }) || 'UNKNOWN';
        const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
        return Object.freeze({
            receivedActions: replayPipelineDiagnostic.receivedActions,
            parsed: replayPipelineDiagnostic.messagesObserved,
            parseFailed: replayPipelineDiagnostic.parseFailed,
            displayable: replayPipelineDiagnostic.messagesObserved,
            invalid: 0,
            unsupported: 0,
            beforeStartFiltered: replayPipelineDiagnostic.uniqueTimingFiltered,
            staleDropped: replayPipelineDiagnostic.stalePruned,
            exactIdDeduped: replayGapEvidence?.exactIdDeduped === true ? 1 : 0,
            dueClassified: replayPipelineDiagnostic.uniqueTimingDue,
            dueBridged: replayPipelineDiagnostic.bridged,
            futureClassified: replayPipelineDiagnostic.uniqueTimingFutureBuffered,
            futureQueued: replayPipelineDiagnostic.timingPending,
            capacityDropped: replayPipelineDiagnostic.uniqueTimingCapacityDropped,
            schedulerEligible: replayPipelineDiagnostic.enqueued,
            schedulerBlocked: replayPipelineDiagnostic.selectionNoneCollisionBlocked,
            selectionAttempts: replayPipelineDiagnostic.launchAttempted,
            schedulerSelected: replayPipelineDiagnostic.launchCommitted,
            collisionDropped: replayPipelineDiagnostic.staleAfterCollision,
            readabilityDropped: 0,
            densityDropped: 0,
            subtitleDropped: 0,
            hardSafetyDropped: 0,
            launched: replayPipelineDiagnostic.launchCommitted,
            displayed: replayPipelineDiagnostic.launched,
            launchRejected: replayPipelineDiagnostic.launchRejected,
            rendererDropped: Math.max(0, replayPipelineDiagnostic.launchCommitted - replayPipelineDiagnostic.launched),
            lifecycleDiscarded: 0,
            generationDiscarded: replayPipelineDiagnostic.pendingGenerationMismatch + replayPipelineDiagnostic.generationInvalidated,
            stages: ledger.stages,
            parserLost: ledger.stages?.parser?.lost || 0,
            classificationLost: ledger.stages?.classification?.lost || 0,
            bridgeLost: ledger.stages?.bridge?.lost || 0,
            pendingLost: ledger.stages?.pending?.lost || 0,
            schedulerLost: ledger.stages?.scheduler?.lost || 0,
            rendererLost: (ledger.stages?.launch?.lost || 0) + (ledger.stages?.renderer?.lost || 0),
            lostUnaccounted: ledger.lostUnaccounted,
            overflowUnaccounted: ledger.overflowUnaccounted,
            displayableToSelected: ratio(replayPipelineDiagnostic.launchCommitted, temporalDisplayable),
            displayableToDisplayed: ratio(replayPipelineDiagnostic.launched, temporalDisplayable),
            launchedToDisplayed: ratio(replayPipelineDiagnostic.launched, replayPipelineDiagnostic.launchCommitted),
            currentWindowInputCountClass: core?.classifyReplayCount?.(currentWindow.input) || 'UNKNOWN',
            currentWindowDisplayableCountClass: core?.classifyReplayCount?.(currentWindow.displayable) || 'UNKNOWN',
            currentWindowDueCountClass: core?.classifyReplayCount?.(currentWindow.due) || 'UNKNOWN',
            currentWindowEnqueuedCountClass: core?.classifyReplayCount?.(currentWindow.enqueued) || 'UNKNOWN',
            currentWindowSelectedCountClass: core?.classifyReplayCount?.(currentWindow.selected) || 'UNKNOWN',
            currentWindowDisplayedCountClass: core?.classifyReplayCount?.(currentWindow.displayed) || 'UNKNOWN',
            currentWindowInput: currentWindow.input,
            currentWindowDisplayable: currentWindow.displayable,
            currentWindowDue: currentWindow.due,
            currentWindowEnqueued: currentWindow.enqueued,
            currentWindowSelected: currentWindow.selected,
            currentWindowDisplayed: currentWindow.displayed,
            schedulerRetained,
            acquisitionForward: replayPipelineDiagnostic.sequentialTemporalProgress === 'FORWARD',
            coverageGap: ['LONG_GAP', 'VERY_LONG_GAP'].includes(replayPipelineDiagnostic.nearestFutureClass),
            sourceSparse: replayGapOriginStatus().gapOriginClass === 'SOURCE_SPARSE',
            blankCause,
            warning: ledger.valid !== true || ledger.lostUnaccounted > 0 || ledger.overflowUnaccounted > 0 ||
                replayPipelineDiagnostic.launchCommitted > replayPipelineDiagnostic.launched ||
                (currentWindow.displayable > 0 && currentWindow.displayed === 0)
        });
    }

    window.LiveFlowReplayAccountingDiagnostic = Object.freeze({
        status: replayAccountingStatus,
        printSummary() {
            const status = replayAccountingStatus();
            const method = status.warning ? 'warn' : 'info';
            console[method]('[LiveFlow Replay Accounting]', Object.freeze({
                INPUT: { receivedActions: status.receivedActions, parsed: status.parsed, displayable: status.displayable },
                FILTER: { parseFailed: status.parseFailed, beforeStart: status.beforeStartFiltered, stale: status.staleDropped, dedupe: status.exactIdDeduped },
                BUFFER: { due: status.dueClassified, future: status.futureClassified, queued: status.futureQueued,
                    capacityDropped: status.capacityDropped, pendingCurrent: replayPipelineDiagnostic.pendingCurrent },
                SCHEDULER: { eligible: status.schedulerEligible, blocked: status.schedulerBlocked,
                    selected: status.schedulerSelected, pending: replayPipelineDiagnostic.pendingCurrent },
                DROP: { collision: status.collisionDropped, readability: status.readabilityDropped, density: status.densityDropped,
                    subtitle: status.subtitleDropped, hardSafety: status.hardSafetyDropped, lifecycle: status.lifecycleDiscarded },
                OUTPUT: { launched: status.launched, displayed: status.displayed },
                LOSS: { parserLost: status.parserLost, bridgeLost: status.bridgeLost, pendingLost: status.pendingLost,
                    schedulerLost: status.schedulerLost, rendererLost: status.rendererLost, lostUnaccounted: status.lostUnaccounted },
                RATIOS: { displayableToSelected: status.displayableToSelected, displayableToDisplayed: status.displayableToDisplayed,
                    launchedToDisplayed: status.launchedToDisplayed },
                CURRENT_WINDOW: { input: status.currentWindowInputCountClass, due: status.currentWindowDueCountClass,
                    selected: status.currentWindowSelectedCountClass, displayed: status.currentWindowDisplayedCountClass },
                BLANK_CAUSE: status.blankCause
            }));
            return status;
        }
    });

    let replayRuntimeObserver = null;

    function ensureReplayRuntimeObserver() {
        if (replayRuntimeObserver) return replayRuntimeObserver;
        replayRuntimeObserver = window.LiveFlowChatReadCore?.createReplayRuntimeObserver?.({
            maximumEpisodes: 8,
            report(event) {
                if (!event || !['BLANK_CONFIRMED', 'BLANK_RECOVERED', 'ACCOUNTING_WARNING', 'DENSITY_WARNING'].includes(event.type)) return;
                const label = event.type === 'ACCOUNTING_WARNING'
                    ? '[LiveFlow Replay Accounting Warning]'
                    : '[LiveFlow Replay Runtime Episode]';
                console.warn(label, event);
            }
        }) || null;
        return replayRuntimeObserver;
    }

    function observeReplayRuntimeAccounting(trigger) {
        const observer = ensureReplayRuntimeObserver();
        if (!observer) return null;
        const accounting = replayAccountingStatus();
        return observer.observe({ ...accounting,
            path: replayPipelineDiagnostic.freshChainSource === 'PLAYER_SEEK_RESPONSE_REPLAY_CONTINUATION' ? 'SEEK' : 'NORMAL',
            seekActive: replaySeekInProgress, adActive: replayAdActive,
            lifecycleChanged: ['navigation', 'pagehide', 'visibility-hidden'].includes(trigger)
        }, trigger);
    }

    window.LiveFlowReplayRuntimeObserver = Object.freeze({
        status() { return ensureReplayRuntimeObserver()?.status?.() || Object.freeze({ state: 'IDLE', recentEpisodeCount: 0 }); },
        recentEpisodes() { return ensureReplayRuntimeObserver()?.recentEpisodes?.() || Object.freeze([]); },
        printSummary() {
            const summary = ensureReplayRuntimeObserver()?.printSummary?.() || Object.freeze({ state: 'IDLE', recentEpisodes: [] });
            console.info('[LiveFlow Replay Runtime Observer]', summary);
            return summary;
        }
    });

    function observeReplayPendingMerge(priorPending, currentMessages, capacityDroppedBefore) {
        const priorIds = new Set((priorPending || []).map((message) => message?.id).filter((id) => typeof id === 'string' && id));
        const currentIds = new Set((currentMessages || []).map((message) => message?.id).filter((id) => typeof id === 'string' && id));
        replayPipelineDiagnostic.replayPendingRetainedFromPriorResponse = replayPending.reduce((count, message) =>
            count + (priorIds.has(message?.id) ? 1 : 0), 0);
        replayPipelineDiagnostic.replayPendingAddedFromCurrentResponse = replayPending.reduce((count, message) =>
            count + (!priorIds.has(message?.id) && currentIds.has(message?.id) ? 1 : 0), 0);
        replayPipelineDiagnostic.replayPendingCapacityDroppedCurrentMerge = Math.max(0,
            replayPipelineDiagnostic.timingCapacityDropped - capacityDroppedBefore);
    }
    let replayReanchorIntent = null;

    function emptyPlayerSeekResult() {
        return { requestAttempted: false, http: 'NOT_SENT', jsonParsed: false, replayShapeObserved: false, responseOffsetRelation: 'UNKNOWN', continuationShapeObserved: false };
    }

    function createReplayPlayerSeekDiagnostic() {
        return { armed: false, ready: false, consumed: false, inFlight: false, lifecycleGeneration: -1, revision: -1, readGeneration: -1, targetIdentity: '', continuation: '', notSentReason: 'NOT_ARMED', result: emptyPlayerSeekResult() };
    }

    function replayPlayerSeekDiagnosticStatus() {
        const diagnostic = replayPlayerSeekDiagnostic;
        return Object.freeze({ armed: diagnostic.armed === true, ready: diagnostic.ready === true, inFlight: diagnostic.inFlight === true, notSentReason: diagnostic.notSentReason, ...diagnostic.result });
    }

    function replayPlayerSeekDiagnosticNotSentStatus(reason) {
        const diagnostic = replayPlayerSeekDiagnostic;
        diagnostic.notSentReason = reason;
        return Object.freeze({ armed: diagnostic.armed === true, ready: diagnostic.ready === true, inFlight: diagnostic.inFlight === true, notSentReason: reason, ...emptyPlayerSeekResult() });
    }

    function abortReplayPlayerSeekDiagnostic() {
        const diagnostic = replayPlayerSeekDiagnostic;
        if (replayPlayerSeekDiagnosticAbortController) replayPlayerSeekDiagnosticAbortController.abort();
        replayPlayerSeekDiagnosticAbortController = null;
        replayPlayerSeekDiagnosticLock = false;
        if (diagnostic.inFlight) {
            diagnostic.armed = false;
            diagnostic.ready = false;
            diagnostic.consumed = true;
            diagnostic.continuation = '';
            diagnostic.result.http = 'ABORTED';
        } else replayPlayerSeekDiagnostic = createReplayPlayerSeekDiagnostic();
    }

    function capturePlayerSeekDiagnosticAuthority(payload, { mode, revision, generation, abortController } = {}) {
        const diagnostic = replayPlayerSeekDiagnostic;
        if (!diagnostic.armed || diagnostic.ready || diagnostic.consumed || diagnostic.inFlight) return;
        if (mode !== 'replay' || revision !== diagnostic.revision || generation !== diagnostic.readGeneration ||
            pageLifecycleGeneration !== diagnostic.lifecycleGeneration || pageState.targetIdentity !== diagnostic.targetIdentity ||
            navigationPending || abortController?.signal?.aborted === true || !isCurrentPageStateTarget()) return;
        const continuation = window.LiveFlowChatReadCore?.extractPlayerSeekContinuation?.(payload) || '';
        if (!continuation) return;
        diagnostic.continuation = continuation;
        diagnostic.ready = true;
        diagnostic.notSentReason = 'NONE';
    }

    function invalidateReplaySeekAuthority() {
        const binding = currentReplayAuthorityBinding(pageLifecycleGeneration);
        if (binding && replaySeekAuthority?.diagnostic?.(binding)?.authorityState === 'OBSERVED_UNUSED') {
            replayControlPlaneCore?.transitionAuthority?.(replaySeekAuthority, 'INVALIDATE', binding);
        }
        replaySeekAuthority = null;
        replayForegroundRecoveryOwnedVideo = null;
        replayReanchorIntent = null;
        replaySeekInProgress = false;
        replaySeekNeedsReanchor = false;
        replayAdActive = false;
        replayAdExitNeedsReanchor = false;
        replayProductionReanchorReason = 'NONE';
        if (replayReanchorAbortController) replayReanchorAbortController.abort();
        replayReanchorAbortController = null;
    }

    function captureReplaySeekAuthority(payload, { mode, revision, generation, abortController } = {}) {
        if (mode !== 'replay' || revision !== pageRevision || generation !== currentLoopGeneration ||
            abortController?.signal?.aborted === true || navigationPending || !isCurrentPageStateTarget()) return false;
        const continuation = window.LiveFlowChatReadCore?.extractPlayerSeekContinuation?.(payload) || '';
        if (!continuation) return false;
        const binding = currentReplayAuthorityBinding(pageLifecycleGeneration);
        if (binding && replaySeekAuthority?.diagnostic?.(binding)?.authorityState === 'OBSERVED_UNUSED') {
            replayControlPlaneCore?.transitionAuthority?.(replaySeekAuthority, 'INVALIDATE', binding);
        }
        replaySeekAuthority = replayControlPlaneCore?.createReplayAuthority?.({
            kind: 'REANCHOR', opaqueToken: continuation, binding, provenance: 'ADAPTER_REANCHOR'
        })?.authority || null;
        return Boolean(replaySeekAuthority);
    }

    function replaySeekAuthorityIsCurrent() {
        const diagnostic = replaySeekAuthority?.diagnostic?.(currentReplayAuthorityBinding(pageLifecycleGeneration));
        return Boolean(diagnostic?.authorityKind === 'REANCHOR' && diagnostic.authorityState === 'OBSERVED_UNUSED' &&
            diagnostic.authorityCurrent === true && pageState.mode === 'replay' && !navigationPending && isCurrentPageStateTarget());
    }

    function replaySeekAuthorityEligibleForHidden(video) {
        const binding = currentReplayAuthorityBinding(pageLifecycleGeneration);
        const eligibility = replayControlPlaneCore?.inspectAuthorityRequestEligibility?.({
            authority: replaySeekAuthority,
            expectedKind: 'REANCHOR',
            currentBinding: binding,
            consumedRegistry: replayConsumedAuthorityRegistry
        });
        return Boolean(eligibility?.ok === true && replayProductionControlState?.phase !== 'STOPPED' &&
            video && video === getCurrentMainVideo() &&
            Number.isFinite(video.currentTime) && isCurrentPageStateTarget() && !replayAdActive &&
            !replaySeekInProgress && !navigationPending && !replayReanchorLock && !replayPlayerSeekDiagnosticLock);
    }

    function replayAdIsActive() {
        const player = document.querySelector('ytd-watch-flexy')?.querySelector('#movie_player, .html5-video-player');
        return player?.classList?.contains('ad-showing') === true || player?.classList?.contains('ad-interrupting') === true;
    }

    function createReplayCredentiallessSchemaDiagnostic() {
        return { armed: false, observed: false, result: 'UNKNOWN', lifecycleGeneration: -1, revision: -1, targetIdentity: '' };
    }

    function invalidateReplayCredentiallessSchemaDiagnostic() {
        replayCredentiallessSchemaDiagnostic = createReplayCredentiallessSchemaDiagnostic();
    }

    function replayCredentiallessSchemaDiagnosticStatus() {
        const state = replayCredentiallessSchemaDiagnostic;
        return Object.freeze({ armed: state.armed === true, observed: state.observed === true, result: state.result });
    }

    function inspectOwnReplayResponseForPlayerSeek(payload, { mode, revision, generation, abortController } = {}) {
        const diagnostic = replayCredentiallessSchemaDiagnostic;
        if (!diagnostic.armed || diagnostic.observed) return false;
        const eligible = window.LiveFlowChatReadCore?.canAcceptReplaySchemaDiagnostic?.({
            armed: diagnostic.armed,
            observed: diagnostic.observed,
            mode,
            armedLifecycleGeneration: diagnostic.lifecycleGeneration,
            currentLifecycleGeneration: pageLifecycleGeneration,
            armedRevision: diagnostic.revision,
            currentRevision: pageRevision,
            responseRevision: revision,
            armedTargetIdentity: diagnostic.targetIdentity,
            currentTargetIdentity: pageState.targetIdentity,
            readGeneration: generation,
            currentReadGeneration: currentLoopGeneration,
            aborted: abortController?.signal?.aborted === true,
            navigationPending,
            targetCurrent: isCurrentPageStateTarget()
        }) === true;
        if (!eligible) {
            if (diagnostic.lifecycleGeneration !== pageLifecycleGeneration || diagnostic.revision !== pageRevision ||
                diagnostic.targetIdentity !== pageState.targetIdentity || navigationPending) invalidateReplayCredentiallessSchemaDiagnostic();
            return false;
        }
        const result = window.LiveFlowChatReadCore?.classifyPlayerSeekContinuationPresence?.(payload);
        replayCredentiallessSchemaDiagnostic = {
            armed: false,
            observed: true,
            result: ['PRESENT', 'ABSENT', 'INVALID_RESPONSE', 'UNKNOWN'].includes(result) ? result : 'UNKNOWN',
            lifecycleGeneration: diagnostic.lifecycleGeneration,
            revision: diagnostic.revision,
            targetIdentity: diagnostic.targetIdentity
        };
        return true;
    }

    function createReplayRestartDiagnostic() {
        return { sequence: replayRestartSequence, restartReason: 'OTHER', restartStage: 'IDLE', startedAt: 0, generation: pageLifecycleGeneration, continuationAdvances: 0, currentWindowMessagePresent: false, displayedSinceRestart: false, lastStopReason: 'NONE', lastFailReason: 'NONE' };
    }

    function beginReplayRestart(reason) {
        replayRestartSequence += 1;
        replayRestartDiagnostic = { sequence: replayRestartSequence, restartReason: REPLAY_RESTART_REASONS.has(reason) ? reason : 'OTHER', restartStage: 'WAITING_MEDIA', startedAt: performance.now(), generation: pageLifecycleGeneration, continuationAdvances: 0, currentWindowMessagePresent: false, displayedSinceRestart: false, lastStopReason: replayRestartDiagnostic.lastStopReason, lastFailReason: 'NONE' };
    }

    function setReplayRestartStage(stage, failReason = 'NONE', expectedSequence = replayRestartDiagnostic.sequence) {
        if (expectedSequence !== replayRestartDiagnostic.sequence) return;
        if (!REPLAY_RESTART_STAGES.has(stage)) return;
        replayRestartDiagnostic.restartStage = stage;
        if (stage === 'FAILED_CLOSED') replayRestartDiagnostic.lastFailReason = REPLAY_STOP_REASONS.has(failReason) ? failReason : 'OTHER';
    }

    function replayCountBucket(value) {
        if (!Number.isInteger(value) || value <= 0) return 'ZERO';
        if (value === 1) return 'ONE';
        return value <= 5 ? 'TWO_TO_FIVE' : 'GT_FIVE';
    }

    function replayPendingBucket(value) {
        if (!Number.isInteger(value) || value <= 0) return 'ZERO';
        if (value <= 10) return 'LOW';
        return value <= 50 ? 'MEDIUM' : 'HIGH';
    }

    function replayElapsedBucket(startedAt) {
        if (!Number.isFinite(startedAt) || startedAt <= 0) return 'LT_1S';
        const elapsed = Math.max(0, performance.now() - startedAt);
        if (elapsed < 1000) return 'LT_1S';
        if (elapsed < 3000) return '1_TO_3S';
        return elapsed < 10000 ? '3_TO_10S' : 'GT_10S';
    }

    function getYtcfgValue(key) {
        try {
            if (typeof window.ytcfg?.get === 'function') {
                const value = window.ytcfg.get(key);
                if (value !== undefined && value !== null) return value;
            }
        } catch (error) {
            return undefined;
        }
        return window.ytcfg?.data_?.[key];
    }

    function readContinuation(initialData = window.ytInitialData) {
        return initialData
            ?.contents
            ?.twoColumnWatchNextResults
            ?.conversationBar
            ?.liveChatRenderer
            ?.continuations?.[0]
            ?.reloadContinuationData
            ?.continuation || '';
    }

    function readInternalApiContext() {
        const core = window.LiveFlowChatReadCore;
        const candidates = [
            window.INNERTUBE_CONTEXT,
            getYtcfgValue('INNERTUBE_CONTEXT')
        ];

        for (const candidate of candidates) {
            const normalized = core?.normalizeInternalApiContext?.(candidate);
            if (normalized) return normalized;
        }

        const fallback = {};
        const fallbackKeys = [
            'INNERTUBE_CONTEXT_CLIENT_NAME',
            'INNERTUBE_CONTEXT_CLIENT_VERSION',
            'HL',
            'GL',
            'VISITOR_DATA'
        ];
        const targetKeys = ['clientName', 'clientVersion', 'hl', 'gl', 'visitorData'];

        fallbackKeys.forEach((key, index) => {
            const value = getYtcfgValue(key);
            if (value !== undefined && value !== null && value !== '') {
                fallback[targetKeys[index]] = value;
            }
        });

        return core?.normalizeInternalApiContext?.(fallback) || null;
    }

    function postLifecycleInvalidated() {
        window.postMessage({
            source: 'liveflow-page-state',
            type: NAVIGATION_INVALIDATED_TYPE,
            pageRevision,
            pageLifecycleGeneration
        }, window.location.origin);
    }

    function readBootstrapTargetEvidence(watchSnapshot, watchRoot) {
        return {
            authoritative: watchSnapshot?.currentVideoEndpoint?.watchEndpoint?.videoId,
            supporting: [
                window.ytInitialPlayerResponse?.videoDetails?.videoId,
                watchRoot?.getAttribute?.('video-id')
            ]
        };
    }

    function readNavigationCompletionTarget(event) {
        const value = event?.detail?.response?.playerResponse?.videoDetails?.videoId;
        return typeof value === 'string' ? value : '';
    }

    function disconnectWatchRootObserver() {
        watchRootObserver?.disconnect();
        watchRootObserver = null;
        observedWatchRoot = null;
        ownershipReevaluationQueued = false;
    }

    function bindWatchRootObserver(watchRoot) {
        if (watchRoot === observedWatchRoot && watchRootObserver) return false;
        disconnectWatchRootObserver();
        if (!watchRoot) return false;

        const observedGeneration = pageLifecycleGeneration;
        observedWatchRoot = watchRoot;
        watchRootObserver = new MutationObserver(() => {
            const canSignalReevaluation = window.LiveFlowChatReadCore?.canSignalOwnershipReevaluation?.({
                navigationPending,
                pageEstablished: establishedTargetIdentity.length > 0,
                pageDataUpdatedSeen: navigationPageDataUpdated
            }) === true;
            if (!canSignalReevaluation || ownershipReevaluationQueued ||
                observedGeneration !== pageLifecycleGeneration || observedWatchRoot !== watchRoot) return;
            ownershipReevaluationQueued = true;
            window.queueMicrotask(() => {
                ownershipReevaluationQueued = false;
                const stillCanSignalReevaluation = window.LiveFlowChatReadCore?.canSignalOwnershipReevaluation?.({
                    navigationPending,
                    pageEstablished: establishedTargetIdentity.length > 0,
                    pageDataUpdatedSeen: navigationPageDataUpdated
                }) === true;
                if (!stillCanSignalReevaluation || observedGeneration !== pageLifecycleGeneration || observedWatchRoot !== watchRoot) return;
                respond({
                    ownershipMutation: true,
                    eventSource: 'watch-root-mutation',
                    expectedLifecycleGeneration: observedGeneration
                });
            });
        });
        watchRootObserver.observe(watchRoot, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['video-id', 'hidden']
        });
        return true;
    }

    function isCurrentPageStateTarget() {
        const targetIdentity = window.LiveFlowChatReadCore?.extractWatchTargetIdentity?.(window.location.href) || '';
        return targetIdentity.length > 0 &&
            pageState.bootstrapTargetMatched === true &&
            pageState.targetIdentity === targetIdentity;
    }

    function postLifecycleDiagnostic(eventName, details = {}) {
        window.postMessage({
            source: 'liveflow-page-state',
            type: LIFECYCLE_DIAGNOSTIC_TYPE,
            eventName,
            pageRevision,
            pageLifecycleGeneration,
            readGeneration: currentLoopGeneration,
            readActive: activeLoopGeneration !== 0,
            requestInFlight: readRequestInFlight,
            ...details
        }, window.location.origin);
    }

    function invalidatePageLifecycle(eventSource = 'yt-navigate-start') {
        observeReplayRuntimeAccounting('navigation');
        terminateReplayForegroundRetainedDiagnostic('STALE_BINDING', true);
        observeReplayControlShadow('NAVIGATION', {}, 'STOPPED');
        abortReplayPlayerSeekDiagnostic();
        invalidateReplayCredentiallessSchemaDiagnostic();
        invalidateReplaySeekAuthority();
        const abortIssued = Boolean(activeAbortController);
        stopReadLoop('navigation');
        replayPipelineDiagnostic = createReplayPipelineDiagnostic();
        replayTemporalStarvationDiagnostic = createReplayTemporalStarvationDiagnostic();
        resetReplayGapOriginDiagnostic();
        replayEarlyResumeCoverageBefore = null;
        replayPressureEpisodeActive = false;
        replayEpisodeAdvancedBudgetUsed = 0;
        replayEarlyResumeCompleted = false;
        replayRunwayDepletionEpisodeState = 'UNKNOWN';
        replayTimingDiagnosticSeen = createReplayTimingDiagnosticSeen();
        replayAwaitingFirstFreshSequentialResponse = false;
        pageRevision += 1;
        pageLifecycleGeneration += 1;
        replayBootstrapAuthority = null;
        replayConsumedAuthorityRegistry = replayControlPlaneCore?.createConsumedAuthorityRegistry?.() || null;
        window.LiveFlowChatFrameRole?.beginGeneration?.(pageLifecycleGeneration);
        navigationPending = true;
        navigationPageDataUpdated = false;
        navigationCompletionTargetIdentity = '';
        disconnectWatchRootObserver();
        invalidatedTargetIdentity = establishedTargetIdentity;
        readAttemptedRevision = -1;
        readCount = 0;
        pageState = { continuation: '', context: null, targetIdentity: '', bootstrapTargetMatched: false, mode: 'unknown' };
        postLifecycleInvalidated();
        postLifecycleDiagnostic('NAV_INVALIDATE', { eventSource, abortIssued });
    }

    function applyLiveToReplayModeTransition(targetIdentity, eventSource) {
        const transition = window.LiveFlowChatReadCore?.classifySameTargetChatModeTransition?.({
            previousMode: pageState.mode,
            nextMode: 'replay',
            previousTargetIdentity: pageState.targetIdentity,
            nextTargetIdentity: targetIdentity
        }) || 'NONE';
        if (transition !== 'LIVE_TO_REPLAY') return false;

        observeReplayControlShadow('GENERATION_INVALIDATED', {}, 'STOPPED');
        invalidateReplaySeekAuthority();
        stopReadLoop('mode-transition');
        pageRevision += 1;
        pageLifecycleGeneration += 1;
        replayBootstrapAuthority = null;
        replayConsumedAuthorityRegistry = replayControlPlaneCore?.createConsumedAuthorityRegistry?.() || null;
        readAttemptedRevision = -1;
        readCount = 0;
        window.LiveFlowChatFrameRole?.beginGeneration?.(pageLifecycleGeneration);
        postLifecycleInvalidated();
        postLifecycleDiagnostic('MODE_TRANSITION', { eventSource });
        return true;
    }

    function respond({ pageDataUpdated = false, navigationFinished = false, ownershipMutation = false, eventSource = 'request', event = null, expectedLifecycleGeneration = null } = {}) {
        if (expectedLifecycleGeneration !== null && expectedLifecycleGeneration !== pageLifecycleGeneration) return false;
        const nextPageKey = `${location.origin}${location.pathname}${location.search}`;
        const hadEstablishedPage = pageKey !== '';
        const revisionState = window.LiveFlowChatReadCore?.getPageRevisionState?.(pageKey, pageRevision, nextPageKey);
        if (revisionState?.changed || (!revisionState && nextPageKey !== pageKey)) {
            if (hadEstablishedPage && !navigationPending) {
                terminateReplayForegroundRetainedDiagnostic('STALE_BINDING', true);
                observeReplayControlShadow('NAVIGATION', {}, 'STOPPED');
                invalidateReplayCredentiallessSchemaDiagnostic();
                invalidateReplaySeekAuthority();
                stopReadLoop('navigation');
                pageRevision = revisionState?.revision || pageRevision + 1;
                pageLifecycleGeneration += 1;
                replayBootstrapAuthority = null;
                replayConsumedAuthorityRegistry = replayControlPlaneCore?.createConsumedAuthorityRegistry?.() || null;
                navigationPending = true;
                navigationPageDataUpdated = false;
                navigationCompletionTargetIdentity = '';
                disconnectWatchRootObserver();
                invalidatedTargetIdentity = establishedTargetIdentity;
                postLifecycleInvalidated();
                postLifecycleDiagnostic('NAV_INVALIDATE', {
                    eventSource,
                    abortIssued: false
                });
            }
            pageKey = revisionState?.key || nextPageKey;
            readAttemptedRevision = -1;
            readCount = 0;
            pageState = { continuation: '', context: null, targetIdentity: '', bootstrapTargetMatched: false, mode: 'unknown' };
        }
        window.LiveFlowChatFrameRole?.beginGeneration?.(pageLifecycleGeneration);
        if (pageDataUpdated) navigationPageDataUpdated = true;
        if (navigationFinished) navigationCompletionTargetIdentity = readNavigationCompletionTarget(event);
        const watchRoot = document.querySelector('ytd-watch-flexy');
        const watchRootRebound = bindWatchRootObserver(watchRoot);
        const canReevaluate = window.LiveFlowChatReadCore?.canReevaluatePageLifecycle?.({
            navigationPending,
            pageDataUpdatedSeen: navigationPageDataUpdated,
            pageDataUpdated,
            navigationFinished,
            ownershipMutation
        }) === true;
        if (!canReevaluate) return false;
        const watchSnapshot = watchRoot?.data;
        const continuation = readContinuation(watchSnapshot);
        const context = readInternalApiContext();
        const currentVideo = watchRoot?.querySelector('#movie_player video.html5-main-video, #movie_player video') || null;
        const watchRootChanged = lastEstablishedWatchRoot !== null && watchRoot !== lastEstablishedWatchRoot;
        const videoElementChanged = lastEstablishedVideo !== null && currentVideo !== lastEstablishedVideo;
        const core = window.LiveFlowChatReadCore;
        const targetIdentity = core?.extractWatchTargetIdentity?.(window.location.href) || '';
        const bootstrapTargetEvidence = readBootstrapTargetEvidence(watchSnapshot, watchRoot);
        const bootstrapTarget = core?.evaluateBootstrapTarget?.(
            targetIdentity,
            bootstrapTargetEvidence.authoritative,
            bootstrapTargetEvidence.supporting
        ) || { available: false, matched: false, supportingCandidateCount: 0, supportingMatchCount: 0 };
        const frameRole = window.LiveFlowChatFrameRole?.snapshot?.(watchRoot, pageLifecycleGeneration);
        const snapshotChatMode = core?.classifyInitialChatMode?.(watchSnapshot) || 'unknown';
        const frameChatMode = frameRole?.sourceMatchesOwnedFrame === true && frameRole.frameConnected === true && frameRole.generationCurrent === true
            ? frameRole.role === 'LIVE_CHAT' ? 'live' : frameRole.role === 'REPLAY_CHAT' ? 'replay' : 'unknown'
            : 'unknown';
        const chatMode = snapshotChatMode !== 'unknown' ? snapshotChatMode : frameChatMode;
        const pageTargetChanged = invalidatedTargetIdentity.length === 0 || targetIdentity !== invalidatedTargetIdentity;
        const navigationTargetMatched = !navigationPending || (
            navigationCompletionTargetIdentity.length > 0 &&
            navigationCompletionTargetIdentity === targetIdentity
        );
        const establishment = core?.canEstablishPageLifecycle?.({
            navigationPending,
            pageDataUpdated: !navigationPending || navigationPageDataUpdated,
            navigationTargetMatched,
            pageTargetChanged,
            bootstrapTargetMatched: bootstrapTarget.matched,
            pageStateUsable: Boolean(continuation && context && watchRoot && currentVideo && chatMode !== 'unknown')
        }) || { ok: false, reason: 'PAGE_STATE_STALE' };
        if (!establishment.ok) {
            postLifecycleDiagnostic('PAGE_STATE_REJECTED', {
                rejectionReason: establishment.reason,
                lifecycleSignal: eventSource,
                navigationPageDataUpdated,
                canReevaluate,
                navigationTargetMatched,
                targetKnown: targetIdentity.length > 0,
                bootstrapKnown: bootstrapTarget.available,
                ownershipSource: 'WATCH_ROOT_SNAPSHOT',
                ownershipContinuationAvailable: Boolean(continuation),
                ownershipSameSnapshot: bootstrapTarget.matched && Boolean(continuation),
                watchRootObserved: Boolean(watchRootObserver),
                watchRootRebound,
                pageTargetChanged,
                bootstrapTargetMatched: bootstrapTarget.matched,
                supportingCandidateCount: bootstrapTarget.supportingCandidateCount,
                supportingMatchCount: bootstrapTarget.supportingMatchCount,
                watchRootChanged,
                videoElementChanged
            });
            return false;
        }
        applyLiveToReplayModeTransition(targetIdentity, eventSource);
        navigationPending = false;
        navigationPageDataUpdated = false;
        navigationCompletionTargetIdentity = '';
        establishedTargetIdentity = targetIdentity;
        invalidatedTargetIdentity = '';
        lastEstablishedWatchRoot = watchRoot;
        lastEstablishedVideo = currentVideo;
        const shadowLifecycleStart = pageState.mode !== 'replay' || pageState.targetIdentity !== targetIdentity;
        pageState = {
            continuation: chatMode === 'live' && typeof continuation === 'string' ? continuation : '',
            context,
            targetIdentity,
            bootstrapTargetMatched: true,
            mode: chatMode
        };
        if (pageState.mode === 'replay' && shadowLifecycleStart) acceptReplayBootstrapCandidate(continuation);
        if (pageState.mode === 'replay' && shadowLifecycleStart) {
            observeReplayControlShadow('LIFECYCLE_START', {}, 'BOOTSTRAPPING');
        }
        if (pageState.mode !== 'replay' || (replaySeekAuthority &&
            replaySeekAuthority.diagnostic?.(currentReplayAuthorityBinding(pageLifecycleGeneration))?.authorityCurrent !== true)) {
            invalidateReplaySeekAuthority();
        }
        if ((replayPlayerSeekDiagnostic.armed || replayPlayerSeekDiagnostic.inFlight) &&
            (replayPlayerSeekDiagnostic.lifecycleGeneration !== pageLifecycleGeneration ||
                replayPlayerSeekDiagnostic.revision !== pageRevision ||
                replayPlayerSeekDiagnostic.targetIdentity !== pageState.targetIdentity || pageState.mode !== 'replay')) {
            abortReplayPlayerSeekDiagnostic();
        }
        if (replayCredentiallessSchemaDiagnostic.armed &&
            (replayCredentiallessSchemaDiagnostic.lifecycleGeneration !== pageLifecycleGeneration ||
                replayCredentiallessSchemaDiagnostic.revision !== pageRevision ||
                replayCredentiallessSchemaDiagnostic.targetIdentity !== pageState.targetIdentity || pageState.mode !== 'replay')) {
            invalidateReplayCredentiallessSchemaDiagnostic();
        }
        postLifecycleDiagnostic('NEW_PAGE_STATE', {
            eventSource,
            navigationPageDataUpdated: true,
            canReevaluate,
            navigationTargetMatched,
            targetKnown: true,
            bootstrapKnown: true,
            ownershipSource: 'WATCH_ROOT_SNAPSHOT',
            ownershipContinuationAvailable: true,
            ownershipSameSnapshot: true,
            watchRootObserved: Boolean(watchRootObserver),
            watchRootRebound,
            pageTargetChanged,
            bootstrapTargetMatched: true,
            supportingCandidateCount: bootstrapTarget.supportingCandidateCount,
            supportingMatchCount: bootstrapTarget.supportingMatchCount,
            watchRootChanged,
            videoElementChanged
        });
        window.postMessage({
            source: 'liveflow-page-state',
            type: RESPONSE_TYPE,
            continuation: pageState.mode === 'live' ? pageState.continuation : '',
            chatAvailable: pageState.mode === 'replay' ? Boolean(replayBootstrapAuthority) : Boolean(pageState.continuation),
            context: pageState.context,
            pageRevision,
            pageLifecycleGeneration,
            mode: pageState.mode
        }, window.location.origin);
        return true;
    }

    function postReadResult(result, lifecycleGeneration) {
        const { continuationInfo, messages, summary, ...safeResult } = result;
        window.postMessage({
            source: 'liveflow-page-state',
            type: READ_RESPONSE_TYPE,
            pageRevision: result.revision,
            pageLifecycleGeneration: lifecycleGeneration,
            ...safeResult,
            messages,
            parsedMessageCount: Array.isArray(messages) ? messages.length : 0,
            nextContinuationAvailable: Boolean(continuationInfo?.continuation)
        }, window.location.origin);
    }

    function stopReadLoop(reason = 'explicit') {
        currentLoopGeneration += 1;
        activeLoopGeneration = 0;
        if (activeAbortController) activeAbortController.abort();
        activeAbortController = null;
        if (activeWaitTimer !== null) window.clearTimeout(activeWaitTimer);
        activeWaitTimer = null;
        cancelReplayTemporalWakeup();
        deferredReadStartGeneration = null;
        deferredVisibilityResumeGeneration = null;
        readStopReason = reason;
        replayPending = [];
        replayAcquisitionPausedForBuffer = false;
        replayPausedSequentialAuthority = null;
        invalidateAuthorityHandle(replayObservedSequentialAuthority);
        replayObservedSequentialAuthority = null;
        replaySequentialResumeHandoff = false;
        replayEarlyResumeSuppressionState = 'CLEAR';
        replayRunwayDepletionEpisodeState = 'UNKNOWN';
        replayPipelineDiagnostic.earlyResumeEligible = false;
        replayPipelineDiagnostic.earlyResumeSuppressed = false;
        replayPipelineDiagnostic.earlyResumeSuppressionState = 'CLEAR';
        replayPipelineDiagnostic.earlyResumeDecision = 'NOT_PAUSED';
        replayPreviousSequentialMessages = null;
        if (['user-disabled', 'visibility-hidden', 'pagehide', 'navigation', 'seek', 'ad-enter'].includes(reason)) {
            replayPressureEpisodeActive = false;
            replayEpisodeAdvancedBudgetUsed = 0;
            replayEarlyResumeCompleted = false;
        }
        if (['user-disabled', 'visibility-hidden', 'pagehide', 'navigation'].includes(reason)) {
            resetReplayGapOriginDiagnostic();
        }
        replayRestartDiagnostic.lastStopReason = reason === 'playback-paused' ? 'PAUSED' : reason === 'seek' ? 'SEEKING' : reason === 'user-disabled' ? 'DISABLED' : reason === 'visibility-hidden' ? 'HIDDEN' : reason === 'navigation' ? 'STALE_GENERATION' : 'OTHER';
        if (['user-disabled', 'visibility-hidden', 'pagehide', 'navigation'].includes(reason)) abortReplayPlayerSeekDiagnostic();
    }

    function suspendReplayForMediaPause() {
        if (pageState.mode !== 'replay') return false;
        activeLoopGeneration = 0;
        if (activeAbortController) activeAbortController.abort();
        activeAbortController = null;
        replayPausedSequentialAuthority = replayControlPlaneCore?.retainSequentialAuthorityForMediaPause?.(
            replayPausedSequentialAuthority, replayObservedSequentialAuthority
        ) || replayPausedSequentialAuthority || replayObservedSequentialAuthority;
        replayObservedSequentialAuthority = null;
        replayAcquisitionPausedForBuffer = Boolean(replayPausedSequentialAuthority);
        replaySequentialResumeHandoff = Boolean(replayPausedSequentialAuthority);
        const retainedDiagnostic = savedSequentialDiagnostic();
        replayPipelineDiagnostic.bufferSavedContinuationState = retainedDiagnostic?.authorityState || 'NONE';
        replayPipelineDiagnostic.unreadSequentialAuthorityAvailable = retainedDiagnostic?.authorityState === 'OBSERVED_UNUSED';
        readStopReason = 'playback-paused';
        replayRestartDiagnostic.lastStopReason = 'PAUSED';
        return true;
    }

    function stopReplayContext(reason) {
        if (pageState.mode !== 'replay') return false;
        stopReadLoop(reason);
        return true;
    }

    function getCurrentMainVideo() {
        return document.querySelector('ytd-watch-flexy')?.querySelector('#movie_player video.html5-main-video, #movie_player video') || null;
    }

    function cancelReplayTemporalWakeup() {
        replayTemporalWakeSequence += 1;
        if (replayTemporalWakeTimer !== null) window.clearTimeout(replayTemporalWakeTimer);
        replayTemporalWakeTimer = null;
    }

    function armReplayTemporalWakeup(generation, revision, lifecycleGeneration, video) {
        cancelReplayTemporalWakeup();
        if (replayPending.length === 0 || pageState.mode !== 'replay' || document.hidden || navigationPending ||
            replayAdActive || replaySeekInProgress || replayReanchorLock || replayPlayerSeekDiagnosticLock ||
            !video || video !== getCurrentMainVideo() || video.paused || video.ended || video.seeking ||
            !Number.isFinite(video.currentTime) || !Number.isFinite(video.playbackRate) || video.playbackRate <= 0) return false;
        const delayMs = window.LiveFlowChatReadCore?.getReplayTemporalWakeDelayMs?.(
            replayPending, video.currentTime, replayStartTimeSeconds, video.playbackRate
        );
        if (!Number.isFinite(delayMs)) return false;
        const sequence = replayTemporalWakeSequence;
        const targetIdentity = pageState.targetIdentity;
        const armedCurrentTime = video.currentTime;
        replayTemporalWakeTimer = window.setTimeout(() => {
            replayTemporalWakeTimer = null;
            const currentVideo = getCurrentMainVideo();
            const current = window.LiveFlowChatReadCore?.canRunReplayTemporalWakeup?.({
                sequenceCurrent: sequence === replayTemporalWakeSequence,
                generationCurrent: generation === currentLoopGeneration,
                revisionCurrent: revision === pageRevision,
                lifecycleCurrent: lifecycleGeneration === pageLifecycleGeneration,
                targetCurrent: targetIdentity === pageState.targetIdentity && isCurrentPageStateTarget(),
                modeReplay: pageState.mode === 'replay', visible: !document.hidden,
                navigationPending, adActive: replayAdActive, seekActive: replaySeekInProgress,
                reanchorActive: replayReanchorLock, diagnosticLock: replayPlayerSeekDiagnosticLock,
                controlSuspended: replayProductionControlState?.phase === 'SUSPENDED',
                videoCurrent: currentVideo === video, mediaPaused: video?.paused === true,
                mediaEnded: video?.ended === true, mediaSeeking: video?.seeking === true,
                playerTimingValid: Number.isFinite(video?.currentTime),
                mediaTimeAdvanced: Number.isFinite(video?.currentTime) && video.currentTime > armedCurrentTime
            }) === true;
            if (!current) return;
            flushReplayPending(generation, revision, lifecycleGeneration, replayRestartDiagnostic.sequence, 'temporal-wakeup');
        }, delayMs);
        return true;
    }

    function flushReplayPending(generation, revision, lifecycleGeneration, diagnosticSequence = replayRestartDiagnostic.sequence, source = 'response') {
        replayPipelineDiagnostic.replayPendingFlushCalls += 1;
        if (generation !== currentLoopGeneration || lifecycleGeneration !== pageLifecycleGeneration) {
            replayPipelineDiagnostic.pendingGenerationMismatch += 1;
            setReplayRestartStage('FAILED_CLOSED', 'STALE_GENERATION', diagnosticSequence);
            return;
        }
        if (pageState.mode !== 'replay' || document.hidden || replayProductionControlState?.phase === 'SUSPENDED') return;
        const video = getCurrentMainVideo();
        if (!video || video.paused || video.ended || !Number.isFinite(video.currentTime)) {
            replayPipelineDiagnostic.pendingAuthorityMismatch += 1;
            return;
        }
        if (source === 'timeupdate') replayPipelineDiagnostic.replayPendingFlushFromTimeupdate += 1;
        const selection = window.LiveFlowChatReadCore?.selectBoundedReplayDueMessages?.(
            replayPending, video.currentTime, replayStartTimeSeconds, REPLAY_MAX_PENDING
        );
        if (!selection) return;
        replayPipelineDiagnostic.timingFiltered += selection.filteredCount;
        replayPipelineDiagnostic.timingDueObserved += selection.due.length;
        replayPipelineDiagnostic.timingFutureObserved += selection.pending.length;
        const countUnique = window.LiveFlowChatReadCore?.countNewReplayMessageIdentities;
        replayPipelineDiagnostic.uniqueTimingFiltered += countUnique?.(selection.filtered, replayTimingDiagnosticSeen.filtered) || 0;
        replayPipelineDiagnostic.uniqueTimingFutureBuffered += countUnique?.(selection.pending, replayTimingDiagnosticSeen.future) || 0;
        replayPipelineDiagnostic.uniqueTimingDue += countUnique?.(selection.due, replayTimingDiagnosticSeen.due) || 0;
        replayPipelineDiagnostic.uniqueTimingCapacityDropped += countUnique?.(selection.capacityDroppedItems, replayTimingDiagnosticSeen.capacityDropped) || 0;
        const gapObservations = [
            ...selection.filtered.map(({ replayOffsetMsec }) => ({ replayOffsetMsec, disposition: 'FILTERED_BEFORE_START' })),
            ...selection.due.map(({ replayOffsetMsec }) => ({ replayOffsetMsec, disposition: 'BRIDGED_DUE' })),
            ...selection.capacityDroppedItems.map(({ replayOffsetMsec }) => ({ replayOffsetMsec, disposition: 'CAPACITY_DROPPED' })),
            ...selection.pending.map(({ replayOffsetMsec }) => ({ replayOffsetMsec, disposition: 'RETAINED' })),
            ...(selection.deduplicatedItems || []).map(({ replayOffsetMsec }) => ({ replayOffsetMsec, disposition: 'EXACT_ID_DEDUPED' }))
        ];
        replayGapEvidence = window.LiveFlowChatReadCore?.updateReplayGapEvidence?.(
            replayGapEvidence, gapObservations, video.currentTime
        ) || replayGapEvidence;
        replayGapOriginDiagnostic.capacitySelectionNearestPreserved = selection.capacitySelectionNearestPreserved;
        replayGapOriginDiagnostic.evidenceStateClass = replayGapEvidence?.observationPasses > 0 ? 'OBSERVED' : 'EMPTY';
        replayPipelineDiagnostic.replayPendingPromoted += selection.due.length;
        replayPipelineDiagnostic.timingCapacityDropped += selection.capacityDropped;
        replayPipelineDiagnostic.timingPending = selection.pending.length;
        replayPending = selection.pending;
        replayPipelineDiagnostic.nearestFutureClass = window.LiveFlowChatReadCore?.classifyNearestReplayFuture?.(
            replayPending, video.currentTime
        ) || 'UNKNOWN';
        observeReplayRuntimeAccounting(source === 'timeupdate' ? 'timeupdate' : 'temporal-classification');
        const bufferState = window.LiveFlowChatReadCore?.classifyReplayBufferPauseState?.({
            paused: replayAcquisitionPausedForBuffer,
            pendingCount: replayPending.length,
            nearestFutureClass: replayPipelineDiagnostic.nearestFutureClass,
            maximumPending: REPLAY_MAX_PENDING
        });
        replayPipelineDiagnostic.bufferPauseTemporalState = bufferState?.temporalState || 'UNKNOWN';
        replayPipelineDiagnostic.futureGapWhileBufferPaused = bufferState?.futureGapWhilePaused === true;
        replayPipelineDiagnostic.bufferResumeBlockedByCount = bufferState?.resumeBlockedByCount === true;
        replayPipelineDiagnostic.unreadSequentialAuthorityAvailable = savedSequentialDiagnostic()?.authorityState === 'OBSERVED_UNUSED';
        const runwayPositive = selection.due.length > 0 || replayPipelineDiagnostic.pendingCurrent > 0;
        replayRunwayDepletionEpisodeState = window.LiveFlowChatReadCore?.transitionReplayRunwayDepletionEpisode?.(
            replayRunwayDepletionEpisodeState, runwayPositive ? 'RUNWAY_POSITIVE' : 'RUNWAY_DEPLETED'
        ) || 'UNKNOWN';
        updateReplayTemporalStarvationDiagnostic(selection.due.length);
        updateReplayTemporalLeadShadowDiagnostic();
        replayRestartDiagnostic.currentWindowMessagePresent = selection.due.length > 0;
        if (selection.due.length > 0) {
            replayPipelineDiagnostic.bridged += selection.due.length;
            setReplayRestartStage('CURRENT_WINDOW_REACHED', 'NONE', diagnosticSequence);
            postReadResult({ ok: true, status: 200, readNumber: readCount, revision, generation, messages: selection.due, summary: {}, continuationInfo: null }, lifecycleGeneration);
            setReplayRestartStage('LAUNCH_READY', 'NONE', diagnosticSequence);
        }
        armReplayTemporalWakeup(generation, revision, lifecycleGeneration, video);
        if (source === 'temporal-wakeup') return;
        const lowWatermarkReached = replayPending.length <= Math.floor(REPLAY_MAX_PENDING / 2);
        if (lowWatermarkReached && replayEarlyResumeSuppressionState === 'USED_WAITING_FOR_LOW_WATERMARK') {
            replayEarlyResumeSuppressionState = window.LiveFlowChatReadCore?.transitionReplayEarlyResumeSuppression?.(
                replayEarlyResumeSuppressionState, 'LOW_WATERMARK_REACHED'
            ) || 'UNKNOWN';
            replayPipelineDiagnostic.earlyResumeSuppressed = false;
            replayPipelineDiagnostic.earlyResumeSuppressionState = replayEarlyResumeSuppressionState;
        }
        if (lowWatermarkReached && replayTemporalStarvationDiagnostic.episodeActive) {
            replayTemporalStarvationDiagnostic = createReplayTemporalStarvationDiagnostic();
            replayTemporalStarvationDiagnostic.lowWatermarkReached = true;
            replayPressureEpisodeActive = false;
            replayEpisodeAdvancedBudgetUsed = 0;
            replayEarlyResumeCompleted = false;
        }
        const authority = replayPausedSequentialAuthority;
        const authorityDiagnostic = savedSequentialDiagnostic();
        const ownedVideoCurrent = video === getCurrentMainVideo() && video.seeking !== true;
        const authorityCurrent = Boolean(authorityDiagnostic?.authorityCurrent === true &&
            pageState.mode === 'replay' && isCurrentPageStateTarget() &&
            ownedVideoCurrent && !navigationPending && !replayAdActive && !replaySeekInProgress);
        const authorityUnused = authorityDiagnostic?.authorityKind === 'SEQUENTIAL' &&
            authorityDiagnostic?.authorityState === 'OBSERVED_UNUSED';
        const normalResume = window.LiveFlowChatReadCore?.evaluateReplayNormalResume?.({
            paused: replayAcquisitionPausedForBuffer,
            pendingCount: replayPending.length,
            maximumPending: REPLAY_MAX_PENDING,
            authorityAvailable: Boolean(authority),
            authorityCurrent,
            authorityUnused
        });
        const capabilitySnapshot = replayControlPlaneCore?.createCapabilitySnapshot?.({
            binding: currentReplayAuthorityBinding(), evidenceEpoch: pageRevision,
            capabilities: {
                sequentialRead: authority ? 'SUPPORTED' : 'UNKNOWN',
                targetIdentity: isCurrentPageStateTarget() ? 'SUPPORTED' : 'UNKNOWN',
                mainContentOwnership: ownedVideoCurrent ? 'SUPPORTED' : 'UNKNOWN',
                playerTiming: Number.isFinite(video.currentTime) ? 'SUPPORTED' : 'UNKNOWN'
            }
        })?.snapshot;
        const legacyCapabilityAvailable = Boolean(authority && isCurrentPageStateTarget() && ownedVideoCurrent &&
            Number.isFinite(video.currentTime));
        if (capabilitySnapshot) replayControlShadow?.compareCapability?.(
            'BUFFER_RESUME', capabilitySnapshot, currentReplayAuthorityBinding(), legacyCapabilityAvailable
        );
        const earlyResumeCapabilityAllowed = replayControlPlaneCore?.canUseCapabilityPath?.(
            'EARLY_RESUME', capabilitySnapshot, currentReplayAuthorityBinding()
        )?.allowed === true;
        if (normalResume?.eligible === true) {
            const requestGrant = authorizeSavedSequentialResume();
            if (!requestGrant) {
                observeReplayControlShadow('AUTHORITY_FAILURE');
                failClosedSavedSequentialResume();
                return;
            }
            observeReplayControlShadow('BUFFER_LOW_WATERMARK');
            replayPipelineDiagnostic.earlyResumeDecision = 'NORMAL_RESUME_PRECEDENCE';
            replayAcquisitionPausedForBuffer = false;
            replayPausedSequentialAuthority = null;
            replayPipelineDiagnostic.unreadSequentialAuthorityAvailable = false;
            replayPipelineDiagnostic.bufferResumeBlockedByCount = false;
            replayPipelineDiagnostic.bufferSavedContinuationState = 'CONSUMED';
            replaySequentialResumeHandoff = true;
            replayPipelineDiagnostic.bufferPauseActive = false;
            replayPipelineDiagnostic.bufferResumeStarted = true;
            window.queueMicrotask(() => startReadLoop(pageLifecycleGeneration, 'BUFFER_RESUME', requestGrant));
            return;
        }
        const earlyResume = window.LiveFlowChatReadCore?.evaluateReplayBufferEarlyResume?.({
            paused: replayAcquisitionPausedForBuffer,
            pauseReason: replayPipelineDiagnostic.bufferPauseReason,
            pendingCount: replayPending.length,
            maximumPending: REPLAY_MAX_PENDING,
            dueCount: selection.due.length,
            schedulerPendingCount: replayPipelineDiagnostic.pendingCurrent,
            nearestFutureClass: replayPipelineDiagnostic.nearestFutureClass,
            authorityAvailable: Boolean(authority) && earlyResumeCapabilityAllowed,
            authorityCurrent,
            authorityUnused,
            requestInFlight: readRequestInFlight,
            activeLoop: activeLoopGeneration !== 0,
            locked: replayReanchorLock || replayPlayerSeekDiagnosticLock,
            suppressed: replayRunwayDepletionEpisodeState !== 'DEPLETED_AVAILABLE'
        });
        replayPipelineDiagnostic.earlyResumeEligible = earlyResume?.eligible === true;
        replayPipelineDiagnostic.earlyResumeDecision = earlyResume?.decision || 'UNKNOWN';
        if (earlyResume?.decision === 'SUPPRESSED') {
            replayPipelineDiagnostic.earlyResumeSuppressed = true;
            replayPipelineDiagnostic.earlyResumeSuppressedCount += 1;
        }
        if (earlyResume?.eligible === true) {
            replayEarlyResumeCoverageBefore = window.LiveFlowChatReadCore?.summarizeReplayTemporalAvailability?.(
                replayPending, video.currentTime, selection.due.length, REPLAY_MAX_PENDING
            ) || null;
            const requestGrant = authorizeSavedSequentialResume();
            if (!requestGrant) {
                observeReplayControlShadow('AUTHORITY_FAILURE');
                failClosedSavedSequentialResume();
                return;
            }
            observeReplayControlShadow('EARLY_RESUME_ELIGIBLE');
            replayPipelineDiagnostic.earlyResumeAttempted = true;
            replayPipelineDiagnostic.earlyResumeAttemptedCount += 1;
            replayPausedSequentialAuthority = null;
            replayEarlyResumeSuppressionState = window.LiveFlowChatReadCore?.transitionReplayEarlyResumeSuppression?.(
                replayEarlyResumeSuppressionState, 'EARLY_RESUME_STARTED'
            ) || 'UNKNOWN';
            replayRunwayDepletionEpisodeState = window.LiveFlowChatReadCore?.transitionReplayRunwayDepletionEpisode?.(
                replayRunwayDepletionEpisodeState, 'EARLY_RESUME_STARTED'
            ) || 'UNKNOWN';
            replayAcquisitionPausedForBuffer = false;
            replaySequentialResumeHandoff = true;
            replayPipelineDiagnostic.bufferSavedContinuationState = 'CONSUMED';
            replayPipelineDiagnostic.unreadSequentialAuthorityAvailable = false;
            replayPipelineDiagnostic.bufferPauseActive = false;
            replayPipelineDiagnostic.earlyResumeStarted = true;
            replayPipelineDiagnostic.earlyResumeStartedCount += 1;
            replayPipelineDiagnostic.earlyResumeSuppressed = true;
            replayPipelineDiagnostic.earlyResumeSuppressionState = replayEarlyResumeSuppressionState;
            replayPipelineDiagnostic.earlyResumeDecision = 'STARTED';
            replayPressureEpisodeActive = true;
            replayEpisodeAdvancedBudgetUsed = Math.max(replayEpisodeAdvancedBudgetUsed, 1);
            replayEarlyResumeCompleted = false;
            window.queueMicrotask(() => startReadLoop(pageLifecycleGeneration, 'BUFFER_EARLY_RESUME', requestGrant));
            return;
        }
        const availability = window.LiveFlowChatReadCore?.summarizeReplayTemporalAvailability?.(
            replayPending, video.currentTime, selection.due.length, REPLAY_MAX_PENDING
        );
    }

    function resumeReadAfterVisibility(requestedLifecycleGeneration, userEnabled) {
        if (pageState.mode === 'replay') {
            if (replayProductionControlState?.phase !== 'SUSPENDED' || replayProductionControlState.suspendedReason !== 'HIDDEN' ||
                document.visibilityState !== 'visible') return false;
            observeReplayForegroundVisible();
            replayAdActive = replayAdIsActive();
            if (replayAdActive) {
                invalidateAuthorityHandle(replaySeekAuthority);
                replaySeekAuthority = null;
                replayForegroundRecoveryOwnedVideo = null;
                replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'AD_ACTIVE';
                observeReplayControlShadow('VISIBLE_ENTER', { adActive: true, recoveryEligible: false });
                return false;
            }
            const video = getCurrentMainVideo();
            const binding = currentReplayAuthorityBinding(pageLifecycleGeneration);
            const authorityDiagnostic = replaySeekAuthority?.diagnostic?.(binding);
            const authorityEligibility = replayControlPlaneCore?.inspectAuthorityRequestEligibility?.({
                authority: replaySeekAuthority,
                expectedKind: 'REANCHOR',
                currentBinding: binding,
                consumedRegistry: replayConsumedAuthorityRegistry
            });
            const playerOffsetMs = window.LiveFlowChatReadCore?.validatePlayerSeekOffset?.(video?.currentTime, video?.duration);
            const ownershipCurrent = Boolean(video && video === replayForegroundRecoveryOwnedVideo && video === getCurrentMainVideo() && !video.paused && !video.ended &&
                !video.seeking && playerOffsetMs !== null && isCurrentPageStateTarget());
            const capabilitySnapshot = replayControlPlaneCore?.createCapabilitySnapshot?.({
                binding, evidenceEpoch: pageRevision,
                capabilities: {
                    reanchorRead: 'SUPPORTED',
                    targetIdentity: isCurrentPageStateTarget() ? 'SUPPORTED' : 'UNKNOWN',
                    mainContentOwnership: ownershipCurrent ? 'SUPPORTED' : 'UNKNOWN',
                    playerTiming: playerOffsetMs !== null ? 'SUPPORTED' : 'UNKNOWN'
                }
            })?.snapshot;
            const capabilityAllowed = replayControlPlaneCore?.canUseCapabilityPath?.(
                'REANCHOR', capabilitySnapshot, binding
            )?.allowed === true;
            const recovery = replayControlPlaneCore?.evaluateForegroundRecoveryEligibility?.({
                visible: document.visibilityState === 'visible',
                replayTarget: pageState.mode === 'replay',
                lifecycleCurrent: requestedLifecycleGeneration === pageLifecycleGeneration,
                revisionCurrent: authorityDiagnostic?.authorityCurrent === true,
                targetCurrent: isCurrentPageStateTarget(),
                authorityAvailable: Boolean(replaySeekAuthority),
                authorityUnused: authorityDiagnostic?.authorityState === 'OBSERVED_UNUSED',
                authorityBindingCurrent: authorityDiagnostic?.authorityCurrent === true,
                authorityUnconsumed: authorityEligibility?.ok === true,
                noAd: !replayAdActive,
                noSeek: !replaySeekInProgress,
                ownershipCurrent,
                playerTimingValid: playerOffsetMs !== null,
                noRequestConflict: !readRequestInFlight && !replayReanchorLock && !replayPlayerSeekDiagnosticLock,
                capabilityAllowed,
                controlSuspendedHidden: replayProductionControlState?.phase === 'SUSPENDED' &&
                    replayProductionControlState.suspendedReason === 'HIDDEN'
            }) || { allowed: false };
            replayForegroundRecoveryDiagnostic.retainedCurrentAtVisible = authorityEligibility?.ok === true;
            if (userEnabled !== true || navigationPending || recovery.allowed !== true) {
                invalidateAuthorityHandle(replaySeekAuthority);
                replaySeekAuthority = null;
                replayForegroundRecoveryOwnedVideo = null;
                replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'PRECONDITION_FAILED';
                observeReplayControlShadow('VISIBLE_ENTER', { adActive: false, recoveryEligible: false });
                observeReplayControlShadow('REANCHOR_FAILED');
                setReplayRestartStage('FAILED_CLOSED', 'OTHER');
                return false;
            }
            replayControlShadow?.compareCapability?.('REANCHOR', capabilitySnapshot, binding, true);
            observeReplayControlShadow('VISIBLE_ENTER', { adActive: false, recoveryEligible: true });
            const queued = queueReplayReanchor('FOREGROUND', replaySeekEpoch, video);
            replayForegroundRecoveryDiagnostic.foregroundRecoveryStarted = queued;
            replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = queued ? 'STARTED' : 'AUTHORIZATION_FAILED';
            if (!queued) {
                invalidateAuthorityHandle(replaySeekAuthority);
                replaySeekAuthority = null;
                replayForegroundRecoveryOwnedVideo = null;
                observeReplayControlShadow('REANCHOR_FAILED');
                setReplayRestartStage('FAILED_CLOSED', 'OTHER');
            }
            return queued;
        }
        const core = window.LiveFlowChatReadCore;
        const watchRoot = document.querySelector('ytd-watch-flexy');
        const watchSnapshot = watchRoot?.data;
        const targetIdentity = core?.extractWatchTargetIdentity?.(window.location.href) || '';
        const evidence = readBootstrapTargetEvidence(watchSnapshot, watchRoot);
        const target = core?.evaluateBootstrapTarget?.(targetIdentity, evidence.authoritative, evidence.supporting);
        const continuation = readContinuation(watchSnapshot);
        const context = readInternalApiContext();
        const currentVideo = watchRoot?.querySelector('#movie_player video.html5-main-video, #movie_player video') || null;
        const currentWatchRoot = Boolean(watchRoot?.isConnected && document.querySelector('ytd-watch-flexy') === watchRoot && currentVideo);
        const allowed = core?.canResumeReadAfterVisibility?.({
            visibilityState: document.visibilityState,
            userEnabled,
            stopReason: readStopReason,
            requestedLifecycleGeneration,
            currentLifecycleGeneration: pageLifecycleGeneration,
            navigationPending,
            targetMatched: target?.matched === true && pageState.targetIdentity === targetIdentity,
            continuationAvailable: Boolean(continuation),
            contextAvailable: Boolean(context),
            watchRootCurrent: currentWatchRoot,
            activeLoopGeneration,
            requestInFlight: readRequestInFlight
        }) === true;
        if (!allowed) return false;
        const accepted = respond({
            eventSource: 'visibility-resume',
            expectedLifecycleGeneration: requestedLifecycleGeneration
        });
        if (accepted) readStopReason = 'none';
        return accepted;
    }

    function requestVisibilityResume(requestedLifecycleGeneration, userEnabled) {
        if (pageState.mode === 'replay') return resumeReadAfterVisibility(requestedLifecycleGeneration, userEnabled);
        if (document.visibilityState === 'visible' && userEnabled === true &&
            readStopReason === 'visibility-hidden' && requestedLifecycleGeneration === pageLifecycleGeneration &&
            activeLoopGeneration === 0 && readRequestInFlight) {
            deferredVisibilityResumeGeneration = requestedLifecycleGeneration;
            return false;
        }
        return resumeReadAfterVisibility(requestedLifecycleGeneration, userEnabled);
    }

    function waitForNextRead(delay, generation) {
        return new Promise((resolve) => {
            activeWaitTimer = window.setTimeout(() => {
                activeWaitTimer = null;
                resolve(generation === currentLoopGeneration);
            }, delay);
        });
    }

    async function performRead(continuation, context, readNumber, revision, generation, abortController, mode = 'live', playerOffsetMs = null, allowProductionAuthorityCapture = true, allowDevelopmentCapture = true) {
        const requestBody = window.LiveFlowChatReadCore?.buildLiveChatReadRequest?.(
            context,
            continuation
        );
        if (!requestBody) {
            return { ok: false, status: null, errorType: 'missing_page_state', readNumber, revision };
        }
        if (mode === 'replay' && Number.isSafeInteger(playerOffsetMs) && playerOffsetMs >= 0) {
            requestBody.currentPlayerState = { playerOffsetMs };
        }

        try {
            let timeoutId = null;
            if (mode === 'replay') timeoutId = window.setTimeout(() => abortController.abort(), REPLAY_REQUEST_TIMEOUT_MS);
            const response = await fetch(mode === 'replay' ? '/youtubei/v1/live_chat/get_live_chat_replay?prettyPrint=false' : '/youtubei/v1/live_chat/get_live_chat?prettyPrint=false', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                credentials: 'omit',
                signal: abortController.signal
            });
            if (timeoutId !== null) window.clearTimeout(timeoutId);

            if (!window.LiveFlowChatReadCore?.isSuccessfulHttpStatus?.(response.status)) {
                return { ok: false, status: response.status, errorType: 'http_error', readNumber, revision };
            }

            let payload;
            try {
                payload = await response.json();
            } catch (error) {
                return { ok: false, status: response.status, errorType: 'invalid_json', readNumber, revision };
            }

            if (allowDevelopmentCapture) {
                inspectOwnReplayResponseForPlayerSeek(payload, { mode, revision, generation, abortController });
                capturePlayerSeekDiagnosticAuthority(payload, { mode, revision, generation, abortController });
            }

            const parser = window.LiveFlowChatReadCore;
            try {
                window.LiveFlowSchemaDiagnostics?.collect?.(payload);
            } catch {
                // Development diagnostics must never affect READ or parsing.
            }
            let validation;
            let messages;
            let summary;
            let reanchorTemporalCoverage = 'UNKNOWN';
            let reanchorAcceptedRelation = 'NONE';
            let playerSeekContinuationObserved = false;
            let replayTargetHole = { nearestBeforeTargetClass: 'UNKNOWN', nearestAfterTargetClass: 'UNKNOWN', targetBracketGapClass: 'UNKNOWN', currentWindowState: 'UNKNOWN' };
            let reanchorTimestampedActionCount = 0;
            try {
                validation = mode === 'replay' ? parser?.validateReplayChatReadResponse?.(payload,
                    playerOffsetMs === null ? { requestContinuation: continuation, consumedContinuations: replayConsumedAuthorityRegistry } : null)
                    : parser?.validateLiveChatReadResponse?.(payload);
                validation ||= { ok: false, errorType: 'parser_unavailable' };
                if (!validation.ok) {
                    return { ok: false, status: response.status, errorType: validation.errorType, readNumber, revision };
                }
                if (mode === 'replay' && playerOffsetMs !== null) {
                    const reanchorSummary = parser?.summarizePlayerSeekDiagnosticResponse?.(payload, playerOffsetMs);
                    reanchorTemporalCoverage = parser?.classifyReplayReanchorCoverage?.(payload, playerOffsetMs) || 'UNKNOWN';
                    replayTargetHole = parser?.summarizeReplayTargetHole?.(payload, playerOffsetMs) || replayTargetHole;
                    reanchorTimestampedActionCount = parser?.countReplayTimestampedActions?.(payload) || 0;
                    playerSeekContinuationObserved = Boolean(parser?.extractPlayerSeekContinuation?.(payload));
                    const relation = reanchorSummary?.responseOffsetRelation;
                    if (relation !== 'CROSSES_TARGET' && relation !== 'ALL_NEAR_OR_AFTER_TARGET') {
                        const errorType = relation === 'ALL_BEFORE_TARGET' ? 'reanchor_relation_all_before' : 'reanchor_relation_unknown';
                        return { ok: false, status: response.status, errorType, readNumber, revision, reanchorRelation: relation || 'UNKNOWN' };
                    }
                    reanchorAcceptedRelation = relation;
                }
                if (mode === 'replay' && allowProductionAuthorityCapture) captureReplaySeekAuthority(payload, { mode, revision, generation, abortController });
                if (mode === 'replay') captureReplayForegroundRetainedCandidate(payload, { mode, revision, generation, abortController, playerOffsetMs });
                messages = mode === 'replay' ? parser.extractReplayChatMessagesFromResponse(payload) : parser.extractChatMessagesFromResponse(payload);
                summary = parser.summarizeLiveChatResponse(payload);
            } catch (error) {
                return { ok: false, status: response.status, errorType: 'parser_exception', readNumber, revision };
            }
            const normalizedMessages = messages.map((message) => ({
                id: message.id,
                authorName: message.authorName,
                message: message.message,
                timestampUsec: message.timestampUsec,
                authorPhoto: message.authorPhoto,
                authorBadges: message.authorBadges,
                badges: message.badges,
                messageType: message.messageType,
                authorRole: message.authorRole,
                messageRuns: message.messageRuns,
                authorExternalChannelId: message.authorExternalChannelId,
                purchaseAmountText: message.purchaseAmountText,
                sticker: message.sticker,
                colors: message.colors,
                replayOffsetMsec: message.replayOffsetMsec
            }));
            const replayDisplayableTargetHole = mode === 'replay' && playerOffsetMs !== null
                ? parser?.summarizeReplayDisplayableTargetHole?.(normalizedMessages, playerOffsetMs) : null;
            const replayDisplayableAccounting = mode === 'replay' && playerOffsetMs !== null
                ? parser?.summarizeReplayDisplayableAccounting?.(normalizedMessages, playerOffsetMs) : null;

            return {
                ok: true,
                status: response.status,
                readNumber,
                revision,
                generation,
                messages: normalizedMessages,
                continuationInfo: validation.continuationInfo,
                continuationCandidateState: validation.continuationCandidateState || 'INVALID',
                effectiveDelayMs: validation.effectiveDelayMs,
                summary,
                reanchorTemporalCoverage,
                reanchorAcceptedRelation,
                playerSeekContinuationObserved,
                replayTargetHole,
                reanchorTimestampedActionCount,
                replayDisplayableTargetHole,
                replayDisplayableAccounting
            };
        } catch (error) {
            return { ok: false, status: null, errorType: 'network_error', readNumber, revision };
        }
    }

    async function startReadLoop(requestedLifecycleGeneration, replayContinuationSource = 'INITIAL_WATCH', replayRequestGrant = null) {
        const core = window.LiveFlowChatReadCore;
        if (pageState.mode === 'replay' && replayProductionControlState?.phase === 'SUSPENDED') {
            setReplayRestartStage('FAILED_CLOSED', 'OTHER');
            return;
        }
        if (requestedLifecycleGeneration !== pageLifecycleGeneration || navigationPending) {
            setReplayRestartStage('FAILED_CLOSED', 'STALE_GENERATION');
            return;
        }
        if (!isCurrentPageStateTarget()) {
            postLifecycleDiagnostic('READ_START_REJECTED', {
                rejectionReason: 'BOOTSTRAP_TARGET_MISMATCH',
                targetKnown: Boolean(core?.extractWatchTargetIdentity?.(window.location.href)),
                bootstrapKnown: Boolean(pageState.targetIdentity),
                bootstrapTargetMatched: false
            });
            setReplayRestartStage('FAILED_CLOSED', 'SNAPSHOT_UNAVAILABLE');
            return;
        }
        const replayGrantKind = replayRequestGrant?.diagnostic?.().authorizedKind || 'NONE';
        const replayStartAuthority = pageState.mode === 'replay' && replayRequestGrant &&
            ['BOOTSTRAP', 'SEQUENTIAL'].includes(replayGrantKind)
            ? Object.freeze({ allowed: true, authorityKind: replayGrantKind, source: replayContinuationSource, reason: 'NONE' })
            : null;
        if (pageState.mode === 'replay' && replayStartAuthority?.allowed !== true) {
            setReplayRestartStage('FAILED_CLOSED', 'OTHER');
            return;
        }
        if (pageState.mode === 'replay') {
            const shadowAuthorizationEvent = replayStartAuthority.authorityKind === 'BOOTSTRAP'
                ? 'BOOTSTRAP_AUTHORIZED' : 'SEQUENTIAL_AUTHORIZED';
            observeReplayControlShadow(shadowAuthorizationEvent);
        }
        if (readRequestInFlight || activeLoopGeneration !== 0 || replayReanchorLock) {
            if (pageState.mode === 'replay') {
                setReplayRestartStage('FAILED_CLOSED', 'OTHER');
                return;
            }
            deferredReadStartGeneration = requestedLifecycleGeneration;
            return;
        }
        if (!core?.canStartReadLoop?.({
            activeLoopGeneration,
            requestInFlight: readRequestInFlight,
            hasContinuation: Boolean(replayRequestGrant || pageState.continuation),
            hasContext: Boolean(pageState.context),
            hidden: document.hidden
        })) {
            if (pageState.mode === 'replay') setReplayRestartStage('FAILED_CLOSED', 'OTHER');
            return;
        }

        const generation = ++currentLoopGeneration;
        activeLoopGeneration = generation;
        readStopReason = 'none';
        const revision = pageRevision;
        const lifecycleGeneration = pageLifecycleGeneration;
        const diagnosticSequence = replayRestartDiagnostic.sequence;
        const context = pageState.context;
        const mode = pageState.mode;
        let continuation = mode === 'replay' ? '' : pageState.continuation;
        let continuationSource = mode === 'replay' ? replayContinuationSource : 'INITIAL_WATCH';
        let requestAuthorityKind = mode === 'replay' ? replayStartAuthority.authorityKind : 'NONE';
        let currentRequestGrant = mode === 'replay' ? replayRequestGrant : null;
        let nextSequentialAuthority = null;
        let initialReplayTargetOffsetMsec = null;
        if (mode === 'replay') {
            const video = getCurrentMainVideo();
            if (!video || video.paused || video.ended || !Number.isFinite(video.currentTime)) {
                activeLoopGeneration = 0;
                setReplayRestartStage('WAITING_MEDIA');
                return;
            }
            const preserveSequentialPending = requestAuthorityKind === 'SEQUENTIAL' &&
                (replayAwaitingFirstFreshSequentialResponse || replaySequentialResumeHandoff);
            if (!preserveSequentialPending) {
                replayStartTimeSeconds = video.currentTime;
                replayPending = [];
            }
            if (requestAuthorityKind === 'BOOTSTRAP') {
                initialReplayTargetOffsetMsec = core?.validatePlayerSeekOffset?.(video.currentTime, video.duration);
            }
            replaySequentialResumeHandoff = false;
            replayAcquisitionPausedForBuffer = false;
            setReplayRestartStage('BOOTSTRAP_READY');
        }
        postLifecycleDiagnostic('READ_START', { readGeneration: generation });

        while (generation === currentLoopGeneration && revision === pageRevision &&
            lifecycleGeneration === pageLifecycleGeneration && !navigationPending &&
            (continuation || currentRequestGrant || nextSequentialAuthority)) {
            if (replayPlayerSeekDiagnosticLock || replayReanchorLock) break;
            if (!isCurrentPageStateTarget()) {
                postLifecycleDiagnostic('READ_STOP', {
                    readGeneration: generation,
                    aborted: false,
                    responseAfterInvalidation: false,
                    rejectionReason: 'BOOTSTRAP_TARGET_MISMATCH'
                });
                break;
            }
            if (mode === 'replay' && nextSequentialAuthority) {
                if (replayObservedSequentialAuthority === nextSequentialAuthority) replayObservedSequentialAuthority = null;
                currentRequestGrant = authorizeSequentialAuthority(
                    nextSequentialAuthority,
                    currentReplayAuthorityBinding(generation),
                    generation
                );
                nextSequentialAuthority = null;
                if (!currentRequestGrant) {
                    observeReplayControlShadow('AUTHORITY_FAILURE');
                    setReplayRestartStage('FAILED_CLOSED', 'OTHER', diagnosticSequence);
                    break;
                }
                observeReplayControlShadow('SEQUENTIAL_AUTHORIZED');
                requestAuthorityKind = 'SEQUENTIAL';
                const video = getCurrentMainVideo();
                const sequentialCapabilitySnapshot = replayControlPlaneCore?.createCapabilitySnapshot?.({
                    binding: currentReplayAuthorityBinding(generation), evidenceEpoch: pageRevision,
                    capabilities: {
                        sequentialRead: 'SUPPORTED',
                        targetIdentity: isCurrentPageStateTarget() ? 'SUPPORTED' : 'UNKNOWN',
                        mainContentOwnership: video && video === getCurrentMainVideo() ? 'SUPPORTED' : 'UNKNOWN',
                        playerTiming: Number.isFinite(video?.currentTime) ? 'SUPPORTED' : 'UNKNOWN'
                    }
                })?.snapshot;
                if (sequentialCapabilitySnapshot) replayControlShadow?.compareCapability?.(
                    'SEQUENTIAL', sequentialCapabilitySnapshot, currentReplayAuthorityBinding(generation), true
                );
            }
            let requestContinuation = continuation;
            if (mode === 'replay' && currentRequestGrant) {
                const claimed = replayControlPlaneCore?.claimAuthorityRequestGrant?.(currentRequestGrant, requestAuthorityKind);
                currentRequestGrant = null;
                if (claimed?.ok !== true) {
                    observeReplayControlShadow('AUTHORITY_FAILURE');
                    setReplayRestartStage('FAILED_CLOSED', 'OTHER', diagnosticSequence);
                    break;
                }
                requestContinuation = claimed.opaqueToken;
                continuation = '';
            }
            if (mode === 'replay') {
                replayPipelineDiagnostic.sequentialContinuationSource = continuationSource;
                if (continuationSource === 'BUFFER_RESUME') replayPipelineDiagnostic.bufferSavedContinuationState = 'CONSUMED';
            }
            readCount += 1;
            const abortController = new AbortController();
            activeAbortController = abortController;
            readRequestInFlight = true;
            if (mode === 'replay') replayPipelineDiagnostic.maxObservedSequentialInFlight = Math.max(
                replayPipelineDiagnostic.maxObservedSequentialInFlight, readRequestInFlight ? 1 : 0
            );
            if (mode === 'replay') setReplayRestartStage('REQUESTING', 'NONE', diagnosticSequence);
            postLifecycleDiagnostic('READ_REQUEST_BEGIN', {
                readGeneration: generation,
                requestAfterInvalidation: lifecycleGeneration !== pageLifecycleGeneration || navigationPending
            });
            let result;
            try {
                result = await performRead(requestContinuation, context, readCount, revision, generation, abortController, mode);
            } finally {
                readRequestInFlight = false;
                const deferredVisibilityGeneration = deferredVisibilityResumeGeneration;
                deferredVisibilityResumeGeneration = null;
                if (mode !== 'replay' && deferredVisibilityGeneration === pageLifecycleGeneration && readStopReason === 'visibility-hidden') {
                    window.queueMicrotask(() => resumeReadAfterVisibility(deferredVisibilityGeneration, true));
                }
                if (replayReanchorIntent && !replayReanchorLock) {
                    const pendingIntent = replayReanchorIntent;
                    window.queueMicrotask(() => runQueuedReplayReanchor(pendingIntent));
                }
            }
            if (activeAbortController === abortController) activeAbortController = null;
            postLifecycleDiagnostic('READ_RESPONSE_RECEIVED', {
                readGeneration: generation,
                responseAfterInvalidation: lifecycleGeneration !== pageLifecycleGeneration
            });
            if (mode === 'replay' && result?.ok) setReplayRestartStage('RESPONSE_ACCEPTED', 'NONE', diagnosticSequence);
            const canContinue = core.canScheduleNextRead({
                generation,
                currentGeneration: currentLoopGeneration,
                revision,
                currentRevision: pageRevision,
                aborted: abortController.signal.aborted,
                validationOk: Boolean(result?.ok)
            });
            if (!canContinue) {
                postLifecycleDiagnostic('READ_STOP', {
                    readGeneration: generation,
                    aborted: abortController.signal.aborted,
                    responseAfterInvalidation: lifecycleGeneration !== pageLifecycleGeneration
                });
                const responseBindingCurrent = generation === currentLoopGeneration && revision === pageRevision &&
                    lifecycleGeneration === pageLifecycleGeneration && !navigationPending && !abortController.signal.aborted;
                if (mode === 'replay' && responseBindingCurrent) {
                    if (requestAuthorityKind === 'BOOTSTRAP') observeReplayControlShadow('BOOTSTRAP_FAILED');
                    else observeReplayControlShadow('AUTHORITY_FAILURE');
                    setReplayRestartStage('FAILED_CLOSED', result?.errorType === 'http_error' ? 'NON_2XX' : 'INVALID_RESPONSE', diagnosticSequence);
                }
                break;
            }

            if (mode === 'replay') {
                if (requestAuthorityKind === 'BOOTSTRAP') {
                    const coverage = core?.classifyReplayInitialStartupCoverage?.(
                        result.messages, initialReplayTargetOffsetMsec
                    ) || 'UNKNOWN';
                    const alignment = replayControlPlaneCore?.evaluateInitialReplayAlignment?.({
                        targetOffsetMsec: initialReplayTargetOffsetMsec,
                        coverage,
                        reanchorEligible: replaySeekAuthorityIsCurrent(),
                        attempted: replayInitialAlignmentAttemptedLifecycleId === lifecycleGeneration
                    }) || { action: 'HOLD', reason: 'COVERAGE_UNKNOWN' };
                    if (alignment.action !== 'COMMIT_BOOTSTRAP') {
                        observeReplayControlShadow('INITIAL_ALIGNMENT_REQUIRED');
                        let queued = false;
                        if (alignment.action === 'ALIGN_ONCE') {
                            replayInitialAlignmentAttemptedLifecycleId = lifecycleGeneration;
                            queued = queueReplayReanchor('INITIAL_ALIGNMENT', lifecycleGeneration, getCurrentMainVideo());
                        }
                        if (!queued) {
                            observeReplayControlShadow('AUTHORITY_FAILURE');
                            setReplayRestartStage('FAILED_CLOSED', 'OTHER', diagnosticSequence);
                        }
                        break;
                    }
                }
                const shadowResponseEvent = requestAuthorityKind === 'BOOTSTRAP'
                    ? 'BOOTSTRAP_SUCCEEDED' : 'SEQUENTIAL_SUCCEEDED';
                observeReplayControlShadow(shadowResponseEvent);
                observeReplayPipelineResponse(result);
                replayPipelineDiagnostic.sequentialResponsesProcessed += 1;
                replayPipelineDiagnostic.sequentialContinuationCandidateState = result.continuationCandidateState || 'INVALID';
                const nextSequentialContinuation = result.continuationInfo?.continuation || '';
                const continuationProgress = core?.classifySequentialContinuationProgress?.(
                    requestContinuation, nextSequentialContinuation, replayConsumedAuthorityRegistry
                ) || 'UNKNOWN';
                replayPipelineDiagnostic.sequentialContinuationProgress = continuationProgress;
                if (continuationProgress === 'ADVANCED') replayPipelineDiagnostic.sequentialContinuationAdvanced += 1;
                else if (continuationProgress === 'REPEATED') replayPipelineDiagnostic.sequentialContinuationRepeated += 1;
                else if (continuationProgress === 'RETURNED_TO_SEEN') replayPipelineDiagnostic.sequentialContinuationReturnedToSeen += 1;
                else if (continuationProgress === 'MISSING') replayPipelineDiagnostic.sequentialContinuationMissing += 1;
                const temporalProgress = core?.classifyReplayTemporalProgress?.(replayPreviousSequentialMessages, result.messages);
                replayPipelineDiagnostic.sequentialTemporalProgress = temporalProgress?.direction || 'UNKNOWN';
                replayPipelineDiagnostic.sequentialTemporalCoverageProgress = temporalProgress?.coverage || 'UNKNOWN';
                const responseShape = core?.summarizeReplayResponseTemporalShape?.(
                    result.messages, getCurrentMainVideo()?.currentTime, replayPreviousSequentialMessages
                );
                replayGapOriginDiagnostic.responseFirstMessageRelation = responseShape?.responseFirstMessageRelation || 'UNKNOWN';
                replayGapOriginDiagnostic.responseLastMessageRelation = responseShape?.responseLastMessageRelation || 'UNKNOWN';
                replayGapOriginDiagnostic.responseCoverageProgress = responseShape?.responseCoverageProgress || 'UNKNOWN';
                replayGapOriginDiagnostic.acquisitionLeadClass = responseShape?.acquisitionLeadClass || 'UNKNOWN';
                observeReplayGapPersistence(responseShape);
                replayPreviousSequentialMessages = result.messages;
                const candidateBinding = currentReplayAuthorityBinding(generation);
                nextSequentialAuthority = continuationProgress === 'ADVANCED' && candidateBinding
                    ? createSequentialAuthorityCandidate(nextSequentialContinuation, candidateBinding) : null;
                replayObservedSequentialAuthority = nextSequentialAuthority;
                if (!nextSequentialAuthority) {
                    observeReplayControlShadow('AUTHORITY_FAILURE');
                    setReplayRestartStage('FAILED_CLOSED', 'OTHER', diagnosticSequence);
                    break;
                }
                const responseCapabilitySnapshot = replayControlPlaneCore?.createCapabilitySnapshot?.({
                    binding: candidateBinding, evidenceEpoch: pageRevision,
                    capabilities: { replayMessages: 'SUPPORTED', sequentialRead: 'SUPPORTED' }
                })?.snapshot;
                if (responseCapabilitySnapshot) replayControlShadow?.compareCapability?.(
                    requestAuthorityKind === 'BOOTSTRAP' ? 'BOOTSTRAP_RESPONSE' : 'SEQUENTIAL_RESPONSE',
                    responseCapabilitySnapshot, candidateBinding, true
                );
                const priorPending = replayPending.slice();
                const capacityDroppedBefore = replayPipelineDiagnostic.timingCapacityDropped;
                const firstFreshSequential = replayAwaitingFirstFreshSequentialResponse;
                if (replayAwaitingFirstFreshSequentialResponse) {
                    const targetOffsetMsec = Math.floor(replayStartTimeSeconds * 1000);
                    const hole = core?.summarizeReplayDisplayableTargetHole?.(result.messages, targetOffsetMsec);
                    const accounting = core?.summarizeReplayDisplayableAccounting?.(result.messages, targetOffsetMsec);
                    replayPipelineDiagnostic.freshSequentialResponseObserved = true;
                    replayPipelineDiagnostic.freshSequentialDisplayableMessageCount = accounting?.count || 0;
                    replayPipelineDiagnostic.freshSequentialDisplayableBefore = accounting?.before || 0;
                    replayPipelineDiagnostic.freshSequentialDisplayableDue = accounting?.due || 0;
                    replayPipelineDiagnostic.freshSequentialDisplayableFuture = accounting?.future || 0;
                    replayPipelineDiagnostic.freshSequentialDisplayableNearestBeforeTargetClass = hole?.nearestBeforeTargetClass || 'UNKNOWN';
                    replayPipelineDiagnostic.freshSequentialDisplayableNearestAfterTargetClass = hole?.nearestAfterTargetClass || 'UNKNOWN';
                    replayPipelineDiagnostic.freshSequentialDisplayableTargetBracketGapClass = hole?.targetBracketGapClass || 'UNKNOWN';
                    replayPipelineDiagnostic.freshSequentialDisplayableCurrentWindowState = hole?.currentWindowState || 'UNKNOWN';
                    replayPipelineDiagnostic.freshSequentialDisplayableCurrentWindowConfirmed = ['CONFIRMED_NEAR', 'CROSSES_WITH_SMALL_GAP', 'AFTER_NEAR']
                        .includes(replayPipelineDiagnostic.freshSequentialDisplayableCurrentWindowState);
                    replayAwaitingFirstFreshSequentialResponse = false;
                }
                replayPending = replayPending.concat(result.messages);
                flushReplayPending(generation, revision, lifecycleGeneration, diagnosticSequence);
                if (continuationSource === 'BUFFER_EARLY_RESUME') {
                    const currentVideo = getCurrentMainVideo();
                    const after = window.LiveFlowChatReadCore?.summarizeReplayTemporalAvailability?.(
                        replayPending, currentVideo?.currentTime, 0, REPLAY_MAX_PENDING
                    );
                    replayTemporalStarvationDiagnostic.earlyResumeCompleted = true;
                    replayEarlyResumeCompleted = true;
                    replayTemporalStarvationDiagnostic.earlyResumeProgressResult =
                        window.LiveFlowChatReadCore?.compareReplayTemporalCoverage?.(replayEarlyResumeCoverageBefore, after) || 'UNKNOWN';
                    replayEarlyResumeCoverageBefore = null;
                    updateReplayTemporalStarvationDiagnostic(0);
                }
                observeReplayPendingMerge(priorPending, result.messages, capacityDroppedBefore);
                if (firstFreshSequential) {
                    replayPipelineDiagnostic.firstFreshSequentialPriorPendingRetained = replayPipelineDiagnostic.replayPendingRetainedFromPriorResponse;
                    replayPipelineDiagnostic.firstFreshSequentialPendingAdded = replayPipelineDiagnostic.replayPendingAddedFromCurrentResponse;
                    replayPipelineDiagnostic.firstFreshSequentialCapacityDropped = replayPipelineDiagnostic.replayPendingCapacityDroppedCurrentMerge;
                }
                if (continuationSource === 'BUFFER_EARLY_RESUME' && replayPressureEpisodeActive &&
                    replayEpisodeAdvancedBudgetUsed === 1) {
                    observeReplayControlShadow('EARLY_RESUME_COMPLETED');
                    replayAcquisitionPausedForBuffer = true;
                    replayPausedSequentialAuthority = nextSequentialAuthority;
                    replayObservedSequentialAuthority = null;
                    nextSequentialAuthority = null;
                    replayPipelineDiagnostic.bufferSavedContinuationState = 'OBSERVED_UNUSED';
                    replayPipelineDiagnostic.bufferPauseActive = true;
                    replayPipelineDiagnostic.bufferPauseReason = 'COUNT_PRESSURE';
                    replayPipelineDiagnostic.unreadSequentialAuthorityAvailable = true;
                    replayRestartDiagnostic.lastStopReason = 'BUFFER_BOUND';
                    break;
                }
                if (diagnosticSequence === replayRestartDiagnostic.sequence) replayRestartDiagnostic.continuationAdvances += 1;
                if (diagnosticSequence === replayRestartDiagnostic.sequence && !replayRestartDiagnostic.currentWindowMessagePresent) setReplayRestartStage('ADVANCING_STALE', 'NONE', diagnosticSequence);
                if (replayPending.length >= REPLAY_MAX_PENDING) {
                    observeReplayControlShadow('BUFFER_HIGH_WATERMARK');
                    replayAcquisitionPausedForBuffer = true;
                    replayPausedSequentialAuthority = nextSequentialAuthority;
                    replayObservedSequentialAuthority = null;
                    nextSequentialAuthority = null;
                    replayPipelineDiagnostic.bufferSavedContinuationState = 'OBSERVED_UNUSED';
                    replayPipelineDiagnostic.bufferPauseActive = true;
                    replayPipelineDiagnostic.bufferPauseReason = 'COUNT_PRESSURE';
                    replayPipelineDiagnostic.bufferPauseEpochCount += 1;
                    if (!replayTemporalStarvationDiagnostic.episodeActive) {
                        replayTemporalStarvationDiagnostic = createReplayTemporalStarvationDiagnostic();
                        replayTemporalStarvationDiagnostic.episodeActive = true;
                        replayTemporalStarvationDiagnostic.episodeIdClass = 'ACTIVE';
                        replayTemporalStarvationDiagnostic.pauseReason = 'COUNT_PRESSURE';
                        replayPressureEpisodeActive = true;
                    }
                    replayPipelineDiagnostic.earlyResumeEligible = false;
                    replayPipelineDiagnostic.earlyResumeAttempted = false;
                    replayPipelineDiagnostic.earlyResumeStarted = false;
                    replayEarlyResumeSuppressionState = core?.transitionReplayEarlyResumeSuppression?.(
                        replayEarlyResumeSuppressionState, 'COUNT_PRESSURE_PAUSED'
                    ) || 'UNKNOWN';
                    replayPipelineDiagnostic.earlyResumeSuppressed = replayEarlyResumeSuppressionState !== 'CLEAR';
                    replayPipelineDiagnostic.earlyResumeSuppressionState = replayEarlyResumeSuppressionState;
                    replayPipelineDiagnostic.bufferPauseStartNearestFutureClass = replayPipelineDiagnostic.nearestFutureClass;
                    replayPipelineDiagnostic.unreadSequentialAuthorityAvailable = true;
                    const pausedState = core?.classifyReplayBufferPauseState?.({
                        paused: true,
                        pendingCount: replayPending.length,
                        nearestFutureClass: replayPipelineDiagnostic.nearestFutureClass,
                        maximumPending: REPLAY_MAX_PENDING
                    });
                    replayPipelineDiagnostic.bufferPauseTemporalState = pausedState?.temporalState || 'UNKNOWN';
                    replayPipelineDiagnostic.futureGapWhileBufferPaused = pausedState?.futureGapWhilePaused === true;
                    replayPipelineDiagnostic.bufferResumeBlockedByCount = pausedState?.resumeBlockedByCount === true;
                    updateReplayTemporalStarvationDiagnostic(0);
                    replayRestartDiagnostic.lastStopReason = 'BUFFER_BOUND';
                    break;
                }
            } else postReadResult(result, lifecycleGeneration);
            const continuationInfo = result.continuationInfo;
            if (mode === 'replay' && ['REPEATED', 'RETURNED_TO_SEEN', 'MISSING'].includes(replayPipelineDiagnostic.sequentialContinuationProgress)) break;
            if (mode !== 'replay') continuation = continuationInfo.continuation;
            if (mode === 'replay') continuationSource = 'SEQUENTIAL_RESPONSE';
            let nextReadDelayMs = result.effectiveDelayMs;
            if (mode === 'replay') {
                nextReadDelayMs = core?.getReplayCoverageAwareReadDelayMs?.(
                    result.effectiveDelayMs, replayPending, getCurrentMainVideo()?.currentTime
                );
                if (!Number.isFinite(nextReadDelayMs)) {
                    observeReplayControlShadow('AUTHORITY_FAILURE');
                    setReplayRestartStage('FAILED_CLOSED', 'OTHER', diagnosticSequence);
                    break;
                }
            }
            if (!await waitForNextRead(nextReadDelayMs, generation)) break;
        }

        if (activeLoopGeneration === generation) {
            activeLoopGeneration = 0;
        }
        const deferredGeneration = deferredReadStartGeneration;
        deferredReadStartGeneration = null;
        if (mode !== 'replay' && deferredGeneration === pageLifecycleGeneration && !navigationPending) {
            window.queueMicrotask(() => startReadLoop(deferredGeneration));
        }
    }

    function queueReplayReanchor(reason, epoch, video, waitForMediaEvent = false) {
        if (!['SEEK', 'AD_EXIT', 'FOREGROUND', 'INITIAL_ALIGNMENT'].includes(reason) || !video || replayReanchorLock || replayPlayerSeekDiagnosticLock) return false;
        if (!replaySeekAuthorityIsCurrent()) {
            replayProductionReanchorReason = replaySeekAuthority ? 'AUTHORITY_STALE' : 'NO_AUTHORITY';
            return false;
        }
        if (reason === 'SEEK' && epoch === replayLastAttemptedSeekEpoch) return false;
        if (reason === 'INITIAL_ALIGNMENT' && (epoch !== pageLifecycleGeneration ||
            replayInitialAlignmentAttemptedLifecycleId !== pageLifecycleGeneration)) return false;
        cancelReplayTemporalWakeup();
        replayReanchorIntent = {
            reason,
            epoch,
            video,
            lifecycleGeneration: pageLifecycleGeneration,
            revision: pageRevision,
            targetIdentity: pageState.targetIdentity,
            attempted: false
        };
        if (!waitForMediaEvent) window.queueMicrotask(() => runQueuedReplayReanchor(replayReanchorIntent));
        return true;
    }

    async function runQueuedReplayReanchor(intent) {
        if (!intent || intent !== replayReanchorIntent || intent.attempted || replayReanchorLock || replayPlayerSeekDiagnosticLock) return false;
        if (readRequestInFlight) return false;
        const video = getCurrentMainVideo();
        const bindingCurrent = intent.lifecycleGeneration === pageLifecycleGeneration && intent.revision === pageRevision &&
            intent.targetIdentity === pageState.targetIdentity && intent.video === video && pageState.mode === 'replay' &&
            runtimeUserEnabled === true && !document.hidden && !navigationPending && !replayAdIsActive() &&
            (intent.reason !== 'SEEK' || (!replaySeekInProgress && intent.epoch === replaySeekEpoch));
        const mediaReady = bindingCurrent && window.LiveFlowChatReadCore?.canRestartReplayAtCurrentPosition?.({
                mode: pageState.mode, userEnabled: runtimeUserEnabled, hidden: document.hidden,
                videoPresent: Boolean(video), paused: video?.paused, seeking: video?.seeking,
                ended: video?.ended, currentTime: video?.currentTime
            }) === true;
        const playerOffsetMs = mediaReady
            ? window.LiveFlowChatReadCore?.validatePlayerSeekOffset?.(video.currentTime, video.duration)
            : null;
        if (!bindingCurrent || !replaySeekAuthorityIsCurrent()) {
            replayProductionReanchorReason = replaySeekAuthority ? 'AUTHORITY_STALE' : 'NO_AUTHORITY';
            if (intent.reason === 'FOREGROUND') replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'STALE_AUTHORITY';
            if (replayReanchorIntent === intent) replayReanchorIntent = null;
            return false;
        }
        if (!mediaReady || playerOffsetMs === null) {
            if (intent.reason === 'FOREGROUND') replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'PLAYER_NOT_READY';
            if (intent.reason !== 'AD_EXIT' && replayReanchorIntent === intent) replayReanchorIntent = null;
            return false;
        }

        const reanchorGrant = authorizeReplayAuthority(
            replaySeekAuthority,
            'REANCHOR',
            currentReplayAuthorityBinding(pageLifecycleGeneration),
            0
        );
        if (!reanchorGrant) {
            replayProductionReanchorReason = 'AUTHORITY_STALE';
            if (intent.reason === 'FOREGROUND') replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'AUTHORIZATION_FAILED';
            replayReanchorIntent = null;
            observeReplayControlShadow('AUTHORITY_FAILURE');
            return false;
        }
        observeReplayControlShadow('REANCHOR_AUTHORIZED');
        intent.attempted = true;
        if (intent.reason === 'SEEK') replayLastAttemptedSeekEpoch = intent.epoch;
        if (intent.reason === 'AD_EXIT') replayAdExitNeedsReanchor = false;
        replayReanchorIntent = null;
        replayReanchorLock = true;
        if (intent.reason === 'FOREGROUND') replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'REQUEST_STARTED';
        replayProductionReanchorReason = 'NONE';
        const generation = ++currentLoopGeneration;
        activeLoopGeneration = generation;
        const controller = new AbortController();
        activeAbortController = controller;
        replayReanchorAbortController = controller;
        readRequestInFlight = true;
        const timeoutId = window.setTimeout(() => controller.abort(), REPLAY_REQUEST_TIMEOUT_MS);
        let freshSequentialAuthority = null;
        try {
            const claimed = replayControlPlaneCore?.claimAuthorityRequestGrant?.(reanchorGrant, 'REANCHOR');
            if (claimed?.ok !== true) {
                replayProductionReanchorReason = 'AUTHORITY_STALE';
                return false;
            }
            const reanchorCapabilitySnapshot = replayControlPlaneCore?.createCapabilitySnapshot?.({
                binding: currentReplayAuthorityBinding(pageLifecycleGeneration), evidenceEpoch: pageRevision,
                capabilities: {
                    reanchorRead: 'SUPPORTED', targetIdentity: 'SUPPORTED',
                    mainContentOwnership: 'SUPPORTED', playerTiming: 'SUPPORTED'
                }
            })?.snapshot;
            if (reanchorCapabilitySnapshot) replayControlShadow?.compareCapability?.(
                'REANCHOR', reanchorCapabilitySnapshot,
                currentReplayAuthorityBinding(pageLifecycleGeneration), true
            );
            readCount += 1;
            const result = await performRead(claimed.opaqueToken, pageState.context, readCount, pageRevision, generation, controller, 'replay', playerOffsetMs);
            const completionCurrent = generation === currentLoopGeneration && intent.lifecycleGeneration === pageLifecycleGeneration &&
                intent.revision === pageRevision && intent.targetIdentity === pageState.targetIdentity && !controller.signal.aborted;
            if (result?.ok && completionCurrent &&
                !document.hidden && replayProductionControlState?.phase === 'REANCHORING') {
                observeReplayPipelineResponse(result);
                replayPipelineDiagnostic.reanchorTemporalCoverage = result.reanchorTemporalCoverage || 'UNKNOWN';
                replayPipelineDiagnostic.reanchorAccepted = true;
                replayPipelineDiagnostic.reanchorAcceptedRelation = result.reanchorAcceptedRelation || 'NONE';
                replayPipelineDiagnostic.nearestBeforeTargetClass = result.replayTargetHole?.nearestBeforeTargetClass || 'UNKNOWN';
                replayPipelineDiagnostic.nearestAfterTargetClass = result.replayTargetHole?.nearestAfterTargetClass || 'UNKNOWN';
                replayPipelineDiagnostic.targetBracketGapClass = result.replayTargetHole?.targetBracketGapClass || 'UNKNOWN';
                replayPipelineDiagnostic.currentWindowState = result.replayTargetHole?.currentWindowState || 'UNKNOWN';
                replayPipelineDiagnostic.transportTemporalCoverageConfirmed = ['CONFIRMED_NEAR', 'CROSSES_WITH_SMALL_GAP', 'AFTER_NEAR']
                    .includes(replayPipelineDiagnostic.currentWindowState);
                replayPipelineDiagnostic.currentWindowConfirmed = replayPipelineDiagnostic.transportTemporalCoverageConfirmed;
                const displayableHole = result.replayDisplayableTargetHole;
                const displayableAccounting = result.replayDisplayableAccounting;
                replayPipelineDiagnostic.displayableNearestBeforeTargetClass = displayableHole?.nearestBeforeTargetClass || 'UNKNOWN';
                replayPipelineDiagnostic.displayableNearestAfterTargetClass = displayableHole?.nearestAfterTargetClass || 'UNKNOWN';
                replayPipelineDiagnostic.displayableTargetBracketGapClass = displayableHole?.targetBracketGapClass || 'UNKNOWN';
                replayPipelineDiagnostic.displayableCurrentWindowState = displayableHole?.currentWindowState || 'UNKNOWN';
                replayPipelineDiagnostic.displayableCurrentWindowConfirmed = ['CONFIRMED_NEAR', 'CROSSES_WITH_SMALL_GAP', 'AFTER_NEAR']
                    .includes(replayPipelineDiagnostic.displayableCurrentWindowState);
                replayPipelineDiagnostic.reanchorTimestampedActionCount = result.reanchorTimestampedActionCount || 0;
                replayPipelineDiagnostic.reanchorDisplayableMessageCount = displayableAccounting?.count || 0;
                replayPipelineDiagnostic.reanchorDisplayableBefore = displayableAccounting?.before || 0;
                replayPipelineDiagnostic.reanchorDisplayableDue = displayableAccounting?.due || 0;
                replayPipelineDiagnostic.reanchorDisplayableFuture = displayableAccounting?.future || 0;
                replayPipelineDiagnostic.reanchorProductionState = replayPipelineDiagnostic.transportTemporalCoverageConfirmed
                    ? 'REANCHOR_CONFIRMED' : 'SPARSE_UNCONFIRMED';
                replayPipelineDiagnostic.reanchorTimestampedActionsObserved = result.reanchorTemporalCoverage !== 'NO_TIMESTAMPED_ACTIONS' &&
                    result.reanchorTemporalCoverage !== 'UNKNOWN';
                replayPipelineDiagnostic.reanchorReplayContinuationObserved = Boolean(result.continuationInfo?.continuation);
                replayPipelineDiagnostic.reanchorPlayerSeekContinuationObserved = result.playerSeekContinuationObserved === true;
                replayStartTimeSeconds = playerOffsetMs / 1000;
                replayPending = result.messages;
                const capacityDroppedBefore = replayPipelineDiagnostic.timingCapacityDropped;
                flushReplayPending(generation, pageRevision, pageLifecycleGeneration);
                observeReplayPendingMerge([], result.messages, capacityDroppedBefore);
                const freshBinding = currentReplayAuthorityBinding(generation);
                freshSequentialAuthority = createSequentialAuthorityCandidate(
                    result.continuationInfo?.continuation || '', freshBinding
                );
                const responseCapabilitySnapshot = replayControlPlaneCore?.createCapabilitySnapshot?.({
                    binding: freshBinding, evidenceEpoch: pageRevision,
                    capabilities: { replayMessages: 'SUPPORTED', sequentialRead: freshSequentialAuthority ? 'SUPPORTED' : 'UNKNOWN' }
                })?.snapshot;
                if (responseCapabilitySnapshot) replayControlShadow?.compareCapability?.(
                    'REANCHOR_RESPONSE', responseCapabilitySnapshot, freshBinding, Boolean(freshSequentialAuthority)
                );
                if (!freshSequentialAuthority) replayProductionReanchorReason = 'NO_FRESH_CHAIN';
            } else if (completionCurrent && result?.errorType === 'reanchor_relation_all_before') {
                replayProductionReanchorReason = 'RELATION_ALL_BEFORE';
            } else if (completionCurrent && result?.errorType === 'reanchor_relation_unknown') {
                replayProductionReanchorReason = 'RELATION_UNKNOWN';
            } else if (completionCurrent && result?.errorType && ['invalid_json', 'missing_replay_actions', 'invalid_replay_continuation', 'parser_exception'].includes(result.errorType)) {
                replayProductionReanchorReason = 'REANCHOR_SCHEMA_INVALID';
            } else if (completionCurrent && !result?.ok) {
                replayProductionReanchorReason = 'OTHER';
            }
            if (intent.reason === 'FOREGROUND' && !freshSequentialAuthority) {
                replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = controller.signal.aborted && document.hidden
                    ? 'REHIDDEN_ABORTED' : 'REQUEST_FAILED';
            }
            if (completionCurrent && !result?.ok) replayPipelineDiagnostic.reanchorProductionState = 'REANCHOR_FAILED';
        } finally {
            window.clearTimeout(timeoutId);
            readRequestInFlight = false;
            if (activeAbortController === controller) activeAbortController = null;
            if (replayReanchorAbortController === controller) replayReanchorAbortController = null;
            if (activeLoopGeneration === generation) activeLoopGeneration = 0;
            replayReanchorLock = false;
        }
        if (freshSequentialAuthority && generation === currentLoopGeneration && pageState.mode === 'replay' && isCurrentPageStateTarget()) {
            const sequentialGrant = authorizeSequentialAuthority(
                freshSequentialAuthority, currentReplayAuthorityBinding(generation), 0
            );
            if (!sequentialGrant) {
                replayProductionReanchorReason = 'NO_FRESH_CHAIN';
                observeReplayControlShadow('REANCHOR_FAILED');
                return false;
            }
            observeReplayControlShadow('REANCHOR_SUCCEEDED');
            replayPipelineDiagnostic.freshChainStarted = true;
            replayPipelineDiagnostic.freshChainSource = 'PLAYER_SEEK_RESPONSE_REPLAY_CONTINUATION';
            replayAwaitingFirstFreshSequentialResponse = true;
            if (intent.reason === 'FOREGROUND') {
                replayForegroundRecoveryDiagnostic.freshSequentialHandoff = true;
                replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'SUCCESS';
            }
            window.queueMicrotask(() => startReadLoop(pageLifecycleGeneration, 'PLAYER_SEEK_HANDOFF', sequentialGrant));
            return true;
        }
        const completionStillCurrent = generation === currentLoopGeneration && intent.lifecycleGeneration === pageLifecycleGeneration &&
            intent.revision === pageRevision && intent.targetIdentity === pageState.targetIdentity && !controller.signal.aborted;
        if (completionStillCurrent) observeReplayControlShadow('REANCHOR_FAILED');
        return false;
    }

    function settleReplayAdExit(event = null) {
        if (!replayAdExitNeedsReanchor || replayAdActive || pageState.mode !== 'replay') return false;
        const video = getCurrentMainVideo();
        if (event?.target && event.target !== video) return false;
        if (replayReanchorIntent?.reason === 'AD_EXIT' && replayReanchorIntent.video !== video) replayReanchorIntent = null;
        if (replayReanchorIntent?.reason === 'AD_EXIT') {
            const intent = replayReanchorIntent;
            window.queueMicrotask(() => runQueuedReplayReanchor(intent));
            return true;
        }
        return queueReplayReanchor('AD_EXIT', replaySeekEpoch, video, true);
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-content-script') return;
        if (event.data.type === REQUEST_TYPE) {
            if (runtimeUserEnabled === false) beginReplayRestart('ENABLE');
            respond();
            return;
        }
        if (event.data.type === READ_REQUEST_TYPE) {
            if (runtimeUserEnabled === false) beginReplayRestart('ENABLE');
            runtimeUserEnabled = true;
            if (pageState.mode === 'replay') startReplayBootstrap(event.data.pageLifecycleGeneration);
            else startReadLoop(event.data.pageLifecycleGeneration);
            return;
        }
        if (event.data.type === STOP_READ_LOOP_TYPE) {
            runtimeUserEnabled = false;
            terminateReplayForegroundRetainedDiagnostic('STALE_BINDING', true);
            observeReplayControlShadow('DISABLE', {}, 'STOPPED');
            invalidateReplayCredentiallessSchemaDiagnostic();
            invalidateReplaySeekAuthority();
            stopReadLoop('user-disabled');
            return;
        }
        if (event.data.type === REPLAY_AD_ENTER_TYPE) {
            if (pageState.mode === 'replay' && !replayAdActive) {
                terminateReplayForegroundRetainedDiagnostic('VISIBLE_PRECONDITION_FAILED', true);
                replayAdActive = true;
                observeReplayRuntimeAccounting('ad-enter');
                replayAdExitNeedsReanchor = false;
                replaySeekInProgress = false;
                replayReanchorIntent = null;
                enterReplaySuspended('AD');
            }
            return;
        }
        if (event.data.type === REPLAY_AD_EXIT_TYPE) {
            if (replayAdActive && pageState.mode === 'replay') {
                replayAdActive = false;
                observeReplayRuntimeAccounting('ad-exit');
                if (document.hidden || replayProductionControlState?.suspendedReason === 'HIDDEN') return;
                if (!runtimeUserEnabled) {
                    observeReplayControlShadow('AD_EXIT_READY', { hidden: false });
                    observeReplayControlShadow('REANCHOR_FAILED');
                    return;
                }
                replayAdExitNeedsReanchor = true;
                observeReplayControlShadow('AD_EXIT_READY', { hidden: false });
                observeSuspendedRecoveryCapabilities();
                if (!settleReplayAdExit()) observeReplayControlShadow('REANCHOR_FAILED');
            }
            return;
        }
        if (event.data.type === REPLAY_DISPLAYED_TYPE && pageState.mode === 'replay' && event.data.pageLifecycleGeneration === pageLifecycleGeneration) {
            replayRestartDiagnostic.displayedSinceRestart = true;
            replayPipelineDiagnostic.launched += 1;
            replayPipelineDiagnostic.firstLaunchObserved = true;
            observeReplayRuntimeAccounting('displayed');
            return;
        }
        if (event.data.type === REPLAY_PIPELINE_DIAGNOSTIC_TYPE && pageState.mode === 'replay' &&
            event.data.pageLifecycleGeneration === pageLifecycleGeneration) {
            for (const [eventKey, diagnosticKey] of [['inputCount', 'bridgeInput'], ['enqueuedCount', 'enqueued'],
                ['visibilityFiltered', 'visibilityFiltered'], ['enqueueRejected', 'enqueueRejected'],
                ['exactIdDedupedCount', 'bridgeDeduped'], ['lifecycleDiscarded', 'lifecycleDiscarded'],
                ['lifecycleDiscardedDisplayDisabled', 'lifecycleDiscardedDisplayDisabled'],
                ['lifecycleDiscardedMediaMissing', 'lifecycleDiscardedMediaMissing'],
                ['lifecycleDiscardedMediaPaused', 'lifecycleDiscardedMediaPaused'],
                ['lifecycleDiscardedMediaEnded', 'lifecycleDiscardedMediaEnded'],
                ['lifecycleDiscardedMediaNotReady', 'lifecycleDiscardedMediaNotReady'],
                ['lifecycleDiscardedAdShowing', 'lifecycleDiscardedAdShowing'],
                ['lifecycleDiscardedAdInterrupting', 'lifecycleDiscardedAdInterrupting']]) {
                if (Number.isInteger(event.data[eventKey]) && event.data[eventKey] >= 0) replayPipelineDiagnostic[diagnosticKey] += event.data[eventKey];
            }
            const scheduler = event.data.scheduler;
            if (scheduler && typeof scheduler === 'object') {
                for (const key of ['pendingCurrent', 'opportunitiesArmed', 'opportunitiesEvaluated', 'stalePruned', 'staleAfterCollision', 'staleAfterPacing', 'staleAfterSelectionMiss', 'staleAlreadyOnEnqueue', 'staleOther', 'selectionNone', 'selectionNoneNoPending', 'selectionNoneCollisionBlocked', 'selectionNoneNoEligible', 'collisionBlocked', 'geometryUnknown', 'generationInvalidated', 'geometryInvalidated', 'launchAttempted', 'launchRejected', 'launchCommitted', 'collisionActiveDanmaku', 'collisionSubtitle', 'collisionCandidateGeometry', 'collisionNoUsableLane', 'collisionOther']) {
                    if (Number.isInteger(scheduler[key]) && scheduler[key] >= 0) replayPipelineDiagnostic[key] = scheduler[key];
                }
                if (['IDLE', 'ARMED', 'EVALUATING'].includes(scheduler.schedulerState)) replayPipelineDiagnostic.schedulerState = scheduler.schedulerState;
                if (['NONE', 'SHORT', 'NOTICEABLE', 'LONG'].includes(scheduler.launchGapClass)) replayPipelineDiagnostic.launchGapClass = scheduler.launchGapClass;
                const gapCause = scheduler.launchGapCause === 'NO_DUE_COMMENT' && replayPending.length > 0 ? 'WAITING_FOR_FUTURE' : scheduler.launchGapCause;
                if (['NO_DUE_COMMENT', 'WAITING_FOR_FUTURE', 'PACING', 'COLLISION_BLOCKED', 'SELECTION_NONE', 'GEOMETRY', 'STALE_ONLY', 'UNKNOWN'].includes(gapCause)) replayPipelineDiagnostic.launchGapCause = gapCause;
                for (const key of ['launchGapDuePending', 'launchGapEligibleCandidate', 'launchGapActiveDanmaku', 'launchGapCollisionBlocked']) {
                    if (typeof scheduler[key] === 'boolean') replayPipelineDiagnostic[key] = scheduler[key];
                }
                if (['IDLE', 'ARMED', 'EVALUATING'].includes(scheduler.launchGapSchedulerState)) replayPipelineDiagnostic.launchGapSchedulerState = scheduler.launchGapSchedulerState;
                if (['NORMAL', 'COMPACT', 'DENSE', 'MAX_READABLE'].includes(scheduler.launchGapDensityLevel)) replayPipelineDiagnostic.launchGapDensityLevel = scheduler.launchGapDensityLevel;
                replayPipelineDiagnostic.launchGapNearestFutureClass = replayPipelineDiagnostic.nearestFutureClass;
            }
            observeReplayRuntimeAccounting('scheduler');
            return;
        }
        if (event.data.type === RESUME_READ_LOOP_TYPE) {
            requestVisibilityResume(event.data.pageLifecycleGeneration, event.data.userEnabled === true);
            return;
        }
    });

    window.addEventListener('yt-navigate-finish', (event) => respond({ navigationFinished: true, eventSource: 'yt-navigate-finish', event }));
    window.addEventListener('yt-navigate-start', () => invalidatePageLifecycle('yt-navigate-start'));
    window.addEventListener('yt-page-data-updated', () => respond({ pageDataUpdated: true, eventSource: 'yt-page-data-updated' }));
    window.addEventListener('liveflow-chat-frame-role-change', (event) => {
        if (event.detail?.generation !== pageLifecycleGeneration) return;
        respond({ ownershipMutation: true, eventSource: 'chat-frame-role', expectedLifecycleGeneration: pageLifecycleGeneration });
    });
    window.addEventListener('pagehide', () => {
        observeReplayRuntimeAccounting('pagehide');
        terminateReplayForegroundRetainedDiagnostic('STALE_BINDING', true);
        observeReplayControlShadow('NAVIGATION', {}, 'STOPPED');
        disconnectWatchRootObserver();
        invalidateReplaySeekAuthority();
        stopReadLoop('pagehide');
    });
    window.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (pageState.mode === 'replay') enterReplaySuspended('HIDDEN');
            else if (activeLoopGeneration !== 0 || readRequestInFlight || activeWaitTimer !== null) stopReadLoop('visibility-hidden');
            observeReplayRuntimeAccounting('visibility-hidden');
        }
    });
    window.addEventListener('timeupdate', (event) => {
        if (event.target !== getCurrentMainVideo()) return;
        replayPipelineDiagnostic.ownedVideoTimeupdateObserved += 1;
        flushReplayPending(currentLoopGeneration, pageRevision, pageLifecycleGeneration, replayRestartDiagnostic.sequence, 'timeupdate');
    }, true);
    window.addEventListener('pause', (event) => {
        if (event.target !== getCurrentMainVideo()) return;
        cancelReplayTemporalWakeup();
        observeReplayControlShadow('MEDIA_PAUSE');
        suspendReplayForMediaPause();
    }, true);
    for (const type of ['waiting', 'stalled']) window.addEventListener(type, (event) => {
        if (event.target === getCurrentMainVideo()) cancelReplayTemporalWakeup();
    }, true);
    window.addEventListener('seeking', (event) => {
        if (event.target !== getCurrentMainVideo()) return;
        terminateReplayForegroundRetainedDiagnostic('STALE_BINDING', true);
        if (replayProductionControlState?.phase === 'SUSPENDED' && replayProductionControlState.suspendedReason === 'HIDDEN') {
            invalidateAuthorityHandle(replaySeekAuthority);
            replaySeekAuthority = null;
            replayForegroundRecoveryOwnedVideo = null;
            replayForegroundRecoveryDiagnostic.foregroundRecoveryResult = 'PRECONDITION_FAILED';
            observeReplayControlShadow('SEEK_STARTED');
            return;
        }
        if (!replaySeekInProgress) {
            replaySeekInProgress = true;
            replaySeekNeedsReanchor = true;
            replaySeekEpoch += 1;
            observeReplayRuntimeAccounting('seek');
            observeReplayControlShadow('SEEK_STARTED');
            replayPipelineDiagnostic = createReplayPipelineDiagnostic();
            replayTimingDiagnosticSeen = createReplayTimingDiagnosticSeen();
            replayAwaitingFirstFreshSequentialResponse = false;
            replayReanchorIntent = null;
            beginReplayRestart('SEEK');
            stopReplayContext('seek');
        }
    }, true);
    function restartReplayFromCurrentPosition(event, explicitReason = null) {
        if (event && event.target !== getCurrentMainVideo()) return;
        if (event?.type === 'seeked') {
            replaySeekInProgress = false;
            observeReplayControlShadow('SEEK_COMPLETED');
        }
        const restartReason = explicitReason || (event?.type === 'seeked' || (event?.type === 'play' && replaySeekNeedsReanchor)
            ? 'SEEK' : event?.type === 'play' ? 'RESUME' : event?.type === 'ratechange' ? 'RATE_CHANGE' : 'OTHER');
        if (event?.type === 'play' && restartReason === 'RESUME') observeReplayControlShadow('MEDIA_PLAY');
        if (event?.type === 'ratechange') observeReplayControlShadow('PLAYBACK_RATE_CHANGED');
        if (replayRestartDiagnostic.restartReason !== 'SEEK' || restartReason !== 'SEEK') beginReplayRestart(restartReason);
        const video = getCurrentMainVideo();
        const canRestart = window.LiveFlowChatReadCore?.canRestartReplayAtCurrentPosition?.({
            mode: pageState.mode, userEnabled: runtimeUserEnabled, hidden: document.hidden,
            videoPresent: Boolean(video), paused: video?.paused, seeking: video?.seeking,
            ended: video?.ended, currentTime: video?.currentTime
        }) === true;
        if (!canRestart) {
            setReplayRestartStage('WAITING_MEDIA');
            return;
        }
        const generation = pageLifecycleGeneration;
        window.queueMicrotask(() => {
            const currentVideo = getCurrentMainVideo();
            const stillCanRestart = video === currentVideo && window.LiveFlowChatReadCore?.canRestartReplayAtCurrentPosition?.({
                mode: pageState.mode, userEnabled: runtimeUserEnabled, hidden: document.hidden,
                videoPresent: Boolean(currentVideo), paused: currentVideo?.paused, seeking: currentVideo?.seeking,
                ended: currentVideo?.ended, currentTime: currentVideo?.currentTime
            }) === true;
            if (!stillCanRestart) {
                setReplayRestartStage('WAITING_MEDIA');
                return;
            }
            if (restartReason === 'SEEK') {
                if (queueReplayReanchor('SEEK', replaySeekEpoch, currentVideo)) replaySeekNeedsReanchor = false;
                return;
            }
            if (restartReason === 'RESUME' && readStopReason === 'playback-paused' && replayPausedSequentialAuthority) {
                flushReplayPending(currentLoopGeneration, pageRevision, pageLifecycleGeneration,
                    replayRestartDiagnostic.sequence, 'media-resume');
                return;
            }
            const watchRoot = document.querySelector('ytd-watch-flexy');
            const frameRole = window.LiveFlowChatFrameRole?.snapshot?.(watchRoot, generation);
            if (frameRole?.role !== 'REPLAY_CHAT' || frameRole.sourceMatchesOwnedFrame !== true || frameRole.frameConnected !== true || frameRole.generationCurrent !== true) setReplayRestartStage('WAITING_FRAME_ROLE');
            if (respond({ eventSource: 'request', expectedLifecycleGeneration: generation }) && pageState.mode === 'live') startReadLoop(generation);
            else if (replayRestartDiagnostic.restartStage !== 'WAITING_FRAME_ROLE') setReplayRestartStage('WAITING_SNAPSHOT');
        });
    }
    window.addEventListener('play', restartReplayFromCurrentPosition, true);
    window.addEventListener('seeked', restartReplayFromCurrentPosition, true);
    window.addEventListener('playing', settleReplayAdExit, true);
    window.addEventListener('canplay', settleReplayAdExit, true);
    function resumeReplayTemporalWakeup(event) {
        if (event.target === getCurrentMainVideo() && pageState.mode === 'replay' && replayPending.length > 0 &&
            !replayAdActive && !replaySeekInProgress && !navigationPending) {
            flushReplayPending(currentLoopGeneration, pageRevision, pageLifecycleGeneration,
                replayRestartDiagnostic.sequence, 'temporal-wakeup');
        }
    }
    window.addEventListener('playing', resumeReplayTemporalWakeup, true);
    window.addEventListener('canplay', resumeReplayTemporalWakeup, true);
    window.addEventListener('loadeddata', settleReplayAdExit, true);
    window.addEventListener('ratechange', (event) => {
        if (event.target !== getCurrentMainVideo() || !stopReplayContext('playback-rate-change')) return;
        restartReplayFromCurrentPosition(event, 'RATE_CHANGE');
    }, true);
    window.LiveFlowReplayRestartDiagnostic = Object.freeze({
        status() {
            const video = getCurrentMainVideo();
            const watchRoot = document.querySelector('ytd-watch-flexy');
            const frameRole = window.LiveFlowChatFrameRole?.snapshot?.(watchRoot, pageLifecycleGeneration);
            const snapshot = watchRoot?.data;
            const targetIdentity = window.LiveFlowChatReadCore?.extractWatchTargetIdentity?.(window.location.href) || '';
            const targetEvidence = readBootstrapTargetEvidence(snapshot, watchRoot);
            const target = window.LiveFlowChatReadCore?.evaluateBootstrapTarget?.(targetIdentity, targetEvidence.authoritative, targetEvidence.supporting);
            return Object.freeze({
                restartReason: replayRestartDiagnostic.restartReason,
                restartStage: replayRestartDiagnostic.restartStage,
                runtimeEnabled: runtimeUserEnabled === true,
                mainVideoPlayable: Boolean(video && !video.paused && !video.ended && Number.isFinite(video.currentTime)),
                seeking: video?.seeking === true,
                frameRoleCurrent: frameRole?.role === 'REPLAY_CHAT' && frameRole.generationCurrent === true,
                ownedFrameConnected: frameRole?.sourceMatchesOwnedFrame === true && frameRole.frameConnected === true,
                sameSnapshotCurrent: target?.matched === true && Boolean(readContinuation(snapshot)),
                generationCurrent: replayRestartDiagnostic.generation === pageLifecycleGeneration,
                requestInFlight: readRequestInFlight === true,
                pendingCountBucket: replayPendingBucket(replayPending.length),
                currentWindowMessagePresent: replayRestartDiagnostic.currentWindowMessagePresent === true,
                displayedSinceRestart: replayRestartDiagnostic.displayedSinceRestart === true,
                restartElapsedBucket: replayElapsedBucket(replayRestartDiagnostic.startedAt),
                continuationAdvanceBucket: replayCountBucket(replayRestartDiagnostic.continuationAdvances),
                lastStopReason: replayRestartDiagnostic.lastStopReason,
                lastFailReason: replayRestartDiagnostic.lastFailReason
            });
        }
    });
    window.LiveFlowReplayProductionReanchorDiagnostic = Object.freeze({
        status() {
            return Object.freeze({
                authorityAvailable: replaySeekAuthorityIsCurrent(),
                inFlight: replayReanchorLock === true,
                reason: REPLAY_REANCHOR_FAILURE_REASONS.has(replayProductionReanchorReason)
                    ? replayProductionReanchorReason : 'OTHER'
            });
        }
    });
    window.LiveFlowReplayPipelineDiagnostic = Object.freeze({
        status() {
            return Object.freeze({ ...replayPipelineDiagnostic });
        }
    });
    window.LiveFlowReplayForegroundRecoveryDiagnostic = Object.freeze({
        status: replayForegroundRecoveryStatus
    });
    window.LiveFlowReplayCredentiallessSchemaDiagnostic = Object.freeze({
        arm() {
            invalidateReplayCredentiallessSchemaDiagnostic();
            const ready = pageState.mode === 'replay' && runtimeUserEnabled === true && navigationPending === false &&
                pageState.bootstrapTargetMatched === true && pageState.targetIdentity.length > 0 && isCurrentPageStateTarget();
            if (ready) {
                replayCredentiallessSchemaDiagnostic = {
                    armed: true,
                    observed: false,
                    result: 'UNKNOWN',
                    lifecycleGeneration: pageLifecycleGeneration,
                    revision: pageRevision,
                    targetIdentity: pageState.targetIdentity
                };
            }
            return replayCredentiallessSchemaDiagnosticStatus();
        },
        status: replayCredentiallessSchemaDiagnosticStatus
    });
    window.LiveFlowReplayForegroundRetainedReanchorDiagnostic = Object.freeze({
        arm() {
            if (replayForegroundRetainedAbortController) replayForegroundRetainedAbortController.abort();
            replayForegroundRetainedAbortController = null;
            replayForegroundRetainedDiagnostic = createReplayForegroundRetainedDiagnostic();
            const video = getCurrentMainVideo();
            const ready = pageState.mode === 'replay' && runtimeUserEnabled === true && !document.hidden &&
                !navigationPending && !replayAdActive && !replaySeekInProgress && !replayReanchorLock &&
                !replayPlayerSeekDiagnosticLock && !readRequestInFlight && activeLoopGeneration !== 0 &&
                isCurrentPageStateTarget() && video && !video.paused && !video.ended && !video.seeking &&
                Number.isFinite(video.currentTime);
            if (ready) {
                replayForegroundRetainedDiagnostic.armed = true;
                replayForegroundRetainedDiagnostic.result = 'NO_CANDIDATE';
            }
            return replayForegroundRetainedStatus();
        },
        async run() {
            const diagnostic = replayForegroundRetainedDiagnostic;
            const video = getCurrentMainVideo();
            const playerOffsetMs = window.LiveFlowChatReadCore?.validatePlayerSeekOffset?.(video?.currentTime, video?.duration);
            diagnostic.bindingCurrent = diagnostic.lifecycleGeneration === pageLifecycleGeneration &&
                diagnostic.revision === pageRevision && diagnostic.targetIdentity === pageState.targetIdentity;
            diagnostic.ownershipCurrent = Boolean(video && video === getCurrentMainVideo() && !video.paused &&
                !video.ended && !video.seeking && playerOffsetMs !== null && isCurrentPageStateTarget());
            const binding = currentReplayAuthorityBinding(pageLifecycleGeneration);
            const capabilitySnapshot = replayControlPlaneCore?.createCapabilitySnapshot?.({
                binding, evidenceEpoch: pageRevision,
                capabilities: {
                    reanchorRead: diagnostic.captured ? 'SUPPORTED' : 'UNKNOWN',
                    targetIdentity: diagnostic.bindingCurrent && isCurrentPageStateTarget() ? 'SUPPORTED' : 'UNKNOWN',
                    mainContentOwnership: diagnostic.ownershipCurrent ? 'SUPPORTED' : 'UNKNOWN',
                    playerTiming: playerOffsetMs !== null ? 'SUPPORTED' : 'UNKNOWN'
                }
            })?.snapshot;
            const capabilityAllowed = replayControlPlaneCore?.canUseCapabilityPath?.(
                'HIDDEN_RECOVERY', capabilitySnapshot, binding
            )?.allowed === true;
            const eligibility = replayControlPlaneCore?.evaluateForegroundRetainedDiagnosticEligibility?.({
                armed: diagnostic.armed, captured: diagnostic.captured,
                hiddenObserved: diagnostic.hiddenObserved, visibleObserved: diagnostic.visibleObserved,
                terminal: diagnostic.terminal, requestCount: diagnostic.requestCount,
                bindingCurrent: diagnostic.bindingCurrent, ownershipCurrent: diagnostic.ownershipCurrent,
                capabilityAllowed, documentVisible: document.visibilityState === 'visible',
                noAd: !replayAdActive, noSeek: !replaySeekInProgress, noNavigation: !navigationPending,
                noReadRequest: !readRequestInFlight, noReanchorRequest: !replayReanchorLock,
                noDiagnosticConflict: !replayPlayerSeekDiagnosticLock,
                noDiagnosticRequest: !replayForegroundRetainedAbortController,
                controlStopped: replayProductionControlState?.phase === 'STOPPED',
                tokenAvailable: typeof diagnostic.opaqueToken === 'string' && diagnostic.opaqueToken.length > 0,
                contextAvailable: Boolean(pageState.context)
            }) || { allowed: false, reason: 'VISIBLE_PRECONDITION_FAILED' };
            if (!eligibility.allowed) {
                terminateReplayForegroundRetainedDiagnostic(eligibility.reason === 'STALE_BINDING' ? 'STALE_BINDING' : 'VISIBLE_PRECONDITION_FAILED', false);
                return replayForegroundRetainedStatus();
            }

            const retainedToken = diagnostic.opaqueToken;
            diagnostic.opaqueToken = '';
            diagnostic.requestStarted = true;
            diagnostic.requestCount = 1;
            diagnostic.result = 'REQUEST_STARTED';
            diagnostic.terminal = true;
            replayPlayerSeekDiagnosticLock = true;
            const controller = new AbortController();
            replayForegroundRetainedAbortController = controller;
            try {
                const result = await performRead(retainedToken, pageState.context, readCount + 1, pageRevision,
                    currentLoopGeneration, controller, 'replay', playerOffsetMs, false, false);
                diagnostic.responseValidated = result?.ok === true;
                diagnostic.relationAccepted = ['CROSSES_TARGET', 'ALL_NEAR_OR_AFTER_TARGET'].includes(result?.reanchorAcceptedRelation);
                diagnostic.freshSequentialObserved = Boolean(result?.continuationInfo?.continuation);
                if (controller.signal.aborted) diagnostic.result = 'ABORTED';
                else if (result?.status && (result.status < 200 || result.status >= 300)) diagnostic.result = 'HTTP_FAILED';
                else if (result?.errorType === 'reanchor_relation_all_before' || result?.errorType === 'reanchor_relation_unknown') diagnostic.result = 'RELATION_REJECTED';
                else if (!diagnostic.responseValidated) diagnostic.result = 'RESPONSE_INVALID';
                else if (!diagnostic.freshSequentialObserved) diagnostic.result = 'FRESH_SEQUENTIAL_MISSING';
                else diagnostic.result = 'SUCCESS';
            } catch {
                diagnostic.result = controller.signal.aborted ? 'ABORTED' : 'RESPONSE_INVALID';
            } finally {
                replayPlayerSeekDiagnosticLock = false;
                if (replayForegroundRetainedAbortController === controller) replayForegroundRetainedAbortController = null;
            }
            return replayForegroundRetainedStatus();
        },
        status: replayForegroundRetainedStatus
    });
    window.LiveFlowReplayPlayerSeekActiveDiagnostic = Object.freeze({
        arm() {
            abortReplayPlayerSeekDiagnostic();
            const ready = pageState.mode === 'replay' && runtimeUserEnabled === true && navigationPending === false &&
                pageState.bootstrapTargetMatched === true && pageState.targetIdentity.length > 0 && isCurrentPageStateTarget() &&
                activeLoopGeneration !== 0;
            if (ready) replayPlayerSeekDiagnostic = {
                ...createReplayPlayerSeekDiagnostic(), armed: true, lifecycleGeneration: pageLifecycleGeneration,
                revision: pageRevision, readGeneration: currentLoopGeneration, targetIdentity: pageState.targetIdentity
            };
            return replayPlayerSeekDiagnosticStatus();
        },
        async run() {
            const diagnostic = replayPlayerSeekDiagnostic;
            const video = getCurrentMainVideo();
            const playerOffsetMs = window.LiveFlowChatReadCore?.validatePlayerSeekOffset?.(video?.currentTime, video?.duration);
            const canRun = window.LiveFlowChatReadCore?.canRunPlayerSeekDiagnostic?.({
                armed: diagnostic.armed, ready: diagnostic.ready, consumed: diagnostic.consumed, inFlight: diagnostic.inFlight,
                productionRequestInFlight: readRequestInFlight, diagnosticLocked: replayPlayerSeekDiagnosticLock,
                mode: pageState.mode, runtimeEnabled: runtimeUserEnabled, hidden: document.hidden, navigationPending,
                armedLifecycleGeneration: diagnostic.lifecycleGeneration, currentLifecycleGeneration: pageLifecycleGeneration,
                armedRevision: diagnostic.revision, currentRevision: pageRevision,
                targetMatches: diagnostic.targetIdentity === pageState.targetIdentity, targetCurrent: isCurrentPageStateTarget(),
                videoPresent: Boolean(video), seeking: video?.seeking === true, offsetValid: playerOffsetMs !== null
            }) === true;
            if (!canRun) {
                const reason = window.LiveFlowChatReadCore?.getPlayerSeekDiagnosticNotSentReason?.({
                    armed: diagnostic.armed, ready: diagnostic.ready, consumed: diagnostic.consumed, inFlight: diagnostic.inFlight,
                    productionRequestInFlight: readRequestInFlight, diagnosticLocked: replayPlayerSeekDiagnosticLock,
                    mode: pageState.mode, runtimeEnabled: runtimeUserEnabled, hidden: document.hidden, navigationPending,
                    armedLifecycleGeneration: diagnostic.lifecycleGeneration, currentLifecycleGeneration: pageLifecycleGeneration,
                    armedRevision: diagnostic.revision, currentRevision: pageRevision,
                    targetMatches: diagnostic.targetIdentity === pageState.targetIdentity, targetCurrent: isCurrentPageStateTarget(),
                    videoPresent: Boolean(video), seeking: video?.seeking === true, offsetValid: playerOffsetMs !== null
                }) || 'OTHER';
                return replayPlayerSeekDiagnosticNotSentStatus(reason);
            }
            const context = pageState.context;
            const continuation = diagnostic.continuation;
            if (!context || !continuation) return replayPlayerSeekDiagnosticNotSentStatus('OTHER');

            diagnostic.armed = false;
            diagnostic.consumed = true;
            diagnostic.ready = false;
            diagnostic.continuation = '';
            diagnostic.inFlight = true;
            diagnostic.notSentReason = 'NONE';
            diagnostic.result = { ...emptyPlayerSeekResult(), requestAttempted: true };
            replayPlayerSeekDiagnosticLock = true;
            // The explicit Gate owns the only READ slot and never resumes the old
            // sequential traversal after completion. A later normal lifecycle event
            // may establish a fresh Production generation.
            currentLoopGeneration += 1;
            activeLoopGeneration = 0;
            deferredReadStartGeneration = null;
            const controller = new AbortController();
            replayPlayerSeekDiagnosticAbortController = controller;
            let timedOut = false;
            const timeoutId = window.setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
            try {
                const requestBody = window.LiveFlowChatReadCore?.buildLiveChatReadRequest?.(context, continuation);
                if (requestBody) {
                    requestBody.currentPlayerState = { playerOffsetMs };
                    const diagnosticFetch = window.fetch.bind(window);
                    const response = await diagnosticFetch('/youtubei/v1/live_chat/get_live_chat_replay?prettyPrint=false', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody),
                        credentials: 'omit', signal: controller.signal
                    });
                    if (!window.LiveFlowChatReadCore?.isSuccessfulHttpStatus?.(response.status)) diagnostic.result.http = 'NON_2XX';
                    else {
                        diagnostic.result.http = 'TWO_XX';
                        let payload;
                        let jsonParsed = false;
                        try { payload = await response.json(); jsonParsed = true; } catch { /* Strict JSON failure stops the Gate. */ }
                        if (jsonParsed) {
                            diagnostic.result.jsonParsed = true;
                            const summary = window.LiveFlowChatReadCore?.summarizePlayerSeekDiagnosticResponse?.(payload, playerOffsetMs);
                            if (summary) Object.assign(diagnostic.result, summary);
                        }
                    }
                }
            } catch {
                diagnostic.result.http = timedOut ? 'TIMEOUT' : 'ABORTED';
            } finally {
                window.clearTimeout(timeoutId);
                window.LiveFlowChatReadCore?.finalizePlayerSeekDiagnosticState?.(diagnostic);
                replayPlayerSeekDiagnosticLock = false;
                if (replayPlayerSeekDiagnosticAbortController === controller) replayPlayerSeekDiagnosticAbortController = null;
            }
            return replayPlayerSeekDiagnosticStatus();
        },
        status: replayPlayerSeekDiagnosticStatus
    });
    window.LiveFlowChatFrameRole?.beginGeneration?.(pageLifecycleGeneration);
})();
