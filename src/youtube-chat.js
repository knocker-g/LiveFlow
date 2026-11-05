(function () {
    // Import-only private seam. The browser path below composes this same renderer
    // over its original lexical state, without a lifecycle observer.
    function createRenderer(dependencies) {
        const { state, document, window, performance, overlayCore, schedulerFoundations,
            geometryCore, phase5Tuning, PHASE3_UNTUNED_RUNTIME, isEffectiveDisplayActive,
            getCurrentMainMedia, ensureSubtitleGeometryObservers, disconnectSubtitleGeometryObservers,
            logInfo, publishReplaySchedulerDiagnostic, observer, recognizeAttempt, runtimeObserver,
            isProductCurrent, resolveProductLease, withPresentationCleanup } = dependencies;
        const observed = observer !== undefined;
        const records = observed ? new Map() : null;
        const leases = observed ? new WeakMap() : null;
        const registeredAttempts = observed ? new WeakSet() : null;
        const instance = Object.freeze({});
        const productRecordOwner = Symbol('original-renderer-product-record');
        const faults = new Set();
        const nativeThen = Promise.prototype.then;
        let currentAttempt = null;
        const lifecycleProofs = observed ? new WeakMap() : null;
        const resultProofs = observed ? new WeakMap() : null;
        let proofDelivering = false;
        let proofCount = 0;
        const runtimeProofs = runtimeObserver ? new WeakMap() : null;
        let runtimeDelivering = false, runtimeFault = false;
        function originalProductAttempt(token, record) {
            const original = record?.[productRecordOwner];
            return original?.instance === instance && original.record === record && original.token === token &&
                original.attempt === record.productAttempt && original.attempt.record === record
                ? original.attempt : null;
        }
        function prepareDanmaku(message, generation, video, proof, settings, diagnosticLease, productLease) {
            if (typeof isProductCurrent !== 'function' || typeof resolveProductLease !== 'function') return null;
            const association = resolveProductLease(productLease);
            if (!association || !association.scope || !association.pendingOwner || !association.document ||
                isProductCurrent(productLease) !== true || resolveProductLease(productLease) !== association) return null;
            const attempt = {
                scope: association.scope, productLease, runtime: state.phase3Runtime, association,
                token: Symbol('danmaku'), node: null, record: null, observation: null,
                started: false, nativeReturned: false, nativeAttempted: false, native: 'NOT_ATTEMPTED',
                queueConfirmed: false, aborted: false, visibleActive: false, cleanup: 'CLEANED',
                cleanupAttempted: false, cleanupError: null, cleanupThrew: false, cancelIssued: false,
                current() { return !attempt.aborted && isProductCurrent(productLease) === true &&
                    resolveProductLease(productLease) === association; },
                retain() { if (attempt.record && (attempt.native === 'UNKNOWN' || attempt.native === 'UNSETTLED' ||
                    attempt.cleanup !== 'CLEANED')) state.activeDanmaku.set(attempt.token, attempt.record); },
                clean() {
                if (attempt.cleanupAttempted) {
                    // A later native return/throw can create an obligation after
                    // an earlier reentrant visual cleanup already ran.
                    attempt.retain();
                        if (attempt.cleanupThrew) throw attempt.cleanupError;
                        return;
                    }
                    attempt.cleanupAttempted = true;
                    try {
                        state.activeDanmaku.delete(attempt.token);
                        overlayCore.releaseLaneReservation(state.laneStates, attempt.token);
                        attempt.node?.remove();
                        attempt.cleanup = attempt.node && (attempt.node.isConnected !== false ||
                            state.laneStates.some(lane => lane?.token === attempt.token)) ? 'INCOMPLETE' : 'CLEANED';
                    } catch (error) {
                        attempt.cleanup = 'INCOMPLETE'; attempt.cleanupThrew = true; attempt.cleanupError = error;
                        throw error;
                    } finally {
                        attempt.visibleActive = false; attempt.retain();
                        if (attempt.cleanup === 'CLEANED' && ['FINISHED', 'REJECTED'].includes(attempt.native) && attempt.observation)
                            confirmCleanup(attempt.observation);
                    }
                },
                settled(outcome) {
                    attempt.native = outcome;
                    if (attempt.cleanup === 'CLEANED') {
                        state.activeDanmaku.delete(attempt.token);
                        if (attempt.observation) confirmCleanup(attempt.observation);
                    }
                },
                abort() {
                    attempt.aborted = true;
                    let primary, threw = false;
                    try {
                        if (attempt.record?.animation && !attempt.cancelIssued) {
                            attempt.cancelIssued = true;
                            attempt.record.animation.cancel();
                        }
                    } catch (error) { primary = error; threw = true; }
                    try { attempt.clean(); } catch (error) { if (!threw) { primary = error; threw = true; } }
                    if (threw) throw primary;
                    return status();
                }
            };
            let used = false;
            function status() { return Object.freeze({ prepared: true, started: attempt.started,
                nativeReturned: attempt.nativeReturned, queueConfirmed: attempt.queueConfirmed,
                native: attempt.native, cleanup: attempt.cleanup, aborted: attempt.aborted,
                settledAndCleaned: ['FINISHED', 'REJECTED'].includes(attempt.native) && attempt.cleanup === 'CLEANED' }); }
            return Object.freeze({
                start() {
                    if (used || attempt.aborted) return false;
                    used = true;
                    if (!attempt.current()) { attempt.abort(); return false; }
                    try {
                        const result = renderDanmaku(message, generation, video, proof, settings, diagnosticLease, productLease, attempt);
                        if (result?.status !== 'rendered' || !attempt.current()) { attempt.abort(); return false; }
                        return true;
                    } catch (error) {
                        if (attempt.nativeAttempted && !attempt.nativeReturned) attempt.native = 'UNKNOWN';
                        else if (attempt.nativeReturned && !['FINISHED', 'REJECTED'].includes(attempt.native)) attempt.native = 'UNKNOWN';
                        try { attempt.abort(); } catch (_) { /* Original operation exception wins. */ }
                        throw error;
                    }
                },
                isCurrent: attempt.current, abort: attempt.abort,
                markQueueConfirmed() { attempt.queueConfirmed = true; }, status
            });
        }
        function issuedProof() {
            if (proofCount < Number.MAX_SAFE_INTEGER) proofCount++; else faults.add('PROOF_COUNTER_OVERFLOW');
        }
        function fault(identity, reason) {
            if (!observed) return;
            const first = !faults.has(reason);
            faults.add(reason);
            if (first && typeof observer?.onFault === 'function') {
                try { observer.onFault(identity, reason); } catch (_) { faults.add('FAULT_RECEIVER_FAILED'); }
            }
        }
        if (observed && (!observer || ['onCommit', 'onTerminal', 'onFault'].some(key => typeof observer[key] !== 'function'))) {
            fault(null, 'OBSERVER_INVALID');
        }
        function registerAttempt(scope, pendingOwner, attempt) {
            if (!observed || ![scope, pendingOwner, attempt].every(value => value !== null && typeof value === 'object') ||
                typeof recognizeAttempt !== 'function') { fault(null, 'IDENTITY_INVALID'); return null; }
            if (registeredAttempts.has(attempt)) { fault(null, 'IDENTITY_INVALID'); return null; }
            try {
                if (recognizeAttempt(scope, pendingOwner, attempt) !== true) { fault(null, 'IDENTITY_INVALID'); return null; }
            } catch (_) { fault(null, 'IDENTITY_INVALID'); return null; }
            const lease = Object.freeze({});
            registeredAttempts.add(attempt);
            leases.set(lease, { scope, pendingOwner, attempt, used: false });
            return lease;
        }
        function observeToken(token, node) {
            if (!observed || !currentAttempt?.binding) return null;
            const identity = Object.freeze({ ...currentAttempt.binding, instance, token });
            if (records.size >= 40) { fault(identity, 'REGISTRY_EXHAUSTED'); return null; }
            const record = { identity, node, committed: false, notifying: false, delivered: false,
                settlement: null, cleaned: false, cancel: 'NONE' };
            records.set(token, record);
            currentAttempt.record = record;
            return record;
        }
        function terminal(record) {
            if (!record.committed || record.notifying || record.delivered || !record.settlement || !record.cleaned) return;
            // Earlier teardown is not permanent proof: check the actual resources
            // again at delivery, keeping old callbacks bound to their own token.
            try {
                if (!cleanupProven(record)) { record.cleaned = false; fault(record.identity, 'CLEANUP_UNPROVEN'); return; }
            } catch (_) { fault(record.identity, 'CLEANUP_UNPROVEN'); return; }
            record.delivered = true;
            records.delete(record.identity.token);
            if (typeof observer?.onTerminal !== 'function') { fault(record.identity, 'OBSERVER_INVALID'); return; }
            const proof = Object.freeze({}), receipt = { kind: 'RENDER_TERMINAL', state: 'PENDING',
                identity: record.identity, settlement: record.settlement, cleanup: record.cleaned, commitProof: record.commitProof };
            issuedProof(); lifecycleProofs.set(proof, receipt);
            const previousDelivery = proofDelivering; proofDelivering = true;
            if (previousDelivery) faults.add('PROOF_REENTRANT');
            try {
                const returned = observer.onTerminal(record.identity, record.settlement, record.cancel, proof);
                if (returned !== null && ['object', 'function'].includes(typeof returned)) { receipt.state = 'UNKNOWN'; fault(record.identity, 'PROOF_RECEIVER_ASYNC'); }
            }
            catch (_) { receipt.state = 'FAILED'; fault(record.identity, 'TERMINAL_RECEIVER_FAILED'); }
            finally {
                proofDelivering = previousDelivery;
                if (receipt.state === 'PENDING') receipt.state = !faults.size && record.cleaned && record.delivered
                    ? 'FINAL_DELIVERED' : 'UNKNOWN';
            }
        }
        function commitObservation(record) {
            record.committed = true;
            record.notifying = true;
            const proof = Object.freeze({}), receipt = { kind: 'RENDER_COMMIT', state: 'PENDING', identity: record.identity };
            record.commitProof = proof; issuedProof(); lifecycleProofs.set(proof, receipt);
            const previousDelivery = proofDelivering; proofDelivering = true;
            if (previousDelivery) faults.add('PROOF_REENTRANT');
            try {
                if (typeof observer?.onCommit !== 'function') fault(record.identity, 'OBSERVER_INVALID');
                else {
                    const returned = observer.onCommit(record.identity, proof);
                    if (returned !== null && ['object', 'function'].includes(typeof returned)) { receipt.state = 'UNKNOWN'; fault(record.identity, 'PROOF_RECEIVER_ASYNC'); }
                }
            } catch (_) { receipt.state = 'FAILED'; fault(record.identity, 'COMMIT_RECEIVER_FAILED'); }
            finally {
                record.notifying = false; proofDelivering = previousDelivery;
                if (receipt.state === 'PENDING') receipt.state = !faults.size && record.committed ? 'FINAL_DELIVERED' : 'UNKNOWN';
            }
            terminal(record);
        }
        function cleanupProven(record) {
            return !state.activeDanmaku.has(record.identity.token) &&
                !state.laneStates.some(lane => lane?.token === record.identity.token) && record.node.isConnected === false;
        }
        function confirmCleanup(record) {
            try {
                record.cleaned = cleanupProven(record);
                if (record.cleaned) terminal(record);
                else fault(record.identity, 'CLEANUP_UNPROVEN');
            } catch (_) { fault(record.identity, 'CLEANUP_UNPROVEN'); }
        }
        function cleanupToken(token, node, record) {
            try {
                state.activeDanmaku.delete(token);
                overlayCore.releaseLaneReservation(state.laneStates, token);
                node.remove();
            } catch (error) { if (record) fault(record.identity, 'CLEANUP_FAILED'); throw error; }
            if (record) confirmCleanup(record);
        }
        function observeFinished(record, finished) {
            try {
                nativeThen.call(finished,
                    () => { record.settlement = 'FINISHED'; terminal(record); },
                    () => { record.settlement = 'REJECTED'; terminal(record); });
            } catch (_) { fault(record.identity, 'SETTLEMENT_UNOBSERVABLE'); }
        }
        function renderDanmaku(...args) {
            if (!observed) return renderDanmakuImpl(...args);
            if (proofDelivering) faults.add('PROOF_REENTRANT');
            const previous = currentAttempt;
            const lease = args[5];
            const registered = lease && leases.get(lease);
            let binding = null;
            if (!registered || registered.used) fault(null, 'IDENTITY_INVALID');
            else {
                registered.used = true;
                binding = Object.freeze({ scope: registered.scope, pendingOwner: registered.pendingOwner,
                    attempt: registered.attempt, instance, token: null });
            }
            const attempt = { binding, record: null };
            currentAttempt = attempt;
            try {
                const result = renderDanmakuImpl(...args);
                if (binding) {
                    const proof = Object.freeze({}), committed = attempt.record?.committed === true;
                    issuedProof();
                    lifecycleProofs.set(proof, { kind: 'RENDER_RESULT', state: !faults.size &&
                        ((!attempt.record && ['drop', 'defer'].includes(result?.status)) || committed) ? 'FINAL_DELIVERED' : 'UNKNOWN',
                        identity: binding, created: Boolean(attempt.record), status: result?.status });
                    resultProofs.set(binding.attempt, proof);
                }
                if (attempt.record && !attempt.record.committed) records.delete(attempt.record.identity.token);
                return result;
            } catch (error) {
                fault(attempt.record?.identity || binding, 'RENDER_FAILED');
                throw error;
            } finally { currentAttempt = previous; }
        }

        function cleanupOverlay() {
            const originalRuntime = runtimeObserver ? state.phase3Runtime : null;
            if (runtimeDelivering) runtimeFault = true;
            if (proofDelivering) faults.add('PROOF_REENTRANT');
            try {
                state.rendererGeneration += 1;
                state.activeDanmaku.forEach(({ animation, node }, token) => {
                    const value = state.activeDanmaku.get(token);
                    const product = originalProductAttempt(token, value);
                    if (product) { product.abort(); return; }
                    if (value.productAttempt || value[productRecordOwner]) {
                        fault(null, 'PRODUCT_OWNERSHIP_UNKNOWN'); return;
                    }
                    const record = records?.get(token);
                    try {
                        if (record) record.cancel = 'THREW';
                        animation?.cancel();
                        if (record) record.cancel = animation ? 'ISSUED_RETURNED' : 'NONE';
                        node?.remove();
                    } catch (error) {
                        fault(record?.identity || null, 'CLEANUP_FAILED');
                        throw error;
                    }
                });
                // Only proven legacy-only remainder may take the original full
                // clear. An unresolved original or unproven Product candidate
                // must survive; cancel/visual cleanup cannot settle its native work.
                const productRetained = [...state.activeDanmaku.values()].some(value =>
                    value.productAttempt || value[productRecordOwner]);
                if (!productRetained) state.activeDanmaku.clear();
                else for (const [token, value] of state.activeDanmaku)
                    if (!value.productAttempt && !value[productRecordOwner]) state.activeDanmaku.delete(token);
                state.phase3Runtime?.clear();
                state.phase3Runtime = null;
                state.phase3RuntimeVideo = null;
                disconnectSubtitleGeometryObservers();
                state.laneStates = [];
                state.overlayRoot?.remove();
                state.overlayRoot = null;
                state.overlaySurface = null;
                if (records) for (const record of records.values()) confirmCleanup(record);
                if (originalRuntime && runtimeObserver) {
                    const proof = Object.freeze({}), receipt = { kind: 'RUNTIME_DETACHED', state: 'PENDING',
                        runtime: originalRuntime, instance };
                    runtimeProofs.set(proof, receipt);
                    runtimeDelivering = true;
                    try {
                        const returned = runtimeObserver(proof);
                        receipt.state = runtimeFault || (returned !== null && ['object', 'function'].includes(typeof returned))
                            ? 'UNKNOWN' : 'FINAL_DELIVERED';
                    } catch (_) { receipt.state = 'FAILED'; fault(null, 'RUNTIME_RECEIVER_FAILED'); }
                    finally { runtimeDelivering = false; }
                }
            } catch (error) {
                fault(null, 'CLEANUP_FAILED');
                throw error;
            }
        }

        function cleanupPresentation(productLease) {
            if (typeof withPresentationCleanup !== 'function') return Object.freeze({ status: 'NOT_APPLIED_UNKNOWN' });
            return withPresentationCleanup(productLease, () => {
                state.rendererGeneration += 1;
                state.subtitleGeometryAdapter?.markDirty(geometryCore.DIRTY_SIGNALS.VIDEO_GEOMETRY);
                state.activeDanmaku.forEach(({ animation, node }, token) => {
                    const value = state.activeDanmaku.get(token), product = originalProductAttempt(token, value);
                    if (product) { product.abort(); return; }
                    if (value.productAttempt || value[productRecordOwner]) { fault(null, 'PRODUCT_OWNERSHIP_UNKNOWN'); return; }
                    const record = records?.get(token);
                    if (record) record.cancel = 'THREW';
                    animation?.cancel();
                    if (record) record.cancel = animation ? 'ISSUED_RETURNED' : 'NONE';
                    node?.remove();
                });
                const retained = [...state.activeDanmaku.values()].some(value => value.productAttempt || value[productRecordOwner]);
                if (!retained) state.activeDanmaku.clear();
                else for (const [token, value] of state.activeDanmaku)
                    if (!value.productAttempt && !value[productRecordOwner]) state.activeDanmaku.delete(token);
                disconnectSubtitleGeometryObservers();
                state.laneStates = [];
                state.overlayRoot?.remove(); state.overlayRoot = null; state.overlaySurface = null;
                if (records) for (const record of records.values()) confirmCleanup(record);
                // Physical Pending removal belongs to the original Scope exit.
                // Keep the actual Runtime/adapter/issuer; this is not detach.
            });
        }

        function attachOverlay(player, productLease) {
            if (!player) return false;

            if (state.overlayRoot?.isConnected && state.overlayRoot.parentElement === player) return true;
            if (state.overlayRoot) {
                if (typeof withPresentationCleanup === 'function' && productLease) cleanupPresentation(productLease);
                else cleanupOverlay();
                return false;
            }
            state.overlayRoot = document.createElement('div');
            state.overlayRoot.id = 'liveflow-overlay-root';
            state.overlayRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:20;overflow:hidden;contain:layout paint;';
            state.overlaySurface = document.createElement('div');
            state.overlaySurface.id = 'liveflow-danmaku-surface';
            state.overlaySurface.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;contain:layout paint;';
            state.overlaySurface.style.opacity = String((state.runtimeSettings.opacityPercent ?? 80) / 100);
            state.overlayRoot.appendChild(state.overlaySurface);
            player.appendChild(state.overlayRoot);
            ensureSubtitleGeometryObservers(player);
            state.subtitleGeometryAdapter?.markDirty(geometryCore.DIRTY_SIGNALS.VIDEO_GEOMETRY);
            logInfo('Overlay attached');
            return true;
        }

        function applyOverlaySurfaceRect(surfaceRect) {
            if (!state.overlayRoot?.isConnected || !state.overlaySurface?.isConnected || !surfaceRect ||
                ![surfaceRect.left, surfaceRect.top, surfaceRect.width, surfaceRect.height].every(Number.isFinite) ||
                surfaceRect.width <= 0 || surfaceRect.height <= 0) return false;
            if (state.activeDanmaku.size > 0 && ['left', 'top', 'width', 'height'].some(key =>
                state.overlaySurface.style[key] !== `${surfaceRect[key]}px`)) return false;
            state.overlaySurface.style.left = `${surfaceRect.left}px`;
            state.overlaySurface.style.top = `${surfaceRect.top}px`;
            state.overlaySurface.style.width = `${surfaceRect.width}px`;
            state.overlaySurface.style.height = `${surfaceRect.height}px`;
            return true;
        }

        function snapshotActiveGeometry(surfaceBounds) {
            const result = [];
            for (const record of state.activeDanmaku.values()) {
                if (record.productAttempt && !record.productAttempt.visibleActive) continue;
                const { node, trajectory, occlusionEpisodes, occlusionHistoryKnown } = record;
                if (!node?.isConnected || !trajectory) return null;
                const rect = node.getBoundingClientRect();
                if (![rect.left, rect.top, rect.width, rect.height, trajectory.velocity].every(Number.isFinite) ||
                    rect.width <= 0 || rect.height <= 0 || trajectory.velocity <= 0) return null;
                result.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height,
                    velocity: trajectory.velocity, anchorIndex: trajectory.anchorIndex,
                    exitX: surfaceBounds.left, surfaceRight: surfaceBounds.right,
                    semanticClass: trajectory.semanticClass,
                    occlusionEpisodes, occlusionHistoryKnown: occlusionHistoryKnown === true });
            }
            return result;
        }

        function readSubtitleGeometry() {
            const media = getCurrentMainMedia();
            if (!media || !geometryCore) {
                return Object.freeze({ state: 'UNKNOWN', exclusionRegions: Object.freeze([]), capabilityAvailable: false });
            }
            const videoRect = media.video.getBoundingClientRect();
            const selectors = '.ytp-caption-segment, .ytp-caption-window-container .captions-text';
            const candidates = Array.from(media.player.querySelectorAll(selectors)).map((element) => {
                const style = window.getComputedStyle(element);
                return {
                    visible: element.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0,
                    rect: element.getBoundingClientRect()
                };
            });
            return geometryCore.computeSubtitleGeometry({
                candidates,
                videoRect: { x: videoRect.left, y: videoRect.top, width: videoRect.width, height: videoRect.height },
                safetyMargin: PHASE3_UNTUNED_RUNTIME.subtitleMargin
            });
        }

        function isCaptionTrackEnabled(player) {
            return player?.querySelector?.('.ytp-subtitles-button[aria-pressed="true"]') !== null;
        }

        function createDanmakuNode(normalized, settingsSnapshot = state.runtimeSettings) {
            const node = document.createElement('div');
            node.className = 'liveflow-danmaku';
            node.dataset.authorRole = normalized.authorRole;
            const fontScale = settingsSnapshot.fontSizeMode === 'manual' ? settingsSnapshot.fontScalePercent / 100 : 1;
            const fontSize = phase5Tuning.fontSize * fontScale;
            const lineHeight = phase5Tuning.lineHeight * fontScale;
            node.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;font:${fontSize}px/${lineHeight}px sans-serif;font-weight:600;will-change:transform;pointer-events:none;`;
            const special = normalized.messageType === 'superChat' || normalized.messageType === 'superSticker';
            if (special) {
                node.classList.add('liveflow-danmaku-special');
                node.dataset.messageType = normalized.messageType;
                const backgroundColor = normalized.colors.bodyBackgroundColor || normalized.colors.backgroundColor || normalized.colors.headerBackgroundColor;
                node.style.backgroundColor = overlayCore.withCssColorAlpha(backgroundColor, 0.8) || 'rgba(24, 24, 24, 0.8)';
                node.style.color = '#FFFFFF';
            }
            const specialHeader = special ? document.createElement('div') : null;
            const specialBody = special ? document.createElement('div') : null;
            if (specialHeader && specialBody) {
                specialHeader.className = 'liveflow-danmaku-special-header';
                specialBody.className = 'liveflow-danmaku-special-body';
                node.append(specialHeader, specialBody);
            }
            const headerTarget = specialHeader || node;
            const bodyTarget = specialBody || node;
            if (overlayCore.shouldRenderAvatar(normalized, settingsSnapshot)) {
                const avatar = document.createElement('img');
                avatar.className = 'liveflow-danmaku-avatar';
                avatar.alt = '';
                avatar.src = normalized.authorPhoto;
                avatar.width = 22;
                avatar.height = 22;
                headerTarget.appendChild(avatar);
            }
            if (special && normalized.authorName) {
                const author = document.createElement('span');
                author.className = 'liveflow-danmaku-author';
                author.textContent = normalized.authorName;
                headerTarget.appendChild(author);
            }
            if (special && normalized.purchaseAmountText) {
                const amount = document.createElement('span');
                amount.className = 'liveflow-danmaku-amount';
                amount.textContent = normalized.purchaseAmountText;
                if (normalized.colors.moneyChipBackgroundColor) amount.style.backgroundColor = normalized.colors.moneyChipBackgroundColor;
                headerTarget.appendChild(amount);
            }
            if (normalized.messageType === 'superSticker' && normalized.sticker?.url) {
                const sticker = document.createElement('img');
                sticker.className = 'liveflow-danmaku-sticker';
                sticker.src = normalized.sticker.url;
                sticker.alt = normalized.sticker.alt;
                sticker.width = 32;
                sticker.height = 32;
                bodyTarget.appendChild(sticker);
            }
            const content = document.createElement('span');
            content.className = 'liveflow-danmaku-message';
            for (const run of overlayCore.getRenderableMessageRuns(normalized, settingsSnapshot)) {
                if (run.type === 'text') content.appendChild(document.createTextNode(run.text));
                if (run.type === 'image') {
                    const image = document.createElement('img');
                    image.className = 'liveflow-danmaku-emoji';
                    image.src = run.url;
                    image.alt = run.alt;
                    image.width = 29;
                    image.height = 29;
                    content.appendChild(image);
                }
            }
            if (content.childNodes.length > 0) bodyTarget.appendChild(content);
            return node;
        }

        function applySpecialFit(node, surfaceWidth) {
            if (!node?.classList?.contains('liveflow-danmaku-special')) return { result: 'FIT' };
            const header = node.querySelector('.liveflow-danmaku-special-header');
            const body = node.querySelector('.liveflow-danmaku-special-body');
            const message = node.querySelector('.liveflow-danmaku-message');
            if (!header || !body || !message || !Number.isFinite(surfaceWidth) || surfaceWidth <= 0) return null;
            const maximumWidth = Math.min(surfaceWidth * phase5Tuning.specialMaximumWidthFraction, phase5Tuning.specialMaximumWidthPx);
            node.style.maxWidth = 'none';
            message.style.fontSize = '';
            const baseBodyFontSize = Number.parseFloat(window.getComputedStyle(message).fontSize);
            const fit = schedulerFoundations.computeSpecialSingleLineFit({
                headerNaturalWidth: header.scrollWidth,
                bodyNaturalWidth: body.scrollWidth,
                maximumWidth,
                baseBodyFontSize,
                minimumBodyFontSize: phase5Tuning.specialMinimumBodyFontSize
            });
            if (!fit || fit.result === 'UNREPRESENTABLE_SPECIAL') return fit;
            node.style.maxWidth = `${maximumWidth}px`;
            if (fit.result === 'SCALED') message.style.fontSize = `${fit.bodyFontSize}px`;
            return fit;
        }

        function getCandidateProof(entry, geometryState, densityPolicy) {
            const media = getCurrentMainMedia();
            if (!media || !overlayCore.isMainContentPlaybackEligible(media.player, media.video)) return { blockedReason: 'OTHER' };
            const normalized = overlayCore.normalizeDanmakuMessage(entry.payload.message);
            if (!normalized) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
            entry.payload.settingsSnapshot = state.runtimeSettings;
            const playerRect = media.player.getBoundingClientRect();
            const videoRect = media.video.getBoundingClientRect();
            const surface = overlayCore.calculateVideoSurfaceRect(playerRect, videoRect);
            if (!surface) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
            if (!attachOverlay(media.player) || !state.overlaySurface) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
            if (!applyOverlaySurfaceRect(surface)) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
            const surfaceBounds = state.overlaySurface.getBoundingClientRect();
            const probe = createDanmakuNode(normalized, entry.payload.settingsSnapshot);
            state.overlaySurface.appendChild(probe);
            const specialFit = applySpecialFit(probe, surface.width);
            if (specialFit?.result === 'UNREPRESENTABLE_SPECIAL') {
                probe.remove();
                return { unrepresentableSpecial: true };
            }
            if (!specialFit) {
                probe.remove();
                return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
            }
            const measured = probe.getBoundingClientRect();
            probe.remove();
            const metrics = overlayCore.createRenderedTextMetrics(normalized.text, measured.width);
            const width = metrics?.renderedWidth;
            const height = measured.height;
            if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
            const laneCount = overlayCore.calculateLaneCount(surface.height, phase5Tuning.lineHeight, phase5Tuning.laneGap);
            const playbackRate = state.currentChatMode === 'replay' ? media.video.playbackRate : 1;
            const baseDuration = overlayCore.calculateCompensatedDanmakuDuration(surface.width, width);
            const factor = state.currentChatMode === 'replay' ? overlayCore.calculateReplayPlaybackRateFactor(playbackRate) : 1;
            const baseVelocity = overlayCore.calculateDanmakuSpeed({
                overlayWidth: surface.width,
                commentWidth: width,
                targetDurationMs: baseDuration && factor ? baseDuration * factor : null,
                minSpeed: phase5Tuning.minimumSpeed * playbackRate,
                maxSpeed: phase5Tuning.maximumSpeed * playbackRate
            });
            const velocity = window.LiveFlowPhase5Tuning.applyLengthAwareVelocity(baseVelocity, width, surface.width,
                phase5Tuning.lengthVelocity, phase5Tuning.maximumSpeed * playbackRate);
            if (!Number.isFinite(velocity)) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
            const now = performance.now();
            const activeComments = snapshotActiveGeometry(surfaceBounds);
            if (!activeComments) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
            const captionsEnabled = isCaptionTrackEnabled(media.player);
            const reservedBottomLaneStart = captionsEnabled ? Math.max(0, laneCount - 2) : laneCount;
            const lanePitch = phase5Tuning.lineHeight + phase5Tuning.laneGap;
            const hardExclusions = geometryState.exclusionRegions.slice();
            if (reservedBottomLaneStart < laneCount) hardExclusions.push({
                x: surfaceBounds.left,
                y: surfaceBounds.top + reservedBottomLaneStart * lanePitch,
                width: surfaceBounds.width,
                height: surfaceBounds.bottom - (surfaceBounds.top + reservedBottomLaneStart * lanePitch)
            });
            const special = normalized.messageType === 'superChat' || normalized.messageType === 'superSticker';
            const generated = geometryCore.generateDensityLaneCandidates({
                videoRect: { x: surfaceBounds.left, y: surfaceBounds.top, width: surfaceBounds.width, height: surfaceBounds.height },
                renderedWidth: width,
                renderedHeight: height,
                actualVelocity: velocity,
                footprint: entry.footprint,
                lineHeight: phase5Tuning.lineHeight,
                laneGap: phase5Tuning.laneGap,
                densityPolicy,
                laneBandFractions: phase5Tuning.laneBandFractions,
                interleavedAnchorStride: phase5Tuning.interleavedAnchorStride,
                exclusionRegions: hardExclusions,
                special
            });
            if (!generated) return { blockedReason: 'CANDIDATE_GEOMETRY_INVALID' };
            if (generated.candidates.length === 0) return { blockedReason: hardExclusions.length ? 'SUBTITLE_EXCLUSION' : 'NO_USABLE_LANE' };
            const decorate = (candidates) => candidates.map((candidate) => Object.freeze({ ...candidate, specialFit,
                rectangle: Object.freeze({ ...candidate.rectangle, snapshotAt: now / 1000, occlusionHistoryKnown: true }),
                snapshotAtMs: now, captionsEnabled, surfaceBounds: Object.freeze({ left: surfaceBounds.left, top: surfaceBounds.top,
                    width: surfaceBounds.width, height: surfaceBounds.height }),
                hardExclusions: Object.freeze(hardExclusions) }));
            const primaryCandidates = decorate(generated.baseCandidates);
            const secondaryCandidates = decorate(generated.interleavedCandidates);
            const expansionCandidates = decorate(generated.expansionCandidates);
            const ranked = window.LiveFlowPhase5Tuning.rankDensityRescuePlacements(
                primaryCandidates, secondaryCandidates, expansionCandidates, activeComments, entry.id, densityPolicy.density,
                false
            );
            const selection = window.LiveFlowOpportunityAwareDensity.select({ candidates: ranked, active: activeComments, density: densityPolicy.density, config: phase5Tuning });
            return { candidates: selection.candidates, activeComments };
        }

        function renderDanmakuImpl(message, scheduledGeneration = state.rendererGeneration, scheduledVideo = null, launchProof = null,
            settingsSnapshot = state.runtimeSettings, diagnosticLease = null, productLease = null, productAttempt = null) {
            if (!isEffectiveDisplayActive()) return { status: 'drop' };
            const media = getCurrentMainMedia();
            if (!media || !overlayCore?.isRendererTargetCurrent?.({
                scheduledGeneration,
                currentGeneration: state.rendererGeneration,
                scheduledVideo: scheduledVideo || media.video,
                currentVideo: media.video,
                currentPlayerOwnsVideo: true
            })) return { status: 'drop' };
            const { player, video } = media;
            if (!overlayCore.isMainContentPlaybackEligible(player, video)) return { status: 'drop' };
            if (!attachOverlay(player, productLease) || !state.overlayRoot || !state.overlaySurface) return { status: 'drop' };
            const normalized = overlayCore.normalizeDanmakuMessage(message);
            if (!normalized) return { status: 'drop' };

            const surfaceRect = overlayCore.calculateVideoSurfaceRect(player.getBoundingClientRect(), video.getBoundingClientRect());
            if (!surfaceRect) return { status: 'drop' };
            if (!applyOverlaySurfaceRect(surfaceRect)) return { status: 'drop' };

            const laneCount = overlayCore.calculateLaneCount(surfaceRect.height, phase5Tuning.lineHeight, phase5Tuning.laneGap);
            if (laneCount <= 0) return { status: 'drop' };
            const anchorCount = Math.max(1, laneCount * 2 - 1);
            if (state.laneStates.length !== anchorCount) {
                state.laneStates = Array.from({ length: anchorCount }, (_, index) => state.laneStates[index] || null);
            }

            const now = performance.now();
            if ([...state.activeDanmaku.values()].filter(record => !record.productAttempt || record.productAttempt.started).length >= overlayCore.DANMAKU_MAX_ACTIVE_COMMENTS) {
                const resumeAtMs = state.laneStates.reduce((earliest, lane) => {
                    if (!Number.isFinite(lane?.endTimeMs) || lane.endTimeMs <= now) return earliest;
                    return earliest === null || lane.endTimeMs < earliest ? lane.endTimeMs : earliest;
                }, null);
                return { status: resumeAtMs === null ? 'drop' : 'wait', resumeAtMs };
            }

            const node = createDanmakuNode(normalized, settingsSnapshot);
            if (productAttempt) {
                productAttempt.node = node; productAttempt.cleanup = 'INCOMPLETE';
                productAttempt.record = { productAttempt, animation: null, node, trajectory: null };
                Object.defineProperty(productAttempt.record, productRecordOwner, { value: Object.freeze({
                    instance, token: productAttempt.token, record: productAttempt.record, attempt: productAttempt
                }) });
                state.activeDanmaku.set(productAttempt.token, productAttempt.record);
            }
            const special = normalized.messageType === 'superChat' || normalized.messageType === 'superSticker';
            state.overlaySurface.appendChild(node);
            const specialFit = applySpecialFit(node, surfaceRect.width);
            if (!specialFit || specialFit.result === 'UNREPRESENTABLE_SPECIAL') {
                node.remove();
                return { status: 'drop' };
            }
            const renderedRect = node.getBoundingClientRect();
            const metrics = overlayCore.createRenderedTextMetrics(normalized.text, renderedRect.width);
            const commentWidth = metrics?.renderedWidth;
            const baseDurationMs = overlayCore.calculateCompensatedDanmakuDuration(surfaceRect.width, commentWidth);
            const playbackRate = state.currentChatMode === 'replay' ? video.playbackRate : 1;
            const replayFactor = state.currentChatMode === 'replay' ? overlayCore.calculateReplayPlaybackRateFactor(playbackRate) : 1;
            const targetDurationMs = baseDurationMs && replayFactor ? baseDurationMs * replayFactor : null;
            const baseSpeed = overlayCore.calculateDanmakuSpeed({
                overlayWidth: surfaceRect.width,
                commentWidth,
                targetDurationMs,
                minSpeed: phase5Tuning.minimumSpeed * playbackRate,
                maxSpeed: phase5Tuning.maximumSpeed * playbackRate
            });
            const speed = window.LiveFlowPhase5Tuning.applyLengthAwareVelocity(baseSpeed, commentWidth, surfaceRect.width,
                phase5Tuning.lengthVelocity, phase5Tuning.maximumSpeed * playbackRate);
            const commitAt = performance.now();
            const currentBounds = state.overlaySurface.getBoundingClientRect();
            const commitRectangle = { ...launchProof?.rectangle, snapshotAt: commitAt / 1000, occlusionHistoryKnown: true };
            const refreshedGeometry = state.subtitleGeometryAdapter?.refresh();
            const activeGeometry = snapshotActiveGeometry(currentBounds);
            const allowanceClass = window.LiveFlowSchedulerFoundations.getDensityVisualPolicy(launchProof?.density)?.collisionAllowanceClass;
            const allowance = phase5Tuning.collisionAllowances[allowanceClass];
            if (!launchProof?.rectangle || !launchProof.surfaceBounds || !allowance || !activeGeometry ||
                !Number.isFinite(launchProof.snapshotAtMs) || now < launchProof.snapshotAtMs ||
                isCaptionTrackEnabled(player) !== launchProof.captionsEnabled || refreshedGeometry?.geometry?.state === 'UNKNOWN' ||
                refreshedGeometry?.revision !== launchProof.geometryRevision ||
                ['left', 'top', 'width', 'height'].some(key => currentBounds[key] !== launchProof.surfaceBounds[key]) ||
                commentWidth !== launchProof.rectangle.width || renderedRect.height !== launchProof.rectangle.height ||
                speed !== launchProof.rectangle.velocity ||
                !window.LiveFlowSchedulerFoundations.isOutsideHardExclusions(
                    { ...launchProof.rectangle, ...launchProof.clearanceRectangle }, launchProof.hardExclusions) ||
                !(phase5Tuning.normalOverlapPolicy
                    ? window.LiveFlowNormalOverlapPolicy.prove(commitRectangle, activeGeometry, allowance, phase5Tuning.normalOverlapPolicy, ['DENSE', 'MAX_READABLE'].includes(launchProof.density))
                    : window.LiveFlowSchedulerFoundations.proveBoundedCollisionSafe(launchProof.rectangle, activeGeometry, allowance)).safe) {
                node.remove();
                return { status: 'drop' };
            }
            const laneSpan = 1;
            const anchorIndex = Number.isInteger(launchProof?.anchorIndex) && launchProof.anchorIndex >= 0 && launchProof.anchorIndex < anchorCount ? launchProof.anchorIndex : -1;
            if (anchorIndex < 0 || !Number.isFinite(launchProof?.lane)) {
                node.remove();
                return { status: 'drop' };
            }
            const motion = overlayCore.calculateDanmakuMotion({
                overlayWidth: surfaceRect.width,
                commentWidth,
                commentHeight: renderedRect.height,
                speed,
                startTimeMs: now
            });
            if (!motion || typeof node.animate !== 'function') {
                node.remove();
                return { status: 'drop' };
            }

            const token = productAttempt ? productAttempt.token : Symbol('danmaku');
            const observation = observeToken(token, node);
            if (productAttempt) productAttempt.observation = observation;
            const reservation = {
                token,
                startTimeMs: now,
                startX: motion.startX,
                commentWidth,
                commentHeight: renderedRect.height,
                speed,
                endTimeMs: now + motion.durationMs
            };
            if (!overlayCore.reserveLaneSpan(state.laneStates, anchorIndex, laneSpan, reservation)) {
                node.remove();
                return { status: 'drop' };
            }
            node.style.top = `${launchProof.lane * (phase5Tuning.lineHeight + phase5Tuning.laneGap)}px`;
            if (productAttempt) {
                if (!productAttempt.current()) return { status: 'drop' };
                productAttempt.started = true;
            }
            node.style.visibility = 'visible';
            if (productAttempt && !productAttempt.current()) return { status: 'drop' };
            if (productAttempt) productAttempt.nativeAttempted = true;
            const animation = node.animate([
                { transform: `translateX(${motion.startX}px)` },
                { transform: `translateX(${motion.endX}px)` }
            ], {
                duration: motion.durationMs,
                easing: 'linear',
                fill: 'forwards'
            });
            if (productAttempt) {
                productAttempt.record.animation = animation;
                productAttempt.nativeReturned = animation !== null && typeof animation === 'object';
                productAttempt.native = productAttempt.nativeReturned ? 'UNSETTLED' : 'UNKNOWN';
                productAttempt.retain();
            }
            const episodes = phase5Tuning.normalOverlapPolicy
                ? window.LiveFlowNormalOverlapPolicy.recordEpisodes(commitRectangle, activeGeometry, commitAt / 1000) : null;
            if (episodes) {
                let index = 1;
                for (const record of state.activeDanmaku.values()) {
                    if (record.productAttempt && !record.productAttempt.visibleActive) continue;
                    const subject = activeGeometry[index - 1];
                    record.occlusionHistoryKnown = window.LiveFlowNormalOverlapPolicy.historyKnown(subject,
                        activeGeometry.filter(r => r !== subject));
                    record.occlusionEpisodes = episodes[index++];
                }
            }
            const activeRecord = {
                occlusionEpisodes: episodes?.[0], occlusionHistoryKnown: Boolean(episodes),
                animation,
                node,
                visualFootprint: Object.freeze({ width: commentWidth, height: renderedRect.height, anchorLane: launchProof.lane, logicalLaneSpan: 1 }),
                trajectory: Object.freeze({ startTimeMs: now, startX: currentBounds.right,
                    y: currentBounds.top + launchProof.lane * (phase5Tuning.lineHeight + phase5Tuning.laneGap),
                    width: commentWidth, height: renderedRect.height, velocity: speed, anchorIndex,
                    semanticClass: special ? 'SPECIAL' : 'NORMAL' })
            };
            if (productAttempt) {
                Object.assign(productAttempt.record, activeRecord); productAttempt.visibleActive = true;
            } else state.activeDanmaku.set(token, activeRecord);
            if (state.currentChatMode === 'replay') {
                state.replayDiagnosticDisplayed += 1;
                publishReplaySchedulerDiagnostic();
            }
            if (observation) commitObservation(observation);
            const finished = animation.finished;
            if (productAttempt) {
                const then = finished.then;
                const originalNative = then === nativeThen;
                const clean = () => productAttempt.clean();
                const next = originalNative ? Reflect.apply(then, finished, [
                    () => { productAttempt.settled('FINISHED'); clean(); },
                    () => { productAttempt.settled('REJECTED'); clean(); }
                ]) : Reflect.apply(then, finished, [clean]);
                if (!originalNative) productAttempt.native = 'UNKNOWN';
                next.catch(() => { if (!productAttempt.cleanupAttempted) clean(); });
            } else finished.then(() => {
                cleanupToken(token, node, observation);
            }).catch(() => {
                cleanupToken(token, node, observation);
            });
            if (observation) observeFinished(observation, finished);
            return { status: 'rendered' };
        }

        return Object.freeze({ cleanupOverlay, cleanupPresentation, attachOverlay, applyOverlaySurfaceRect,
            snapshotActiveGeometry, readSubtitleGeometry, isCaptionTrackEnabled,
            createDanmakuNode, applySpecialFit, getCandidateProof, renderDanmaku, registerAttempt,
            prepareDanmaku,
            recognizeProof(proof) { const receipt = lifecycleProofs?.get(proof); return receipt ? Object.freeze({ ...receipt }) : null; },
            recognizeRuntimeProof(proof) { const receipt = runtimeProofs?.get(proof); return receipt ? Object.freeze({ ...receipt }) : null; },
            proofForAttempt: attempt => resultProofs?.get(attempt) || null,
            isProofDelivering: () => proofDelivering,
            proofCoverage: () => proofCount,
            observationStatus: () => Object.freeze({ state: !observed ? 'NOT_INSTALLED' : faults.size ? 'UNKNOWN' : 'OBSERVING',
                unresolved: records?.size || 0, faults: Object.freeze([...faults]) }) });
    }
    // Import-only, single-source Content processing; no startup occurs here.
    function createContentHandoff(dependencies) {
        const { state, overlayCore, phase5Tuning, performance, PHASE3_UNTUNED_RUNTIME,
            isEffectiveDisplayActive, getCurrentMainMedia, cleanupOverlay, ensurePhase3Runtime,
            ensureSubtitleGeometryObservers, ensurePlaybackContextObserver,
            observeLivePresentationBatch, publishReplaySchedulerDiagnostic,
            rememberReplayPendingOwner, pending, getPending, privateEntry } = dependencies;
        const MAX_MESSAGES = 500;
        // Dormant CommonJS composition only; the browser path never loads this module.
        const admissionFactory = privateEntry ? require('./bridge-admission.js').createBridgeAdmissionObserver : null;
        const registrations = privateEntry ? new WeakMap() : null;
        const faults = privateEntry ? new Set() : null;
        const dispositionProofs = privateEntry ? new WeakMap() : null;
        let dispositionProofCount = 0;
        let active = null, delivering = false, processing = false;
        function productInvalidated(lease) {
            return (typeof privateEntry?.isProductInvalidated === 'function' &&
                privateEntry.isProductInvalidated(lease) === true) ||
                (typeof privateEntry?.isProductCurrent === 'function' && privateEntry.isProductCurrent(lease) !== true);
        }
        function fault(reason) {
            if (faults) {
                faults.add(reason);
                try { privateEntry.onFault?.(reason); } catch (_) { faults.add('FAULT_RECEIVER_THROWN'); }
            }
        }
        function record(index, disposition, item = null) {
            if (active.outcomes[index]) { fault('DUPLICATE_DISPOSITION'); return; }
            active.outcomes[index] = { disposition, item };
            if (disposition === 'UNKNOWN') fault('INCOMPLETE_DISPOSITION');
        }
        function markScheduled(disposition) { active.scheduled.forEach(index => record(index, disposition)); }
        function observeAdmission(runtime, index, payload, options, productLease) {
            const occurrence = active.occurrences[index];
            let before, admission, returned;
            try {
                const guardedRuntime = runtime && typeof privateEntry?.isProductInvalidated === 'function'
                    ? Object.freeze({ get queue() { return runtime.queue; }, get status() { return runtime.status; },
                        enqueue(value, settings) { return productInvalidated(productLease) ? false : runtime.enqueue(value, settings); } })
                    : runtime;
                admission = admissionFactory({ runtime: guardedRuntime, pendingOwner: active.identity.pendingOwner });
                before = runtime ? runtime.queue.snapshot() : null;
            } catch (_) { fault('ADMISSION_OBSERVER_UNAVAILABLE'); }
            // A missing observer never changes an actual enqueue decision.
            try {
                if (productInvalidated(productLease)) return false;
                returned = admission ? admission.enqueue(occurrence, payload, options)
                    : runtime ? runtime.enqueue(payload, options) : false;
            } catch (error) { record(index, 'UNKNOWN'); throw error; }
            try {
                const receipt = admission?.receipt(occurrence);
                if (receipt?.status === 'VERIFIED_NO_ADMISSION') record(index, 'ADMISSION_REJECTED');
                else if (receipt?.status === 'ADMITTED' && before) {
                    const after = runtime.queue.snapshot();
                    const added = after.filter(item => !before.includes(item));
                    if (added.length === 1 && added[0].payload === payload &&
                        pending.samePendingOwner(added[0].pendingOwner, active.identity.pendingOwner) &&
                        after.length === before.length + 1 && before.every((item, i) => item === after[i])) {
                        record(index, 'ADMITTED', added[0]);
                    } else record(index, 'UNKNOWN');
                } else record(index, 'UNKNOWN');
            } catch (_) { if (!active.outcomes[index]) record(index, 'UNKNOWN'); fault('ADMISSION_METADATA_UNKNOWN'); }
            return returned;
        }
        function enqueue(runtime, payload, options, index, productLease) {
            if (productInvalidated(productLease)) return false;
            return active ? observeAdmission(runtime, active.visible[index], payload, options, productLease)
                : runtime.enqueue(payload, options);
        }
        function guard() {
            if (processing || delivering) { fault('REENTRANT_PROCESSING'); throw new Error('REENTRANT_PROCESSING'); }
        }
        function registerBatch(handle) {
            guard();
            if (!registrations) return false;
            if (!handle || typeof handle !== 'object' || registrations.has(handle)) { fault('INVALID_REGISTRATION'); return false; }
            let identity;
            try { identity = privateEntry?.recognizeBatch(handle); }
            catch (_) { fault('REGISTRATION_UNKNOWN'); return false; }
            if (!identity || !Object.isFrozen(identity) || typeof identity.document !== 'object' || !identity.document ||
                typeof identity.scope !== 'object' || !identity.scope ||
                typeof identity.targetId !== 'string' || !identity.targetId ||
                ![identity.lifecycle, identity.revision].every(value => Number.isSafeInteger(value) && value >= 0) ||
                !pending.clonePendingOwner(identity.pendingOwner) ||
                identity.pendingOwner.target !== identity.targetId || identity.pendingOwner.lifecycle !== identity.lifecycle ||
                identity.pendingOwner.revision !== identity.revision || !Array.isArray(identity.messages) ||
                !Object.isFrozen(identity.messages) || !Array.isArray(identity.occurrences) ||
                !Object.isFrozen(identity.occurrences) || identity.occurrences.length !== identity.messages.length ||
                new Set(identity.occurrences).size !== identity.occurrences.length) { fault('INVALID_REGISTRATION'); return false; }
            try {
                for (let i = 0; i < identity.occurrences.length; i++) {
                    const original = privateEntry.recognizeOccurrence(identity.occurrences[i]);
                    if (!original || original.message !== identity.messages[i] || original.origin.document !== identity.document ||
                        original.association.scope !== identity.scope || original.association.pendingOwner !== identity.pendingOwner) {
                        fault('INVALID_ORIGIN'); return false;
                    }
                }
            } catch (_) { fault('INVALID_ORIGIN'); return false; }
            registrations.set(handle, { identity, used: false });
            return true;
        }
        function processRegisteredBatch(handle, productLease) {
            if (typeof privateEntry?.withProductReceiver === 'function')
                return privateEntry.withProductReceiver(productLease, () => processRegisteredOriginal(handle, productLease));
            return processRegisteredOriginal(handle, productLease);
        }
        function processRegisteredOriginal(handle, productLease) {
            guard();
            const registration = handle && typeof handle === 'object' ? registrations?.get(handle) : null;
            if (!registration || registration.used) { fault('INVALID_OR_REUSED_BATCH'); return; }
            registration.used = true;
            try {
                if (privateEntry.claimBatch(registration.identity) !== true) { fault('INVALID_OR_REUSED_BATCH'); return; }
            } catch (_) { fault('REGISTRATION_UNKNOWN'); return; }
            let current = false;
            try { current = privateEntry.isCurrent(registration.identity) === true; } catch (_) { /* UNKNOWN */ }
            if (!current) { fault('STALE_BATCH'); return; }
            const identity = registration.identity, messages = identity.messages;
            const call = { identity, occurrences: identity.occurrences, proofs: [], completed: false,
                visited: [], outcomes: [], scheduled: [], visible: [] };
            processing = true; active = call;
            try { const result = processSuccess(messages, identity.pendingOwner, null, productLease); call.completed = true; return result; }
            catch (error) { fault('PROCESSING_THROWN'); throw error; }
            finally {
                active = null; processing = false; delivering = true;
                try {
                    messages.forEach((_, index) => {
                        const outcome = call.outcomes[index];
                        if (!outcome) fault('INTERRUPTED_BATCH');
                        // Unknown unvisited tail is coverage, never a fabricated occurrence event.
                        if (!call.visited[index]) return;
                        const event = Object.freeze({ occurrence: call.occurrences[index],
                            disposition: outcome?.disposition || 'UNKNOWN', item: outcome?.item || null });
                        const proof = Object.freeze({}), receipt = { kind: 'CONTENT', state: 'PENDING', identity, event };
                        if (dispositionProofCount < Number.MAX_SAFE_INTEGER) dispositionProofCount++; else fault('COUNTER_OVERFLOW');
                        dispositionProofs.set(proof, receipt); call.proofs.push(receipt);
                        try {
                            if (typeof privateEntry.onDisposition !== 'function') fault('MISSING_RECEIVER');
                            else {
                                const returned = privateEntry.onDisposition(identity, event, proof);
                                if (returned !== null && ['object', 'function'].includes(typeof returned)) { receipt.state = 'UNKNOWN'; fault('INCOMPLETE_DISPOSITION'); }
                            }
                        } catch (_) { receipt.state = 'FAILED'; fault('RECEIVER_THROWN'); }
                    });
                } finally {
                    delivering = false;
                    for (const receipt of call.proofs) if (receipt.state === 'PENDING') receipt.state =
                        call.completed && !faults.size ? 'FINAL_DELIVERED' : 'UNKNOWN';
                }
            }
        }
    function processSuccess(messages, sourceOwner, sourceScope, productLease) {
        if (productInvalidated(productLease)) return;
        const messageIds = new Set(state.currentMessages.map((message) => message.id).filter(Boolean));
        const newMessages = [];
        let exactIdDedupedCount = 0;
        messages.forEach((message, index) => {
            if (productInvalidated(productLease)) return;
            if (active) active.visited[index] = true;
            if (message.id && messageIds.has(message.id)) {
                if (active) record(index, 'EXACT_ID_DUPLICATE');
                exactIdDedupedCount += 1; return;
            }
            if (message.id) messageIds.add(message.id);
            if (productInvalidated(productLease)) return;
            state.currentMessages.push(message);
            newMessages.push(message);
            if (active) active.scheduled.push(index);
        });
        if (productInvalidated(productLease)) return;
        if (state.currentMessages.length > MAX_MESSAGES) {
            state.currentMessages.splice(0, state.currentMessages.length - MAX_MESSAGES);
        }
        const pendingOwner = active ? active.identity.pendingOwner : (getPending ? getPending() : pending).clonePendingOwner(sourceOwner);
        rememberReplayPendingOwner(pendingOwner, sourceScope);
        if (productInvalidated(productLease)) return;
        scheduleDanmakuBatch(newMessages, pendingOwner, productLease);
        if (productInvalidated(productLease)) return;
        if (state.currentChatMode === 'replay' && exactIdDedupedCount > 0) publishReplayBatchAccounting({ exactIdDedupedCount });
    }

    function currentSourceActivityBinding() {
        if (!state.currentPageKey || !['live', 'replay'].includes(state.currentChatMode) ||
            !Number.isSafeInteger(state.currentPageLifecycleGeneration) || state.currentPageLifecycleGeneration < 0) return null;
        return Object.freeze({
            target: state.currentPageKey,
            timeline: `${state.currentChatMode}:${state.currentPageRevision}`,
            generation: state.currentPageLifecycleGeneration
        });
    }

    function observeCurrentWindowSourceActivity(runtime, messages, media, productLease) {
        const binding = currentSourceActivityBinding();
        const playerTimeMsec = Number.isFinite(media?.video?.currentTime) ? media.video.currentTime * 1000 : null;
        if (!runtime || !binding || !Number.isFinite(playerTimeMsec) || !Array.isArray(messages)) return null;
        const windowEndMs = playerTimeMsec + 250;
        const windowStartMs = Math.max(0, windowEndMs - PHASE3_UNTUNED_RUNTIME.sourceActivityWindowMsec);
        const facts = messages.map((message) => Object.freeze({
            mediaTimeMs: state.currentChatMode === 'replay' && Number.isFinite(message?.replayOffsetMsec)
                ? message.replayOffsetMsec : playerTimeMsec,
            displayable: true,
            temporalClass: 'CURRENT_WINDOW'
        }));
        if (productInvalidated(productLease)) return null;
        return runtime.observeSourceActivity?.({ eventBinding: binding, mediaTimeMs: playerTimeMsec,
            windowStartMs, windowEndMs, facts }) || null;
    }

    function scheduleDanmakuBatch(messages, pendingOwner = null, productLease) {
        if (productInvalidated(productLease)) return;
        const inputCount = Array.isArray(messages) ? messages.length : 0;
        if (!isEffectiveDisplayActive()) {
            if (active) markScheduled('DISPLAY_SUPPRESSED');
            observeLivePresentationBatch({ input: inputCount, lifecycleSuppressed: inputCount, suppressedOther: inputCount });
            if (state.currentChatMode === 'replay') publishReplayBatchAccounting({
                inputCount, lifecycleDiscarded: inputCount, lifecycleDiscardedDisplayDisabled: inputCount
            });
            return;
        }
        const media = getCurrentMainMedia();
        if (productInvalidated(productLease)) return;
        if (!media || !overlayCore?.isMainContentPlaybackEligible?.(media.player, media.video)) {
            if (active) markScheduled('MEDIA_SUPPRESSED');
            state.phase3Runtime?.clear();
            observeLivePresentationBatch({ input: inputCount, lifecycleSuppressed: inputCount,
                suppressedPaused: media?.video?.paused === true ? inputCount : 0,
                suppressedOther: media?.video?.paused === true ? 0 : inputCount });
            if (state.currentChatMode === 'replay') {
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
        if (state.currentChatMode === 'live' && state.livePresentationResumeGateActive) {
            const proximity = overlayCore?.classifyLiveEdgeProximity?.({
                currentTime: media.video.currentTime,
                seekable: snapshotTimeRanges(media.video.seekable),
                buffered: snapshotTimeRanges(media.video.buffered)
            }) || 'UNKNOWN';
            const gate = overlayCore?.reduceLivePresentationResumeGate?.(true, 'BATCH', proximity) ||
                Object.freeze({ active: true, allowLaunch: false, reason: 'UNKNOWN' });
            state.livePresentationResumeGateActive = gate.active;
            if (!gate.allowLaunch) {
                if (active) markScheduled('LIVE_RESUME_SUPPRESSED');
                state.phase3Runtime?.clear();
                observeLivePresentationBatch({ input: inputCount, lifecycleSuppressed: inputCount,
                    suppressedBehindLive: gate.reason === 'BEHIND_LIVE' ? inputCount : 0,
                    suppressedUnknown: gate.reason === 'UNKNOWN' ? inputCount : 0 });
                return;
            }
        }
        if (productInvalidated(productLease)) return;
        if (state.phase3Runtime && state.phase3RuntimeVideo !== media.video) cleanupOverlay();
        if (productInvalidated(productLease)) return;
        const runtime = ensurePhase3Runtime();
        if (productInvalidated(productLease)) return;
        if (!runtime) {
            if (active) active.scheduled.forEach((index) => observeAdmission(null, index, null, null, productLease));
            observeLivePresentationBatch({ input: inputCount, enqueueRejected: inputCount });
            if (state.currentChatMode === 'replay') publishReplayBatchAccounting({ inputCount, enqueueRejected: inputCount });
            return;
        }
        ensureSubtitleGeometryObservers(media.player);
        if (productInvalidated(productLease)) return;
        ensurePlaybackContextObserver(media.player);
        if (productInvalidated(productLease)) return;
        const scheduledGeneration = state.rendererGeneration;
        const scheduledVideo = media.video;
        const launchSettingsSnapshot = state.runtimeSettings;
        const visibleMessages = Array.isArray(messages)
            ? messages.filter((message, index) => {
                const visible = overlayCore.isMessageVisibleForSettings(message, launchSettingsSnapshot);
                if (active) {
                    const original = active.scheduled[index];
                    if (visible) active.visible.push(original); else record(original, 'VISIBILITY_FILTERED');
                }
                return visible;
            })
            : [];
        if (productInvalidated(productLease)) return;
        observeCurrentWindowSourceActivity(runtime, visibleMessages, media, productLease);
        if (productInvalidated(productLease)) return;
        let enqueuedCount = 0;
        state.replayDiagnosticBatchInProgress = true;
        try { visibleMessages.forEach((message, index) => {
            if (productInvalidated(productLease)) return;
            if (enqueue(runtime, {
            message,
            ...(typeof privateEntry?.isProductCurrent === 'function' ? { productLease } : {}),
            pendingOwner,
            generation: scheduledGeneration,
            pageLifecycleGeneration: state.currentPageLifecycleGeneration,
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
            }, index, productLease)) enqueuedCount += 1;
        }); } finally { state.replayDiagnosticBatchInProgress = false; }
        if (productInvalidated(productLease)) return;
        if (state.currentChatMode === 'replay') {
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
            if (Number.isInteger(value) && value >= 0) state.replayDiagnosticBatch[key] = (state.replayDiagnosticBatch[key] || 0) + value;
        }
        publishReplaySchedulerDiagnostic();
    }

        return Object.freeze({
            processLegacySuccess(messages, owner, scope, productLease) {
                guard();
                return typeof privateEntry?.withProductReceiver === 'function'
                    ? privateEntry.withProductReceiver(productLease, () => processSuccess(messages, owner, scope, productLease))
                    : processSuccess(messages, owner, scope, productLease);
            },
            recognizeProof(proof) { const receipt = dispositionProofs?.get(proof); return receipt ? Object.freeze({ ...receipt }) : null; },
            isProofDelivering: () => delivering || processing,
            proofCoverage: () => dispositionProofCount,
            scheduleDanmakuBatch(messages, owner, productLease) { guard(); return scheduleDanmakuBatch(messages, owner, productLease); },
            currentSourceActivityBinding, registerBatch, processRegisteredBatch,
            observationStatus: () => Object.freeze({ state: !faults ? 'DORMANT' : faults.size ? 'UNKNOWN' : 'OBSERVING',
                faults: Object.freeze(faults ? [...faults] : []), scopeClosure: 'NOT_IMPLEMENTED' })
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Object.freeze({ createRenderer, createContentHandoff, startContent });
        return;
    }

    function startContent(cutover = null) {
    const privateBridge = cutover ? cutover.createBridge() : null;
    const LOG_PREFIX = '[LiveFlow PoC]';
    const REQUEST_TYPE = 'LIVEFLOW_REQUEST_INITIAL_CHAT_CONTINUATION';
    const RESPONSE_TYPE = 'LIVEFLOW_INITIAL_CHAT_CONTINUATION';
    const READ_REQUEST_TYPE = 'LIVEFLOW_REQUEST_CHAT_READ_ONCE';
    const READ_RESPONSE_TYPE = 'LIVEFLOW_CHAT_READ_ONCE_RESULT';
    const STOP_READ_LOOP_TYPE = 'LIVEFLOW_STOP_CHAT_READ_LOOP';
    const RESUME_READ_LOOP_TYPE = 'LIVEFLOW_RESUME_CHAT_READ_AFTER_VISIBILITY';
    const NAVIGATION_INVALIDATED_TYPE = 'LIVEFLOW_PAGE_LIFECYCLE_INVALIDATED';
    const LIFECYCLE_DIAGNOSTIC_TYPE = 'LIVEFLOW_READ_LIFECYCLE_DIAGNOSTIC';
    const REPLAY_AD_ENTER_TYPE = 'LIVEFLOW_REPLAY_AD_ENTER';
    const REPLAY_AD_EXIT_TYPE = 'LIVEFLOW_REPLAY_AD_EXIT';
    const REPLAY_PIPELINE_DIAGNOSTIC_TYPE = 'LIVEFLOW_REPLAY_PIPELINE_DIAGNOSTIC';
    const PENDING_ONLY_CLEAR_TYPE = 'LIVEFLOW_PENDING_ONLY_CLEAR';
    const PENDING_ONLY_CLEAR_ACK_TYPE = 'LIVEFLOW_PENDING_ONLY_CLEAR_ACK';
    const MAX_MESSAGES = 500;
    const MANAGEMENT_BAR_ID = 'liveflow-management-bar';
    const MANAGEMENT_STYLE_ID = 'liveflow-management-bar-style';
    const UI_FALLBACK_MESSAGES = Object.freeze({
        managementBarLabel: 'LiveFlow controls',
        liveFlowOn: 'LiveFlow ON',
        liveFlowOff: 'LiveFlow OFF'
    });
    // Structural integration placeholders only; Phase 5 owns production tuning.
    const PHASE3_UNTUNED_RUNTIME = Object.freeze({
        geometryEpsilon: 1,
        subtitleMargin: 8,
        scanDepth: 5,
        cohortMaximumItems: 5,
        maximumRescueFraction: 0.75,
        attackThresholds: Object.freeze([0.5, 0.75, 0.9]),
        releaseThresholds: Object.freeze([0.2, 0.35, 0.5]),
        minimumAttackResidence: 2,
        releaseDwell: 4,
        sourceActivityWindowMsec: 10000,
        sourceActivityBandThresholdsPerSecond: Object.freeze([1, 2, 4]),
        sourceActivityPromotionResidence: 2,
        sourceActivityReleaseDwell: 2,
    });
    let displayLinkSettings = Object.freeze({
        autoEnableLiveFlowWhenNativeChatClosed: true,
        autoOpenNativeChatWhenLiveFlowDisabled: true
    });
    let runtimeSettings = Object.freeze({});
    let persistentSettingsReady = false;
    const PLAYER_SELECTORS = Object.freeze({
        watchRoot: 'ytd-watch-flexy',
        nativeChat: 'ytd-live-chat-frame#chat, ytd-live-chat-frame',
        nativeChatContainer: '#chat-container, #secondary-inner',
        nativeChatOpenButtons: Object.freeze([
            'ytd-live-chat-frame#chat #show-hide-button button',
            'ytd-live-chat-frame#chat #show-hide-button tp-yt-paper-button',
            '#chat-container #show-hide-button button',
            '#chat-container #show-hide-button tp-yt-paper-button'
        ]),
        belowPlayer: '#below',
        player: '#movie_player, .html5-video-player',
        video: 'video.html5-main-video, video',
        miniPlayerAncestor: 'ytd-miniplayer, #miniplayer'
    });
    const overlayCore = window.LiveFlowOverlayCore;
    const schedulerRuntimeCore = window.LiveFlowSchedulerRuntime;
    const schedulerFoundations = window.LiveFlowSchedulerFoundations;
    const geometryCore = window.LiveFlowGeometryAdapter;
    const phase5Tuning = window.LiveFlowPhase5Tuning?.CURRENT;
    let overlayRoot = null;
    let overlaySurface = null;
    let laneStates = [];
    const activeDanmaku = new Map();
    let phase3Runtime = null;
    let phase3RuntimeVideo = null;
    let subtitleGeometryAuthority = null;
    let subtitleGeometryAdapter = null;
    let subtitleMutationObserver = null;
    let subtitleResizeObserver = null;
    let subtitleObservedPlayer = null;
    let playbackContextObserver = null;
    let playbackContextObservedPlayer = null;
    let playbackContextWasAd = false;
    let internalApiContext = null;
    let chatAvailable = false;
    let currentPageRevision = 0;
    let readRequestedRevision = -1;
    let currentMessages = [];
    let currentPageKey = '';
    let rendererGeneration = 0;
    let acceptingReadResults = false;
    let minimumAcceptedPageRevision = 0;
    let geometryChangeQueued = false;
    let pageGeneration = 0;
    let currentPageLifecycleGeneration = -1;
    let currentChatMode = 'unknown';
    let livePresentationResumeGateActive = false;
    let livePresentationAccounting = createLivePresentationAccounting();
    let replaySchedulerDiagnostic = createReplaySchedulerDiagnostic();
    let replayDiagnosticEpoch = null;
    let replayDiagnosticLifecycle = 0;
    let replayDiagnosticSequence = 0;
    let replayDiagnosticBatch = {};
    let replayDiagnosticDisplayed = 0;
    let replayDiagnosticAwaiting = null;
    let replayDiagnosticIncomplete = false;
    let replayDiagnosticBatchInProgress = false;
    const replayContentPendingOwners = new Map();
    const replayContentClearOperations = new Map();
    let replayPendingClearApplying = null;

    function rememberReplayPendingOwner(binding, scope) {
        if (!binding || binding.lifecycle !== currentPageLifecycleGeneration || binding.revision !== currentPageRevision) return;
        const key = binding.document + ':' + binding.stream;
        const existing = replayContentPendingOwners.get(key);
        if (existing) {
            if (!window.LiveFlowPendingSelection.samePendingOwner(existing.owner, binding)) replayDiagnosticIncomplete = true;
            return;
        }
        if (replayContentPendingOwners.size >= 64) { replayDiagnosticIncomplete = true; return; }
        replayContentPendingOwners.set(key, { owner: binding, video: getCurrentMainMedia()?.video,
            epoch: scope?.epoch, lifecycle: scope?.lifecycle });
    }

    function handlePendingOnlyClear(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const data = event.data;
        if (data?.source !== 'liveflow-page-state' || data.type !== PENDING_ONLY_CLEAR_TYPE) return;
        const owner = window.LiveFlowPendingSelection.clonePendingOwner(data.owner);
        if (!owner || data.document !== owner.document || data.reason !== 'FAIL_CLOSED' ||
            !Number.isSafeInteger(data.operationId) || data.operationId < 1 ||
            !Number.isSafeInteger(data.epoch) || data.epoch < 0 || data.lifecycle !== owner.lifecycle) return;
        const key = data.document + ':' + data.operationId;
        const previous = replayContentClearOperations.get(key);
        let result;
        if (previous) {
            result = window.LiveFlowPendingSelection.samePendingOwner(previous.owner, owner) &&
                previous.reason === data.reason && previous.epoch === data.epoch && previous.lifecycle === data.lifecycle
                ? { ...previous, status: 'DUPLICATE', originalStatus: previous.status }
                : { operationId: data.operationId, owner, reason: data.reason,
                    epoch: data.epoch, lifecycle: data.lifecycle, status: 'FAILED', count: 0 };
        } else {
            const known = replayContentPendingOwners.get(owner.document + ':' + owner.stream);
            result = { operationId: data.operationId, owner, reason: data.reason,
                epoch: data.epoch, lifecycle: data.lifecycle, status: 'NOT_APPLIED_UNKNOWN', count: 0 };
            if (replayContentClearOperations.size >= 64) {
                replayDiagnosticIncomplete = true; result.status = 'FAILED';
            } else {
                const media = getCurrentMainMedia();
                if (known && window.LiveFlowPendingSelection.samePendingOwner(known.owner, owner) &&
                    owner.lifecycle === currentPageLifecycleGeneration && owner.revision === currentPageRevision &&
                    known.video === media?.video && (!phase3Runtime || phase3RuntimeVideo === media?.video)) {
                    const applying = { owner, epoch: known.epoch, lifecycle: known.lifecycle, count: 0, fault: false };
                    const batching = replayDiagnosticBatchInProgress;
                    replayDiagnosticBatchInProgress = true;
                    replayPendingClearApplying = applying;
                    try {
                        const removed = phase3Runtime?.removePendingOwner(owner) || { status: 'STALE_OR_NOT_FOUND', count: 0 };
                        result.status = removed.status; result.count = removed.count;
                        if (applying.count !== removed.count || applying.fault || known.epoch !== data.epoch ||
                            known.lifecycle !== data.lifecycle) { result.status = 'FAILED'; replayDiagnosticIncomplete = true; }
                    } catch { result.status = 'FAILED'; replayDiagnosticIncomplete = true; }
                    finally { replayPendingClearApplying = null; replayDiagnosticBatchInProgress = batching; }
                }
                replayContentClearOperations.set(key, Object.freeze(result));
            }
            publishReplaySchedulerDiagnostic();
        }
        window.postMessage({ source: 'liveflow-content-script', type: PENDING_ONLY_CLEAR_ACK_TYPE,
            ...result, document: owner.document }, window.location.origin);
    }

    function publishReplayScopeSnapshot(terminal = false) {
        if (cutover) return;
        if (replayDiagnosticEpoch === null) return;
        window.postMessage({ source: 'liveflow-content-script', type: REPLAY_PIPELINE_DIAGNOSTIC_TYPE,
            pageLifecycleGeneration: replayDiagnosticLifecycle, diagnosticScopeEpoch: replayDiagnosticEpoch,
            diagnosticSequence: ++replayDiagnosticSequence, diagnosticTerminal: terminal,
            diagnosticIncomplete: replayDiagnosticIncomplete, batch: { ...replayDiagnosticBatch },
            pendingClearResults: [...replayContentClearOperations.values()].filter(r =>
                r.epoch === replayDiagnosticEpoch && r.lifecycle === replayDiagnosticLifecycle),
            displayedCount: replayDiagnosticDisplayed, scheduler: { ...replaySchedulerDiagnostic } }, window.location.origin);
    }

    function resetReplayDiagnosticCounters() {
        replayDiagnosticSequence = 0;
        replayDiagnosticBatch = {};
        replayDiagnosticDisplayed = 0;
        replaySchedulerDiagnostic = createReplaySchedulerDiagnostic();
        resetReplayLaunchGapDiagnostic();
    }

    function closeReplayDiagnosticScope() {
        if (replayDiagnosticEpoch === null) {
            // A second transition before binding cannot be represented as a complete scope.
            replayDiagnosticIncomplete = true;
            return;
        }
        publishReplayScopeSnapshot(true);
        replayDiagnosticAwaiting = replayDiagnosticEpoch;
        replayDiagnosticEpoch = null;
        resetReplayDiagnosticCounters();
    }

    function handleReplayDiagnosticScopeOpen(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const data = event.data;
        if (data?.source !== 'liveflow-page-state' || data.type !== 'LIVEFLOW_REPLAY_DIAGNOSTIC_SCOPE_OPEN' ||
            !Number.isSafeInteger(data.diagnosticScopeEpoch) || data.diagnosticScopeEpoch < 0 ||
            data.pageLifecycleGeneration !== currentPageLifecycleGeneration) return;
        if (replayDiagnosticEpoch === data.diagnosticScopeEpoch ||
            (replayDiagnosticAwaiting !== null && data.diagnosticScopeEpoch <= replayDiagnosticAwaiting) ||
            (replayDiagnosticEpoch !== null && data.diagnosticScopeEpoch < replayDiagnosticEpoch)) return;
        const initialBinding = replayDiagnosticEpoch === null && replayDiagnosticAwaiting === null && data.previousEpoch === null;
        const expectedHandoff = replayDiagnosticEpoch === null && replayDiagnosticAwaiting !== null &&
            data.previousEpoch === replayDiagnosticAwaiting;
        if (!initialBinding && !expectedHandoff) {
            // Never clear runtime here: a missed close only invalidates diagnostics.
            replayDiagnosticIncomplete = true;
            resetReplayDiagnosticCounters();
        }
        replayDiagnosticEpoch = data.diagnosticScopeEpoch;
        replayDiagnosticLifecycle = data.pageLifecycleGeneration;
        replayDiagnosticAwaiting = null;
        publishReplayScopeSnapshot();
    }

    let userEnabled = true;
    let nativeChatVisible = true;
    let nativeChatKnown = false;
    let nativeChatObserver = null;

    function createReplaySchedulerDiagnostic() {
        return {
            pendingCurrent: 0,
            schedulerLifecycleDiscarded: 0,
            schedulerStructuralDiscarded: 0,
            opportunitiesArmed: 0,
            opportunitiesEvaluated: 0,
            stalePruned: 0,
            staleAfterCollision: 0,
            staleAfterPacing: 0,
            staleAfterSelectionMiss: 0,
            staleAlreadyOnEnqueue: 0,
            staleOther: 0,
            capacityDropped: 0,
            emergencyPendingDropped: 0,
            sourceActivityBand: 'LOW',
            densityProvenance: 'NONE',
            selectionNone: 0,
            selectionNoneNoPending: 0,
            selectionNoneCollisionBlocked: 0,
            selectionNoneNoEligible: 0,
            collisionBlocked: 0,
            collisionActiveDanmaku: 0,
            collisionSubtitle: 0,
            collisionCandidateGeometry: 0,
            collisionNoUsableLane: 0,
            collisionOther: 0,
            geometryUnknown: 0,
            generationInvalidated: 0,
            geometryInvalidated: 0,
            launchCommitted: 0,
            launchAttempted: 0,
            launchRejected: 0,
            launchGapClass: 'NONE',
            launchGapCause: 'UNKNOWN',
            launchGapDuePending: false,
            launchGapEligibleCandidate: false,
            launchGapActiveDanmaku: false,
            launchGapCollisionBlocked: false,
            launchGapSchedulerState: 'IDLE',
            launchGapDensityLevel: 'NORMAL',
            schedulerState: 'IDLE'
        };
    }

    function createLivePresentationAccounting() {
        return {
            input: 0,
            enqueued: 0,
            visibilityFiltered: 0,
            enqueueRejected: 0,
            lifecycleSuppressed: 0,
            suppressedPaused: 0,
            suppressedBehindLive: 0,
            suppressedUnknown: 0,
            suppressedOther: 0
        };
    }

    function observeLivePresentationBatch(fields = {}) {
        if (currentChatMode !== 'live') return;
        for (const key of Object.keys(livePresentationAccounting)) {
            const value = fields[key];
            if (Number.isInteger(value) && value >= 0) livePresentationAccounting[key] += value;
        }
    }

    function livePresentationAccountingStatus() {
        const ledger = overlayCore?.computeLivePresentationAccounting?.(livePresentationAccounting) ||
            Object.freeze({ accounted: 0, lostUnaccounted: livePresentationAccounting.input, valid: false });
        return Object.freeze({ ...livePresentationAccounting, ...ledger });
    }

    if (!cutover) window.LiveFlowLivePresentationDiagnostic = Object.freeze({ status: livePresentationAccountingStatus });

    let replayLastLaunchAt = null;
    let replayGapCollisionBlocked = false;
    let replayGapSelectionNone = false;
    let replayGapGeometryBlocked = false;
    let replayGapStaleOnly = false;
    let replayGapHadNoDuePeriod = false;

    function resetReplayLaunchGapDiagnostic() {
        replayLastLaunchAt = null;
        replayGapCollisionBlocked = false;
        replayGapSelectionNone = false;
        replayGapGeometryBlocked = false;
        replayGapStaleOnly = false;
        replayGapHadNoDuePeriod = false;
    }

    function classifyReplayLaunchGap(elapsed) {
        return schedulerRuntimeCore?.classifyLaunchGapClass?.(elapsed) || 'NONE';
    }

    function updateReplayLaunchGap(status, completed = false) {
        if (replayLastLaunchAt === null) return;
        replaySchedulerDiagnostic.launchGapClass = classifyReplayLaunchGap(performance.now() - replayLastLaunchAt);
        replaySchedulerDiagnostic.launchGapDuePending = (status?.pendingCount || 0) > 0;
        replaySchedulerDiagnostic.launchGapEligibleCandidate = completed === true;
        replaySchedulerDiagnostic.launchGapActiveDanmaku = activeDanmaku.size > 0;
        replaySchedulerDiagnostic.launchGapCollisionBlocked = replayGapCollisionBlocked;
        replaySchedulerDiagnostic.launchGapSchedulerState = ['IDLE', 'ARMED', 'EVALUATING'].includes(status?.state) ? status.state : 'IDLE';
        replaySchedulerDiagnostic.launchGapDensityLevel = ['NORMAL', 'COMPACT', 'DENSE', 'MAX_READABLE'].includes(status?.density) ? status.density : 'NORMAL';
        replaySchedulerDiagnostic.launchGapCause = schedulerRuntimeCore?.classifyLaunchGapCause?.({
            pendingCount: replayGapHadNoDuePeriod ? 0 : status?.pendingCount || 0,
            geometryBlocked: replayGapGeometryBlocked,
            collisionBlocked: replayGapCollisionBlocked,
            selectionNone: replayGapSelectionNone,
            staleOnly: replayGapStaleOnly
        }) || 'UNKNOWN';
    }

    function publishReplaySchedulerDiagnostic(stableEvaluationBoundary = false) {
        if (cutover) return;
        if (currentChatMode !== 'replay' || replayDiagnosticBatchInProgress) return;
        const status = phase3Runtime?.status?.();
        // Counters still update at every original event. Publish only a coherent event/batch boundary.
        if (status?.state === 'EVALUATING' && !stableEvaluationBoundary) return;
        if (Number.isInteger(status?.pendingCount)) replaySchedulerDiagnostic.pendingCurrent = status.pendingCount;
        publishReplayScopeSnapshot();
    }

    function observeReplayScheduler(event) {
        if (!event || typeof event.type !== 'string') return;
        if (event.type === 'ARMED') replaySchedulerDiagnostic.opportunitiesArmed += 1;
        if (event.type === 'EVALUATING') replaySchedulerDiagnostic.opportunitiesEvaluated += 1;
        if (event.type === 'STALE_PRUNED') {
            replaySchedulerDiagnostic.stalePruned += Number.isInteger(event.count) ? event.count : 0;
            replaySchedulerDiagnostic.staleAfterCollision += event.staleReasons?.collisionBlocked || 0;
            replaySchedulerDiagnostic.staleAfterPacing += event.staleReasons?.pacingWait || 0;
            replaySchedulerDiagnostic.staleAfterSelectionMiss += event.staleReasons?.selectionMiss || 0;
            replaySchedulerDiagnostic.staleAlreadyOnEnqueue += event.staleReasons?.alreadyStaleOnEnqueue || 0;
            replaySchedulerDiagnostic.staleOther += event.staleReasons?.other || 0;
            replayGapStaleOnly = true;
        }
        if (event.type === 'CAPACITY_DROPPED') {
            replaySchedulerDiagnostic.capacityDropped += Number.isInteger(event.count) ? event.count : 0;
        }
        if (event.type === 'STRUCTURAL_DROPPED') {
            replaySchedulerDiagnostic.schedulerStructuralDiscarded += Number.isInteger(event.count) ? event.count : 0;
        }
        if (event.type === 'EMERGENCY_PENDING_DROPPED') {
            replaySchedulerDiagnostic.emergencyPendingDropped += Number.isInteger(event.count) ? event.count : 0;
        }
        if (event.type === 'PENDING_CLEARED' && event.reason === 'LIFECYCLE_SUPPRESSED') {
            replaySchedulerDiagnostic.schedulerLifecycleDiscarded += Number.isInteger(event.count) ? event.count : 0;
        }
        if (event.type === 'PENDING_OWNER_REMOVED') {
            const applying = replayPendingClearApplying;
            if (applying && window.LiveFlowPendingSelection.samePendingOwner(applying.owner, event.pendingOwner) &&
                Number.isSafeInteger(event.count) && event.count > 0) {
                applying.count += event.count;
                if (applying.epoch === replayDiagnosticEpoch && applying.lifecycle === replayDiagnosticLifecycle) {
                    replaySchedulerDiagnostic.schedulerLifecycleDiscarded += event.count;
                } else { applying.fault = true; replayDiagnosticIncomplete = true; }
            } else replayDiagnosticIncomplete = true;
        }
        if (event.type === 'SELECTION_NONE') {
            replaySchedulerDiagnostic.selectionNone += 1;
            if ((event.pendingCount || 0) === 0) replaySchedulerDiagnostic.selectionNoneNoPending += 1;
            else if (replayGapCollisionBlocked) replaySchedulerDiagnostic.selectionNoneCollisionBlocked += 1;
            else replaySchedulerDiagnostic.selectionNoneNoEligible += 1;
            replayGapSelectionNone = true;
        }
        if (event.type === 'COLLISION_BLOCKED') {
            replaySchedulerDiagnostic.collisionBlocked += 1;
            replayGapCollisionBlocked = true;
        }
        if (event.type === 'COLLISION_ACTIVE_DANMAKU') replaySchedulerDiagnostic.collisionActiveDanmaku += 1;
        if (event.type === 'COLLISION_SUBTITLE') replaySchedulerDiagnostic.collisionSubtitle += 1;
        if (event.type === 'COLLISION_CANDIDATE_GEOMETRY') replaySchedulerDiagnostic.collisionCandidateGeometry += 1;
        if (event.type === 'COLLISION_NO_USABLE_LANE') replaySchedulerDiagnostic.collisionNoUsableLane += 1;
        if (event.type === 'COLLISION_OTHER') replaySchedulerDiagnostic.collisionOther += 1;
        if (event.type === 'GEOMETRY_UNKNOWN') { replaySchedulerDiagnostic.geometryUnknown += 1; replayGapGeometryBlocked = true; }
        if (event.type === 'GENERATION_INVALIDATED') replaySchedulerDiagnostic.generationInvalidated += 1;
        if (event.type === 'GEOMETRY_INVALIDATED') replaySchedulerDiagnostic.geometryInvalidated += 1;
        if (event.type === 'LAUNCH_COMMITTED') replaySchedulerDiagnostic.launchCommitted += 1;
        if (event.type === 'LAUNCH_ATTEMPTED') replaySchedulerDiagnostic.launchAttempted += 1;
        if (event.type === 'LAUNCH_REJECTED') replaySchedulerDiagnostic.launchRejected += 1;
        const status = phase3Runtime?.status?.();
        updateReplayLaunchGap(status, event.type === 'LAUNCH_COMMITTED');
        if (event.type === 'LAUNCH_COMMITTED') {
            replayGapHadNoDuePeriod = (status?.pendingCount || 0) === 0;
            replayLastLaunchAt = performance.now();
            replayGapCollisionBlocked = false;
            replayGapSelectionNone = false;
            replayGapGeometryBlocked = false;
            replayGapStaleOnly = false;
        }
        replaySchedulerDiagnostic.pendingCurrent = Number.isInteger(status?.pendingCount) ? status.pendingCount :
            Number.isInteger(event.pendingCount) ? event.pendingCount : replaySchedulerDiagnostic.pendingCurrent;
        if (['LOW', 'MEDIUM', 'HIGH', 'BURST'].includes(status?.sourceActivityBand)) {
            replaySchedulerDiagnostic.sourceActivityBand = status.sourceActivityBand;
        }
        replaySchedulerDiagnostic.densityProvenance = ['SOURCE_ACTIVITY', 'PRESSURE_RESCUE', 'BOTH'].includes(status?.densityProvenance)
            ? status.densityProvenance : 'NONE';
        replaySchedulerDiagnostic.schedulerState = ['IDLE', 'ARMED', 'EVALUATING'].includes(status?.state)
            ? status.state : ['IDLE', 'ARMED', 'EVALUATING'].includes(event.state) ? event.state : replaySchedulerDiagnostic.schedulerState;
        publishReplaySchedulerDiagnostic(['LAUNCH_COMMITTED', 'LAUNCH_REJECTED', 'SELECTION_NONE', 'GENERATION_INVALIDATED', 'GEOMETRY_INVALIDATED'].includes(event.type));
    }
    let observedWatchRoot = null;
    let visibilityEvaluationQueued = false;
    let managementAttachmentTask = null;
    let managementBar = null;
    let managementToggleButton = null;
    let managementToggleLabel = null;
    let managementReadIndicator = null;
    let readIndicatorState = 'idle';
    let nativeChatOpenAttempt = null;

    function logInfo(message) {
        console.log(`${LOG_PREFIX} ${message}`);
    }

    function getUiMessage(key) {
        return overlayCore.getLocalizedMessage(globalThis.chrome?.i18n, key, UI_FALLBACK_MESSAGES[key]);
    }

    function requestInitialContinuation() {
        if (privateBridge) return privateBridge.start();
        window.postMessage({
            source: 'liveflow-content-script',
            type: REQUEST_TYPE
        }, window.location.origin);
    }

    if (!cutover) window.LiveFlowStopReadLoop = function () {
        window.postMessage({
            source: 'liveflow-content-script',
            type: STOP_READ_LOOP_TYPE
        }, window.location.origin);
    };

    function resetPageState() {
        internalApiContext = null;
        chatAvailable = false;
        readRequestedRevision = -1;
        currentMessages = [];
        currentPageKey = '';
        currentChatMode = 'unknown';
        livePresentationResumeGateActive = false;
        livePresentationAccounting = createLivePresentationAccounting();
        setReadIndicatorState('idle');
        cleanupOverlay();
    }

    function getCurrentMainMedia() {
        if (!isYouTubeWatchPage()) return null;
        const watchRoot = document.querySelector(PLAYER_SELECTORS.watchRoot);
        const player = watchRoot?.querySelector(PLAYER_SELECTORS.player) || null;
        if (!player || player.closest(PLAYER_SELECTORS.miniPlayerAncestor) || player.classList.contains('ytp-player-minimized')) return null;
        const video = player.querySelector(PLAYER_SELECTORS.video);
        return video ? { player, video } : null;
    }

    function cleanupOverlay(...args) { return privateBridge ? privateBridge.cleanupPresentation(renderer) : renderer.cleanupOverlay(...args); }

    function isEffectiveDisplayActive() {
        return overlayCore?.isEffectiveDisplayActive?.({ userEnabled, nativeChatVisible }) === true;
    }

    function applyDisplayAction(action) {
        const wasUserEnabled = userEnabled;
        const transition = overlayCore.reduceDisplayState(
            { userEnabled, nativeChatVisible, nativeChatKnown },
            action,
            displayLinkSettings
        );
        userEnabled = transition.userEnabled;
        nativeChatVisible = transition.nativeChatVisible;
        nativeChatKnown = transition.nativeChatKnown;
        if (nativeChatVisible && nativeChatOpenAttempt) {
            logInfo('Native Chat open confirmation: observerTransition=true, result=confirmed');
            clearNativeChatOpenAttempt();
        }
        if (transition.cleanupRequired) cleanupOverlay();
        if (wasUserEnabled && !userEnabled) {
            currentMessages = [];
        }
        if (action?.type === 'set-user-enabled' && wasUserEnabled !== userEnabled) {
            persistDisplayDefault(userEnabled);
        }
        updateManagementBar();
        if (transition.requestNativeChatOpen) {
            logInfo(`Native Chat open linkage: triggered=true, visible=${nativeChatVisible}`);
            tryOpenNativeChat();
        }
        privateBridge?.synchronize();
        return transition;
    }

    if (!cutover) window.LiveFlowDisplayState = Object.freeze({
        setUserEnabled(value) {
            if (typeof value !== 'boolean') return false;
            applyDisplayAction({ type: 'set-user-enabled', value });
            return true;
        },
        getUserEnabled() {
            return userEnabled;
        },
        getNativeChatVisible() {
            return nativeChatVisible;
        },
        getEffectiveDisplayActive() {
            return isEffectiveDisplayActive();
        }
    });

    function readNativeChatVisibility(watchRoot) {
        if (!watchRoot) return true;
        const frame = watchRoot.querySelector(PLAYER_SELECTORS.nativeChat);
        if (!frame) return false;
        let style;
        let rect;
        try {
            style = window.getComputedStyle(frame);
            rect = frame.getBoundingClientRect();
        } catch (error) {
            return true;
        }
        return overlayCore?.isNativeChatFrameVisible?.({
            belongsToCurrentWatchRoot: watchRoot.contains(frame),
            hiddenAttribute: frame.hidden === true || frame.hasAttribute('hidden'),
            collapsed: frame.hasAttribute('collapsed') || frame.getAttribute('aria-hidden') === 'true',
            display: style.display,
            visibility: style.visibility,
            width: rect.width,
            height: rect.height
        }) !== false;
    }

    function evaluateNativeChatVisibility() {
        visibilityEvaluationQueued = false;
        if (!isYouTubeWatchPage()) {
            applyDisplayAction({ type: 'reset-native-chat' });
            return;
        }
        const watchRoot = document.querySelector(PLAYER_SELECTORS.watchRoot);
        applyDisplayAction({ type: 'native-chat-visibility', value: readNativeChatVisibility(watchRoot) });
        observeNativeChat(watchRoot);
    }

    function scheduleNativeChatVisibilityEvaluation() {
        if (visibilityEvaluationQueued) return;
        visibilityEvaluationQueued = true;
        window.queueMicrotask(evaluateNativeChatVisibility);
    }

    function nodeContainsNativeChat(node) {
        return node?.nodeType === 1 && (
            node.matches?.(PLAYER_SELECTORS.nativeChat) ||
            Boolean(node.querySelector?.(PLAYER_SELECTORS.nativeChat))
        );
    }

    function mutationAffectsNativeChat(mutation) {
        if (mutation.type === 'attributes') {
            return mutation.target?.matches?.(PLAYER_SELECTORS.nativeChat) === true ||
                Boolean(mutation.target?.querySelector?.(PLAYER_SELECTORS.nativeChat));
        }
        return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeContainsNativeChat);
    }

    function nodeAffectsManagementPlacement(node) {
        if (node?.nodeType !== 1) return false;
        const selector = `${PLAYER_SELECTORS.player}, ${PLAYER_SELECTORS.video}, ${PLAYER_SELECTORS.nativeChat}, ${PLAYER_SELECTORS.belowPlayer}`;
        return node.matches?.(selector) === true || Boolean(node.querySelector?.(selector));
    }

    function mutationAffectsManagementPlacement(mutation) {
        return mutation.type === 'childList' &&
            [...mutation.addedNodes, ...mutation.removedNodes].some(nodeAffectsManagementPlacement);
    }

    function observeNativeChat(watchRoot) {
        if (watchRoot === observedWatchRoot && nativeChatObserver) return;
        nativeChatObserver?.disconnect();
        nativeChatObserver = null;
        observedWatchRoot = watchRoot || null;
        if (!watchRoot) return;
        nativeChatObserver = new MutationObserver((mutations) => {
            const nativeChatChanged = mutations.some(mutationAffectsNativeChat);
            const managementPlacementChanged = mutations.some(mutationAffectsManagementPlacement);
            if (nativeChatChanged) scheduleNativeChatVisibilityEvaluation();
            if (managementPlacementChanged) scheduleManagementBarAttachment(watchRoot);
        });
        nativeChatObserver.observe(watchRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['hidden', 'style', 'class', 'collapsed', 'aria-hidden']
        });
        scheduleManagementBarAttachment(watchRoot);
    }

    function disconnectNativeChatObserver() {
        nativeChatObserver?.disconnect();
        nativeChatObserver = null;
        observedWatchRoot = null;
        visibilityEvaluationQueued = false;
        managementAttachmentTask = null;
    }

    function clearNativeChatOpenAttempt() {
        if (!nativeChatOpenAttempt) return;
        window.clearTimeout(nativeChatOpenAttempt.timerId);
        nativeChatOpenAttempt = null;
    }

    function tryOpenNativeChat() {
        if (!nativeChatKnown || nativeChatVisible || nativeChatOpenAttempt) return false;
        const watchRoot = document.querySelector(PLAYER_SELECTORS.watchRoot);
        const frame = watchRoot?.querySelector(PLAYER_SELECTORS.nativeChat) || null;
        if (!watchRoot) {
            logInfo('Native Chat open attempt: started=false, result=no-watch-root');
            return false;
        }
        if (readNativeChatVisibility(watchRoot) !== false) {
            logInfo('Native Chat open attempt: started=false, result=visibility-not-closed');
            return false;
        }
        const chatContainer = watchRoot.querySelector(PLAYER_SELECTORS.nativeChatContainer);
        const ownedChatContainer = watchRoot.querySelector('#chat-container');
        const elements = [];
        PLAYER_SELECTORS.nativeChatOpenButtons.forEach((selector) => {
            watchRoot.querySelectorAll(selector).forEach((element) => {
                if (!elements.includes(element)) elements.push(element);
            });
        });
        const candidates = elements.map((element) => {
            let style;
            let rect;
            try {
                style = window.getComputedStyle(element);
                rect = element.getBoundingClientRect();
            } catch (error) {
                return { element: null };
            }
            const strategy = frame?.contains(element) ? 'frame-control' : 'chat-container-control';
            const showHideButton = element.closest('#show-hide-button');
            const associatedWithNativeChat = Boolean(
                frame?.contains(element) || chatContainer?.contains(element)
            );
            const candidate = {
                element,
                strategy,
                associatedWithNativeChat,
                belongsToCurrentWatchRoot: watchRoot.contains(element),
                nativeChatClosed: true,
                insideChatContainer: Boolean(ownedChatContainer?.contains(element)),
                insideLiveChatFrame: Boolean(frame?.contains(element)),
                descendantOfShowHideButton: Boolean(showHideButton && frame?.contains(showHideButton)),
                actualButton: element.tagName === 'BUTTON',
                hiddenAttribute: element.hidden === true || element.hasAttribute('hidden'),
                disabled: element.disabled === true,
                ariaDisabled: element.getAttribute('aria-disabled'),
                display: style.display,
                visibility: style.visibility,
                width: rect.width,
                height: rect.height
            };
            candidate.rejectionReason = overlayCore.getNativeChatOpenCandidateRejectionReason(candidate);
            logInfo(`Native Chat open candidate: strategy=${strategy}, accepted=${candidate.rejectionReason === 'none'}, reason=${candidate.rejectionReason}`);
            return candidate;
        });
        const button = overlayCore.selectFirstUsableNativeChatButton(candidates);
        if (!button) {
            logInfo(`Native Chat open attempt: started=true, candidates=${elements.length}, clickIssued=false, result=no-candidate`);
            return false;
        }
        const attemptGeneration = pageGeneration;
        if (attemptGeneration !== pageGeneration || document.querySelector(PLAYER_SELECTORS.watchRoot) !== watchRoot ||
            !watchRoot.contains(button) || readNativeChatVisibility(watchRoot) !== false) {
            logInfo('Native Chat open attempt: started=true, clickIssued=false, result=stale-or-open');
            return false;
        }
        button.click();
        const timerId = window.setTimeout(() => {
            if (nativeChatOpenAttempt?.generation !== attemptGeneration) return;
            nativeChatOpenAttempt = null;
            logInfo(`Native Chat open confirmation: visible=${nativeChatVisible}, result=${nativeChatVisible ? 'confirmed' : 'not-confirmed'}`);
        }, 1500);
        nativeChatOpenAttempt = { generation: attemptGeneration, timerId };
        logInfo(`Native Chat open attempt: started=true, candidates=${elements.length}, clickIssued=true, result=pending`);
        return true;
    }

    function ensureManagementStyle() {
        if (document.getElementById(MANAGEMENT_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = MANAGEMENT_STYLE_ID;
        style.textContent = `
            #${MANAGEMENT_BAR_ID} {
                display: flex;
                position: relative;
                z-index: 1;
                align-items: center;
                gap: clamp(4px, 2vw, 10px);
                box-sizing: border-box;
                width: 100%;
                max-width: calc(100vw - 16px);
                margin-inline: auto;
                margin-top: 8px;
                min-height: 48px;
                padding: 1px 8px;
                border-top: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,.1));
                border-bottom: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,.1));
                border-radius: 8px;
                color: var(--yt-spec-text-primary, #f1f1f1);
                background: color-mix(in srgb, currentColor 7%, transparent);
                font: 500 14px/1.2 Roboto, Arial, sans-serif;
            }
            :root:not([dark]) #${MANAGEMENT_BAR_ID} {
                color: #0f0f0f;
                background: var(--yt-spec-general-background-a, #f2f2f2);
            }
            #${MANAGEMENT_BAR_ID} button {
                flex: 0 0 auto;
                min-width: 44px;
                min-height: 44px;
                border: 0;
                border-radius: 4px;
                padding: 0 6px;
                color: inherit;
                background: transparent;
                font: inherit;
                cursor: pointer;
            }
            #${MANAGEMENT_BAR_ID} .liveflow-toggle-button {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                max-width: 100%;
                white-space: nowrap;
            }
            #${MANAGEMENT_BAR_ID} .liveflow-status-icon { width: 1em; text-align: center; }
            #${MANAGEMENT_BAR_ID} .liveflow-status-icon::before {
                display: block;
                width: 0;
                height: 0;
                margin: auto;
                border-top: 7px solid transparent;
                border-bottom: 7px solid transparent;
                border-left: 11px solid currentColor;
                content: '';
            }
            #${MANAGEMENT_BAR_ID}[data-status-shape="stopped"] .liveflow-status-icon::before {
                width: 12px;
                height: 12px;
                border: 0;
                background: currentColor;
            }
            #${MANAGEMENT_BAR_ID} button:focus-visible {
                outline: 2px solid currentColor;
                outline-offset: 1px;
            }
            #${MANAGEMENT_BAR_ID} .liveflow-read-indicator {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                color: var(--yt-spec-call-to-action, #3ea6ff);
                letter-spacing: 3px;
                white-space: nowrap;
                opacity: .35;
            }
            #${MANAGEMENT_BAR_ID}[data-read-state="active"] .liveflow-read-indicator {
                opacity: 1;
                animation: liveflow-read-indicator 1.2s ease-in-out infinite alternate;
            }
            #${MANAGEMENT_BAR_ID}[data-enabled="false"] .liveflow-read-indicator {
                visibility: hidden;
            }
            .liveflow-danmaku { display: inline-flex; align-items: center; gap: 6px; max-width: none; white-space: nowrap; }
            .liveflow-danmaku-avatar { flex: 0 0 22px; width: 22px; height: 22px; border-radius: 50%; object-fit: cover; }
            .liveflow-danmaku-author { flex: 0 0 auto; font-weight: 700; }
            .liveflow-danmaku-message { flex: 0 0 auto; min-width: 0; overflow: visible; text-overflow: clip; white-space: nowrap; }
            .liveflow-danmaku-emoji { width: 1.2em; height: 1.2em; object-fit: contain; vertical-align: middle; }
            .liveflow-danmaku-special { box-sizing: border-box; display: flex; flex-direction: column; align-items: stretch; gap: 2px; width: max-content; min-width: 180px; min-height: 68px; height: auto; padding: 4px 8px; overflow: visible; border-radius: 8px; background: rgba(24,24,24,.8); color: #fff; }
            .liveflow-danmaku-special-header, .liveflow-danmaku-special-body { display: flex; min-width: 0; align-items: center; gap: 6px; }
            .liveflow-danmaku-special-header { flex: 0 0 28px; white-space: nowrap; }
            .liveflow-danmaku-special-body { flex: 1 1 28px; overflow: visible; white-space: nowrap; }
            .liveflow-danmaku-special .liveflow-danmaku-message { flex: 0 0 auto; overflow: visible; text-overflow: clip; white-space: nowrap; overflow-wrap: normal; }
            .liveflow-danmaku-special .liveflow-danmaku-author { flex: 0 0 auto; min-width: 0; overflow: visible; text-overflow: clip; white-space: nowrap; color: #fff; }
            .liveflow-danmaku-amount { flex: 0 0 auto; white-space: nowrap; padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,.25); color: #fff; font-weight: 700; }
            .liveflow-danmaku-sticker { flex: 0 0 32px; width: 32px; height: 32px; object-fit: contain; }
            .liveflow-danmaku[data-author-role="guest"] { color: #fff; -webkit-text-stroke: 1.4px #101010; paint-order: stroke fill; }
            .liveflow-danmaku[data-author-role="member"] { color: #66e08a; -webkit-text-stroke: 1.1px #0b2011; paint-order: stroke fill; }
            .liveflow-danmaku[data-author-role="moderator"] { color: #70b7ff; -webkit-text-stroke: 1.1px #0e2338; paint-order: stroke fill; }
            .liveflow-danmaku[data-author-role="owner"] { color: #ffd75e; -webkit-text-stroke: 1.1px #302709; paint-order: stroke fill; }
            .liveflow-danmaku.liveflow-danmaku-special { -webkit-text-stroke: .8px rgba(0,0,0,.85); paint-order: stroke fill; }
            .liveflow-danmaku img { -webkit-text-stroke: 0; }
            @keyframes liveflow-read-indicator { from { opacity: .35; } to { opacity: 1; } }
            @media (prefers-reduced-motion: reduce) {
                #${MANAGEMENT_BAR_ID}[data-read-state="active"] .liveflow-read-indicator { animation: none; }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function updateManagementBar() {
        if (!managementBar) return;
        const view = overlayCore.getManagementBarViewModel({
            userEnabled,
            readState: readIndicatorState,
            enabledLabel: getUiMessage('liveFlowOn'),
            disabledLabel: getUiMessage('liveFlowOff')
        });
        managementBar.dataset.enabled = String(view.enabled);
        managementBar.dataset.readState = view.readState;
        managementBar.dataset.statusShape = view.statusShape;
        managementToggleLabel.textContent = view.toggleLabel;
        managementToggleButton.setAttribute('aria-pressed', String(view.togglePressed));
    }

    function cleanupManagementBar() {
        managementBar?.remove();
        managementBar = null;
        managementToggleButton = null;
        managementToggleLabel = null;
        managementReadIndicator = null;
    }

    function getManagementBarPlacement(watchRoot, media) {
        const belowPlayer = watchRoot.querySelector(PLAYER_SELECTORS.belowPlayer);
        if (belowPlayer?.parentElement && watchRoot.contains(belowPlayer)) {
            return { parent: belowPlayer.parentElement, before: belowPlayer };
        }
        return null;
    }

    function attachManagementBar() {
        const media = getCurrentMainMedia();
        if (!media) {
            cleanupManagementBar();
            return false;
        }
        const watchRoot = document.querySelector(PLAYER_SELECTORS.watchRoot);
        if (!watchRoot || !watchRoot.contains(media.player)) {
            cleanupManagementBar();
            return false;
        }
        const placement = getManagementBarPlacement(watchRoot, media);
        if (!placement?.parent || !watchRoot.contains(placement.parent)) {
            cleanupManagementBar();
            return false;
        }
        if (managementBar?.isConnected && watchRoot.contains(managementBar) &&
            managementBar.parentElement === placement.parent && managementBar.nextSibling === placement.before) {
            updateManagementBar();
            return true;
        }
        cleanupManagementBar();
        document.getElementById(MANAGEMENT_BAR_ID)?.remove();
        ensureManagementStyle();

        const bar = document.createElement('div');
        bar.id = MANAGEMENT_BAR_ID;
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', getUiMessage('managementBarLabel'));

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'liveflow-toggle-button';
        toggle.addEventListener('click', () => applyDisplayAction({ type: 'set-user-enabled', value: !userEnabled }));
        const statusIcon = document.createElement('span');
        statusIcon.className = 'liveflow-status-icon';
        statusIcon.setAttribute('aria-hidden', 'true');
        const toggleLabel = document.createElement('span');
        toggleLabel.className = 'liveflow-toggle-label';
        toggle.append(statusIcon, toggleLabel);

        const indicator = document.createElement('span');
        indicator.className = 'liveflow-read-indicator';
        indicator.textContent = '›››››';
        indicator.setAttribute('aria-hidden', 'true');

        bar.append(toggle, indicator);
        placement.parent.insertBefore(bar, placement.before);
        managementBar = bar;
        managementToggleButton = toggle;
        managementToggleLabel = toggleLabel;
        managementReadIndicator = indicator;
        updateManagementBar();
        return true;
    }

    function setReadIndicatorState(state) {
        readIndicatorState = state;
        updateManagementBar();
    }

    function applyPersistentSettings(settings, { initializeDisplay = false } = {}) {
        const snapshot = window.LiveFlowSettingsCore?.createSettingsSnapshot?.(settings);
        if (!snapshot) return;
        const fontMetricsChanged = runtimeSettings.fontSizeMode !== snapshot.fontSizeMode ||
            runtimeSettings.fontScalePercent !== snapshot.fontScalePercent;
        runtimeSettings = snapshot;
        if (initializeDisplay) userEnabled = snapshot.displayEnabled === true;
        displayLinkSettings = Object.freeze({
            autoEnableLiveFlowWhenNativeChatClosed: snapshot.autoEnableLiveFlowWhenNativeChatClosed,
            autoOpenNativeChatWhenLiveFlowDisabled: snapshot.autoOpenNativeChatWhenLiveFlowDisabled
        });
        if (overlaySurface) overlaySurface.style.opacity = String(snapshot.opacityPercent / 100);
        if (fontMetricsChanged) phase3Runtime?.markGeometryDirty(geometryCore.DIRTY_SIGNALS.FONT_METRICS);
    }

    function persistDisplayDefault(value) {
        const settingsCore = window.LiveFlowSettingsCore;
        const storageArea = globalThis.chrome?.storage?.local;
        if (!settingsCore || typeof value !== 'boolean') return;
        settingsCore.updateSettings(storageArea, runtimeSettings, { displayEnabled: value })
            .then(applyPersistentSettings);
    }

    function initializePersistentSettings() {
        const settingsCore = window.LiveFlowSettingsCore;
        const storageArea = globalThis.chrome?.storage?.local;
        if (!settingsCore) {
            persistentSettingsReady = true;
            return Promise.resolve();
        }
        globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
            if (areaName !== 'local' || !changes?.[settingsCore.STORAGE_KEY]) return;
            applyPersistentSettings(changes[settingsCore.STORAGE_KEY].newValue);
        });
        return settingsCore.getStoredSettings(storageArea).then((settings) => {
            applyPersistentSettings(settings, { initializeDisplay: true });
            persistentSettingsReady = true;
        });
    }

    function refreshManagementBarPlacement() {
        attachManagementBar();
    }

    function scheduleManagementBarAttachment(watchRoot) {
        if (!watchRoot || managementAttachmentTask) return;
        const task = { watchRoot, pageGeneration };
        managementAttachmentTask = task;
        window.queueMicrotask(() => {
            if (managementAttachmentTask !== task) return;
            managementAttachmentTask = null;
            if (task.pageGeneration !== pageGeneration || !isYouTubeWatchPage() ||
                !task.watchRoot.isConnected || document.querySelector(PLAYER_SELECTORS.watchRoot) !== task.watchRoot) return;
            attachManagementBar();
        });
    }

    function attachOverlay(...args) { return renderer.attachOverlay(...args); }

    function applyOverlaySurfaceRect(...args) { return renderer.applyOverlaySurfaceRect(...args); }

    function snapshotActiveGeometry(...args) { return renderer.snapshotActiveGeometry(...args); }

    function readSubtitleGeometry(...args) { return renderer.readSubtitleGeometry(...args); }

    function isCaptionTrackEnabled(...args) { return renderer.isCaptionTrackEnabled(...args); }

    function disconnectSubtitleGeometryObservers() {
        subtitleMutationObserver?.disconnect();
        subtitleResizeObserver?.disconnect();
        subtitleMutationObserver = null;
        subtitleResizeObserver = null;
        subtitleObservedPlayer = null;
    }

    function ensureSubtitleGeometryObservers(player) {
        if (!player || subtitleObservedPlayer === player) return;
        disconnectSubtitleGeometryObservers();
        subtitleObservedPlayer = player;
        if (typeof MutationObserver === 'function') {
            subtitleMutationObserver = new MutationObserver(() => subtitleGeometryAdapter?.markDirty(geometryCore.DIRTY_SIGNALS.MUTATION));
            subtitleMutationObserver.observe(player, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-pressed'] });
        }
        if (typeof ResizeObserver === 'function') {
            subtitleResizeObserver = new ResizeObserver(() => subtitleGeometryAdapter?.markDirty(geometryCore.DIRTY_SIGNALS.RESIZE));
            subtitleResizeObserver.observe(player);
            const media = getCurrentMainMedia();
            if (media?.video) subtitleResizeObserver.observe(media.video);
        }
    }

    function isAdPlaybackActive(player) {
        return player?.classList?.contains('ad-showing') === true || player?.classList?.contains('ad-interrupting') === true;
    }

    function ensurePlaybackContextObserver(player) {
        if (!player || playbackContextObservedPlayer === player) return;
        playbackContextObserver?.disconnect();
        playbackContextObservedPlayer = player;
        playbackContextWasAd = isAdPlaybackActive(player);
        if (playbackContextWasAd && !cutover) {
            window.postMessage({ source: 'liveflow-content-script', type: REPLAY_AD_ENTER_TYPE }, window.location.origin);
        }
        if (typeof MutationObserver !== 'function') return;
        playbackContextObserver = new MutationObserver(() => {
            const adActive = isAdPlaybackActive(player);
            if (adActive === playbackContextWasAd) return;
            playbackContextWasAd = adActive;
            if (cutover) { privateBridge.synchronize(); cleanupOverlay(); return; }
            cleanupOverlay();
            window.postMessage({
                source: 'liveflow-content-script',
                type: adActive ? REPLAY_AD_ENTER_TYPE : REPLAY_AD_EXIT_TYPE
            }, window.location.origin);
        });
        playbackContextObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    }

    function createDanmakuNode(...args) { return renderer.createDanmakuNode(...args); }

    function applySpecialFit(...args) { return renderer.applySpecialFit(...args); }

    function getCandidateProof(...args) { return renderer.getCandidateProof(...args); }

    function ensurePhase3Runtime() {
        if (phase3Runtime) return phase3Runtime;
        if (!schedulerRuntimeCore || !geometryCore) return null;
        subtitleGeometryAuthority = geometryCore.createGeometryAuthority({ epsilon: PHASE3_UNTUNED_RUNTIME.geometryEpsilon });
        subtitleGeometryAdapter = geometryCore.createSubtitleGeometryAdapter({
            authority: subtitleGeometryAuthority,
            readGeometry: readSubtitleGeometry
        });
        subtitleGeometryAdapter.refresh();
        const runtimeOptions = {
            clock: () => performance.now(),
            scheduleOneShot: (callback, delay) => window.setTimeout(callback, Math.max(0, Math.ceil(delay))),
            cancelOneShot: (timer) => window.clearTimeout(timer),
            generation: () => rendererGeneration,
            sourceActivityBinding: currentSourceActivityBinding,
            sourceActivityTime: () => {
                const media = getCurrentMainMedia();
                return Number.isFinite(media?.video?.currentTime) ? media.video.currentTime * 1000 : null;
            },
            geometryAdapter: subtitleGeometryAdapter,
            candidateProof: getCandidateProof,
            launch: (entry, proof) => privateBridge
                ? privateBridge.launch(entry, proof, renderDanmaku)
                : renderDanmaku(entry.message, entry.generation, entry.video, proof, entry.settingsSnapshot).status === 'rendered',
            observe: observeReplayScheduler,
            config: {
                maxPendingAge: overlayCore.DANMAKU_TARGET_DURATION_MS,
                maxPendingCount: overlayCore.DANMAKU_MAX_RENDER_QUEUE,
                pendingPressureCapacity: overlayCore.DANMAKU_MAX_RENDER_QUEUE,
                scanDepth: PHASE3_UNTUNED_RUNTIME.scanDepth,
                cohortMaximumItems: PHASE3_UNTUNED_RUNTIME.cohortMaximumItems,
                cohortMaximumSpan: overlayCore.DANMAKU_MAX_BATCH_SPREAD_MS,
                pacing: {
                    userBaseInterval: overlayCore.DANMAKU_DEFAULT_LAUNCH_CADENCE_MS,
                    minimumInterval: overlayCore.DANMAKU_MIN_LAUNCH_CADENCE_MS,
                    maximumRescueFraction: PHASE3_UNTUNED_RUNTIME.maximumRescueFraction
                },
                density: {
                    attackThresholds: PHASE3_UNTUNED_RUNTIME.attackThresholds,
                    releaseThresholds: PHASE3_UNTUNED_RUNTIME.releaseThresholds,
                    minimumAttackResidence: PHASE3_UNTUNED_RUNTIME.minimumAttackResidence,
                    releaseDwell: PHASE3_UNTUNED_RUNTIME.releaseDwell
                },
                sourceActivity: {
                    bandThresholdsPerSecond: PHASE3_UNTUNED_RUNTIME.sourceActivityBandThresholdsPerSecond,
                    promotionResidence: PHASE3_UNTUNED_RUNTIME.sourceActivityPromotionResidence,
                    releaseDwell: PHASE3_UNTUNED_RUNTIME.sourceActivityReleaseDwell
                },
                collisionAllowances: phase5Tuning.collisionAllowances,
                normalOverlapPolicy: phase5Tuning.normalOverlapPolicy
            }
        };
        phase3Runtime = privateBridge ? privateBridge.createRuntime(runtimeOptions)
            : schedulerRuntimeCore.createSchedulerRuntime(runtimeOptions);
        phase3RuntimeVideo = getCurrentMainMedia()?.video || null;
        return phase3Runtime;
    }

    function currentSourceActivityBinding() { return contentHandoff.currentSourceActivityBinding(); }



    function renderDanmaku(...args) { return renderer.renderDanmaku(...args); }

    function scheduleDanmakuBatch(...args) { return contentHandoff.scheduleDanmakuBatch(...args); }





    function handleInitialContinuation(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== RESPONSE_TYPE) return;
        if (!Number.isInteger(event.data.pageRevision) || event.data.pageRevision < minimumAcceptedPageRevision) {
            logInfo('Bridge page-state rejected: reason=stale-revision');
            return;
        }
        if (!Number.isInteger(event.data.pageLifecycleGeneration) || event.data.pageLifecycleGeneration < currentPageLifecycleGeneration) {
            logInfo('Bridge page-state rejected: reason=stale-generation');
            return;
        }

        const previousRevision = currentPageRevision;
        const nextPageKey = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        const pageChanged = Boolean(currentPageKey && currentPageKey !== nextPageKey);
        internalApiContext = event.data.context && typeof event.data.context === 'object'
            ? event.data.context
            : null;
        currentPageRevision = Number.isInteger(event.data.pageRevision) ? event.data.pageRevision : currentPageRevision;
        currentPageLifecycleGeneration = event.data.pageLifecycleGeneration;
        if (replayDiagnosticEpoch === null && replayDiagnosticAwaiting === null) {
            window.postMessage({ source: 'liveflow-content-script', type: 'LIVEFLOW_REPLAY_DIAGNOSTIC_SCOPE_HELLO' }, window.location.origin);
        }
        currentChatMode = ['live', 'replay'].includes(event.data.mode) ? event.data.mode : 'unknown';
        acceptingReadResults = true;
        logInfo(`New page established: revision=${currentPageRevision}, generation=${currentPageLifecycleGeneration}`);
        if (pageChanged) {
            readRequestedRevision = -1;
            currentMessages = [];
        }
        currentPageKey = nextPageKey;
        const revisionChanged = previousRevision !== currentPageRevision;
        if (revisionChanged) {
            readRequestedRevision = -1;
            currentMessages = [];
        }
        if (pageChanged || revisionChanged) cleanupOverlay();
        chatAvailable = event.data.chatAvailable === true;

        if (chatAvailable) {
            logInfo('Initial live chat continuation found');
        } else {
            logInfo('Live chat is not available');
        }

        if (internalApiContext) {
            logInfo('YouTube internal API context found');
        } else {
            logInfo('YouTube internal API context is not available');
        }

        const media = getCurrentMainMedia();
        attachManagementBar();
        if (media && event.data.mode === 'replay') ensurePlaybackContextObserver(media.player);
        if (media && isEffectiveDisplayActive()) attachOverlay(media.player);
        requestReadOnce();
    }

    function requestReadOnce() {
        if (!chatAvailable || !internalApiContext || readRequestedRevision === currentPageRevision) return;
        readRequestedRevision = currentPageRevision;
        window.postMessage({
            source: 'liveflow-content-script',
            type: READ_REQUEST_TYPE,
            pageLifecycleGeneration: currentPageLifecycleGeneration
        }, window.location.origin);
        setReadIndicatorState('active');
    }

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
        contentHandoff.processLegacySuccess(messages, event.data.pendingOwner, event.data.pendingOwnerScope);
        logInfo(`READ #${readNumber} completed: HTTP ${event.data.status}`);
        logInfo(`READ #${readNumber} parsed messages: ${event.data.parsedMessageCount ?? messages.length}`);
        if (event.data.nextContinuationAvailable) logInfo(`READ #${readNumber} next continuation available`);
    }

    function isYouTubeWatchPage() {
        return /(?:^|\.)youtube\.com\/(?:watch|live)(?:[/?]|$)/i.test(window.location.href);
    }

    function detectPage() {
        if (!persistentSettingsReady) return;
        if (!isYouTubeWatchPage()) return;
        const nextPageKey = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        if (currentPageKey !== nextPageKey) resetPageState();
        logInfo('YouTube watch page detected');
        attachManagementBar();
        evaluateNativeChatVisibility();
        requestInitialContinuation();
    }

    function handleNavigation() {
        if (!persistentSettingsReady) return;
        attachManagementBar();
        requestInitialContinuation();
    }

    function handleNavigationStart() {
        if (cutover) {
            if (privateBridge.navigationChanged()) {
                currentMessages = []; cleanupManagementBar(); cleanupOverlay();
            }
            return;
        }
        logInfo(`Navigation invalidate: rendererGeneration=${rendererGeneration}, queue=${phase3Runtime?.status().pendingCount || 0}, active=${activeDanmaku.size}, timer=${phase3Runtime?.status().armed === true}`);
        pageGeneration += 1;
        acceptingReadResults = false;
        minimumAcceptedPageRevision = currentPageRevision + 1;
        clearNativeChatOpenAttempt();
        disconnectNativeChatObserver();
        applyDisplayAction({ type: 'reset-native-chat' });
        cleanupManagementBar();
        setReadIndicatorState('idle');
        cleanupOverlay();
    }

    function handlePageHide() {
        if (cutover) privateBridge.retire();
        acceptingReadResults = false;
        clearNativeChatOpenAttempt();
        disconnectNativeChatObserver();
        cleanupManagementBar();
        cleanupOverlay();
    }

    function handleVisibilityChange() {
        if (cutover) {
            privateBridge.synchronize();
            if (document.hidden) { setReadIndicatorState('idle'); cleanupOverlay(); }
            return;
        }
        if (document.hidden) {
            acceptingReadResults = false;
            setReadIndicatorState('idle');
            cleanupOverlay();
            return;
        }
        if (!isYouTubeWatchPage()) return;
        readRequestedRevision = -1;
        acceptingReadResults = true;
        window.postMessage({
            source: 'liveflow-content-script',
            type: RESUME_READ_LOOP_TYPE,
            pageLifecycleGeneration: currentPageLifecycleGeneration,
            userEnabled: true
        }, window.location.origin);
    }

    function handlePageLifecycleInvalidated(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== NAVIGATION_INVALIDATED_TYPE) return;
        if (!Number.isInteger(event.data.pageRevision) || !Number.isInteger(event.data.pageLifecycleGeneration)) return;
        acceptingReadResults = false;
        minimumAcceptedPageRevision = Math.max(minimumAcceptedPageRevision, event.data.pageRevision);
        currentPageLifecycleGeneration = Math.max(currentPageLifecycleGeneration, event.data.pageLifecycleGeneration);
        internalApiContext = null;
        chatAvailable = false;
        readRequestedRevision = -1;
        currentMessages = [];
        currentChatMode = 'unknown';
        cleanupOverlay();
        if (Number.isSafeInteger(event.data.diagnosticScopeEpoch) &&
            event.data.pageLifecycleGeneration === currentPageLifecycleGeneration &&
            event.data.diagnosticScopeEpoch > (replayDiagnosticEpoch ?? replayDiagnosticAwaiting ?? -1)) {
            closeReplayDiagnosticScope();
            resetReplayDiagnosticCounters();
            replayDiagnosticEpoch = event.data.diagnosticScopeEpoch;
            replayDiagnosticLifecycle = event.data.pageLifecycleGeneration;
            replayDiagnosticAwaiting = null;
            replayDiagnosticIncomplete = false;
            publishReplayScopeSnapshot();
        } else {
            publishReplayScopeSnapshot();
        }
        logInfo(`Page lifecycle invalidated: revision=${event.data.pageRevision}, generation=${event.data.pageLifecycleGeneration}`);
    }

    function handleReadLifecycleDiagnostic(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.source !== 'liveflow-page-state' || event.data.type !== LIFECYCLE_DIAGNOSTIC_TYPE) return;
        const allowedEvents = new Set(['NAV_INVALIDATE', 'PAGE_STATE_REJECTED', 'NEW_PAGE_STATE', 'READ_START_REJECTED', 'READ_START', 'READ_REQUEST_BEGIN', 'READ_RESPONSE_RECEIVED', 'READ_STOP']);
        if (!allowedEvents.has(event.data.eventName)) return;
        const lifecycleSignal = ['request', 'yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'watch-root-mutation', 'visibility-resume'].includes(event.data.lifecycleSignal || event.data.eventSource)
            ? event.data.lifecycleSignal || event.data.eventSource
            : 'unknown';
        logInfo(`READ lifecycle: event=${event.data.eventName}, signal=${lifecycleSignal}, pageRevision=${event.data.pageRevision}, pageGeneration=${event.data.pageLifecycleGeneration}, readGeneration=${event.data.readGeneration}, active=${event.data.readActive}, inFlight=${event.data.requestInFlight}, reason=${event.data.rejectionReason || 'NONE'}, pageDataSeen=${event.data.navigationPageDataUpdated === true}, canReevaluate=${event.data.canReevaluate === true}, navigationTargetMatched=${event.data.navigationTargetMatched === true}, targetKnown=${event.data.targetKnown === true}, bootstrapKnown=${event.data.bootstrapKnown === true}, ownershipSource=${event.data.ownershipSource === 'WATCH_ROOT_SNAPSHOT' ? event.data.ownershipSource : 'NONE'}, ownershipContinuationAvailable=${event.data.ownershipContinuationAvailable === true}, ownershipSameSnapshot=${event.data.ownershipSameSnapshot === true}, watchRootObserved=${event.data.watchRootObserved === true}, watchRootRebound=${event.data.watchRootRebound === true}, pageTargetChanged=${event.data.pageTargetChanged === true}, bootstrapTargetMatched=${event.data.bootstrapTargetMatched === true}, supportingCandidates=${Number.isInteger(event.data.supportingCandidateCount) ? event.data.supportingCandidateCount : 0}, supportingMatches=${Number.isInteger(event.data.supportingMatchCount) ? event.data.supportingMatchCount : 0}, abortIssued=${event.data.abortIssued === true}, aborted=${event.data.aborted === true}, requestAfterInvalidation=${event.data.requestAfterInvalidation === true}, responseAfterInvalidation=${event.data.responseAfterInvalidation === true}, watchRootChanged=${event.data.watchRootChanged === true}, videoElementChanged=${event.data.videoElementChanged === true}`);
    }

    function handleGeometryChange() {
        if (cutover && !privateBridge.geometryChanged()) return;
        subtitleGeometryAdapter?.markDirty(geometryCore.DIRTY_SIGNALS.VIDEO_GEOMETRY);
        if (geometryChangeQueued) return;
        geometryChangeQueued = true;
        window.queueMicrotask(() => {
            geometryChangeQueued = false;
            cleanupOverlay();
            refreshManagementBarPlacement();
        });
    }

    function handleReplayMediaContextChange(event) {
        if (cutover && !privateBridge.mediaChanged()) return;
        const media = getCurrentMainMedia();
        if (!media || event.target !== media.video) return;
        if (currentChatMode === 'live' && ['pause', 'seeking'].includes(event.type)) {
            const gate = overlayCore?.reduceLivePresentationResumeGate?.(
                livePresentationResumeGateActive,
                event.type === 'pause' ? 'PAUSE' : 'SEEKING'
            );
            livePresentationResumeGateActive = gate?.active !== false;
            cleanupOverlay();
            return;
        }
        if (currentChatMode !== 'replay') return;
        currentMessages = [];
        cleanupOverlay();
        if (event.type === 'seeking') closeReplayDiagnosticScope();
    }

    const renderer = createRenderer({
        state: {
            get overlayRoot() { return overlayRoot; }, set overlayRoot(value) { overlayRoot = value; },
            get overlaySurface() { return overlaySurface; }, set overlaySurface(value) { overlaySurface = value; },
            get laneStates() { return laneStates; }, set laneStates(value) { laneStates = value; },
            get activeDanmaku() { return activeDanmaku; },
            get rendererGeneration() { return rendererGeneration; }, set rendererGeneration(value) { rendererGeneration = value; },
            get phase3Runtime() { return phase3Runtime; }, set phase3Runtime(value) { phase3Runtime = value; },
            get phase3RuntimeVideo() { return phase3RuntimeVideo; }, set phase3RuntimeVideo(value) { phase3RuntimeVideo = value; },
            get runtimeSettings() { return runtimeSettings; }, set runtimeSettings(value) { runtimeSettings = value; },
            get currentChatMode() { return currentChatMode; }, set currentChatMode(value) { currentChatMode = value; },
            get subtitleGeometryAdapter() { return subtitleGeometryAdapter; }, set subtitleGeometryAdapter(value) { subtitleGeometryAdapter = value; },
            get replayDiagnosticDisplayed() { return replayDiagnosticDisplayed; }, set replayDiagnosticDisplayed(value) { replayDiagnosticDisplayed = value; }
        },
        document, window, performance, overlayCore, schedulerFoundations, geometryCore, phase5Tuning,
        PHASE3_UNTUNED_RUNTIME, isEffectiveDisplayActive, getCurrentMainMedia,
        ensureSubtitleGeometryObservers, disconnectSubtitleGeometryObservers,
        logInfo, publishReplaySchedulerDiagnostic,
        observer: privateBridge?.rendererObserver,
        runtimeObserver: privateBridge?.observeDetached,
        recognizeAttempt: privateBridge?.recognizeAttempt,
        isProductCurrent: privateBridge?.privateEntry.isProductCurrent,
        resolveProductLease: privateBridge?.privateEntry.resolveProductLease,
        withPresentationCleanup: privateBridge?.privateEntry.withPresentationCleanup
    });

    const contentHandoff = createContentHandoff({
        state: {
            get currentMessages() { return currentMessages; }, set currentMessages(value) { currentMessages = value; },
            get currentChatMode() { return currentChatMode; }, set currentChatMode(value) { currentChatMode = value; },
            get currentPageKey() { return currentPageKey; }, set currentPageKey(value) { currentPageKey = value; },
            get currentPageRevision() { return currentPageRevision; }, set currentPageRevision(value) { currentPageRevision = value; },
            get currentPageLifecycleGeneration() { return currentPageLifecycleGeneration; }, set currentPageLifecycleGeneration(value) { currentPageLifecycleGeneration = value; },
            get phase3Runtime() { return phase3Runtime; }, set phase3Runtime(value) { phase3Runtime = value; },
            get phase3RuntimeVideo() { return phase3RuntimeVideo; }, set phase3RuntimeVideo(value) { phase3RuntimeVideo = value; },
            get livePresentationResumeGateActive() { return livePresentationResumeGateActive; }, set livePresentationResumeGateActive(value) { livePresentationResumeGateActive = value; },
            get rendererGeneration() { return rendererGeneration; }, set rendererGeneration(value) { rendererGeneration = value; },
            get runtimeSettings() { return runtimeSettings; }, set runtimeSettings(value) { runtimeSettings = value; },
            get replayDiagnosticBatchInProgress() { return replayDiagnosticBatchInProgress; }, set replayDiagnosticBatchInProgress(value) { replayDiagnosticBatchInProgress = value; },
            get replayDiagnosticBatch() { return replayDiagnosticBatch; }, set replayDiagnosticBatch(value) { replayDiagnosticBatch = value; }
        },
        overlayCore, phase5Tuning, performance, PHASE3_UNTUNED_RUNTIME,
        isEffectiveDisplayActive, getCurrentMainMedia, cleanupOverlay, ensurePhase3Runtime,
        ensureSubtitleGeometryObservers, ensurePlaybackContextObserver,
        observeLivePresentationBatch, publishReplaySchedulerDiagnostic, rememberReplayPendingOwner,
        getPending: () => window.LiveFlowPendingSelection,
        pending: cutover ? window.LiveFlowPendingSelection : undefined,
        privateEntry: privateBridge?.privateEntry
    });

    if (privateBridge) privateBridge.bind({ renderer, content: contentHandoff, document, window, performance,
        scheduler: schedulerRuntimeCore, enabled: () => userEnabled,
        setBinding(mode) { currentChatMode = mode; currentPageRevision = 0; currentPageLifecycleGeneration = 0;
            currentPageKey = `${window.location.origin}${window.location.pathname}${window.location.search}`; },
        onBatch(messages, scope, handle, pendingOwner, productLease) {
            if (handle && contentHandoff.registerBatch(handle)) contentHandoff.processRegisteredBatch(handle, productLease);
            else contentHandoff.processLegacySuccess(messages, pendingOwner, scope, productLease);
        }, setReadIndicatorState });

    if (!cutover) {
    window.addEventListener('message', handleReplayDiagnosticScopeOpen);
    window.postMessage({ source: 'liveflow-content-script', type: 'LIVEFLOW_REPLAY_DIAGNOSTIC_SCOPE_HELLO' }, window.location.origin);
    window.addEventListener('message', handleInitialContinuation);
    window.addEventListener('message', handleReadResult);
    window.addEventListener('message', handlePendingOnlyClear);
    window.addEventListener('message', handlePageLifecycleInvalidated);
    window.addEventListener('message', handleReadLifecycleDiagnostic);
    }
    window.addEventListener('yt-navigate-start', handleNavigationStart);
    window.addEventListener('yt-navigate-finish', detectPage);
    window.addEventListener('yt-page-data-updated', handleNavigation);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('resize', handleGeometryChange);
    window.addEventListener('orientationchange', handleGeometryChange);
    window.addEventListener('pause', handleReplayMediaContextChange, true);
    window.addEventListener('seeking', handleReplayMediaContextChange, true);
    window.addEventListener('ratechange', handleReplayMediaContextChange, true);
    if (privateBridge) for (const signal of ['play','playing','seeked','loadedmetadata','loadeddata','canplay','timeupdate','load']) {
        // Notifications only: actual native facts, never event payloads, authorize work.
        window.addEventListener(signal, () => privateBridge.synchronize(), true);
    }
    document.addEventListener('fullscreenchange', handleGeometryChange);
    window.visualViewport?.addEventListener('resize', handleGeometryChange);
    window.visualViewport?.addEventListener('scroll', handleGeometryChange);

    initializePersistentSettings().then(() => {
        if (isYouTubeWatchPage()) detectPage();
    });
    }
    startContent();
})();
