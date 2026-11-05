// Offline baseline oracle: actual pre-factory Content bodies, never imported by Product.
    function handleReadResult(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== READ_RESPONSE_TYPE) return;
        if (!acceptingReadResults) {
            logInfo('Bridge READ batch rejected: reason=lifecycle-inactive');
            return;
        }
        if (event.data.pageRevision !== currentPageRevision) {
            logInfo('Bridge READ batch rejected: reason=stale-revision');
            return;
        }
        if (event.data.pageLifecycleGeneration !== currentPageLifecycleGeneration) {
            logInfo('Bridge READ batch rejected: reason=stale-generation');
            return;
        }

        if (!event.data.ok) {
            setReadIndicatorState('stopped');
            const readNumber = event.data.readNumber || 0;
            if (event.data.status === null || event.data.status === undefined) {
                logInfo(`READ #${readNumber} failed: ${event.data.errorType}`);
            } else {
                logInfo(`READ #${readNumber} completed: HTTP ${event.data.status}`);
            }
            return;
        }

        const readNumber = event.data.readNumber || 0;
        setReadIndicatorState('active');
        const messages = Array.isArray(event.data.messages) ? event.data.messages : [];
        const messageIds = new Set(currentMessages.map((message) => message.id).filter(Boolean));
        const newMessages = [];
        let exactIdDedupedCount = 0;
        messages.forEach((message) => {
            if (message.id && messageIds.has(message.id)) { exactIdDedupedCount += 1; return; }
            if (message.id) messageIds.add(message.id);
            currentMessages.push(message);
            newMessages.push(message);
        });
        if (currentMessages.length > MAX_MESSAGES) {
            currentMessages.splice(0, currentMessages.length - MAX_MESSAGES);
        }
        const pendingOwner = window.LiveFlowPendingSelection.clonePendingOwner(event.data.pendingOwner);
        rememberReplayPendingOwner(pendingOwner, event.data.pendingOwnerScope);
        scheduleDanmakuBatch(newMessages, pendingOwner);
        if (currentChatMode === 'replay' && exactIdDedupedCount > 0) publishReplayBatchAccounting({ exactIdDedupedCount });
        logInfo(`READ #${readNumber} completed: HTTP ${event.data.status}`);
        logInfo(`READ #${readNumber} parsed messages: ${event.data.parsedMessageCount ?? messages.length}`);
        if (event.data.nextContinuationAvailable) logInfo(`READ #${readNumber} next continuation available`);
    }

    function currentSourceActivityBinding() {
        if (!currentPageKey || !['live', 'replay'].includes(currentChatMode) ||
            !Number.isSafeInteger(currentPageLifecycleGeneration) || currentPageLifecycleGeneration < 0) return null;
        return Object.freeze({
            target: currentPageKey,
            timeline: `${currentChatMode}:${currentPageRevision}`,
            generation: currentPageLifecycleGeneration
        });
    }

    function observeCurrentWindowSourceActivity(runtime, messages, media) {
        const binding = currentSourceActivityBinding();
        const playerTimeMsec = Number.isFinite(media?.video?.currentTime) ? media.video.currentTime * 1000 : null;
        if (!runtime || !binding || !Number.isFinite(playerTimeMsec) || !Array.isArray(messages)) return null;
        const windowEndMs = playerTimeMsec + 250;
        const windowStartMs = Math.max(0, windowEndMs - PHASE3_UNTUNED_RUNTIME.sourceActivityWindowMsec);
        const facts = messages.map((message) => Object.freeze({
            mediaTimeMs: currentChatMode === 'replay' && Number.isFinite(message?.replayOffsetMsec)
                ? message.replayOffsetMsec : playerTimeMsec,
            displayable: true,
            temporalClass: 'CURRENT_WINDOW'
        }));
        return runtime.observeSourceActivity?.({ eventBinding: binding, mediaTimeMs: playerTimeMsec,
            windowStartMs, windowEndMs, facts }) || null;
    }

    function scheduleDanmakuBatch(messages, pendingOwner = null) {
        const inputCount = Array.isArray(messages) ? messages.length : 0;
        if (!isEffectiveDisplayActive()) {
            observeLivePresentationBatch({ input: inputCount, lifecycleSuppressed: inputCount, suppressedOther: inputCount });
            if (currentChatMode === 'replay') publishReplayBatchAccounting({
                inputCount, lifecycleDiscarded: inputCount, lifecycleDiscardedDisplayDisabled: inputCount
            });
            return;
        }
        const media = getCurrentMainMedia();
        if (!media || !overlayCore?.isMainContentPlaybackEligible?.(media.player, media.video)) {
            phase3Runtime?.clear();
            observeLivePresentationBatch({ input: inputCount, lifecycleSuppressed: inputCount,
                suppressedPaused: media?.video?.paused === true ? inputCount : 0,
                suppressedOther: media?.video?.paused === true ? 0 : inputCount });
            if (currentChatMode === 'replay') {
                const reasonField = !media ? 'lifecycleDiscardedMediaMissing'
                    : media.player?.classList?.contains?.('ad-showing') === true ? 'lifecycleDiscardedAdShowing'
                        : media.player?.classList?.contains?.('ad-interrupting') === true ? 'lifecycleDiscardedAdInterrupting'
                            : media.video?.ended === true ? 'lifecycleDiscardedMediaEnded'
                                : !Number.isFinite(media.video?.readyState) || media.video.readyState < 2
                                    ? 'lifecycleDiscardedMediaNotReady' : media.video?.paused === true
                                        ? 'lifecycleDiscardedMediaPaused' : 'lifecycleDiscardedMediaMissing';
                publishReplayBatchAccounting({ inputCount, lifecycleDiscarded: inputCount, [reasonField]: inputCount });
            }
            return;
        }
        if (currentChatMode === 'live' && livePresentationResumeGateActive) {
            const proximity = overlayCore?.classifyLiveEdgeProximity?.({
                currentTime: media.video.currentTime,
                seekable: snapshotTimeRanges(media.video.seekable),
                buffered: snapshotTimeRanges(media.video.buffered)
            }) || 'UNKNOWN';
            const gate = overlayCore?.reduceLivePresentationResumeGate?.(true, 'BATCH', proximity) ||
                Object.freeze({ active: true, allowLaunch: false, reason: 'UNKNOWN' });
            livePresentationResumeGateActive = gate.active;
            if (!gate.allowLaunch) {
                phase3Runtime?.clear();
                observeLivePresentationBatch({ input: inputCount, lifecycleSuppressed: inputCount,
                    suppressedBehindLive: gate.reason === 'BEHIND_LIVE' ? inputCount : 0,
                    suppressedUnknown: gate.reason === 'UNKNOWN' ? inputCount : 0 });
                return;
            }
        }
        if (phase3Runtime && phase3RuntimeVideo !== media.video) cleanupOverlay();
        const runtime = ensurePhase3Runtime();
        if (!runtime) {
            observeLivePresentationBatch({ input: inputCount, enqueueRejected: inputCount });
            if (currentChatMode === 'replay') publishReplayBatchAccounting({ inputCount, enqueueRejected: inputCount });
            return;
        }
        ensureSubtitleGeometryObservers(media.player);
        ensurePlaybackContextObserver(media.player);
        const scheduledGeneration = rendererGeneration;
        const scheduledVideo = media.video;
        const launchSettingsSnapshot = runtimeSettings;
        const visibleMessages = Array.isArray(messages)
            ? messages.filter((message) => overlayCore.isMessageVisibleForSettings(message, launchSettingsSnapshot))
            : [];
        observeCurrentWindowSourceActivity(runtime, visibleMessages, media);
        let enqueuedCount = 0;
        replayDiagnosticBatchInProgress = true;
        try { visibleMessages.forEach((message, index) => {
            if (runtime.enqueue({
            message,
            pendingOwner,
            generation: scheduledGeneration,
            pageLifecycleGeneration: currentPageLifecycleGeneration,
            video: scheduledVideo,
            settingsSnapshot: launchSettingsSnapshot
        }, {
            id: message.id || `${scheduledGeneration}:${performance.now()}:${index}`,
            enqueuedAt: performance.now(),
            rendererType: message.messageType === 'superChat'
                ? 'liveChatPaidMessageRenderer'
                : message.messageType === 'superSticker' ? 'liveChatPaidStickerRenderer' : 'liveChatTextMessageRenderer',
            footprint: message.messageType === 'superChat' || message.messageType === 'superSticker'
                ? { width: 520, height: 68, kind: 'SPECIAL' }
                : { width: 720, height: phase5Tuning.lineHeight, kind: 'NORMAL' }
            })) enqueuedCount += 1;
        }); } finally { replayDiagnosticBatchInProgress = false; }
        if (currentChatMode === 'replay') {
            publishReplayBatchAccounting({ inputCount, visibleCount: visibleMessages.length, enqueuedCount,
                visibilityFiltered: inputCount - visibleMessages.length, enqueueRejected: visibleMessages.length - enqueuedCount });
        }
        observeLivePresentationBatch({ input: inputCount, enqueued: enqueuedCount,
            visibilityFiltered: inputCount - visibleMessages.length,
            enqueueRejected: visibleMessages.length - enqueuedCount });
    }

    function snapshotTimeRanges(ranges) {
        if (!ranges || !Number.isInteger(ranges.length) || ranges.length < 0) return null;
        const snapshot = [];
        try {
            for (let index = 0; index < ranges.length; index += 1) {
                snapshot.push({ start: ranges.start(index), end: ranges.end(index) });
            }
        } catch {
            return null;
        }
        return snapshot;
    }

    function publishReplayBatchAccounting(fields) {
        for (const [key, value] of Object.entries(fields)) {
            if (Number.isInteger(value) && value >= 0) replayDiagnosticBatch[key] = (replayDiagnosticBatch[key] || 0) + value;
        }
        publishReplaySchedulerDiagnostic();
    }
