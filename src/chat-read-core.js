(function (global) {
    const LIVEFLOW_MIN_READ_DELAY_MS = 1000;
    const LIVEFLOW_MAX_TIMER_DELAY_MS = 2147483647;
    const SUPPORTED_CONTINUATION_TYPES = [
        'nextContinuationData',
        'invalidationContinuationData',
        'timedContinuationData',
        'reloadContinuationData'
    ];
    const MAX_AUTHOR_NAME_LENGTH = 100;
    const MAX_AMOUNT_TEXT_LENGTH = 64;
    const MAX_IMAGE_ALT_LENGTH = 160;

    function normalizeDisplayText(value, maxLength) {
        return typeof value === 'string' ? value.slice(0, maxLength) : '';
    }

    class ChatMessage {
        constructor({ id, authorName, message, timestampUsec, authorPhoto, authorBadges, badges, messageType, authorRole, messageRuns, authorExternalChannelId, purchaseAmountText, sticker, colors }) {
            this.id = id || '';
            this.authorName = authorName || '';
            this.message = message || '';
            this.timestampUsec = timestampUsec || '';
            this.authorPhoto = authorPhoto || '';
            this.authorBadges = Array.isArray(authorBadges) ? authorBadges : Array.isArray(badges) ? badges : [];
            this.badges = this.authorBadges;
            this.messageType = messageType || 'text';
            this.authorRole = ['guest', 'member', 'moderator', 'owner'].includes(authorRole) ? authorRole : 'guest';
            this.messageRuns = Array.isArray(messageRuns) ? messageRuns : [];
            this.authorExternalChannelId = authorExternalChannelId || '';
            this.purchaseAmountText = purchaseAmountText || '';
            this.sticker = sticker && typeof sticker === 'object' ? sticker : null;
            this.colors = colors && typeof colors === 'object' ? colors : {};
        }

        static fromRenderer(renderer, messageType = 'text') {
            if (!renderer) {
                return new ChatMessage({});
            }

            const authorName = normalizeDisplayText(renderer.authorName?.simpleText ||
                renderer.authorName?.runs?.map((run) => run.text).join('') ||
                '', MAX_AUTHOR_NAME_LENGTH);

            const sourceRuns = Array.isArray(renderer.message?.runs)
                ? renderer.message.runs
                : [];
            const messageRuns = normalizeMessageRuns(sourceRuns);
            const messageText = messageRuns.map((run) => run.type === 'text' ? run.text : run.alt).join('');

            const firstThumbnail = normalizeThumbnailImage(renderer.authorPhoto);

            const badges = Array.isArray(renderer.authorBadges)
                ? renderer.authorBadges.map((badge) => badge?.liveChatAuthorBadgeRenderer?.tooltip || badge?.tooltip || 'badge')
                : [];

            return new ChatMessage({
                id: renderer.id || '',
                authorName,
                message: messageText,
                timestampUsec: renderer.timestampUsec || '',
                authorPhoto: firstThumbnail,
                authorBadges: badges,
                messageType,
                authorRole: 'guest',
                messageRuns,
                authorExternalChannelId: renderer.authorExternalChannelId || '',
                purchaseAmountText: normalizeDisplayText(renderer.purchaseAmountText?.simpleText, MAX_AMOUNT_TEXT_LENGTH),
                sticker: messageType === 'superSticker' ? normalizeSticker(renderer.sticker) : null,
                colors: normalizeObservedColors(renderer)
            });
        }
    }

    function normalizeReadImageUrl(value) {
        if (typeof value !== 'string' || !value) return '';
        try {
            const url = new URL(value);
            return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
        } catch {
            return '';
        }
    }

    function getAccessibilityLabel(value) {
        const label = value?.accessibilityData?.label;
        return normalizeDisplayText(label, MAX_IMAGE_ALT_LENGTH);
    }

    function normalizeThumbnailImage(value) {
        const thumbnails = Array.isArray(value?.thumbnails) ? value.thumbnails : [];
        for (const thumbnail of thumbnails) {
            const url = normalizeReadImageUrl(thumbnail?.url);
            if (url) return url;
        }
        return '';
    }

    function normalizeMessageRuns(runs) {
        if (!Array.isArray(runs)) return [];
        const normalized = [];
        for (const run of runs) {
            if (typeof run?.text === 'string' && run.text) {
                normalized.push({ type: 'text', text: run.text });
                continue;
            }
            if (!run?.emoji || typeof run.emoji !== 'object') continue;
            const url = normalizeThumbnailImage(run.emoji.image);
            if (!url) continue;
            const accessibilityAlt = getAccessibilityLabel(run.emoji.image?.accessibility);
            const shortcut = Array.isArray(run.emoji.shortcuts) && typeof run.emoji.shortcuts[0] === 'string'
                ? normalizeDisplayText(run.emoji.shortcuts[0], MAX_IMAGE_ALT_LENGTH)
                : '';
            normalized.push({ type: 'image', url, alt: accessibilityAlt || shortcut, isCustomEmoji: run.emoji.isCustomEmoji === true });
        }
        return normalized;
    }

    function normalizeSticker(sticker) {
        if (!sticker || typeof sticker !== 'object') return null;
        const url = normalizeThumbnailImage(sticker);
        if (!url) return null;
        return { url, alt: getAccessibilityLabel(sticker.accessibility) };
    }

    function normalizeObservedColors(renderer) {
        const keys = ['headerBackgroundColor', 'headerTextColor', 'bodyBackgroundColor', 'bodyTextColor', 'authorNameTextColor', 'moneyChipBackgroundColor', 'moneyChipTextColor', 'backgroundColor'];
        const colors = {};
        for (const key of keys) {
            if (typeof renderer?.[key] === 'number' && Number.isInteger(renderer[key])) colors[key] = renderer[key];
        }
        return colors;
    }

    function extractChatMessagesFromResponse(response) {
        const actions = response?.continuationContents?.liveChatContinuation?.actions || [];

        return actions.flatMap((action) => {
            const item = action?.addChatItemAction?.item;
            if (!item || typeof item !== 'object') return [];
            if (item.liveChatTextMessageRenderer) return [ChatMessage.fromRenderer(item.liveChatTextMessageRenderer, 'text')];
            if (item.liveChatPaidMessageRenderer) return [ChatMessage.fromRenderer(item.liveChatPaidMessageRenderer, 'superChat')];
            if (item.liveChatPaidStickerRenderer) return [ChatMessage.fromRenderer(item.liveChatPaidStickerRenderer, 'superSticker')];
            return [];
        });
    }

    function extractContinuationFromResponse(response) {
        return extractContinuationInfoFromResponse(response)?.continuation || null;
    }

    function extractContinuationInfoFromResponse(response) {
        const continuations = response?.continuationContents?.liveChatContinuation?.continuations || [];
        for (const type of SUPPORTED_CONTINUATION_TYPES) {
            for (const continuation of continuations) {
                const data = continuation?.[type];
                if (data?.continuation) {
                    const timeoutMs = typeof data.timeoutMs === 'number' && Number.isFinite(data.timeoutMs) && data.timeoutMs >= 0
                        ? data.timeoutMs
                        : null;
                    return { continuation: data.continuation, timeoutMs, type };
                }
            }
        }

        return null;
    }

    function getContinuationTypes(response) {
        const continuations = response?.continuationContents?.liveChatContinuation?.continuations || [];
        return SUPPORTED_CONTINUATION_TYPES.filter((type) => continuations.some((continuation) => Boolean(continuation?.[type])));
    }

    function extractInitialLiveChatContinuation(initialData) {
        const continuation = initialData
            ?.contents
            ?.twoColumnWatchNextResults
            ?.conversationBar
            ?.liveChatRenderer
            ?.continuations?.[0]
            ?.reloadContinuationData
            ?.continuation;

        return typeof continuation === 'string' && continuation ? continuation : '';
    }

    function classifyInitialChatMode(initialData) {
        const renderer = initialData
            ?.contents
            ?.twoColumnWatchNextResults
            ?.conversationBar
            ?.liveChatRenderer;
        if (!renderer || typeof renderer !== 'object') return 'unknown';
        if (renderer.isReplay === true) return 'replay';
        if (renderer.isReplay === false) return 'live';
        return 'unknown';
    }

    function classifySameTargetChatModeTransition(input = {}) {
        const previousMode = ['live', 'replay'].includes(input.previousMode) ? input.previousMode : 'unknown';
        const nextMode = ['live', 'replay'].includes(input.nextMode) ? input.nextMode : 'unknown';
        const previousTargetIdentity = typeof input.previousTargetIdentity === 'string' ? input.previousTargetIdentity : '';
        const nextTargetIdentity = typeof input.nextTargetIdentity === 'string' ? input.nextTargetIdentity : '';
        if (previousMode === 'live' && nextMode === 'replay' && previousTargetIdentity.length > 0 &&
            previousTargetIdentity === nextTargetIdentity) return 'LIVE_TO_REPLAY';
        return 'NONE';
    }

    function computeReplayAccountingLoss(input = {}) {
        const keys = ['bridged', 'enqueued', 'selected', 'stale', 'pending', 'displayed'];
        if (keys.some((key) => !Number.isInteger(input[key]) || input[key] < 0)) {
            return Object.freeze({ bridge: 0, scheduler: 0, display: 0, total: 0, valid: false });
        }
        const bridge = Math.max(0, input.bridged - input.enqueued);
        const scheduler = Math.max(0, input.enqueued - input.selected - input.stale - input.pending);
        const display = Math.max(0, input.selected - input.displayed);
        return Object.freeze({ bridge, scheduler, display, total: bridge + scheduler + display, valid: true });
    }

    const REPLAY_BLANK_CAUSES = Object.freeze([
        'SOURCE_SPARSE', 'ACQUISITION_GAP', 'BEFORE_START_FILTER', 'STALE_DROP', 'CAPACITY_DROP',
        'PENDING_NOT_PROMOTED', 'SCHEDULER_BLOCKED', 'SCHEDULER_DROP', 'RENDERER_NOT_DISPLAYED',
        'LIFECYCLE_DISCARD', 'UNACCOUNTED_LOSS', 'UNKNOWN'
    ]);

    function nonnegativeInteger(value) {
        return Number.isInteger(value) && value >= 0 ? value : null;
    }

    function conserveReplayBoundary(input, forwarded = 0, explicitRemoval = 0, retained = 0) {
        const values = [input, forwarded, explicitRemoval, retained].map(nonnegativeInteger);
        if (values.some((value) => value === null)) {
            return Object.freeze({ input: 0, forwarded: 0, explicitRemoval: 0, retained: 0, lost: 0, overflow: 0, valid: false });
        }
        const accounted = values[1] + values[2] + values[3];
        return Object.freeze({
            input: values[0], forwarded: values[1], explicitRemoval: values[2], retained: values[3],
            lost: Math.max(0, values[0] - accounted), overflow: Math.max(0, accounted - values[0]),
            valid: accounted === values[0]
        });
    }

    function computeReplayAccountingLedger(input = {}) {
        const count = (key) => nonnegativeInteger(input[key]) ?? 0;
        const parser = conserveReplayBoundary(count('receivedActions'), count('parsed'), count('parseFailed'), count('parserRetained'));
        const classification = conserveReplayBoundary(count('parsed'), count('displayable'),
            count('invalid') + count('unsupported'), count('classificationRetained'));
        const temporal = conserveReplayBoundary(count('displayable'), count('dueClassified') + count('futureClassified'),
            count('beforeStartFiltered') + count('temporalInvalid') + count('exactIdDeduped'), count('temporalRetained'));
        const dueBridge = conserveReplayBoundary(count('dueClassified'), count('dueBridged'),
            count('dueDropped'), count('dueRetained'));
        const future = conserveReplayBoundary(count('futureClassified'), count('futurePromoted'),
            count('capacityDropped'), count('futureQueued'));
        const bridge = conserveReplayBoundary(count('dueBridged'), count('enqueued'),
            count('bridgeDeduped') + count('bridgeFiltered') + count('lifecycleDiscarded') + count('generationDiscarded'),
            count('bridgeRetained'));
        const pending = conserveReplayBoundary(count('enqueued'), count('schedulerEligible'),
            count('pendingExplicitDrop'), count('pendingRetained'));
        const scheduler = conserveReplayBoundary(count('schedulerEligible'), count('selected'),
            count('staleDropped') + count('schedulerExplicitDrop'), count('schedulerRetained'));
        const launch = conserveReplayBoundary(count('selected'), count('launched'),
            count('launchRejected'), count('launchRetained'));
        const renderer = conserveReplayBoundary(count('launched'), count('displayed'),
            count('rendererDropped'), count('rendererRetained'));
        const stages = Object.freeze({ parser, classification, temporal, dueBridge, future, bridge, pending, scheduler, launch, renderer });
        const lostUnaccounted = Object.values(stages).reduce((sum, stage) => sum + stage.lost, 0);
        const overflowUnaccounted = Object.values(stages).reduce((sum, stage) => sum + stage.overflow, 0);
        return Object.freeze({ stages, lostUnaccounted, overflowUnaccounted,
            valid: Object.values(stages).every((stage) => stage.valid) });
    }

    function classifyReplayCount(value) {
        if (!Number.isInteger(value) || value < 0) return 'UNKNOWN';
        if (value === 0) return 'ZERO';
        if (value <= 2) return 'FEW';
        if (value <= 10) return 'SOME';
        return 'MANY';
    }

    function classifyReplayBlankCause(input = {}) {
        const count = (key) => nonnegativeInteger(input[key]) ?? 0;
        if (count('lostUnaccounted') > 0 || input.conservationValid === false) return 'UNACCOUNTED_LOSS';
        if (count('lifecycleDiscarded') + count('generationDiscarded') > 0) return 'LIFECYCLE_DISCARD';
        if (count('currentWindowDisplayed') > 0) return 'UNKNOWN';
        if (count('rendererDropped') + count('launchRejected') > 0 || count('selected') > count('launched')) return 'RENDERER_NOT_DISPLAYED';
        if (count('schedulerExplicitDrop') > 0) return 'SCHEDULER_DROP';
        if (count('staleDropped') > 0) return 'STALE_DROP';
        if (count('schedulerRetained') > 0 || count('schedulerBlocked') > 0) return 'SCHEDULER_BLOCKED';
        if (count('capacityDropped') > 0 && count('currentWindowDue') === 0) return 'CAPACITY_DROP';
        if (count('currentWindowDisplayable') > 0 && count('currentWindowDue') === 0 && count('futureQueued') > 0) return 'PENDING_NOT_PROMOTED';
        if (count('beforeStartFiltered') > 0 && count('currentWindowInput') > 0 && count('currentWindowDue') === 0) return 'BEFORE_START_FILTER';
        if (count('currentWindowInput') === 0 && input.sourceSparse === true) return 'SOURCE_SPARSE';
        if (count('currentWindowInput') === 0 && (input.acquisitionForward === true || input.coverageGap === true)) return 'ACQUISITION_GAP';
        return 'UNKNOWN';
    }

    function compareReplayPipelinePaths(normal = {}, seek = {}) {
        const keys = ['currentWindowInput', 'currentWindowDisplayable', 'currentWindowDue', 'currentWindowEnqueued',
            'currentWindowSelected', 'currentWindowDisplayed'];
        const firstDifference = keys.find((key) => (nonnegativeInteger(normal[key]) ?? 0) !== (nonnegativeInteger(seek[key]) ?? 0)) || 'NONE';
        return Object.freeze({ firstDifference, equal: firstDifference === 'NONE' });
    }

    const REPLAY_RUNTIME_EPISODE_STATES = Object.freeze(['IDLE', 'SUSPECTED', 'CONFIRMED', 'RECOVERED']);

    function classifyReplayActivity(value) {
        if (!Number.isInteger(value) || value < 0) return 'UNKNOWN';
        if (value <= 2) return 'LOW';
        if (value <= 10) return 'MEDIUM';
        if (value <= 30) return 'HIGH';
        return 'BURST';
    }

    function classifyReplayRatio(numerator, denominator) {
        if (!Number.isInteger(numerator) || numerator < 0 || !Number.isInteger(denominator) || denominator <= 0) return 'UNKNOWN';
        const ratio = numerator / denominator;
        if (ratio >= 0.9) return 'PRESERVED';
        if (ratio >= 0.5) return 'REDUCED';
        return 'SEVERELY_REDUCED';
    }

    function firstReplayMissingBoundary(snapshot = {}) {
        const stages = [
            ['INPUT', 'currentWindowInput'], ['DISPLAYABLE', 'currentWindowDisplayable'], ['DUE', 'currentWindowDue'],
            ['ENQUEUED', 'currentWindowEnqueued'], ['SELECTED', 'currentWindowSelected'], ['DISPLAYED', 'currentWindowDisplayed']
        ];
        for (let index = 1; index < stages.length; index += 1) {
            const prior = nonnegativeInteger(snapshot[stages[index - 1][1]]) ?? 0;
            const current = nonnegativeInteger(snapshot[stages[index][1]]) ?? 0;
            if (prior > 0 && current === 0) return stages[index][0];
        }
        return 'NONE';
    }

    function dominantReplayDropReason(snapshot = {}) {
        const reasons = {
            STALE: nonnegativeInteger(snapshot.staleDropped) ?? 0,
            CAPACITY: nonnegativeInteger(snapshot.capacityDropped) ?? 0,
            COLLISION: nonnegativeInteger(snapshot.collisionDropped) ?? 0,
            READABILITY: nonnegativeInteger(snapshot.readabilityDropped) ?? 0,
            DENSITY: nonnegativeInteger(snapshot.densityDropped) ?? 0,
            SUBTITLE: nonnegativeInteger(snapshot.subtitleDropped) ?? 0,
            HARD_SAFETY: nonnegativeInteger(snapshot.hardSafetyDropped) ?? 0,
            LIFECYCLE: nonnegativeInteger(snapshot.lifecycleDiscarded) ?? 0,
            UNACCOUNTED: nonnegativeInteger(snapshot.lostUnaccounted) ?? 0
        };
        const maximum = Math.max(...Object.values(reasons));
        if (maximum === 0) return 'NONE';
        return Object.keys(reasons).find((key) => reasons[key] === maximum) || 'OTHER';
    }

    function createReplayRuntimeObserver({ maximumEpisodes = 8, report } = {}) {
        const limit = Number.isInteger(maximumEpisodes) && maximumEpisodes > 0 ? Math.min(maximumEpisodes, 32) : 8;
        let state = 'IDLE';
        let consecutiveMissing = 0;
        let prior = null;
        let active = null;
        let accountingWarningActive = false;
        let densityWarningActive = false;
        let normalShape = null;
        let seekShape = null;
        const history = [];

        const number = (snapshot, key) => nonnegativeInteger(snapshot?.[key]) ?? 0;
        function delta(snapshot, key) { return Math.max(0, number(snapshot, key) - number(prior, key)); }
        function boundedShape(snapshot) {
            return Object.freeze({
                currentWindowInput: number(snapshot, 'currentWindowInput'),
                currentWindowDisplayable: number(snapshot, 'currentWindowDisplayable'),
                currentWindowDue: number(snapshot, 'currentWindowDue'),
                currentWindowEnqueued: number(snapshot, 'currentWindowEnqueued'),
                currentWindowSelected: number(snapshot, 'currentWindowSelected'),
                currentWindowDisplayed: number(snapshot, 'currentWindowDisplayed')
            });
        }
        function boundedPreEvidence(snapshot) {
            if (!snapshot) return Object.freeze({ observed: false });
            return Object.freeze({ observed: true,
                inputClass: classifyReplayCount(number(snapshot, 'currentWindowInput')),
                displayableClass: classifyReplayCount(number(snapshot, 'currentWindowDisplayable')),
                dueClass: classifyReplayCount(number(snapshot, 'currentWindowDue')),
                selectedClass: classifyReplayCount(number(snapshot, 'currentWindowSelected')),
                displayedClass: classifyReplayCount(number(snapshot, 'currentWindowDisplayed')),
                schedulerState: ['IDLE', 'ARMED', 'EVALUATING'].includes(snapshot.schedulerState) ? snapshot.schedulerState : 'UNKNOWN' });
        }
        function emit(type, episode) {
            if (typeof report !== 'function') return;
            try { report(Object.freeze({ type, episode })); } catch {}
        }
        function retain(episode) {
            history.push(Object.freeze(episode));
            if (history.length > limit) history.splice(0, history.length - limit);
        }
        function observe(snapshot = {}, trigger = 'UNKNOWN') {
            const current = boundedShape(snapshot);
            const displayableDelta = delta(snapshot, 'currentWindowDisplayable');
            const displayedDelta = delta(snapshot, 'currentWindowDisplayed');
            const acquisitionGapNow = snapshot.acquisitionForward === true && snapshot.coverageGap === true && displayedDelta === 0;
            const sourceSparseNow = snapshot.sourceSparse === true && displayedDelta === 0;
            const missingNow = (displayableDelta > 0 && displayedDelta === 0) || acquisitionGapNow || sourceSparseNow;
            const recoveryNow = displayedDelta > 0;
            const causeInput = { ...snapshot,
                currentWindowInput: delta(snapshot, 'currentWindowInput'),
                currentWindowDisplayable: displayableDelta,
                currentWindowDue: delta(snapshot, 'currentWindowDue'),
                currentWindowEnqueued: delta(snapshot, 'currentWindowEnqueued'),
                currentWindowSelected: delta(snapshot, 'currentWindowSelected'),
                currentWindowDisplayed: displayedDelta,
                lostUnaccounted: delta(snapshot, 'lostUnaccounted'),
                lifecycleDiscarded: delta(snapshot, 'lifecycleDiscarded'),
                generationDiscarded: delta(snapshot, 'generationDiscarded'),
                rendererDropped: delta(snapshot, 'rendererDropped'),
                launchRejected: delta(snapshot, 'launchRejected'),
                selected: Number.isInteger(snapshot.schedulerSelected)
                    ? delta(snapshot, 'schedulerSelected') : delta(snapshot, 'selected'),
                launched: delta(snapshot, 'launched'),
                schedulerExplicitDrop: delta(snapshot, 'schedulerExplicitDrop'),
                staleDropped: delta(snapshot, 'staleDropped'),
                schedulerBlocked: delta(snapshot, 'schedulerBlocked'),
                capacityDropped: delta(snapshot, 'capacityDropped'),
                beforeStartFiltered: delta(snapshot, 'beforeStartFiltered') };

            if (active) active = { ...active,
                seekIntervened: active.seekIntervened || snapshot.seekActive === true,
                adIntervened: active.adIntervened || snapshot.adActive === true,
                lifecycleIntervened: active.lifecycleIntervened || snapshot.lifecycleChanged === true };
            if (snapshot.lifecycleChanged === true) { normalShape = null; seekShape = null; }
            else if (snapshot.path === 'NORMAL') normalShape = current;
            else if (snapshot.path === 'SEEK') seekShape = current;

            if (missingNow) {
                consecutiveMissing += 1;
                if (state === 'IDLE' || state === 'RECOVERED') {
                    state = 'SUSPECTED';
                    active = { state, observations: consecutiveMissing, firstMissingBoundary: firstReplayMissingBoundary(causeInput),
                        blankCause: classifyReplayBlankCause(causeInput), confidence: 'SUPPORTED', startTrigger: trigger,
                        preEpisodeEvidence: boundedPreEvidence(prior),
                        seekIntervened: snapshot.seekActive === true, adIntervened: snapshot.adActive === true,
                        lifecycleIntervened: snapshot.lifecycleChanged === true };
                } else if (state === 'SUSPECTED' && consecutiveMissing >= 2) {
                    state = 'CONFIRMED';
                    active = { ...active, state, observations: consecutiveMissing,
                        blankCause: classifyReplayBlankCause(causeInput), confidence: 'CONFIRMED', accounting: current };
                    emit('BLANK_CONFIRMED', Object.freeze(active));
                } else if (active) active = { ...active, observations: consecutiveMissing };
            } else if (recoveryNow && (state === 'SUSPECTED' || state === 'CONFIRMED')) {
                const recovered = { ...active, state: 'RECOVERED', recoveryBoundary: 'DISPLAYED', recoveryTrigger: trigger,
                    displayedResumed: true, seekIntervened: active?.seekIntervened || snapshot.seekActive === true,
                    adIntervened: active?.adIntervened || snapshot.adActive === true,
                    lifecycleIntervened: active?.lifecycleIntervened || snapshot.lifecycleChanged === true };
                state = 'RECOVERED';
                active = recovered;
                retain(recovered);
                emit('BLANK_RECOVERED', recovered);
                consecutiveMissing = 0;
            } else if (!missingNow && state === 'SUSPECTED') {
                state = 'IDLE'; active = null; consecutiveMissing = 0;
            }

            const displayable = delta(snapshot, 'displayable');
            const selected = delta(snapshot, 'schedulerSelected');
            const launched = delta(snapshot, 'launched');
            const displayed = delta(snapshot, 'displayed');
            const dropReasons = Object.freeze({
                stale: delta(snapshot, 'staleDropped'), capacity: delta(snapshot, 'capacityDropped'),
                collision: delta(snapshot, 'collisionDropped'), readability: delta(snapshot, 'readabilityDropped'),
                density: delta(snapshot, 'densityDropped'), subtitle: delta(snapshot, 'subtitleDropped'),
                hardSafety: delta(snapshot, 'hardSafetyDropped'), lifecycle: delta(snapshot, 'lifecycleDiscarded')
            });
            const explicitDrop = Object.values(dropReasons).reduce((sum, value) => sum + value, 0);
            const densityDropShape = { staleDropped: dropReasons.stale, capacityDropped: dropReasons.capacity,
                collisionDropped: dropReasons.collision, readabilityDropped: dropReasons.readability,
                densityDropped: dropReasons.density, subtitleDropped: dropReasons.subtitle,
                hardSafetyDropped: dropReasons.hardSafety, lifecycleDiscarded: dropReasons.lifecycle,
                lostUnaccounted: delta(snapshot, 'lostUnaccounted') };
            const density = Object.freeze({
                inputActivity: classifyReplayActivity(displayable), displayable, selected, launched, displayed,
                explicitDrop, retained: number(snapshot, 'futureQueued') + number(snapshot, 'schedulerRetained'),
                lost: densityDropShape.lostUnaccounted, dropReasons,
                dominantDropReason: dominantReplayDropReason(densityDropShape),
                displayableToSelectedClass: classifyReplayRatio(selected, displayable),
                displayableToDisplayedClass: classifyReplayRatio(displayed, displayable),
                launchedToDisplayedClass: classifyReplayRatio(displayed, launched),
                densityFidelityClass: classifyReplayRatio(displayed, displayable)
            });
            if (density.lost > 0 && !accountingWarningActive) emit('ACCOUNTING_WARNING', density);
            accountingWarningActive = density.lost > 0;
            const densityWarning = ['HIGH', 'BURST'].includes(density.inputActivity) &&
                ['REDUCED', 'SEVERELY_REDUCED'].includes(density.densityFidelityClass);
            if (densityWarning && !densityWarningActive) emit('DENSITY_WARNING', density);
            densityWarningActive = densityWarning;
            prior = Object.freeze({ ...snapshot });
            return Object.freeze({ state, activeEpisode: active ? Object.freeze({ ...active }) : null, density,
                differential: normalShape && seekShape ? compareReplayPipelinePaths(normalShape, seekShape) : null });
        }
        return Object.freeze({
            observe,
            status: () => Object.freeze({ state, activeEpisode: active ? Object.freeze({ ...active }) : null,
                recentEpisodeCount: history.length,
                differential: normalShape && seekShape ? compareReplayPipelinePaths(normalShape, seekShape) : null }),
            recentEpisodes: () => Object.freeze(history.slice()),
            printSummary: () => Object.freeze({ state, activeEpisode: active ? Object.freeze({ ...active }) : null,
                recentEpisodes: Object.freeze(history.slice()), differential: normalShape && seekShape ? compareReplayPipelinePaths(normalShape, seekShape) : null })
        });
    }

    function normalizeInternalApiContext(source) {
        if (!source || typeof source !== 'object') {
            return null;
        }

        const sourceClient = source.client && typeof source.client === 'object'
            ? source.client
            : source;
        const clientKeys = [
            'clientName',
            'clientVersion',
            'hl',
            'gl',
            'visitorData',
            'userInterfaceTheme',
            'timeZone',
            'utcOffsetMinutes',
            'platform',
            'clientFormFactor',
            'browserName',
            'browserVersion',
            'osName',
            'osVersion',
            'screenDensityFloat',
            'screenHeightPoints',
            'screenPixelDensity',
            'screenWidthPoints'
        ];
        const client = {};

        for (const key of clientKeys) {
            const value = sourceClient[key];
            if (value !== undefined && value !== null && value !== '') {
                client[key] = value;
            }
        }

        return Object.keys(client).length > 0 ? { client } : null;
    }

    function buildLiveChatReadRequest(context, continuation) {
        if (!context || typeof context !== 'object' || !continuation) {
            return null;
        }

        return {
            context,
            continuation
        };
    }

    function summarizeLiveChatResponse(response) {
        const liveChatContinuation = response?.continuationContents?.liveChatContinuation;
        const actions = liveChatContinuation?.actions;
        const continuations = liveChatContinuation?.continuations;

        return {
            liveChatContinuation: Boolean(liveChatContinuation),
            actions: Array.isArray(actions),
            actionCount: Array.isArray(actions) ? actions.length : 0,
            continuations: Array.isArray(continuations),
            nextContinuationAvailable: Array.isArray(continuations) && Boolean(extractContinuationFromResponse(response)),
            continuationTypes: getContinuationTypes(response)
        };
    }

    function canAttemptOneShotRead(pageRevision, attemptedRevision) {
        return Number.isInteger(pageRevision) && pageRevision !== attemptedRevision;
    }

    function getPageRevisionState(currentKey, currentRevision, nextKey) {
        if (currentKey === nextKey) {
            return { key: currentKey, revision: currentRevision, changed: false };
        }

        return { key: nextKey, revision: currentRevision + 1, changed: true };
    }

    function canIssueSecondRead({ firstOk, responseParsed, hasNextContinuation, responseRevision, currentRevision, readCount }) {
        return firstOk === true &&
            responseParsed === true &&
            hasNextContinuation === true &&
            responseRevision === currentRevision &&
            readCount < 2;
    }

    function getReadDelayMs(timeoutMs) {
        if (typeof timeoutMs !== 'number' ||
            !Number.isFinite(timeoutMs) ||
            timeoutMs < 0 ||
            timeoutMs > LIVEFLOW_MAX_TIMER_DELAY_MS) {
            return null;
        }

        return Math.max(timeoutMs, LIVEFLOW_MIN_READ_DELAY_MS);
    }

    function validateLiveChatReadResponse(response) {
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
            return { ok: false, errorType: 'unexpected_response_shape' };
        }
        const liveChatContinuation = response.continuationContents?.liveChatContinuation;
        if (!liveChatContinuation || typeof liveChatContinuation !== 'object' || Array.isArray(liveChatContinuation)) {
            return { ok: false, errorType: 'missing_live_chat_continuation' };
        }
        if (!Array.isArray(liveChatContinuation.continuations)) {
            return { ok: false, errorType: 'missing_continuation' };
        }
        const continuationInfo = extractContinuationInfoFromResponse(response);
        if (!continuationInfo) {
            const hasUnknownType = liveChatContinuation.continuations.some((entry) =>
                entry && typeof entry === 'object' && Object.keys(entry).some((key) => !SUPPORTED_CONTINUATION_TYPES.includes(key))
            );
            return { ok: false, errorType: hasUnknownType ? 'unknown_continuation_type' : 'missing_continuation' };
        }
        if (typeof continuationInfo.continuation !== 'string' || !continuationInfo.continuation) {
            return { ok: false, errorType: 'missing_continuation' };
        }
        const effectiveDelayMs = getReadDelayMs(continuationInfo.timeoutMs);
        if (effectiveDelayMs === null) {
            return { ok: false, errorType: 'invalid_timeout' };
        }
        return { ok: true, continuationInfo, effectiveDelayMs };
    }

    function isSuccessfulHttpStatus(status) {
        return Number.isInteger(status) && status >= 200 && status < 300;
    }

    function canStartReadLoop({ activeLoopGeneration, requestInFlight, hasContinuation, hasContext, hidden }) {
        return activeLoopGeneration === 0 &&
            requestInFlight === false &&
            hasContinuation === true &&
            hasContext === true &&
            hidden === false;
    }

    function canScheduleNextRead({ generation, currentGeneration, revision, currentRevision, aborted, validationOk }) {
        return generation === currentGeneration &&
            revision === currentRevision &&
            aborted === false &&
            validationOk === true;
    }

    function extractWatchTargetIdentity(urlValue) {
        try {
            const url = new URL(urlValue, 'https://www.youtube.com');
            if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return '';
            if (url.pathname === '/watch') return url.searchParams.get('v') || '';
            const liveMatch = url.pathname.match(/^\/live\/([^/?#]+)/);
            return liveMatch?.[1] || '';
        } catch (error) {
            return '';
        }
    }

    function evaluateBootstrapTarget(targetIdentity, authoritativeIdentity, supportingIdentities = []) {
        const targetKnown = typeof targetIdentity === 'string' && targetIdentity.length > 0;
        const authoritativeKnown = typeof authoritativeIdentity === 'string' && authoritativeIdentity.length > 0;
        const supporting = Array.isArray(supportingIdentities)
            ? supportingIdentities.filter((value) => typeof value === 'string' && value.length > 0)
            : [];
        return {
            available: targetKnown && authoritativeKnown,
            matched: targetKnown && authoritativeKnown && authoritativeIdentity === targetIdentity,
            supportingCandidateCount: supporting.length,
            supportingMatchCount: targetKnown
                ? supporting.filter((candidate) => candidate === targetIdentity).length
                : 0
        };
    }

    function canEstablishPageLifecycle({ navigationPending, pageDataUpdated, navigationTargetMatched, pageTargetChanged, bootstrapTargetMatched, pageStateUsable }) {
        if (navigationPending === true && pageDataUpdated !== true) return { ok: false, reason: 'NAVIGATION_PENDING' };
        if (navigationPending === true && navigationTargetMatched !== true) return { ok: false, reason: 'NAVIGATION_TARGET_MISMATCH' };
        if (navigationPending === true && pageTargetChanged !== true) return { ok: false, reason: 'TARGET_UNCHANGED' };
        if (bootstrapTargetMatched !== true) return { ok: false, reason: 'BOOTSTRAP_TARGET_MISMATCH' };
        if (pageStateUsable !== true) return { ok: false, reason: 'PAGE_STATE_STALE' };
        return { ok: true, reason: 'NONE' };
    }

    function canReevaluatePageLifecycle({ navigationPending, pageDataUpdatedSeen, pageDataUpdated, navigationFinished, ownershipMutation }) {
        if (navigationPending !== true) return true;
        if (pageDataUpdated === true) return true;
        if (navigationFinished === true && pageDataUpdatedSeen === true) return true;
        return ownershipMutation === true && pageDataUpdatedSeen === true;
    }

    function canSignalOwnershipReevaluation({ navigationPending, pageEstablished, pageDataUpdatedSeen } = {}) {
        if (navigationPending === true) return pageDataUpdatedSeen === true;
        return pageEstablished !== true;
    }

    function parseReplayOffsetMsec(value) {
        if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number >= 0 ? number : null;
    }

    function extractReplayChatMessagesFromResponse(response) {
        const actions = response?.continuationContents?.liveChatContinuation?.actions;
        if (!Array.isArray(actions)) return [];
        return actions.flatMap((entry) => {
            const replay = entry?.replayChatItemAction;
            const offsetMsec = parseReplayOffsetMsec(replay?.videoOffsetTimeMsec);
            if (offsetMsec === null || !Array.isArray(replay.actions)) return [];
            const nested = { continuationContents: { liveChatContinuation: { actions: replay.actions } } };
            return extractChatMessagesFromResponse(nested).map((message) => ({ ...message, replayOffsetMsec: offsetMsec }));
        });
    }

    function extractReplayContinuationInfo(response) {
        const continuations = response?.continuationContents?.liveChatContinuation?.continuations;
        if (!Array.isArray(continuations)) return null;
        for (const entry of continuations) {
            const data = entry?.liveChatReplayContinuationData;
            if (!data || typeof data.continuation !== 'string' || !data.continuation) continue;
            if (typeof data.timeUntilLastMessageMsec !== 'number' || !Number.isFinite(data.timeUntilLastMessageMsec) ||
                data.timeUntilLastMessageMsec < 0 || data.timeUntilLastMessageMsec > LIVEFLOW_MAX_TIMER_DELAY_MS) return null;
            return { continuation: data.continuation, timeoutMs: data.timeUntilLastMessageMsec, type: 'liveChatReplayContinuationData' };
        }
        return null;
    }

    function selectReplaySequentialContinuationInfo(response, requestContinuation, consumedContinuations) {
        const continuations = response?.continuationContents?.liveChatContinuation?.continuations;
        if (!Array.isArray(continuations)) return { info: null, state: 'INVALID' };
        const candidates = [];
        const identities = new Set();
        for (const entry of continuations) {
            const data = entry?.liveChatReplayContinuationData;
            if (!data) continue;
            if (typeof data.continuation !== 'string' || !data.continuation ||
                typeof data.timeUntilLastMessageMsec !== 'number' || !Number.isFinite(data.timeUntilLastMessageMsec) ||
                data.timeUntilLastMessageMsec < 0 || data.timeUntilLastMessageMsec > LIVEFLOW_MAX_TIMER_DELAY_MS) {
                return { info: null, state: 'INVALID' };
            }
            if (identities.has(data.continuation)) continue;
            identities.add(data.continuation);
            candidates.push({ continuation: data.continuation, timeoutMs: data.timeUntilLastMessageMsec, type: 'liveChatReplayContinuationData' });
        }
        if (candidates.length === 0) return { info: null, state: 'INVALID' };
        const consumed = consumedContinuations && typeof consumedContinuations.has === 'function'
            ? consumedContinuations : new Set();
        const unused = candidates.filter((candidate) => !consumed.has(candidate.continuation));
        if (unused.length === 1) {
            return { info: unused[0], state: candidates.length === 1 ? 'SINGLE_UNUSED' : 'SELECTED_UNUSED_AMONG_CONSUMED' };
        }
        if (unused.length > 1) return { info: null, state: 'AMBIGUOUS_UNUSED' };
        const repeated = candidates.find((candidate) => candidate.continuation === requestContinuation);
        return { info: repeated || candidates[0], state: repeated ? 'ONLY_REPEATED' : 'ONLY_CONSUMED' };
    }

    function classifyPlayerSeekContinuationPresence(response) {
        try {
            const liveChat = response?.continuationContents?.liveChatContinuation;
            if (!liveChat || typeof liveChat !== 'object' || !Array.isArray(liveChat.continuations)) return 'INVALID_RESPONSE';
            return liveChat.continuations.some((entry) =>
                typeof entry?.playerSeekContinuationData?.continuation === 'string' &&
                entry.playerSeekContinuationData.continuation.length > 0
            ) ? 'PRESENT' : 'ABSENT';
        } catch {
            return 'UNKNOWN';
        }
    }

    function extractPlayerSeekContinuation(response) {
        const continuations = response?.continuationContents?.liveChatContinuation?.continuations;
        if (!Array.isArray(continuations)) return '';
        for (const entry of continuations) {
            const continuation = entry?.playerSeekContinuationData?.continuation;
            if (typeof continuation === 'string' && continuation.length > 0) return continuation;
        }
        return '';
    }

    function validatePlayerSeekOffset(currentTimeSeconds, durationSeconds) {
        if (!Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 0) return null;
        if (Number.isFinite(durationSeconds) && (durationSeconds < 0 || currentTimeSeconds > durationSeconds)) return null;
        const offsetMsec = Math.floor(currentTimeSeconds * 1000);
        return Number.isSafeInteger(offsetMsec) && offsetMsec >= 0 ? offsetMsec : null;
    }

    function getPlayerSeekDiagnosticNotSentReason({ armed, ready, consumed, inFlight, productionRequestInFlight, diagnosticLocked,
        mode, runtimeEnabled, hidden, navigationPending, armedLifecycleGeneration, currentLifecycleGeneration,
        armedRevision, currentRevision, targetMatches, targetCurrent, videoPresent, seeking, offsetValid } = {}) {
        if (consumed === true) return 'AUTHORITY_CONSUMED';
        if (inFlight === true || diagnosticLocked === true) return 'DIAGNOSTIC_IN_FLIGHT';
        if (armed !== true) return 'NOT_ARMED';
        if (ready !== true) return 'NOT_READY';
        if (armedLifecycleGeneration !== currentLifecycleGeneration || armedRevision !== currentRevision || navigationPending === true) return 'STALE_LIFECYCLE';
        if (targetMatches !== true || targetCurrent !== true) return 'STALE_TARGET';
        if (mode !== 'replay') return 'NOT_REPLAY';
        if (runtimeEnabled !== true || hidden === true) return 'RUNTIME_UNAVAILABLE';
        if (productionRequestInFlight === true) return 'PRODUCTION_IN_FLIGHT';
        if (videoPresent !== true) return 'NO_CURRENT_VIDEO';
        if (seeking === true) return 'SEEKING';
        if (offsetValid !== true) return 'INVALID_OFFSET';
        return 'NONE';
    }

    function canRunPlayerSeekDiagnostic(state = {}) {
        return getPlayerSeekDiagnosticNotSentReason(state) === 'NONE';
    }

    function summarizePlayerSeekDiagnosticResponse(response, targetOffsetMsec, toleranceMsec = 2000) {
        const liveChat = response?.continuationContents?.liveChatContinuation;
        const actions = liveChat?.actions;
        const continuations = liveChat?.continuations;
        if (!Array.isArray(actions) || !Array.isArray(continuations)) {
            return { replayShapeObserved: false, responseOffsetRelation: 'UNKNOWN', continuationShapeObserved: false };
        }
        let minimumOffset = null;
        let maximumOffset = null;
        for (const action of actions) {
            const parsed = parseReplayOffsetMsec(action?.replayChatItemAction?.videoOffsetTimeMsec);
            if (parsed !== null) {
                minimumOffset = minimumOffset === null ? parsed : Math.min(minimumOffset, parsed);
                maximumOffset = maximumOffset === null ? parsed : Math.max(maximumOffset, parsed);
            }
        }
        const continuationShapeObserved = continuations.some((entry) =>
            typeof entry?.liveChatReplayContinuationData?.continuation === 'string' &&
            entry.liveChatReplayContinuationData.continuation.length > 0
        );
        let responseOffsetRelation = 'UNKNOWN';
        if (Number.isSafeInteger(targetOffsetMsec) && targetOffsetMsec >= 0 && Number.isFinite(toleranceMsec) && toleranceMsec >= 0) {
            if (minimumOffset === null || maximumOffset === null) responseOffsetRelation = 'NO_TIMESTAMPED_ACTIONS';
            else {
                const lowerBound = targetOffsetMsec - toleranceMsec;
                responseOffsetRelation = maximumOffset < lowerBound
                    ? 'ALL_BEFORE_TARGET'
                    : minimumOffset < lowerBound
                        ? 'CROSSES_TARGET'
                        : 'ALL_NEAR_OR_AFTER_TARGET';
            }
        }
        return { replayShapeObserved: true, responseOffsetRelation, continuationShapeObserved };
    }

    function classifyReplayReanchorCoverage(response, targetOffsetMsec, nearAfterMsec = 10000, toleranceMsec = 2000) {
        if (!Number.isSafeInteger(targetOffsetMsec) || targetOffsetMsec < 0 || !Number.isFinite(nearAfterMsec) || nearAfterMsec < 0 ||
            !Number.isFinite(toleranceMsec) || toleranceMsec < 0) return 'UNKNOWN';
        const actions = response?.continuationContents?.liveChatContinuation?.actions;
        if (!Array.isArray(actions)) return 'UNKNOWN';
        const offsets = actions.map((action) => parseReplayOffsetMsec(action?.replayChatItemAction?.videoOffsetTimeMsec))
            .filter((value) => value !== null);
        if (offsets.length === 0) return 'NO_TIMESTAMPED_ACTIONS';
        const minimum = Math.min(...offsets);
        const maximum = Math.max(...offsets);
        const lowerBound = targetOffsetMsec - toleranceMsec;
        if (maximum < lowerBound) return 'UNKNOWN';
        if (minimum < lowerBound) return 'CROSSES_TARGET';
        return minimum <= targetOffsetMsec + nearAfterMsec ? 'NEAR_AFTER_TARGET' : 'FAR_AFTER_TARGET';
    }

    function classifyDiagnosticGapMsec(gapMsec) {
        if (!Number.isFinite(gapMsec) || gapMsec < 0) return 'UNKNOWN';
        if (gapMsec <= 2000) return 'IMMEDIATE';
        if (gapMsec <= 10000) return 'SHORT_GAP';
        if (gapMsec <= 30000) return 'MEDIUM_GAP';
        if (gapMsec <= 120000) return 'LONG_GAP';
        return 'VERY_LONG_GAP';
    }

    function summarizeReplayTargetHole(response, targetOffsetMsec) {
        if (!Number.isSafeInteger(targetOffsetMsec) || targetOffsetMsec < 0) {
            return { nearestBeforeTargetClass: 'UNKNOWN', nearestAfterTargetClass: 'UNKNOWN', targetBracketGapClass: 'UNKNOWN', currentWindowState: 'UNKNOWN' };
        }
        const actions = response?.continuationContents?.liveChatContinuation?.actions;
        if (!Array.isArray(actions)) {
            return { nearestBeforeTargetClass: 'UNKNOWN', nearestAfterTargetClass: 'UNKNOWN', targetBracketGapClass: 'UNKNOWN', currentWindowState: 'UNKNOWN' };
        }
        const offsets = actions.map((action) => parseReplayOffsetMsec(action?.replayChatItemAction?.videoOffsetTimeMsec))
            .filter((value) => value !== null);
        const before = offsets.filter((value) => value < targetOffsetMsec);
        const after = offsets.filter((value) => value >= targetOffsetMsec);
        const nearestBefore = before.length ? Math.max(...before) : null;
        const nearestAfter = after.length ? Math.min(...after) : null;
        const nearestBeforeTargetClass = nearestBefore === null ? 'NONE' : classifyDiagnosticGapMsec(targetOffsetMsec - nearestBefore);
        const nearestAfterTargetClass = nearestAfter === null ? 'NONE' : classifyDiagnosticGapMsec(nearestAfter - targetOffsetMsec);
        let targetBracketGapClass = 'NONE';
        if (nearestBefore !== null && nearestAfter !== null) {
            const bracketGap = nearestAfter - nearestBefore;
            targetBracketGapClass = bracketGap <= 4000 ? 'TIGHT' : bracketGap <= 20000 ? 'SMALL' :
                bracketGap <= 60000 ? 'MEDIUM' : bracketGap <= 240000 ? 'LARGE' : 'VERY_LARGE';
        }
        const near = new Set(['IMMEDIATE', 'SHORT_GAP']);
        let currentWindowState = 'UNKNOWN';
        if (nearestBefore !== null && nearestAfter !== null) {
            if (near.has(nearestBeforeTargetClass) || near.has(nearestAfterTargetClass)) currentWindowState = 'CONFIRMED_NEAR';
            else if (targetBracketGapClass === 'TIGHT' || targetBracketGapClass === 'SMALL') currentWindowState = 'CROSSES_WITH_SMALL_GAP';
            else currentWindowState = 'CROSSES_WITH_LARGE_GAP';
        } else if (nearestAfter !== null) {
            currentWindowState = near.has(nearestAfterTargetClass) ? 'AFTER_NEAR' : 'AFTER_FAR';
        }
        return { nearestBeforeTargetClass, nearestAfterTargetClass, targetBracketGapClass, currentWindowState };
    }

    function summarizeReplayDisplayableTargetHole(messages, targetOffsetMsec) {
        if (!Array.isArray(messages) || !Number.isSafeInteger(targetOffsetMsec) || targetOffsetMsec < 0) {
            return { nearestBeforeTargetClass: 'UNKNOWN', nearestAfterTargetClass: 'UNKNOWN', targetBracketGapClass: 'UNKNOWN', currentWindowState: 'UNKNOWN' };
        }
        const offsets = messages.map((message) => Number.isFinite(message?.replayOffsetMsec) ? String(message.replayOffsetMsec) : null)
            .filter((value) => value !== null);
        if (offsets.length === 0) {
            return { nearestBeforeTargetClass: 'NONE', nearestAfterTargetClass: 'NONE', targetBracketGapClass: 'NONE', currentWindowState: 'NONE' };
        }
        const response = { continuationContents: { liveChatContinuation: { actions: offsets.map((videoOffsetTimeMsec) => ({ replayChatItemAction: { videoOffsetTimeMsec } })) } } };
        return summarizeReplayTargetHole(response, targetOffsetMsec);
    }

    function summarizeReplayDisplayableAccounting(messages, targetOffsetMsec, toleranceMsec = 250) {
        if (!Array.isArray(messages) || !Number.isSafeInteger(targetOffsetMsec) || targetOffsetMsec < 0 ||
            !Number.isFinite(toleranceMsec) || toleranceMsec < 0) return null;
        let before = 0;
        let due = 0;
        let future = 0;
        for (const message of messages) {
            const offset = message?.replayOffsetMsec;
            if (!Number.isFinite(offset)) continue;
            if (offset < targetOffsetMsec - toleranceMsec) before += 1;
            else if (offset <= targetOffsetMsec + toleranceMsec) due += 1;
            else future += 1;
        }
        return { count: before + due + future, before, due, future };
    }

    function classifyReplayInitialStartupCoverage(messages, targetOffsetMsec) {
        if (!Array.isArray(messages) || !Number.isSafeInteger(targetOffsetMsec) || targetOffsetMsec < 0) return 'UNKNOWN';
        if (targetOffsetMsec === 0) return 'ALIGNED';
        const offsets = messages.map((message) => message?.replayOffsetMsec).filter(Number.isFinite);
        if (offsets.length === 0) return 'UNKNOWN';
        const earliest = Math.min(...offsets);
        const latest = Math.max(...offsets);
        return earliest <= targetOffsetMsec && targetOffsetMsec <= latest ? 'ALIGNED' : 'OUTSIDE';
    }

    function countReplayTimestampedActions(response) {
        const actions = response?.continuationContents?.liveChatContinuation?.actions;
        if (!Array.isArray(actions)) return 0;
        return actions.reduce((count, action) => count + (parseReplayOffsetMsec(action?.replayChatItemAction?.videoOffsetTimeMsec) === null ? 0 : 1), 0);
    }

    function classifySequentialContinuationProgress(requestContinuation, nextContinuation, seenContinuations) {
        if (typeof nextContinuation !== 'string' || !nextContinuation) return 'MISSING';
        if (typeof requestContinuation !== 'string' || !requestContinuation || !seenContinuations || typeof seenContinuations.has !== 'function') return 'UNKNOWN';
        if (nextContinuation === requestContinuation) return 'REPEATED';
        if (seenContinuations.has(nextContinuation)) return 'RETURNED_TO_SEEN';
        return 'ADVANCED';
    }

    function classifyReplayTemporalProgress(previousMessages, currentMessages) {
        const range = (messages) => {
            const offsets = (messages || []).map((message) => message?.replayOffsetMsec).filter(Number.isFinite);
            return offsets.length ? { minimum: Math.min(...offsets), maximum: Math.max(...offsets) } : null;
        };
        const previous = range(previousMessages);
        const current = range(currentMessages);
        if (!previous || !current) return { direction: 'UNKNOWN', coverage: 'UNKNOWN' };
        const direction = current.maximum > previous.maximum ? 'FORWARD' : current.maximum < previous.maximum ? 'BACKWARD' : 'STALLED';
        const coverage = current.minimum > previous.maximum ? 'NEWER_THAN_PRIOR' : current.maximum < previous.minimum ? 'OLDER_THAN_PRIOR' :
            current.minimum === previous.minimum && current.maximum === previous.maximum ? 'SAME_WINDOW' : 'OVERLAPS_PRIOR';
        return { direction, coverage };
    }

    function classifyReplayMessageRelation(offsetMsec, currentTimeSeconds, toleranceMsec = 250, nearFutureMsec = 10000) {
        if (!Number.isFinite(offsetMsec) || !Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 0 ||
            !Number.isFinite(toleranceMsec) || toleranceMsec < 0 || !Number.isFinite(nearFutureMsec) || nearFutureMsec < toleranceMsec) return 'UNKNOWN';
        const nowMsec = currentTimeSeconds * 1000;
        if (offsetMsec < nowMsec - toleranceMsec) return 'BEFORE_CURRENT';
        if (offsetMsec <= nowMsec + toleranceMsec) return 'CURRENT_WINDOW';
        if (offsetMsec <= nowMsec + nearFutureMsec) return 'NEAR_FUTURE';
        return 'FAR_FUTURE';
    }

    function summarizeReplayResponseTemporalShape(messages, currentTimeSeconds, previousMessages = null) {
        if (!Array.isArray(messages) || !Number.isFinite(currentTimeSeconds)) return Object.freeze({
            responseFirstMessageRelation: 'UNKNOWN', responseLastMessageRelation: 'UNKNOWN',
            responseCoverageProgress: 'UNKNOWN', acquisitionLeadClass: 'UNKNOWN'
        });
        const offsets = messages.map((message) => message?.replayOffsetMsec).filter(Number.isFinite);
        if (offsets.length === 0) return Object.freeze({
            responseFirstMessageRelation: 'EMPTY', responseLastMessageRelation: 'EMPTY',
            responseCoverageProgress: 'UNKNOWN', acquisitionLeadClass: 'NONE'
        });
        const minimum = Math.min(...offsets);
        const maximum = Math.max(...offsets);
        const previousOffsets = Array.isArray(previousMessages)
            ? previousMessages.map((message) => message?.replayOffsetMsec).filter(Number.isFinite) : [];
        let responseCoverageProgress = 'UNKNOWN';
        if (previousOffsets.length > 0) {
            const previousMinimum = Math.min(...previousOffsets);
            const previousMaximum = Math.max(...previousOffsets);
            responseCoverageProgress = minimum > previousMaximum ? 'NEWER' : maximum < previousMinimum ? 'OLDER' :
                minimum === previousMinimum && maximum === previousMaximum ? 'SAME' :
                    minimum < previousMinimum && maximum > previousMaximum ? 'MIXED' : 'OVERLAP';
        }
        const nowMsec = currentTimeSeconds * 1000;
        return Object.freeze({
            responseFirstMessageRelation: classifyReplayMessageRelation(offsets[0], currentTimeSeconds),
            responseLastMessageRelation: classifyReplayMessageRelation(offsets[offsets.length - 1], currentTimeSeconds),
            responseCoverageProgress,
            acquisitionLeadClass: maximum <= nowMsec ? 'NONE' : classifyDiagnosticGapMsec(maximum - nowMsec)
        });
    }

    function createReplayGapEvidenceState() {
        return Object.freeze({
            observationPasses: 0,
            filteredBeforeStart: false,
            bridgedDue: false,
            capacityDropped: false,
            exactIdDeduped: false,
            retained: false,
            unknownDisposition: false
        });
    }

    function createReplayGapPersistenceState() {
        return Object.freeze({ acquisitionLeadConsecutive: 0, farFutureResponseConsecutive: 0 });
    }

    function updateReplayGapPersistenceState(state, responseShape) {
        if (!state || typeof state !== 'object' || !responseShape || typeof responseShape !== 'object')
            return createReplayGapPersistenceState();
        const leadFar = ['LONG_GAP', 'VERY_LONG_GAP'].includes(responseShape.acquisitionLeadClass);
        const responseFar = responseShape.responseFirstMessageRelation === 'FAR_FUTURE' &&
            responseShape.responseLastMessageRelation === 'FAR_FUTURE';
        return Object.freeze({
            acquisitionLeadConsecutive: leadFar
                ? Math.min(255, Number.isInteger(state.acquisitionLeadConsecutive) ? state.acquisitionLeadConsecutive + 1 : 1) : 0,
            farFutureResponseConsecutive: responseFar
                ? Math.min(255, Number.isInteger(state.farFutureResponseConsecutive) ? state.farFutureResponseConsecutive + 1 : 1) : 0
        });
    }

    function evaluateReplayTemporalLeadShadow(holdActive, input = {}) {
        const booleans = ['normalSequentialContext', 'lifecycleCurrent', 'targetCurrent', 'videoCurrent', 'visible',
            'adActive', 'seekActive', 'navigationPending', 'reanchorActive', 'temporalFactsKnown',
            'retainedFutureAvailable', 'acquisitionLeadPersistent', 'responseFarFuturePersistent'];
        const factsKnown = booleans.every((key) => typeof input[key] === 'boolean') &&
            Number.isInteger(input.pendingCount) && input.pendingCount >= 0 &&
            typeof input.acquisitionLeadClass === 'string' && typeof input.retainedNearestDistanceClass === 'string';
        const base = {
            shadowHoldWouldEnter: false, shadowHoldActive: holdActive === true, shadowHoldWouldResume: false,
            shadowDecision: 'NO_CHANGE', shadowBlockedReason: 'NONE', shadowEntryReason: 'NONE', shadowResumeReason: 'NONE'
        };
        if (!factsKnown || input.temporalFactsKnown !== true) {
            return Object.freeze({ ...base, shadowHoldActive: false, shadowHoldWouldResume: holdActive === true,
                shadowDecision: holdActive === true ? 'WOULD_RELEASE_UNKNOWN' : 'NO_HOLD', shadowBlockedReason: 'UNKNOWN',
                shadowResumeReason: holdActive === true ? 'UNKNOWN' : 'NONE' });
        }
        const environmentCurrent = input.normalSequentialContext && input.lifecycleCurrent && input.targetCurrent && input.videoCurrent &&
            input.visible && !input.adActive && !input.seekActive && !input.navigationPending && !input.reanchorActive;
        if (holdActive === true) {
            const resumeReason = !environmentCurrent ? 'ENVIRONMENT_CHANGED' : !input.retainedFutureAvailable ? 'FUTURE_NONE' :
                input.pendingCount <= 50 ? 'LOW_WATERMARK' :
                    ['IMMEDIATE', 'SHORT_GAP'].includes(input.retainedNearestDistanceClass) ? 'NEAR_COVERAGE' :
                        (!input.acquisitionLeadPersistent || !input.responseFarFuturePersistent) ? 'ENTRY_FACTS_CLEARED' : 'NONE';
            if (resumeReason !== 'NONE') return Object.freeze({ ...base, shadowHoldActive: false, shadowHoldWouldResume: true,
                shadowDecision: 'WOULD_RESUME', shadowResumeReason: resumeReason });
            return Object.freeze({ ...base, shadowHoldActive: true, shadowDecision: 'WOULD_HOLD' });
        }
        const entry = environmentCurrent && input.retainedFutureAvailable && input.pendingCount > 50 &&
            input.acquisitionLeadPersistent && input.responseFarFuturePersistent &&
            ['LONG_GAP', 'VERY_LONG_GAP'].includes(input.acquisitionLeadClass) &&
            ['MEDIUM_GAP', 'LONG_GAP', 'VERY_LONG_GAP'].includes(input.retainedNearestDistanceClass);
        const blockedReason = !environmentCurrent ? 'ENVIRONMENT' : !input.retainedFutureAvailable ? 'NO_FUTURE' :
            input.pendingCount <= 50 ? 'LOW_WATERMARK' : !input.acquisitionLeadPersistent ? 'LEAD_NOT_PERSISTENT' :
                !input.responseFarFuturePersistent ? 'RESPONSE_NOT_PERSISTENT' :
                    !['LONG_GAP', 'VERY_LONG_GAP'].includes(input.acquisitionLeadClass) ? 'LEAD_NOT_FAR' :
                        !['MEDIUM_GAP', 'LONG_GAP', 'VERY_LONG_GAP'].includes(input.retainedNearestDistanceClass) ? 'NEAR_COVERAGE' : 'NONE';
        return Object.freeze({ ...base, shadowHoldWouldEnter: entry, shadowHoldActive: entry,
            shadowDecision: entry ? 'WOULD_ENTER' : 'NO_HOLD', shadowBlockedReason: blockedReason,
            shadowEntryReason: entry ? 'PERSISTENT_FAR_LEAD_WITH_COVERAGE' : 'NONE' });
    }

    function updateReplayGapEvidence(state, observations, currentTimeSeconds, nearBandMsec = 10000) {
        if (!state || typeof state !== 'object' || !Array.isArray(observations) || !Number.isFinite(currentTimeSeconds) ||
            !Number.isFinite(nearBandMsec) || nearBandMsec < 0)
            return createReplayGapEvidenceState();
        const next = {
            observationPasses: Math.min(255, Number.isInteger(state.observationPasses) ? state.observationPasses + 1 : 1),
            filteredBeforeStart: state.filteredBeforeStart === true,
            bridgedDue: state.bridgedDue === true,
            capacityDropped: state.capacityDropped === true,
            exactIdDeduped: state.exactIdDeduped === true,
            retained: state.retained === true,
            unknownDisposition: state.unknownDisposition === true
        };
        for (const observation of observations) {
            const offsetMsec = observation?.replayOffsetMsec;
            if (!Number.isFinite(offsetMsec) || Math.abs(offsetMsec - currentTimeSeconds * 1000) > nearBandMsec) continue;
            if (observation?.disposition === 'FILTERED_BEFORE_START') next.filteredBeforeStart = true;
            else if (observation?.disposition === 'BRIDGED_DUE') next.bridgedDue = true;
            else if (observation?.disposition === 'CAPACITY_DROPPED') next.capacityDropped = true;
            else if (observation?.disposition === 'EXACT_ID_DEDUPED') next.exactIdDeduped = true;
            else if (observation?.disposition === 'RETAINED') next.retained = true;
            else next.unknownDisposition = true;
        }
        return Object.freeze(next);
    }

    function summarizeReplayGapOrigin(state) {
        if (!state || typeof state !== 'object' || !Number.isInteger(state.observationPasses)) return Object.freeze({
            gapBandObserved: false, gapBandObservedDisposition: 'UNKNOWN', gapOriginClass: 'UNKNOWN'
        });
        if (state.observationPasses === 0) return Object.freeze({
            gapBandObserved: false, gapBandObservedDisposition: 'UNKNOWN', gapOriginClass: 'UNKNOWN'
        });
        const dispositions = new Set();
        if (state.filteredBeforeStart === true) dispositions.add('FILTERED_BEFORE_START');
        if (state.bridgedDue === true) dispositions.add('BRIDGED_DUE');
        if (state.capacityDropped === true) dispositions.add('CAPACITY_DROPPED');
        if (state.exactIdDeduped === true) dispositions.add('EXACT_ID_DEDUPED');
        if (state.retained === true) dispositions.add('RETAINED');
        if (state.unknownDisposition === true) dispositions.add('UNKNOWN');
        if (dispositions.size === 0) return Object.freeze({
            gapBandObserved: false, gapBandObservedDisposition: 'NEVER_OBSERVED', gapOriginClass: 'SOURCE_OR_UNOBSERVED'
        });
        if (dispositions.size > 1) return Object.freeze({
            gapBandObserved: true, gapBandObservedDisposition: 'UNKNOWN', gapOriginClass: 'MIXED'
        });
        const disposition = [...dispositions][0];
        const origin = {
            FILTERED_BEFORE_START: 'FILTERED', BRIDGED_DUE: 'ALREADY_BRIDGED', CAPACITY_DROPPED: 'CAPACITY',
            EXACT_ID_DEDUPED: 'DEDUPE', RETAINED: 'RETAINED'
        }[disposition] || 'UNKNOWN';
        return Object.freeze({ gapBandObserved: true, gapBandObservedDisposition: disposition, gapOriginClass: origin });
    }

    function isNearestReplayFuturePreserved(allFuture, retainedFuture) {
        if (!Array.isArray(allFuture) || !Array.isArray(retainedFuture)) return 'UNKNOWN';
        const allOffsets = allFuture.map((message) => message?.replayOffsetMsec).filter(Number.isFinite);
        if (allOffsets.length === 0) return 'UNKNOWN';
        const retainedOffsets = retainedFuture.map((message) => message?.replayOffsetMsec).filter(Number.isFinite);
        if (retainedOffsets.length === 0) return false;
        return Math.min(...allOffsets) === Math.min(...retainedOffsets);
    }

    function classifyNearestReplayFuture(messages, currentTimeSeconds) {
        if (!Array.isArray(messages) || !Number.isFinite(currentTimeSeconds)) return 'UNKNOWN';
        if (messages.length === 0) return 'NONE';
        let nearest = Infinity;
        for (const message of messages) {
            if (!Number.isFinite(message?.replayOffsetMsec)) return 'UNKNOWN';
            nearest = Math.min(nearest, message.replayOffsetMsec);
        }
        const gapMsec = Math.max(0, nearest - currentTimeSeconds * 1000);
        if (gapMsec <= 2000) return 'IMMEDIATE';
        if (gapMsec <= 10000) return 'SHORT_GAP';
        if (gapMsec <= 30000) return 'MEDIUM_GAP';
        if (gapMsec <= 120000) return 'LONG_GAP';
        return 'VERY_LONG_GAP';
    }

    function classifyReplayBufferPauseState({ paused, pendingCount, nearestFutureClass, maximumPending = 100 } = {}) {
        const validClass = ['NONE', 'IMMEDIATE', 'SHORT_GAP', 'MEDIUM_GAP', 'LONG_GAP', 'VERY_LONG_GAP', 'UNKNOWN']
            .includes(nearestFutureClass);
        if (paused !== true || !Number.isInteger(pendingCount) || pendingCount < 0 ||
            !Number.isInteger(maximumPending) || maximumPending <= 0 || !validClass) {
            return Object.freeze({ temporalState: 'UNKNOWN', futureGapWhilePaused: false, resumeBlockedByCount: false });
        }
        const temporalState = pendingCount === 0 || nearestFutureClass === 'NONE' ? 'EMPTY'
            : ['IMMEDIATE', 'SHORT_GAP'].includes(nearestFutureClass) ? 'NEAR_FUTURE_AVAILABLE'
                : ['MEDIUM_GAP', 'LONG_GAP', 'VERY_LONG_GAP'].includes(nearestFutureClass) ? 'ONLY_FAR_FUTURE'
                    : 'UNKNOWN';
        return Object.freeze({
            temporalState,
            futureGapWhilePaused: pendingCount > 0 && temporalState === 'ONLY_FAR_FUTURE',
            resumeBlockedByCount: pendingCount > Math.floor(maximumPending / 2)
        });
    }

    function evaluateReplayBufferEarlyResume({
        paused, pauseReason, pendingCount, maximumPending = 100, dueCount,
        schedulerPendingCount, nearestFutureClass, authorityAvailable, authorityCurrent,
        authorityUnused, requestInFlight, activeLoop, locked, suppressed
    } = {}) {
        if (paused !== true) return Object.freeze({ eligible: false, decision: 'NOT_PAUSED' });
        if (pauseReason !== 'COUNT_PRESSURE') return Object.freeze({ eligible: false, decision: 'UNKNOWN' });
        if (!Number.isInteger(pendingCount) || !Number.isInteger(maximumPending) || maximumPending <= 0)
            return Object.freeze({ eligible: false, decision: 'UNKNOWN' });
        if (pendingCount <= Math.floor(maximumPending / 2) || pendingCount >= maximumPending)
            return Object.freeze({ eligible: false, decision: 'COUNT_NOT_IN_RANGE' });
        if (!Number.isInteger(dueCount) || dueCount < 0) return Object.freeze({ eligible: false, decision: 'UNKNOWN' });
        if (dueCount > 0) return Object.freeze({ eligible: false, decision: 'DUE_PRESENT' });
        if (!Number.isInteger(schedulerPendingCount) || schedulerPendingCount < 0)
            return Object.freeze({ eligible: false, decision: 'UNKNOWN' });
        if (schedulerPendingCount > 0) return Object.freeze({ eligible: false, decision: 'SCHEDULER_PENDING' });
        if (!['MEDIUM_GAP', 'LONG_GAP', 'VERY_LONG_GAP'].includes(nearestFutureClass))
            return Object.freeze({ eligible: false, decision: nearestFutureClass === 'UNKNOWN' ? 'UNKNOWN' : 'NEAR_FUTURE' });
        if (authorityAvailable !== true) return Object.freeze({ eligible: false, decision: 'AUTHORITY_UNAVAILABLE' });
        if (authorityCurrent !== true || authorityUnused !== true)
            return Object.freeze({ eligible: false, decision: 'AUTHORITY_INVALID' });
        if (requestInFlight === true || activeLoop === true)
            return Object.freeze({ eligible: false, decision: 'REQUEST_IN_FLIGHT' });
        if (locked === true) return Object.freeze({ eligible: false, decision: 'LOCKED' });
        if (suppressed === true) return Object.freeze({ eligible: false, decision: 'SUPPRESSED' });
        return Object.freeze({ eligible: true, decision: 'ELIGIBLE' });
    }

    function evaluateReplayNormalResume({
        paused, pendingCount, maximumPending = 100,
        authorityAvailable, authorityCurrent, authorityUnused
    } = {}) {
        if (paused !== true) return Object.freeze({ eligible: false, reason: 'NOT_PAUSED' });
        if (!Number.isInteger(pendingCount) || pendingCount < 0 ||
            !Number.isInteger(maximumPending) || maximumPending <= 0) {
            return Object.freeze({ eligible: false, reason: 'UNKNOWN' });
        }
        if (pendingCount > Math.floor(maximumPending / 2)) {
            return Object.freeze({ eligible: false, reason: 'ABOVE_LOW_WATERMARK' });
        }
        if (authorityAvailable !== true) return Object.freeze({ eligible: false, reason: 'AUTHORITY_UNAVAILABLE' });
        if (authorityCurrent !== true || authorityUnused !== true) {
            return Object.freeze({ eligible: false, reason: 'AUTHORITY_INVALID' });
        }
        return Object.freeze({ eligible: true, reason: 'ELIGIBLE' });
    }

    function transitionReplayEarlyResumeSuppression(state, event) {
        if (!['CLEAR', 'USED_WAITING_FOR_LOW_WATERMARK'].includes(state)) return 'UNKNOWN';
        if (event === 'INVALIDATE') return 'CLEAR';
        if (event === 'EARLY_RESUME_STARTED') return 'USED_WAITING_FOR_LOW_WATERMARK';
        if (event === 'LOW_WATERMARK_REACHED') return 'CLEAR';
        if (event === 'COUNT_PRESSURE_PAUSED') return state;
        return 'UNKNOWN';
    }

    function classifyReplayDiagnosticCount(count, kind = 'TOTAL', maximumPending = 100) {
        if (!Number.isInteger(count) || count < 0 || !Number.isInteger(maximumPending) || maximumPending <= 0) return 'UNKNOWN';
        if (kind === 'TOTAL') {
            if (count === 0) return 'EMPTY';
            if (count <= Math.floor(maximumPending / 2)) return 'LOW_WATERMARK_OR_LESS';
            if (count < maximumPending) return 'PRESSURE_WINDOW';
            return 'CAPACITY';
        }
        if (count === 0) return 'ZERO';
        if (count === 1) return 'ONE';
        if (count <= 5) return 'FEW';
        return 'MANY';
    }

    function summarizeReplayTemporalAvailability(messages, currentTimeSeconds, dueCount = 0, maximumPending = 100) {
        if (!Array.isArray(messages) || !Number.isFinite(currentTimeSeconds) || !Number.isInteger(dueCount) || dueCount < 0)
            return Object.freeze({ known: false, totalPendingClass: 'UNKNOWN', dueCountClass: 'UNKNOWN', nearFutureCountClass: 'UNKNOWN', nearestFutureClass: 'UNKNOWN' });
        let nearFutureCount = 0;
        for (const message of messages) {
            if (!Number.isFinite(message?.replayOffsetMsec))
                return Object.freeze({ known: false, totalPendingClass: 'UNKNOWN', dueCountClass: 'UNKNOWN', nearFutureCountClass: 'UNKNOWN', nearestFutureClass: 'UNKNOWN' });
            const gap = message.replayOffsetMsec - currentTimeSeconds * 1000;
            if (gap >= 0 && gap <= 10000) nearFutureCount += 1;
        }
        return Object.freeze({
            known: true,
            totalPendingClass: classifyReplayDiagnosticCount(messages.length, 'TOTAL', maximumPending),
            dueCountClass: classifyReplayDiagnosticCount(dueCount, 'ITEMS', maximumPending),
            nearFutureCountClass: classifyReplayDiagnosticCount(nearFutureCount, 'ITEMS', maximumPending),
            nearestFutureClass: classifyNearestReplayFuture(messages, currentTimeSeconds)
        });
    }

    function compareReplayTemporalCoverage(before, after) {
        if (!before?.known || !after?.known) return 'UNKNOWN';
        if (before.dueCountClass === 'ZERO' && after.dueCountClass !== 'ZERO') return 'DUE_APPEARED';
        const countRank = { ZERO: 0, ONE: 1, FEW: 2, MANY: 3 };
        if ((countRank[after.nearFutureCountClass] ?? -1) > (countRank[before.nearFutureCountClass] ?? -1)) return 'NEAR_FUTURE_IMPROVED';
        const distanceRank = { IMMEDIATE: 0, SHORT_GAP: 1, MEDIUM_GAP: 2, LONG_GAP: 3, VERY_LONG_GAP: 4, NONE: 5 };
        if ((distanceRank[after.nearestFutureClass] ?? 99) < (distanceRank[before.nearestFutureClass] ?? 99)) return 'NEAREST_MOVED_CLOSER';
        if (after.nearestFutureClass === before.nearestFutureClass && after.nearFutureCountClass === before.nearFutureCountClass &&
            after.dueCountClass === before.dueCountClass) return 'NO_CHANGE';
        return 'COVERAGE_WORSENED';
    }

    function evaluateReplayTemporalStarvation(input = {}) {
        const requiredBooleans = ['bufferPaused', 'schedulerPending', 'schedulerLaunchable', 'savedSequentialAvailable',
            'savedSequentialCurrent', 'savedSequentialUnused', 'requestActive', 'lifecycleCurrent', 'visible', 'adActive',
            'seekActive', 'navigationPending'];
        if (requiredBooleans.some((key) => typeof input[key] !== 'boolean') || !Number.isInteger(input.pendingCount) ||
            !Number.isInteger(input.maximumPending) || input.maximumPending <= 0 || !Number.isInteger(input.dueCount)) {
            return Object.freeze({ known: false, observed: false, hypotheticalEligible: false, blockedReason: 'UNKNOWN' });
        }
        const blocked = input.bufferPaused !== true ? 'NOT_PAUSED' : input.pauseReason !== 'COUNT_PRESSURE' ? 'PAUSE_REASON' :
            input.pendingCount <= Math.floor(input.maximumPending / 2) ? 'LOW_WATERMARK' : input.dueCount > 0 ? 'DUE_PRESENT' :
            input.schedulerPending ? 'SCHEDULER_PENDING' : input.schedulerLaunchable ? 'SCHEDULER_LAUNCHABLE' :
            !['MEDIUM_GAP', 'LONG_GAP', 'VERY_LONG_GAP'].includes(input.nearestFutureClass) ? 'NEAR_FUTURE' :
            !input.savedSequentialAvailable ? 'AUTHORITY_UNAVAILABLE' : (!input.savedSequentialCurrent || !input.savedSequentialUnused) ? 'AUTHORITY_INVALID' :
            input.requestActive ? 'REQUEST_ACTIVE' : !input.lifecycleCurrent ? 'STALE_LIFECYCLE' : !input.visible ? 'HIDDEN' :
            input.adActive ? 'AD' : input.seekActive ? 'SEEK' : input.navigationPending ? 'NAVIGATION' : 'ELIGIBLE';
        const observed = blocked === 'ELIGIBLE';
        return Object.freeze({ known: true, observed, hypotheticalEligible: observed, blockedReason: blocked });
    }

    function mergeReplayTemporalEpisodeHistory(history = {}, observation = {}) {
        const completed = history.earlyResumeCompleted === true || observation.earlyResumeCompleted === true;
        const started = completed || history.earlyResumeStarted === true || observation.earlyResumeStarted === true;
        const attempted = started || history.earlyResumeAttempted === true || observation.earlyResumeAttempted === true;
        const observedResult = typeof observation.earlyResumeProgressResult === 'string'
            ? observation.earlyResumeProgressResult : 'UNKNOWN';
        const retainedResult = observedResult !== 'UNKNOWN' ? observedResult :
            typeof history.earlyResumeProgressResult === 'string' ? history.earlyResumeProgressResult : 'UNKNOWN';
        return Object.freeze({
            earlyResumeAttempted: attempted,
            earlyResumeStarted: started,
            earlyResumeCompleted: completed,
            earlyResumeProgressResult: retainedResult,
            earlyResumeBudgetUsed: started ? 1 : 0,
            hypotheticalRescueBudgetRemaining: started ? 1 : 2
        });
    }

    function evaluateReplayHypotheticalRescue(input = {}) {
        const booleans = ['episodeActive', 'bufferPausedNow', 'episodeEarlyResumeStarted', 'schedulerPending',
            'schedulerLaunchable', 'savedSequentialAvailable', 'savedSequentialCurrent', 'savedSequentialUnused',
            'requestActive', 'lifecycleCurrent', 'visible', 'adActive', 'seekActive', 'navigationPending'];
        if (booleans.some((key) => typeof input[key] !== 'boolean') || !Number.isInteger(input.budgetRemaining) ||
            !Number.isInteger(input.dueCount) || input.dueCount < 0) {
            return Object.freeze({ known: false, eligible: false, blockedReason: 'UNKNOWN' });
        }
        const reason = !input.episodeActive ? 'NOT_IN_EPISODE' : !input.bufferPausedNow ? 'NOT_PAUSED' :
            input.pauseReason !== 'COUNT_PRESSURE' ? 'WRONG_PAUSE_REASON' : !input.episodeEarlyResumeStarted ? 'EARLY_RESUME_NOT_USED' :
            input.budgetRemaining <= 0 ? 'BUDGET_EXHAUSTED' : input.dueCount > 0 ? 'DUE_PRESENT' :
            input.schedulerPending ? 'SCHEDULER_PENDING' : input.schedulerLaunchable ? 'SCHEDULER_LAUNCHABLE' :
            !input.savedSequentialAvailable ? 'NO_SAVED_SEQUENTIAL' : (!input.savedSequentialCurrent || !input.savedSequentialUnused) ? 'SAVED_SEQUENTIAL_INVALID' :
            input.requestActive ? 'REQUEST_ACTIVE' : !input.lifecycleCurrent ? 'STALE_LIFECYCLE' : !input.visible ? 'HIDDEN' :
            input.adActive ? 'AD' : input.seekActive ? 'SEEK' : input.navigationPending ? 'NAVIGATION' :
            !['MEDIUM_GAP', 'LONG_GAP', 'VERY_LONG_GAP'].includes(input.nearestFutureClass) ? 'TEMPORAL_COVERAGE_NOT_STARVED' : 'ELIGIBLE';
        return Object.freeze({ known: true, eligible: reason === 'ELIGIBLE', blockedReason: reason });
    }

    function authorizeReplayReadStart({
        lifecycleGeneration, bootstrapConsumedLifecycleGeneration,
        continuationOverride = '', continuationSource = 'INITIAL_WATCH',
        bufferPaused = false, savedSequentialAvailable = false
    } = {}) {
        const hasOverride = typeof continuationOverride === 'string' && continuationOverride.length > 0;
        if (hasOverride) {
            if (!['BUFFER_RESUME', 'BUFFER_EARLY_RESUME', 'PLAYER_SEEK_HANDOFF'].includes(continuationSource)) {
                return Object.freeze({ allowed: false, authorityKind: 'NONE', source: 'NONE', reason: 'INVALID_SEQUENTIAL_SOURCE' });
            }
            return Object.freeze({ allowed: true, authorityKind: 'SEQUENTIAL', source: continuationSource, reason: 'NONE' });
        }
        if (bufferPaused === true || savedSequentialAvailable === true) {
            return Object.freeze({ allowed: false, authorityKind: 'NONE', source: 'NONE', reason: 'BUFFER_REQUIRES_SAVED_SEQUENTIAL' });
        }
        if (Number.isInteger(lifecycleGeneration) && lifecycleGeneration === bootstrapConsumedLifecycleGeneration) {
            return Object.freeze({ allowed: false, authorityKind: 'NONE', source: 'NONE', reason: 'BOOTSTRAP_CONSUMED' });
        }
        return Object.freeze({ allowed: true, authorityKind: 'BOOTSTRAP', source: 'INITIAL_WATCH', reason: 'NONE' });
    }

    function countNewReplayMessageIdentities(items, seen) {
        if (!Array.isArray(items) || !seen || typeof seen.has !== 'function' || typeof seen.add !== 'function') return 0;
        let count = 0;
        for (const item of items) {
            const identity = typeof item?.id === 'string' && item.id.length > 0 ? item.id : null;
            if (identity === null || seen.has(identity)) continue;
            seen.add(identity);
            count += 1;
        }
        return count;
    }

    function finalizePlayerSeekDiagnosticState(state) {
        if (state && typeof state === 'object') state.inFlight = false;
        return state;
    }

    function canAcceptReplaySchemaDiagnostic({ armed, observed, mode, armedLifecycleGeneration, currentLifecycleGeneration, armedRevision, currentRevision, responseRevision, armedTargetIdentity, currentTargetIdentity, readGeneration, currentReadGeneration, aborted, navigationPending, targetCurrent } = {}) {
        return armed === true && observed !== true && mode === 'replay' &&
            armedLifecycleGeneration === currentLifecycleGeneration &&
            armedRevision === currentRevision && responseRevision === currentRevision &&
            typeof armedTargetIdentity === 'string' && armedTargetIdentity.length > 0 && armedTargetIdentity === currentTargetIdentity &&
            readGeneration === currentReadGeneration && aborted !== true && navigationPending === false && targetCurrent === true;
    }

    function validateReplayChatReadResponse(response, sequentialAuthority = null) {
        const liveChat = response?.continuationContents?.liveChatContinuation;
        if (!liveChat || typeof liveChat !== 'object' || !Array.isArray(liveChat.actions)) return { ok: false, errorType: 'missing_replay_actions' };
        const selection = sequentialAuthority
            ? selectReplaySequentialContinuationInfo(response, sequentialAuthority.requestContinuation, sequentialAuthority.consumedContinuations)
            : { info: extractReplayContinuationInfo(response), state: 'SINGLE_UNUSED' };
        if (!selection.info) return { ok: false, errorType: selection.state === 'AMBIGUOUS_UNUSED' ? 'ambiguous_replay_continuation' : 'invalid_replay_continuation', continuationCandidateState: selection.state };
        return { ok: true, continuationInfo: selection.info, continuationCandidateState: selection.state,
            effectiveDelayMs: Math.max(selection.info.timeoutMs, LIVEFLOW_MIN_READ_DELAY_MS) };
    }

    function selectReplayDueMessages(messages, currentTimeSeconds, startTimeSeconds, toleranceMsec = 250) {
        if (!Array.isArray(messages) || !Number.isFinite(currentTimeSeconds) || !Number.isFinite(startTimeSeconds)) return { due: [], pending: [] };
        const now = currentTimeSeconds * 1000;
        const start = startTimeSeconds * 1000;
        const due = [];
        const pending = [];
        for (const message of messages) {
            const offset = message?.replayOffsetMsec;
            if (!Number.isFinite(offset) || offset < start - toleranceMsec) continue;
            if (offset <= now + toleranceMsec) due.push(message); else pending.push(message);
        }
        return { due, pending };
    }

    function selectBoundedReplayDueMessages(messages, currentTimeSeconds, startTimeSeconds, maximumPending, toleranceMsec = 250) {
        if (!Array.isArray(messages) || !Number.isFinite(currentTimeSeconds) || !Number.isFinite(startTimeSeconds) ||
            !Number.isInteger(maximumPending) || maximumPending < 0) return null;
        const seenIds = new Set();
        const deduplicatedItems = [];
        const uniqueMessages = messages.filter((message) => {
            const id = typeof message?.id === 'string' && message.id.length > 0 ? message.id : null;
            if (id === null) return true;
            if (seenIds.has(id)) {
                deduplicatedItems.push(message);
                return false;
            }
            seenIds.add(id);
            return true;
        });
        const selection = selectReplayDueMessages(uniqueMessages, currentTimeSeconds, startTimeSeconds, toleranceMsec);
        const orderedPending = selection.pending.slice().sort((left, right) => left.replayOffsetMsec - right.replayOffsetMsec);
        const pending = orderedPending.slice(0, maximumPending);
        return {
            due: selection.due,
            pending,
            filtered: uniqueMessages.filter((message) => !selection.due.includes(message) && !selection.pending.includes(message)),
            deduplicatedItems,
            capacityDroppedItems: orderedPending.slice(maximumPending),
            capacitySelectionNearestPreserved: isNearestReplayFuturePreserved(orderedPending, pending),
            filteredCount: uniqueMessages.length - selection.due.length - selection.pending.length,
            deduplicatedCount: messages.length - uniqueMessages.length,
            capacityDropped: orderedPending.length - pending.length
        };
    }

    function replayBatchIsEntirelyStale(messages, startTimeSeconds, toleranceMsec = 250) {
        return Array.isArray(messages) && messages.length > 0 && Number.isFinite(startTimeSeconds) &&
            messages.every((message) => Number.isFinite(message?.replayOffsetMsec) && message.replayOffsetMsec < startTimeSeconds * 1000 - toleranceMsec);
    }

    function canRestartReplayAtCurrentPosition({ mode, userEnabled, hidden, videoPresent, paused, seeking, ended, currentTime } = {}) {
        return mode === 'replay' && userEnabled === true && hidden === false && videoPresent === true &&
            paused === false && seeking === false && ended === false && Number.isFinite(currentTime) && currentTime >= 0;
    }

    function canResumeReadAfterVisibility({ visibilityState, userEnabled, stopReason, requestedLifecycleGeneration, currentLifecycleGeneration, navigationPending, targetMatched, continuationAvailable, contextAvailable, watchRootCurrent, activeLoopGeneration, requestInFlight } = {}) {
        return visibilityState === 'visible' &&
            userEnabled === true &&
            stopReason === 'visibility-hidden' &&
            requestedLifecycleGeneration === currentLifecycleGeneration &&
            navigationPending === false &&
            targetMatched === true &&
            continuationAvailable === true &&
            contextAvailable === true &&
            watchRootCurrent === true &&
            activeLoopGeneration === 0 &&
            requestInFlight === false;
    }

    const api = {
        LIVEFLOW_MIN_READ_DELAY_MS,
        LIVEFLOW_MAX_TIMER_DELAY_MS,
        ChatMessage,
        normalizeReadImageUrl,
        normalizeMessageRuns,
        normalizeSticker,
        extractChatMessagesFromResponse,
        parseReplayOffsetMsec,
        extractReplayChatMessagesFromResponse,
        extractReplayContinuationInfo,
        selectReplaySequentialContinuationInfo,
        classifyPlayerSeekContinuationPresence,
        extractPlayerSeekContinuation,
        validatePlayerSeekOffset,
        canRunPlayerSeekDiagnostic,
        getPlayerSeekDiagnosticNotSentReason,
        summarizePlayerSeekDiagnosticResponse,
        classifyReplayReanchorCoverage,
        summarizeReplayTargetHole,
        summarizeReplayDisplayableTargetHole,
        summarizeReplayDisplayableAccounting,
        classifyReplayInitialStartupCoverage,
        countReplayTimestampedActions,
        classifySequentialContinuationProgress,
        classifyReplayTemporalProgress,
        classifyReplayMessageRelation,
        summarizeReplayResponseTemporalShape,
        createReplayGapEvidenceState,
        createReplayGapPersistenceState,
        updateReplayGapPersistenceState,
        evaluateReplayTemporalLeadShadow,
        updateReplayGapEvidence,
        summarizeReplayGapOrigin,
        isNearestReplayFuturePreserved,
        classifyNearestReplayFuture,
        classifyReplayBufferPauseState,
        evaluateReplayBufferEarlyResume,
        evaluateReplayNormalResume,
        transitionReplayEarlyResumeSuppression,
        classifyReplayDiagnosticCount,
        summarizeReplayTemporalAvailability,
        compareReplayTemporalCoverage,
        evaluateReplayTemporalStarvation,
        mergeReplayTemporalEpisodeHistory,
        evaluateReplayHypotheticalRescue,
        authorizeReplayReadStart,
        countNewReplayMessageIdentities,
        finalizePlayerSeekDiagnosticState,
        canAcceptReplaySchemaDiagnostic,
        validateReplayChatReadResponse,
        selectReplayDueMessages,
        selectBoundedReplayDueMessages,
        replayBatchIsEntirelyStale,
        canRestartReplayAtCurrentPosition,
        extractContinuationFromResponse,
        extractContinuationInfoFromResponse,
        getContinuationTypes,
        extractInitialLiveChatContinuation,
        classifyInitialChatMode,
        classifySameTargetChatModeTransition,
        computeReplayAccountingLoss,
        REPLAY_BLANK_CAUSES,
        conserveReplayBoundary,
        computeReplayAccountingLedger,
        classifyReplayCount,
        classifyReplayBlankCause,
        compareReplayPipelinePaths,
        REPLAY_RUNTIME_EPISODE_STATES,
        classifyReplayActivity,
        classifyReplayRatio,
        firstReplayMissingBoundary,
        dominantReplayDropReason,
        createReplayRuntimeObserver,
        normalizeInternalApiContext,
        buildLiveChatReadRequest,
        summarizeLiveChatResponse,
        canAttemptOneShotRead,
        getPageRevisionState,
        canIssueSecondRead,
        getReadDelayMs,
        validateLiveChatReadResponse,
        isSuccessfulHttpStatus,
        canStartReadLoop,
        canScheduleNextRead,
        extractWatchTargetIdentity,
        evaluateBootstrapTarget,
        canEstablishPageLifecycle,
        canReevaluatePageLifecycle,
        canSignalOwnershipReevaluation,
        canResumeReadAfterVisibility
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.LiveFlowChatReadCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
