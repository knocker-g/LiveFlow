'use strict';

(function () {
const { validateEnvelope } = require('./bootstrap-contract.js');
const { createNativeFactsAdapter, recognizeNativeFactsAdapter, inspectNativeAdmission } = require('./native-facts.js');

// ISOLATED module-private lifetime guard. No owner is constructed on import.
// Retain the document's admission tombstone even after terminal cleanup.
const admittedDocuments = new WeakSet();

// Retain the existing private factory entry point; mode is an observed binding,
// not a caller-selected request type or a user setting.
function createLiveAcquisitionOwner({ document, route, readFacts, clock, timers, transport,
    core, control, entropy, AbortController: Controller, onBatch, nativeFacts, readPendingCount, pendingScopePort, provenance,
    replayAssociationPolicy = 'STRICT_V', liveAssociationPolicy = 'STRICT_V', diagnostic = null }) {
    if (!document || typeof document !== 'object' || admittedDocuments.has(document)) return null;
    // Claim before dependency callbacks can reenter construction. A failed
    // construction cannot create a replacement opportunity in this Document.
    admittedDocuments.add(document);
    let initial, operationId;
    try {
        if (!['STRICT_V', 'ACCEPTED_Z'].includes(replayAssociationPolicy) ||
            (replayAssociationPolicy === 'ACCEPTED_Z' && !nativeFacts)) return null;
        if (!['STRICT_V', 'ACCEPTED_LIVE_ZERO_V'].includes(liveAssociationPolicy) ||
            (liveAssociationPolicy === 'ACCEPTED_LIVE_ZERO_V' && !nativeFacts)) return null;
        if (nativeFacts) {
            const adapter = nativeFacts.adapter
                ? recognizeNativeFactsAdapter(nativeFacts.adapter, document, route) ? nativeFacts.adapter : null
                : createNativeFactsAdapter({ ...nativeFacts, document, route });
            if (!adapter) return null;
            // These counters belong to this single Document owner, not native
            // observations or page notifications. No media event advances them.
            const epoch = Object.freeze({ lifecycle: 0, revision: 0, generation: 0 });
            readFacts = () => {
                const sample = adapter.readFacts();
                const admission = inspectNativeAdmission(adapter, sample, replayAssociationPolicy, liveAssociationPolicy);
                if (!admission) throw Error('NATIVE_FACTS_UNAVAILABLE');
                const values = {};
                for (const key of ['document', 'targetId', 'mode', 'watch', 'player', 'video', 'frame', 'childDocument',
                    'visible', 'ready', 'adActive', 'seeking', 'paused', 'ended', 'position', 'rate']) {
                    const fact = sample.facts[key];
                    if (!fact || fact.state !== 'KNOWN' || !Object.hasOwn(fact, 'value')) throw Error('NATIVE_FACT_UNKNOWN');
                    values[key] = fact.value;
                }
                // A future private Presentation port, never a public diagnostic
                // counter. UNKNOWN remains undefined, not a fabricated empty queue.
                const count = typeof readPendingCount === 'function' ? readPendingCount() : undefined;
                const clockCurrent = Number.isFinite(clock.now());
                // The clock/queue callbacks above may change the actual native
                // binding. Reobserve without acquiring a second clock value.
                const current = adapter.readFacts();
                const currentAdmission = inspectNativeAdmission(adapter, current, replayAssociationPolicy, liveAssociationPolicy);
                if (!currentAdmission) throw Error('NATIVE_FACTS_UNAVAILABLE');
                for (const key of Object.keys(values)) {
                    const fact = current.facts[key];
                    if (!fact || fact.state !== 'KNOWN' || !Object.hasOwn(fact, 'value')) throw Error('NATIVE_FACT_UNKNOWN');
                    values[key] = fact.value;
                }
                return { ...values, ...epoch, currentTime: values.position, playbackRate: values.rate,
                    owned: true, capability: true, clockCurrent,
                    parentTargetEvidence: currentAdmission.parentTargetEvidence,
                    childAssociationEvidence: currentAdmission.childAssociationEvidence,
                    schedulerPendingCount: Number.isInteger(count) && count >= 0 ? count : undefined };
            };
        }
        initial = readFacts();
        const bytes = new Uint8Array(16);
        entropy(bytes);
        operationId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        const checked = validateEnvelope({ version: 1, operationId, route,
            result: { status: 'ERROR', stage: 'OWNER', code: 'INVALID_RESULT' } });
        if (!checked.valid || initial.document !== document || !initial.video || !['live', 'replay'].includes(initial.mode) ||
            typeof initial.targetId !== 'string' || !initial.targetId ||
            !['lifecycle', 'revision', 'generation'].every(k => Number.isSafeInteger(initial[k]) && initial[k] >= 0) ||
            typeof transport !== 'function' || typeof Controller !== 'function' || typeof onBatch !== 'function' ||
            !['buildLiveChatReadRequest', 'validateLiveChatReadResponse', 'extractChatMessagesFromResponse',
                'isSuccessfulHttpStatus', 'canScheduleNextRead'].every(k => typeof core[k] === 'function') ||
            typeof clock.now !== 'function' || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') return null;
        if (initial.mode === 'replay' && (!control || !['createReplayAuthority', 'createConsumedAuthorityRegistry',
            'createOwnerPolicyContext', 'invalidateOwnerPolicyContext', 'isOwnerPolicyContextCurrent',
            'authorizeAuthorityRequest', 'claimAuthorityRequestGrant', 'reduceReplayControlState', 'createReplayState',
            'evaluateInitialReplayAlignment', 'createCapabilitySnapshot', 'canUseCapabilityPath',
            'inspectAuthorityRequestEligibility', 'invalidateAuthority', 'evaluateForegroundRecoveryEligibility'].every(k => typeof control[k] === 'function'))) return null;
        if (initial.mode === 'replay' && !['validatePlayerSeekOffset', 'selectBoundedReplayDueMessages',
            'transitionReplayRunwayDepletionEpisode', 'getReplayTemporalWakeDelayMs', 'canRunReplayTemporalWakeup',
            'evaluateReplayNormalResume', 'evaluateReplayBufferEarlyResume', 'classifyNearestReplayFuture',
            'transitionReplayEarlyResumeSuppression', 'evaluateReplayReadAheadCadence', 'classifyReplayReadAheadHorizon',
            'validateReplayChatReadResponse', 'extractReplayChatMessagesFromResponse', 'extractPlayerSeekContinuation',
            'classifyReplayInitialStartupCoverage', 'summarizePlayerSeekDiagnosticResponse',
            'classifySequentialContinuationProgress', 'getReplayCoverageAwareReadDelayMs',
            'hasReplayCurrentWindowCoverageHole', 'evaluateReplayCoverageHoleRepair', 'transitionReplayCoverageHoleEpisode',
            'classifyReplayCoverageHoleRepairResult',
            'canRestartReplayAtCurrentPosition'].every(k => typeof core[k] === 'function')) return null;
        route = Object.freeze(checked.value.route);
    } catch { return null; }
    const binding = Object.freeze({ document, video: initial.video, targetId: initial.targetId, mode: initial.mode,
        lifecycle: initial.lifecycle, revision: initial.revision, generation: initial.generation });
    let phase = 'CREATED', reason = 'NONE', bootstrap = 'CREATED', permit = 'UNUSED';
    let bootstrapChannel = null, t0 = null, lastNow = null, deadlineTimer = null, readTimer = null;
    let cursor = null, context = null, flight = null, nextTicket = 0, attempts = 0, accepted = 0;
    // Document-lifetime private exact membership, not a persisted/public token log.
    // No eviction: forgetting a spent value could authorize its later reuse.
    const spent = new Set();
    const originOwner = Object.freeze({});
    let observingSource = false;
    const origins = provenance ? require('./occurrence-provenance.js').createOccurrenceProvenance({ owner: originOwner, document, binding,
        observe: (event, proof) => {
            observingSource = true;
            try { return provenance.onDisposition?.(event, proof); } finally { observingSource = false; }
        }, observeTransition: typeof provenance.onTemporalTransition === 'function' ? (event, proof) => {
            observingSource = true;
            try { return provenance.onTemporalTransition(event, proof); } finally { observingSource = false; }
        } : undefined }) : null;
    let replay = null;
    let pendingView = null, pendingScope = null, pendingProductLease = null, pendingFault = false;
    let checkingPresentation = false;
    let pendingDelivery = false, terminalizing = false, terminalFinalized = false;
    // Optional private evidence only. One in-flight ticket, bounded parser slots;
    // no audit history, payloads, or new acquisition opportunities are retained.
    const parserAudits = new WeakMap();
    const auditProofs = new WeakMap();
    let auditProofCount = 0;
    const recognizeAuditProof = proof => {
        const record = auditProofs.get(proof);
        return record ? Object.freeze({ ...record }) : null;
    };
    function beginParserAudit(ticket, authorityBinding) {
        if (!origins) return;
        try {
            const receive = provenance.onParserAudit;
            if (typeof receive === 'function') parserAudits.set(ticket,
                { authorityBinding, receive, signal: null, trace: null, parser: null, observed: false, occurrences: null });
        } catch (_) { origins.fault('PARSER_AUDIT_INCOMPLETE'); }
    }
    function requestSignal(ticket, signal) {
        const audit = parserAudits.get(ticket);
        if (audit) audit.signal = signal;
        return signal;
    }
    function parseResponse(ticket, payload, mode) {
        const ordinary = mode === 'live' ? core.extractChatMessagesFromResponse : core.extractReplayChatMessagesFromResponse;
        const audit = parserAudits.get(ticket);
        if (!audit) return ordinary.call(core, payload);
        const create = mode === 'live' ? core.createLiveParserTrace : core.createReplayParserTrace;
        const parse = mode === 'live' ? core.extractLiveChatMessagesWithTrace : core.extractReplayChatMessagesWithTrace;
        try {
            if (typeof create === 'function' && typeof parse === 'function') audit.trace = create.call(core, { slots: true });
        } catch (_) { origins.fault('PARSER_AUDIT_INCOMPLETE'); }
        if (!audit.trace) { origins.fault('PARSER_AUDIT_INCOMPLETE'); return ordinary.call(core, payload); }
        audit.observed = true;
        // The actual parser is executed once. Its original exception escapes to
        // the unchanged Owner failure handler, never to a fallback parser.
        try { return parse.call(core, payload, audit.trace); }
        finally {
            try { audit.parser = audit.trace.snapshot(); }
            catch (_) { origins.fault('PARSER_AUDIT_INCOMPLETE'); }
        }
    }
    function finishParserAudit(ticket) {
        const audit = parserAudits.get(ticket);
        if (!audit) return;
        parserAudits.delete(ticket);
        if (!audit.parser && audit.trace) {
            try { audit.parser = audit.trace.snapshot(); }
            catch (_) { origins.fault('PARSER_AUDIT_INCOMPLETE'); }
        }
        const origin = origins.acceptedOrigin(ticket);
        const complete = audit.parser?.state === 'COMPLETE' && (!ticket.accepted ||
            (origin !== null && audit.occurrences?.length === audit.parser.normalizedOutputs));
        if (!complete) origins.fault('PARSER_AUDIT_INCOMPLETE');
        const outcome = ticket.accepted ? 'ACCEPTED'
            : ['READ_INVALIDATED', 'CURRENTNESS_INVALID'].includes(reason) ? 'STALE'
            : ['CANCELLED', 'CURSOR_SPENT_HIDDEN', 'REPLAY_TIMEOUT'].includes(reason) ? 'ABORTED'
            : 'NOT_ACCEPTED';
        const event = Object.freeze({ ticket, signal: audit.signal,
            owner: originOwner, document, binding, authorityBinding: audit.authorityBinding,
            acceptedOrigin: origin, occurrences: audit.occurrences, outcome, reason: ticket.accepted ? 'NONE' : reason,
            parser: audit.parser, parserObserved: audit.observed,
            coverage: complete ? 'COMPLETE' : 'INCOMPLETE' });
        observingSource = true;
        const proof = Object.freeze({}), receipt = { kind: 'AUDIT', state: 'PENDING', event };
        if (auditProofCount < Number.MAX_SAFE_INTEGER) auditProofCount++; else origins.fault('COUNTER_OVERFLOW');
        auditProofs.set(proof, receipt);
        try {
            const returned = audit.receive(event, proof);
            if (returned !== null && ['object', 'function'].includes(typeof returned)) { receipt.state = 'UNKNOWN'; origins.fault('PARSER_AUDIT_INCOMPLETE'); }
        }
        catch (_) { receipt.state = 'FAILED'; origins.fault('PARSER_AUDIT_RECEIVER_THROWN'); }
        finally {
            observingSource = false;
            if (receipt.state === 'PENDING') receipt.state = complete && outcome === 'ACCEPTED' &&
                origins.status().state === 'OBSERVING' && origin === origins.acceptedOrigin(ticket)
                ? 'FINAL_DELIVERED' : 'UNKNOWN';
        }
    }

    function captureOrigin(ticket, originalBinding, messages) {
        if (!origins) return null;
        try {
            const occurrences = origins.accept(ticket, originalBinding, messages);
            const audit = parserAudits.get(ticket);
            if (audit && occurrences) audit.occurrences = Object.freeze(occurrences.slice());
            return occurrences;
        }
        catch (_) { origins.fault('ORIGIN_INCOMPLETE'); return null; }
    }

    function retirePresentation() {
        if (!pendingView || !pendingScope) return;
        const old = pendingScope; pendingScope = null; pendingProductLease = null;
        pendingDelivery = true;
        try { pendingView.terminal(old); } catch { pendingFault = true; }
        finally { pendingDelivery = false; }
    }
    function publishBatch(messages, occurrences = null) {
        if (phase === 'TERMINAL') return;
        if (!liveCommitCurrent()) return;
        if (replay && !replay.check('SEQUENTIAL_RESPONSE')) return;
        if (pendingView && !pendingScope && (!origins || messages.length > 0)) {
            try { pendingScope = pendingView.open(); } catch { pendingFault = true; }
            if (!pendingScope) pendingFault = true;
        }
        if (phase === 'TERMINAL') { retirePresentation(); return; }
        if (pendingScope && !pendingProductLease && typeof pendingView.productLease === 'function') {
            try { pendingProductLease = pendingView.productLease(pendingScope); } catch { pendingFault = true; }
        }
        if (!liveCommitCurrent()) return;
        // Opaque in-process scope only; M3b owns actual renderer ingestion.
        if (origins) {
            let handle = null;
            try {
                if (origins.isDelivering()) origins.fault('REENTRANT_DELIVERY');
                else if (messages.length > 0 && !origins.isExhausted()) handle = origins.associate(messages, occurrences, pendingView?.lease(pendingScope), pendingView?.resolveLease);
            }
            catch (_) { origins.fault('ASSOCIATION_UNKNOWN'); }
            if (replay && !replay.check('SEQUENTIAL_RESPONSE')) return;
            if (!liveCommitCurrent()) return;
            origins.deliver(() => {
                if (!liveCommitCurrent()) return;
                onBatch(messages, pendingScope, handle, pendingProductLease);
            });
        } else {
            if (replay && !replay.check('SEQUENTIAL_RESPONSE')) return;
            if (pendingScopePort) onBatch(messages, pendingScope, null, pendingProductLease);
            else onBatch(messages);
        }
        liveCommitCurrent();
    }

    function clearTimer(kind) {
        const timer = kind === 'deadline' ? deadlineTimer : readTimer;
        if (kind === 'deadline') deadlineTimer = null; else readTimer = null;
        if (timer !== null) { try { timers.clearTimeout(timer); } catch { /* Never grants work. */ } }
    }
    function terminal(code) {
        if (phase === 'TERMINAL') return false;
        terminalizing = true;
        try {
        phase = 'TERMINAL'; reason = code;
        if (bootstrap !== 'ACCEPTED') bootstrap = 'FAILED';
        if (permit !== 'CONSUMED') permit = 'INVALID';
        if (cursor) { cursor.state = 'INVALID'; cursor.value = null; }
        bootstrapChannel = null;
        context = null; spent.clear();
        clearTimer('deadline'); clearTimer('read');
        if (replay) replay.stop();
        retirePresentation();
        if (flight) { flight.valid = false; try { flight.controller.abort(); } catch { /* Remains invalid. */ } }
        if (flight) finishParserAudit(flight);
        terminalFinalized = true;
        if (diagnostic) {
            if (code === 'DEADLINE_EXPIRED') diagnostic.record('O_BOOTSTRAP_DEADLINE');
            else if (code === 'CURRENTNESS_INVALID') diagnostic.record('O_CURRENTNESS_DENIED');
            else if (code === 'REPLAY_POLICY_DENIED') diagnostic.record('O_POLICY_DENIED');
            diagnostic.complete();
        }
        return true;
        } finally { terminalizing = false; }
    }
    function time() {
        let value;
        try { value = clock.now(); } catch { terminal('CLOCK_INVALID'); return null; }
        if (!Number.isFinite(value) || (lastNow !== null && value < lastNow)) { terminal('CLOCK_INVALID'); return null; }
        lastNow = value;
        return value;
    }
    function facts() {
        let f;
        try { f = readFacts(); } catch { terminal('CURRENTNESS_INVALID'); return null; }
        if (phase === 'TERMINAL') return null;
        if (!f || !Object.keys(binding).every(k => f[k] === binding[k]) || f.owned !== true || f.capability !== true ||
            !associationCurrent(f) ||
            f.clockCurrent !== true || !['visible', 'ready', 'adActive', 'seeking'].every(k => typeof f[k] === 'boolean')) {
            terminal('CURRENTNESS_INVALID'); return null;
        }
        return f;
    }
    function associationCurrent(f) {
        if (!nativeFacts) return true;
        if (binding.mode === 'live') return f?.parentTargetEvidence?.state === 'KNOWN' &&
            f.parentTargetEvidence.basis === 'ORIGINAL_TOP_ROUTE_MATCH' &&
            (f.childAssociationEvidence?.state === 'V_MATCH' ||
                (liveAssociationPolicy === 'ACCEPTED_LIVE_ZERO_V' &&
                    f.childAssociationEvidence?.state === 'LIVE_ZERO_V_STRUCTURAL_UNVERIFIED' &&
                    f.childAssociationEvidence.childTargetIdentity === 'UNVERIFIED'));
        return f?.parentTargetEvidence?.state === 'KNOWN' &&
            f.parentTargetEvidence.basis === 'ORIGINAL_TOP_ROUTE_MATCH' &&
            (f.childAssociationEvidence?.state === 'V_MATCH' ||
                (replayAssociationPolicy === 'ACCEPTED_Z' && f.childAssociationEvidence?.state === 'Z_STRUCTURAL_UNVERIFIED' &&
                    f.childAssociationEvidence.childTargetIdentity === 'UNVERIFIED'));
    }
    const eligible = f => f && f.visible && f.ready && !f.adActive && !f.seeking;
    function liveCommitCurrent() {
        if (phase === 'TERMINAL') return false;
        if (binding.mode !== 'live') return true;
        const f = facts();
        if (!f) return false;
        if (!f.visible && f.ready && !f.adActive && !f.seeking && cursor?.state === 'UNUSED') {
            clearTimer('read'); phase = 'HIDDEN'; return false;
        }
        if (!eligible(f)) { terminal('READ_INVALIDATED'); return false; }
        return phase !== 'TERMINAL';
    }
    function isProductPresentationCurrent(value) {
        if (!nativeFacts || phase === 'TERMINAL' || bootstrap !== 'ACCEPTED' || checkingPresentation ||
            !pendingScope || !pendingView || typeof pendingView.resolveProductLease !== 'function') return false;
        checkingPresentation = true;
        try {
            const association = pendingView.resolveProductLease(value);
            if (!association || association.document !== document || association.scope !== pendingScope) return false;
            const f = facts();
            return phase !== 'TERMINAL' && eligible(f) && association.scope === pendingScope &&
                pendingView.resolveProductLease(value) === association && (!replay || replay.projectionCurrent(f));
        } catch (_) { return false; }
        finally { checkingPresentation = false; }
    }
    function admissionWindow() {
        if (phase === 'TERMINAL' || bootstrap !== 'PENDING' || permit !== 'CONSUMED') return false;
        const f = facts(), originalNow = replay ? null : time();
        if (!eligible(f)) { terminal('CURRENTNESS_INVALID'); return false; }
        if (replay && !replay.check('BOOTSTRAP')) return false;
        const now = replay ? time() : originalNow;
        if (now === null || t0 === null || now - t0 < 0 || now - t0 >= 5000) {
            terminal('DEADLINE_EXPIRED'); return false;
        }
        return phase !== 'TERMINAL' && bootstrap === 'PENDING' && permit === 'CONSUMED';
    }
    function deadline() {
        deadlineTimer = null;
        if (!admissionWindow()) return;
        try { deadlineTimer = timers.setTimeout(deadline, 5000 - (lastNow - t0)); }
        catch { terminal('TIMER_FAILED'); }
    }
    function armRead() {
        if (phase === 'TERMINAL' || readTimer !== null || flight) return;
        if (replay) { replay.arm(); return; }
        const now = time();
        if (now === null || !cursor || cursor.state !== 'UNUSED') { terminal('CURSOR_UNAVAILABLE'); return; }
        try { readTimer = timers.setTimeout(read, Math.max(0, cursor.notBefore - now)); }
        catch { terminal('TIMER_FAILED'); }
    }
    function synchronize() {
        if (observingSource) { origins.fault('REENTRANT_OBSERVATION'); return false; }
        if (phase === 'TERMINAL') return false;
        const f = facts();
        if (!f) return false;
        if (bootstrap !== 'ACCEPTED') {
            if (permit === 'CONSUMED' && !eligible(f)) terminal('CURRENTNESS_INVALID');
            return false;
        }
        if (replay) return replay.sync(f);
        if (f.adActive || f.seeking || !f.ready) { terminal('MEDIA_UNAVAILABLE'); return false; }
        if (!f.visible) {
            clearTimer('read');
            if ((flight && !flight.accepted) || !cursor || cursor.state !== 'UNUSED') terminal('CURSOR_SPENT_HIDDEN');
            else phase = 'HIDDEN';
            return false;
        }
        if (flight) return false;
        if (!cursor || cursor.state !== 'UNUSED' || spent.has(cursor.value)) { terminal('CURSOR_UNAVAILABLE'); return false; }
        phase = 'READY'; armRead(); return phase !== 'TERMINAL';
    }
    async function read() {
        readTimer = null;
        if (replay) { await replay.read(); return; }
        if (!synchronize() || flight || phase === 'TERMINAL') return;
        // synchronize may have armed a timer; this opportunity owns the read.
        clearTimer('read');
        const now = time();
        if (now === null) return;
        if (phase === 'TERMINAL' || flight || !cursor || cursor.state !== 'UNUSED' || spent.has(cursor.value)) return;
        if (now < cursor.notBefore) { armRead(); return; }
        const current = cursor;
        // Consume before constructing a controller/body or attempting transport.
        current.state = 'CONSUMED'; spent.add(current.value);
        const ticket = { id: ++nextTicket, valid: true, accepted: false, controller: null };
        flight = ticket; phase = 'READING'; attempts++;
        beginParserAudit(ticket, binding);
        try {
            ticket.controller = new Controller();
            const body = core.buildLiveChatReadRequest(context, current.value);
            if (!body) { terminal('INVALID_REQUEST'); return; }
            const encoded = JSON.stringify(body);
            if (!currentFlight(ticket)) return;
            const response = await transport('/youtubei/v1/live_chat/get_live_chat?prettyPrint=false', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: encoded, credentials: 'omit', signal: requestSignal(ticket, ticket.controller.signal)
            });
            if (!currentFlight(ticket)) return;
            if (!core.isSuccessfulHttpStatus(response.status)) { terminal('HTTP_ERROR'); return; }
            const payload = await response.json();
            if (!currentFlight(ticket)) return;
            const validation = core.validateLiveChatReadResponse(payload);
            if (!validation.ok) { terminal('INVALID_RESPONSE'); return; }
            const messageKeys = ['id', 'authorName', 'message', 'timestampUsec', 'authorPhoto', 'authorBadges',
                'badges', 'messageType', 'authorRole', 'messageRuns', 'authorExternalChannelId',
                'purchaseAmountText', 'sticker', 'colors', 'replayOffsetMsec'];
            const messages = parseResponse(ticket, payload, 'live')
                .map(message => Object.fromEntries(messageKeys.map(key => [key, message[key]])));
            const next = validation.continuationInfo.continuation;
            // Final actual media/currentness check after parsing, before commit.
            if (!currentFlight(ticket)) return;
            const acceptedAt = time();
            if (acceptedAt === null || phase === 'TERMINAL') return;
            if (!currentFlight(ticket)) return;
            if (spent.has(next)) { terminal('CURSOR_REPEATED'); return; }
            const notBefore = acceptedAt + validation.effectiveDelayMs;
            if (!Number.isFinite(notBefore) || notBefore <= acceptedAt) { terminal('CLOCK_INVALID'); return; }
            cursor = { state: 'UNUSED', value: next, notBefore };
            ticket.accepted = true;
            accepted++;
            const occurrences = captureOrigin(ticket, binding, messages);
            if (!liveCommitCurrent()) return;
            origins?.liveHandoff(occurrences);
            if (!liveCommitCurrent()) return;
            publishBatch(messages, occurrences); // Private future Presentation port; never raw cursor/context.
        } catch { if (phase !== 'TERMINAL') terminal('READ_FAILED'); }
        finally {
            // Abort does not release flight ownership early; late finally cannot
            // unlock another ticket. This owner never starts an overlapping read.
            if (flight === ticket) flight = null;
            if (phase !== 'TERMINAL') synchronize();
            finishParserAudit(ticket);
        }
    }
    function currentFlight(ticket, path) {
        if (phase === 'TERMINAL' || flight !== ticket || !ticket.valid || ticket.controller.signal.aborted) return false;
        if (!core.canScheduleNextRead({ generation: ticket.id, currentGeneration: nextTicket,
            revision: binding.revision, currentRevision: binding.revision,
            aborted: ticket.controller.signal.aborted, validationOk: true })) return false;
        const f = facts();
        if (replay && nativeFacts && f && !replay.observe(f)) return false;
        if (!eligible(f)) { terminal('READ_INVALIDATED'); return false; }
        if (replay && !replay.check(path || ticket.kind + '_RESPONSE')) return false;
        if (replay && !replay.current(f)) { terminal('READ_INVALIDATED'); return false; }
        return phase !== 'TERMINAL';
    }
    function openBootstrap(channel) {
        if (phase === 'TERMINAL' || bootstrap !== 'CREATED' || !channel || typeof channel !== 'object') return null;
        const f = facts();
        if (!eligible(f)) { diagnostic?.record('O_PREPERMIT_WAIT'); return null; } // Pre-permit WAIT; no election/clock consumed.
        if (replay && !replay.check('BOOTSTRAP')) return null;
        if (phase === 'TERMINAL' || bootstrap !== 'CREATED') return null;
        bootstrapChannel = channel; bootstrap = 'RESERVED';
        diagnostic?.block(); diagnostic?.record('O_BOOTSTRAP_RESERVED');
        const original = channel;
        return Object.freeze({ operationId,
            consumePermit(request) {
                if (phase === 'TERMINAL' || bootstrapChannel !== original || bootstrap !== 'RESERVED' ||
                    permit !== 'UNUSED') return null;
                if (!request || request.operationId !== operationId ||
                    !request.route || !['tabId', 'frameId', 'documentId'].every(k => request.route[k] === route[k])) return null;
                if (!eligible(facts())) { terminal('CURRENTNESS_INVALID'); return false; }
                if (replay && !replay.check('BOOTSTRAP')) return false;
                const now = time(); if (now === null) return false;
                if (phase === 'TERMINAL' || bootstrap !== 'RESERVED' || permit !== 'UNUSED' || bootstrapChannel !== original) return null;
                // One atomic owner transition, before returning the private grant.
                permit = 'CONSUMED'; t0 = now; bootstrap = 'PENDING';
                diagnostic?.record('O_PERMIT_CONSUMED');
                try { deadlineTimer = timers.setTimeout(deadline, 5000); }
                catch { terminal('TIMER_FAILED'); return false; }
                return phase !== 'TERMINAL';
            },
            receive(raw) {
                if (bootstrapChannel !== original || !admissionWindow()) return false;
                const checked = validateEnvelope(raw);
                let rejection = 1;
                if (!checked.valid || (rejection = 2, checked.value.operationId !== operationId) ||
                    (rejection = 3, !['tabId', 'frameId', 'documentId'].every(k => checked.value.route[k] === route[k])) ||
                    (rejection = 4, checked.value.result.status !== 'OK') || (rejection = 5, checked.value.result.mode !== binding.mode) ||
                    (rejection = 6, checked.value.result.targetId !== binding.targetId)) {
                    if (rejection === 4) diagnostic?.record('O_BOOTSTRAP_V2_RESULT_ERROR', checked.value.result.stage, checked.value.result.code);
                    else diagnostic?.record(rejection === 1 ? 'O_BOOTSTRAP_V2_SCHEMA_INVALID' : rejection === 2 ?
                        'O_BOOTSTRAP_V2_OPERATION_MISMATCH' : rejection === 3 ? 'O_BOOTSTRAP_V2_ROUTE_MISMATCH' :
                        rejection === 5 ?
                        'O_BOOTSTRAP_V2_MODE_MISMATCH' : 'O_BOOTSTRAP_V2_TARGET_MISMATCH');
                    terminal('BOOTSTRAP_INVALID'); return false;
                }
                const result = checked.value.result;
                if (!admissionWindow()) return false;
                // No yield/callback between final elapsed/currentness check and commit.
                bootstrap = 'ACCEPTED'; phase = 'READY'; context = result.context;
                if (replay) replay.admit(result.continuation);
                else cursor = { state: 'UNUSED', value: result.continuation, notBefore: lastNow };
                clearTimer('deadline'); if (phase !== 'TERMINAL') armRead();
                return phase !== 'TERMINAL';
            },
            lost() { if (bootstrapChannel === original && bootstrap !== 'ACCEPTED') terminal('DELIVERY_LOST'); }
        });
    }
    if (binding.mode === 'replay') replay = createReplayCore();
    if (pendingScopePort) {
        try {
            const connected = pendingScopePort.connect(binding, route);
            if (!connected || !['open', 'terminal', 'status'].every(key => typeof connected[key] === 'function')) pendingFault = true;
            else { pendingView = connected; if (!origins) {
                pendingScope = pendingView.open();
                if (pendingScope && typeof pendingView.productLease === 'function')
                    pendingProductLease = pendingView.productLease(pendingScope);
            } }
            if (!origins && !pendingScope) pendingFault = true;
        } catch { pendingFault = true; }
    }
    if (origins) {
        try { provenance.connect(Object.freeze({
            recognizeBatch: origins.recognizeBatch, recognizeOccurrence: origins.lookup, claimBatch: origins.claimBatch,
            recognizeAuditProof, isProofDelivering: () => observingSource,
            recognizeTemporalTransitionProof: origins.recognizeTransitionProof,
            proofCoverage: () => Object.freeze({ audit: auditProofCount, ...origins.proofCoverage() }),
            readLifetime: () => Object.freeze({ owner: originOwner, document, binding, phase,
                inFlight: flight !== null, delivering: observingSource || origins.isDelivering(),
                readTimerPending: readTimer !== null, deadlinePending: deadlineTimer !== null,
                bootstrapPending: bootstrapChannel !== null, pendingFault, pendingDelivery, terminalizing, terminalFinalized }),
            enableRetirement: origins.enableRetirement,
            observationStatus: origins.status, onFault: origins.fault,
            isCurrent(identity) {
                if (phase === 'TERMINAL' || !identity || identity.document !== document ||
                    !pendingView?.resolveLease(identity.lease)) return false;
                try {
                    const f = readFacts();
                    if (!f) return false;
                    return Object.keys(binding).every(key => f[key] === binding[key]) &&
                        f.owned === true && f.capability === true && f.clockCurrent === true && associationCurrent(f) &&
                        (!replay || replay.projectionCurrent(f));
                } catch (_) { return false; }
            }
        })); } catch (_) { origins.fault('COMPOSITION_FAILED'); }
    }
    // Private capability only. No public message parser or page-visible export.
    return Object.freeze({ openBootstrap, synchronize, isProductPresentationCurrent, cancel: () => {
        if (observingSource) { origins.fault('REENTRANT_OBSERVATION'); return false; }
        return terminal('CANCELLED');
    },
        status: () => Object.freeze({ phase, bootstrap, permit, cursor: cursor?.state || 'MISSING',
            inFlight: flight !== null, attempts, accepted, reason, ...(replay ? replay.status() : {}),
            ...(pendingScopePort ? { pendingScopeFault: pendingFault, pendingScopes: pendingView?.status() || null } : {}) }) });

    function createReplayCore() {
        const b = Object.freeze({ lifecycleId: binding.lifecycle, revision: binding.revision,
            targetId: binding.targetId, generation: binding.generation });
        const policyContext = control.createOwnerPolicyContext({ owner: originOwner, binding: b,
            validate(path, stage) {
                if (phase === 'TERMINAL') return false;
                const f = facts();
                return phase !== 'TERMINAL' && bootstrap === 'ACCEPTED' && f !== null &&
                    (stage === 'INSPECT' || eligible(f)) &&
                    (!['AUTHORIZE', 'CLAIM', 'CONSUME'].includes(stage) || !f.paused) &&
                    associationCurrent(f) && capability(path, f);
            } });
        if (!policyContext) throw new Error('POLICY_CONTEXT_UNAVAILABLE');
        let state = control.createReplayState('STOPPED'), registry = control.createConsumedAuthorityRegistry(policyContext);
        let authority = null, seekAuthority = null, grant = null, kind = 'BOOTSTRAP', due = 0;
        let pendingOrigins = [];
        let pending = [], start = null, initialTarget = null, alignmentUsed = false, paused = false, deferred = false;
        let wake = null, suppression = 'CLEAR', runway = 'UNKNOWN', episode = false, budget = 0, early = false, resumeRead = false;
        let dropped = 0, bridged = 0, consumedCount = 0;
        let recovery = null, lastReanchor = 'NONE', seekObserved = false, seekEpoch = 0;
        let foregroundActive = false, foregroundResult = 'NOT_ATTEMPTED', lastRate = null;
        let coverageEpisode = core.transitionReplayCoverageHoleEpisode(null, 'INVALIDATED');
        let replaced = 0;
        function invalidate(value) { if (value) control.invalidateAuthority(value); }
        function event(name, input = {}) {
            const step = control.reduceReplayControlState(state, name, input);
            if (step.failure === 'FORBIDDEN_EVENT') { terminal('REPLAY_TRANSITION_INVALID'); return false; }
            state = step.nextState; return true;
        }
        function make(type, token) {
            return control.createReplayAuthority({ kind: type, opaqueToken: token, binding: b,
                policyContext,
                provenance: type === 'BOOTSTRAP' ? 'ADAPTER_BOOTSTRAP' : type === 'REANCHOR' ? 'ADAPTER_REANCHOR' : 'SEQUENTIAL_RESPONSE' }).authority;
        }
        function available(value, type) {
            return control.inspectAuthorityRequestEligibility({ authority: value, expectedKind: type,
                currentBinding: b, consumedRegistry: registry }).ok;
        }
        function capability(path, f) {
            if (!f || !associationCurrent(f)) return false;
            const snapshot = control.createCapabilitySnapshot({ binding: b, evidenceEpoch: binding.revision,
                capabilities: { bootstrapRead: f.capability ? 'SUPPORTED' : 'UNKNOWN',
                    sequentialRead: f.capability ? 'SUPPORTED' : 'UNKNOWN', reanchorRead: f.capability ? 'SUPPORTED' : 'UNKNOWN',
                    targetIdentity: (!nativeFacts || f.parentTargetEvidence?.basis === 'ORIGINAL_TOP_ROUTE_MATCH') ? 'SUPPORTED' : 'UNKNOWN',
                    mainContentOwnership: f.owned ? 'SUPPORTED' : 'UNKNOWN',
                    playerTiming: core.validatePlayerSeekOffset(f.currentTime, f.duration) !== null ? 'SUPPORTED' : 'UNKNOWN',
                    replayMessages: 'SUPPORTED' } }).snapshot;
            return control.canUseCapabilityPath(path, snapshot, b).allowed;
        }
        function check(path) {
            if (phase === 'TERMINAL') return null;
            if (!control.isOwnerPolicyContextCurrent(policyContext)) { terminal('REPLAY_POLICY_DENIED'); return null; }
            const f = facts();
            if (!f || !associationCurrent(f) || !capability(path, f) || phase === 'TERMINAL') {
                terminal('REPLAY_POLICY_DENIED'); return null;
            }
            return f;
        }
        function authorize(value, type, f) {
            if (!capability(type, f)) return null;
            const result = control.authorizeAuthorityRequest({ authority: value, expectedKind: type,
                currentBinding: b, consumedRegistry: registry });
            consumedCount = registry.diagnostic().consumedCount;
            return result.ok ? result.grant : null;
        }
        function cancelWake() {
            const timer = wake; wake = null;
            if (timer !== null) { try { timers.clearTimeout(timer); } catch { /* Callback remains fenced. */ } }
        }
        function abortActive() {
            clearTimer('read'); cancelWake();
            if (authority !== seekAuthority) invalidate(authority);
            authority = null; grant = null;
            if (flight && !flight.accepted) {
                flight.valid = false;
                try { flight.controller.abort(); } catch { /* Ticket remains invalid. */ }
            }
            // The flight lock is retained until its own finalizer. Nothing can
            // restore a consumed grant or start a parallel recovery request.
        }
        function clearPending() {
            retirePresentation();
            const removedOrigins = pendingOrigins;
            pendingOrigins = [];
            replaced += pending.length; pending = []; paused = false; deferred = false;
            if (origins && removedOrigins?.length) origins.discard(removedOrigins, 'TEMPORAL_REPLACED');
            early = false; resumeRead = false; episode = false; budget = 0; suppression = 'CLEAR'; runway = 'UNKNOWN';
            coverageEpisode = core.transitionReplayCoverageHoleEpisode(coverageEpisode, 'INVALIDATED');
        }
        function queueRecovery(reason, f) {
            if (recovery || kind === 'REANCHOR') return false;
            if (!available(seekAuthority, 'REANCHOR') || !capability('REANCHOR', f)) {
                terminal('REPLAY_RECOVERY_AUTHORITY_UNAVAILABLE'); return false;
            }
            invalidate(authority); authority = seekAuthority; grant = null;
            recovery = Object.freeze({ reason, epoch: seekEpoch, video: binding.video });
            kind = 'REANCHOR'; due = time();
            if (reason !== 'COVERAGE_HOLE') clearPending();
            return phase !== 'TERMINAL';
        }
        function suspend(reason, f) {
            if (state.phase === 'SUSPENDED' && state.suspendedReason === reason) return false;
            const retain = available(seekAuthority, 'REANCHOR') && !f.seeking && !foregroundActive;
            abortActive(); clearPending(); recovery = null; kind = 'SEQUENTIAL';
            if (!retain) { invalidate(seekAuthority); seekAuthority = null; }
            if (foregroundActive) { foregroundActive = false; foregroundResult = reason === 'AD' ? 'AD_ACTIVE' : 'REHIDDEN_ABORTED'; }
            seekObserved = false;
            if (!event(reason === 'HIDDEN' ? 'HIDDEN_ENTER' : 'AD_ENTER')) return false;
            phase = reason === 'HIDDEN' ? 'HIDDEN' : 'AD'; return false;
        }
        function observe(f) {
            if (!nativeFacts) return true;
            if (!f || phase === 'TERMINAL') return false;
            if (lastRate !== null && lastRate !== f.playbackRate) event('PLAYBACK_RATE_CHANGED');
            lastRate = f.playbackRate;
            // Hidden dominates ad; arrival of a public notification never
            // supplies either fact, the seek epoch, or an Authority grant.
            if (!f.visible) {
                if (f.seeking) { invalidate(seekAuthority); seekAuthority = null; }
                return suspend('HIDDEN', f);
            }
            if (f.adActive) {
                if (state.phase === 'SUSPENDED' && state.suspendedReason === 'HIDDEN') {
                    invalidate(seekAuthority); seekAuthority = null;
                    event('VISIBLE_ENTER', { adActive: true, recoveryEligible: false });
                    phase = 'AD'; return false;
                }
                return suspend('AD', f);
            }
            if (f.seeking) {
                if (state.phase === 'SUSPENDED' && state.suspendedReason === 'HIDDEN') {
                    terminal('REPLAY_FOREGROUND_SEEK'); return false;
                }
                if (!seekObserved) {
                    seekObserved = true; seekEpoch++;
                    if (foregroundActive) { invalidate(seekAuthority); seekAuthority = null; }
                    abortActive(); clearPending(); recovery = null; kind = 'SEQUENTIAL';
                    if (foregroundActive) { foregroundActive = false; foregroundResult = 'SEEK_ABORTED'; }
                    if (!event('SEEK_STARTED')) return false;
                    if (state.phase === 'STOPPED') { terminal('REPLAY_SEEK_BEFORE_ADMISSION'); return false; }
                }
                phase = 'SEEKING'; return false;
            }
            if (state.phase === 'SUSPENDED' && state.suspendedReason === 'HIDDEN') {
                if (flight) return false;
                const valid = available(seekAuthority, 'REANCHOR');
                const decision = control.evaluateForegroundRecoveryEligibility({
                    visible: f.visible, replayTarget: binding.mode === 'replay', lifecycleCurrent: true,
                    revisionCurrent: true, targetCurrent: true, authorityAvailable: Boolean(seekAuthority),
                    authorityUnused: valid, authorityBindingCurrent: valid, authorityUnconsumed: valid,
                    noAd: !f.adActive, noSeek: !seekObserved, ownershipCurrent: f.owned && !f.paused && !f.ended,
                    playerTimingValid: core.validatePlayerSeekOffset(f.currentTime, f.duration) !== null,
                    noRequestConflict: !flight, capabilityAllowed: capability('REANCHOR', f), controlSuspendedHidden: true
                });
                if (!decision.allowed) { foregroundResult = 'PRECONDITION_FAILED'; terminal('REPLAY_FOREGROUND_INVALID'); return false; }
                if (!event('VISIBLE_ENTER', { adActive: false, recoveryEligible: true })) return false;
                foregroundActive = true; foregroundResult = 'STARTED';
                if (!queueRecovery('FOREGROUND', f)) return false;
            } else if (state.phase === 'SUSPENDED' && state.suspendedReason === 'AD') {
                if (!event('AD_EXIT_READY', { hidden: false })) return false;
                if (!seekObserved && !queueRecovery('AD_EXIT', f)) return false;
            }
            if (seekObserved) {
                seekObserved = false;
                if (!event('SEEK_COMPLETED') || !queueRecovery('SEEK', f)) return false;
            }
            // Known unready media waits without treating a historical readiness
            // sample as permanent authorization. Revalidated again at dispatch.
            if (!f.ready || f.ended) { clearTimer('read'); cancelWake(); phase = 'WAITING_MEDIA'; return false; }
            return true;
        }
        function flush(f) {
            if (!check('SEQUENTIAL_RESPONSE')) return null;
            let trace = null;
            const selection = origins && !origins.isExhausted() && typeof core.selectReplayTemporalWithTrace === 'function'
                ? core.selectReplayTemporalWithTrace(pending, f.currentTime, start, 100, trace = core.createReplayTemporalTrace({ reasons: true }))
                : core.selectBoundedReplayDueMessages(pending, f.currentTime, start, 100);
            let slots = null;
            if (origins && trace) {
                try { slots = origins.temporal(pendingOrigins, trace.snapshot()); }
                catch (_) { origins.fault('TEMPORAL_INCOMPLETE'); }
            }
            if (origins && !trace) origins.fault('TEMPORAL_OBSERVER_MISSING');
            if (!check('SEQUENTIAL_RESPONSE')) return null;
            pendingOrigins = slots?.pending || null;
            if (!selection) { terminal('REPLAY_TEMPORAL_INVALID'); return null; }
            pending = selection.pending; dropped += selection.capacityDropped;
            const schedulerKnown = Number.isInteger(f.schedulerPendingCount) && f.schedulerPendingCount >= 0;
            runway = selection.due.length > 0 || (schedulerKnown && f.schedulerPendingCount > 0)
                ? core.transitionReplayRunwayDepletionEpisode(runway, 'RUNWAY_POSITIVE')
                : schedulerKnown ? core.transitionReplayRunwayDepletionEpisode(runway, 'RUNWAY_DEPLETED') : 'UNKNOWN';
            if (pending.length <= 50) { suppression = 'CLEAR'; episode = false; budget = 0; }
            if (selection.due.length) { bridged += selection.due.length; publishBatch(selection.due, slots?.due); }
            cancelWake();
            const delay = core.getReplayTemporalWakeDelayMs(pending, f.currentTime, start, f.playbackRate);
            if (delay !== null && phase !== 'TERMINAL') {
                const armedTime = f.currentTime;
                try { wake = timers.setTimeout(() => {
                    wake = null; const current = facts();
                    if (phase !== 'TERMINAL' && current && core.canRunReplayTemporalWakeup({
                        sequenceCurrent: true, generationCurrent: true, revisionCurrent: true, lifecycleCurrent: true,
                        targetCurrent: true, modeReplay: binding.mode === 'replay', visible: current.visible,
                        navigationPending: false, adActive: current.adActive, seekActive: current.seeking,
                        reanchorActive: kind === 'REANCHOR', diagnosticLock: false,
                        controlSuspended: state.phase === 'SUSPENDED', videoCurrent: current.video === binding.video,
                        mediaPaused: current.paused, mediaEnded: current.ended, mediaSeeking: current.seeking,
                        playerTimingValid: core.validatePlayerSeekOffset(current.currentTime, current.duration) !== null,
                        mediaTimeAdvanced: current.currentTime > armedTime })) synchronize();
                }, delay); } catch { terminal('TIMER_FAILED'); }
            }
            return selection;
        }
        function validMedia(f) {
            return eligible(f) && typeof f.paused === 'boolean' && f.ended === false &&
                core.validatePlayerSeekOffset(f.currentTime, f.duration) !== null &&
                Number.isFinite(f.playbackRate) && f.playbackRate > 0;
        }
        function sync(f) {
            if (phase === 'TERMINAL') return false;
            if (!observe(f)) return false;
            if (!validMedia(f)) { terminal('REPLAY_MEDIA_INVALID'); return false; }
            if (f.paused) {
                clearTimer('read'); cancelWake();
                if (flight && !flight.accepted) { terminal('REPLAY_PAUSED_IN_FLIGHT'); return false; }
                if (state.phase !== 'SUSPENDED') event('MEDIA_PAUSE', { initialBootstrap: state.phase === 'BOOTSTRAPPING' });
                phase = 'PAUSED'; return false;
            }
            if (state.phase === 'SUSPENDED' && state.suspendedReason === 'MEDIA_PAUSED') event('MEDIA_PLAY');
            const selection = start !== null ? flush(f) : null;
            if (start !== null && !selection) return false;
            if (phase === 'TERMINAL') return false;
            if (flight) return false;
            if (kind === 'REANCHOR') { phase = 'READY'; armRead(); return true; }
            if (nativeFacts && state.phase === 'READING' && !paused && !resumeRead) {
                const hole = core.hasReplayCurrentWindowCoverageHole({ pendingMessages: pending,
                    currentTimeSeconds: f.currentTime, dueCount: selection?.due.length || 0, schedulerPendingCount: f.schedulerPendingCount });
                coverageEpisode = core.transitionReplayCoverageHoleEpisode(coverageEpisode, hole ? 'HOLE_OBSERVED' : 'HOLE_CLEARED');
                const valid = available(seekAuthority, 'REANCHOR');
                const repair = core.evaluateReplayCoverageHoleRepair({ semanticHole: hole, episodeSpent: coverageEpisode.spent,
                    authorityAvailable: Boolean(seekAuthority), authorityCurrent: valid, authorityUnused: valid,
                    capabilityAllowed: capability('REANCHOR', f), requestInFlight: false, reanchorActive: false,
                    lifecycleCurrent: true, revisionCurrent: true, targetCurrent: true, generationCurrent: true,
                    playerTimingValid: core.validatePlayerSeekOffset(f.currentTime, f.duration) !== null,
                    mainContentOwnershipValid: f.owned, visible: f.visible, seekActive: f.seeking, adActive: f.adActive, navigationPending: false });
                if (repair.eligible && queueRecovery('COVERAGE_HOLE', f)) {
                    coverageEpisode = core.transitionReplayCoverageHoleEpisode(coverageEpisode, 'AUTHORIZED');
                    phase = 'READY'; armRead(); return true;
                }
            }
            if (!grant && !available(authority, kind)) { terminal('REPLAY_AUTHORITY_INVALID'); return false; }
            if (paused) {
                const a = { paused: true, pendingCount: pending.length, maximumPending: 100,
                    authorityAvailable: Boolean(authority), authorityCurrent: available(authority, 'SEQUENTIAL'),
                    authorityUnused: available(authority, 'SEQUENTIAL') };
                if (core.evaluateReplayNormalResume(a).eligible) {
                    event('BUFFER_LOW_WATERMARK'); paused = false; resumeRead = true;
                } else {
                    const e = core.evaluateReplayBufferEarlyResume({ ...a, pauseReason: 'COUNT_PRESSURE',
                        dueCount: selection?.due.length || 0, schedulerPendingCount: f.schedulerPendingCount,
                        nearestFutureClass: core.classifyNearestReplayFuture(pending, f.currentTime),
                        requestInFlight: false, activeLoop: false, locked: false,
                        suppressed: runway !== 'DEPLETED_AVAILABLE',
                        authorityAvailable: a.authorityAvailable && capability('EARLY_RESUME', f) });
                    if (!e.eligible) { phase = 'BUFFER_PAUSED'; return false; }
                    event('EARLY_RESUME_ELIGIBLE'); paused = false; early = true; resumeRead = true; episode = true; budget = 1;
                    suppression = core.transitionReplayEarlyResumeSuppression(suppression, 'EARLY_RESUME_STARTED');
                    runway = core.transitionReplayRunwayDepletionEpisode(runway, 'EARLY_RESUME_STARTED');
                }
            }
            if (kind !== 'BOOTSTRAP' && !resumeRead) {
                const decision = core.evaluateReplayReadAheadCadence({ deferred,
                    horizon: core.classifyReplayReadAheadHorizon(pending, f.currentTime),
                    authorityAvailable: Boolean(authority || grant), authorityCurrent: true, authorityUnused: true,
                    capabilityAllowed: capability('SEQUENTIAL', f), requestInFlight: false, activeLoop: false,
                    lifecycleCurrent: true, targetCurrent: true, videoCurrent: true, visible: f.visible,
                    adActive: f.adActive, seekActive: f.seeking, navigationPending: false });
                if (decision.action === 'DEFER' || decision.action === 'WAIT' || decision.action === 'HOLD') {
                    deferred = true; phase = 'READ_AHEAD_DEFERRED'; clearTimer('read'); return false;
                }
                deferred = false;
            }
            phase = 'READY'; armRead(); return true;
        }
        async function executeReplay() {
            const f = facts();
            if (!f || !sync(f) || flight || phase === 'TERMINAL') return;
            clearTimer('read'); const now = time(); if (now === null) return;
            if (now < due) { armRead(); return; }
            const type = kind;
            const recoveryReason = type === 'REANCHOR' ? (recovery?.reason || 'INITIAL_ALIGNMENT') : null;
            const requestGrant = grant || authorize(authority, type, f);
            grant = null;
            if (!requestGrant) { diagnostic?.record('O_GRANT_DENIED'); terminal('REPLAY_AUTHORITY_INVALID'); return; }
            const claimFacts = facts();
            if (!claimFacts || !observe(claimFacts) || !validMedia(claimFacts) || claimFacts.paused) return;
            if (!event(type === 'BOOTSTRAP' ? 'BOOTSTRAP_AUTHORIZED' : type === 'REANCHOR' ? 'REANCHOR_AUTHORIZED' : 'SEQUENTIAL_AUTHORIZED',
                { preservePending: recoveryReason === 'COVERAGE_HOLE' })) return;
            const claimed = control.claimAuthorityRequestGrant(requestGrant, type);
            if (!claimed.ok) { diagnostic?.record('O_GRANT_DENIED'); terminal('REPLAY_GRANT_INVALID'); return; }
            authority = null;
            const ticket = { id: ++nextTicket, valid: true, accepted: false, controller: null, early, kind: type };
            early = false; resumeRead = false;
            flight = ticket; phase = 'READING'; attempts++;
            beginParserAudit(ticket, b);
            if (recoveryReason) lastReanchor = recoveryReason;
            let timeout = null;
            try {
                ticket.controller = new Controller();
                const current = facts();
                if (!validMedia(current) || current.paused || phase === 'TERMINAL') { terminal('REPLAY_MEDIA_INVALID'); return; }
                let offset = null;
                if (type === 'BOOTSTRAP') { start = current.currentTime; initialTarget = core.validatePlayerSeekOffset(current.currentTime, current.duration); }
                if (type === 'REANCHOR') offset = core.validatePlayerSeekOffset(current.currentTime, current.duration);
                const body = core.buildLiveChatReadRequest(context, claimed.opaqueToken);
                if (offset !== null) body.currentPlayerState = { playerOffsetMs: offset };
                timeout = timers.setTimeout(() => { if (flight === ticket) terminal('REPLAY_TIMEOUT'); }, 15000);
                if (!currentFlight(ticket, type)) return;
                diagnostic?.record('O_READ_CALL_REACHED');
                const response = await transport('/youtubei/v1/live_chat/get_live_chat_replay?prettyPrint=false', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                    credentials: 'omit', signal: requestSignal(ticket, ticket.controller.signal) });
                if (type !== 'REANCHOR') { timers.clearTimeout(timeout); timeout = null; }
                if (!currentFlight(ticket)) return;
                if (!core.isSuccessfulHttpStatus(response.status)) { terminal('HTTP_ERROR'); return; }
                const payload = await response.json();
                if (!currentFlight(ticket)) return;
                const validation = core.validateReplayChatReadResponse(payload, offset === null
                    ? { requestContinuation: claimed.opaqueToken, consumedContinuations: registry } : null);
                if (!validation.ok) { terminal('REPLAY_RESPONSE_INVALID'); return; }
                const messages = parseResponse(ticket, payload, 'replay');
                const token = core.extractPlayerSeekContinuation(payload);
                if (!currentFlight(ticket)) return;
                if (type === 'REANCHOR') {
                    const relation = core.summarizePlayerSeekDiagnosticResponse(payload, offset).responseOffsetRelation;
                    if (!['CROSSES_TARGET', 'ALL_NEAR_OR_AFTER_TARGET'].includes(relation)) { terminal('REPLAY_ALIGNMENT_INVALID'); return; }
                    if (recoveryReason === 'COVERAGE_HOLE' && !['SUCCESS', 'NO_PROGRESS'].includes(
                        core.classifyReplayCoverageHoleRepairResult(messages, facts()?.currentTime))) {
                        terminal('REPLAY_COVERAGE_RESPONSE_INVALID'); return;
                    }
                }
                if (token) {
                    if (!currentFlight(ticket)) return;
                    invalidate(seekAuthority); seekAuthority = make('REANCHOR', token);
                    if (!currentFlight(ticket)) return;
                }
                if (type === 'BOOTSTRAP') {
                    const alignment = control.evaluateInitialReplayAlignment({ targetOffsetMsec: initialTarget,
                        coverage: core.classifyReplayInitialStartupCoverage(messages, initialTarget),
                        reanchorEligible: available(seekAuthority, 'REANCHOR'), attempted: alignmentUsed });
                    if (alignment.action !== 'COMMIT_BOOTSTRAP') {
                        if (!currentFlight(ticket)) return;
                        event('INITIAL_ALIGNMENT_REQUIRED');
                        if (!currentFlight(ticket)) return;
                        if (alignment.action !== 'ALIGN_ONCE' || alignmentUsed) { terminal('REPLAY_ALIGNMENT_HOLD'); return; }
                        alignmentUsed = true; authority = seekAuthority; kind = 'REANCHOR'; due = time();
                        return;
                    }
                }
                const next = validation.continuationInfo.continuation;
                if (core.classifySequentialContinuationProgress(claimed.opaqueToken, next, registry) !== 'ADVANCED') {
                    terminal('REPLAY_NO_FRESH_CHAIN'); return;
                }
                if (!currentFlight(ticket)) return;
                const fresh = make('SEQUENTIAL', next);
                if (!fresh || !currentFlight(ticket)) { terminal('REPLAY_NO_FRESH_CHAIN'); return; }
                if (type === 'REANCHOR') {
                    grant = authorize(fresh, 'SEQUENTIAL', facts());
                    if (!grant) { terminal('REPLAY_NO_FRESH_CHAIN'); return; }
                    if (!currentFlight(ticket)) return;
                    if (recoveryReason !== 'COVERAGE_HOLE') { clearPending(); start = offset / 1000; }
                    if (!currentFlight(ticket)) return;
                    resumeRead = true;
                }
                if (!event(type === 'BOOTSTRAP' ? 'BOOTSTRAP_SUCCEEDED' : type === 'REANCHOR' ? 'REANCHOR_SUCCEEDED' : 'SEQUENTIAL_SUCCEEDED')) return;
                if (!currentFlight(ticket)) return;
                authority = fresh; kind = 'SEQUENTIAL'; pending = pending.concat(messages);
                recovery = null;
                if (recoveryReason === 'FOREGROUND') { foregroundActive = false; foregroundResult = 'SUCCESS'; }
                accepted++; ticket.accepted = true;
                if (origins) {
                    const occurrences = captureOrigin(ticket, b, messages);
                    if (!currentFlight(ticket)) return;
                    pendingOrigins = pendingOrigins && occurrences ? pendingOrigins.concat(occurrences) : null;
                }
                const updated = facts(); if (!updated || !flush(updated) || phase === 'TERMINAL') return;
                if ((ticket.early && episode && budget === 1) || pending.length >= 100) {
                    event(ticket.early ? 'EARLY_RESUME_COMPLETED' : 'BUFFER_HIGH_WATERMARK');
                    paused = true; episode = true;
                }
                const delay = type === 'REANCHOR' ? 0 : core.getReplayCoverageAwareReadDelayMs(validation.effectiveDelayMs, pending, updated.currentTime);
                const at = time();
                if (at === null || !Number.isFinite(delay)) { terminal('REPLAY_CADENCE_INVALID'); return; }
                due = at + delay;
            } catch { if (phase !== 'TERMINAL' && ticket.valid) terminal('REPLAY_READ_FAILED'); }
            finally {
                if (timeout !== null) { try { timers.clearTimeout(timeout); } catch { terminal('TIMER_FAILED'); } }
                if (flight === ticket) flight = null;
                if (phase !== 'TERMINAL') synchronize();
                finishParserAudit(ticket);
                diagnostic?.flush();
            }
        }
        return {
            check,
            projectionCurrent: f => control.isOwnerPolicyContextCurrent(policyContext) &&
                associationCurrent(f) && capability('SEQUENTIAL_RESPONSE', f),
            admit(token) { event('LIFECYCLE_START'); authority = make('BOOTSTRAP', token); kind = 'BOOTSTRAP'; due = lastNow;
                if (!authority) terminal('REPLAY_AUTHORITY_INVALID'); },
            arm() { const at = time(); if (at !== null && phase !== 'TERMINAL') {
                try { readTimer = timers.setTimeout(read, Math.max(0, due - at)); } catch { terminal('TIMER_FAILED'); }
            } },
            read: executeReplay, sync, observe,
            current: f => validMedia(f) && !f.paused,
            stop() { control.invalidateOwnerPolicyContext(policyContext);
                cancelWake(); invalidate(authority); invalidate(seekAuthority); authority = null; seekAuthority = null;
                grant = null; registry = null;
                const removedOrigins = pendingOrigins;
                pendingOrigins = []; pending = []; recovery = null; foregroundActive = false;
                if (origins && removedOrigins?.length) origins.discard(removedOrigins, 'OWNER_TERMINAL');
                state = control.createReplayState('STOPPED'); },
            status: () => ({ replayPhase: state.phase, pending: pending.length, alignmentUsed, readAheadDeferred: deferred,
                earlyResumeBudgetUsed: budget, consumedAuthorities: consumedCount, temporalDropped: dropped, temporalBridged: bridged,
                suspendedReason: state.suspendedReason || 'NONE', recovery: recovery?.reason || 'NONE', lastReanchor,
                seekEpoch, foregroundActive, foregroundResult, temporalReplaced: replaced,
                coverageEpisodeSpent: coverageEpisode.spent })
        };
    }
}

module.exports = Object.freeze({ createLiveAcquisitionOwner });
})();
