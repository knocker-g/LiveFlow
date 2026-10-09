(function (global) {
    const foundations = typeof module !== 'undefined' && module.exports
        ? require('./scheduler-foundations.js')
        : global.LiveFlowSchedulerFoundations;

    const SEMANTIC_CLASSES = Object.freeze({ SPECIAL: 'SPECIAL', NORMAL: 'NORMAL' });

    function classifySemanticClass(item) {
        return item?.rendererType === 'liveChatPaidMessageRenderer' ||
            item?.rendererType === 'liveChatPaidStickerRenderer'
            ? SEMANTIC_CLASSES.SPECIAL
            : SEMANTIC_CLASSES.NORMAL;
    }

    function createPendingItem({ id, enqueuedAt, rendererType, payload, footprint } = {}) {
        if ((typeof id !== 'string' && typeof id !== 'number') || !Number.isFinite(enqueuedAt) ||
            !footprint || typeof footprint !== 'object') return null;
        return Object.freeze({
            id,
            enqueuedAt,
            rendererType,
            semanticClass: classifySemanticClass({ rendererType }),
            payload,
            footprint: Object.freeze({ ...footprint })
        });
    }

    function createSpecialPreferencePolicy() {
        return Object.freeze({
            select(candidates) {
                if (!Array.isArray(candidates) || candidates.length === 0) return null;
                return candidates.find((candidate) => candidate.item.semanticClass === SEMANTIC_CLASSES.SPECIAL) || candidates[0];
            }
        });
    }

    function createFifoPolicy() {
        return Object.freeze({
            select(candidates) {
                if (!Array.isArray(candidates) || candidates.length === 0) return null;
                return candidates.reduce((oldest, candidate) => candidate.index < oldest.index ? candidate : oldest);
            }
        });
    }

    function createPendingQueue() {
        const items = [];
        let successfulLaunchSequence = 0;
        let scanRotationCursor = 0;
        let selectionNonce = 0;

        function enqueue(item) {
            if (!item || !Number.isFinite(item.enqueuedAt) || !SEMANTIC_CLASSES[item.semanticClass]) return false;
            items.push(item);
            return true;
        }

        function pruneStale(now, maxPendingAge) {
            if (!Number.isFinite(now) || !Number.isFinite(maxPendingAge) || maxPendingAge < 0) return Object.freeze([]);
            const dropped = [];
            while (items.length && now - items[0].enqueuedAt > maxPendingAge) dropped.push(items.shift());
            return Object.freeze(dropped);
        }

        function enforceHardCount(maxPendingCount) {
            if (!Number.isInteger(maxPendingCount) || maxPendingCount < 0) return Object.freeze([]);
            const dropped = [];
            while (items.length > maxPendingCount) dropped.push(items.shift());
            return Object.freeze(dropped);
        }

        function relieveSaturation(maxDrops = 1) {
            if (!Number.isInteger(maxDrops) || maxDrops <= 0) return Object.freeze([]);
            const dropped = [];
            while (dropped.length < maxDrops) {
                const index = items.findIndex((item) => item.semanticClass === SEMANTIC_CLASSES.NORMAL);
                if (index < 0) break;
                dropped.push(items.splice(index, 1)[0]);
            }
            return Object.freeze(dropped);
        }

        function evaluate({ scanDepth, cohortMaximumItems, cohortMaximumSpan, isSafe, policy } = {}) {
            if (!Number.isInteger(scanDepth) || scanDepth <= 0 ||
                !Number.isInteger(cohortMaximumItems) || cohortMaximumItems <= 0 ||
                !Number.isFinite(cohortMaximumSpan) || cohortMaximumSpan < 0 ||
                typeof isSafe !== 'function' || !policy || typeof policy.select !== 'function' || items.length === 0) return null;

            const traversed = foundations.rotatingModularStride(items.length, scanDepth, successfulLaunchSequence + scanRotationCursor);
            const cohortIndexes = new Set(foundations.temporalCohort(items, {
                maximumItems: cohortMaximumItems,
                maximumSpan: cohortMaximumSpan
            }).map(({ index }) => index));
            const safeCandidates = [];
            const structurallyDiscarded = [];
            for (const index of traversed) {
                const item = items[index];
                const verdict = isSafe(item);
                if (verdict === true) safeCandidates.push(Object.freeze({ index, item, inTemporalCohort: cohortIndexes.has(index) }));
                else if (verdict?.discard === true) structurallyDiscarded.push(item);
            }
            if (structurallyDiscarded.length > 0) {
                for (const item of structurallyDiscarded) {
                    const index = items.indexOf(item);
                    if (index >= 0) items.splice(index, 1);
                }
            }
            if (safeCandidates.length === 0) {
                scanRotationCursor += 1;
                return null;
            }
            const cohortSafe = safeCandidates.filter((candidate) => candidate.inTemporalCohort);
            const selected = cohortSafe.length ? policy.select(cohortSafe) : createFifoPolicy().select(safeCandidates);
            if (!selected || !safeCandidates.includes(selected)) return null;
            selectionNonce += 1;
            return Object.freeze({
                token: Object.freeze({ nonce: selectionNonce, sequence: successfulLaunchSequence, item: selected.item }),
                item: selected.item,
                index: selected.index,
                inspectedCount: traversed.length
            });
        }

        function confirmSuccessfulLaunch(token) {
            if (!token || token.sequence !== successfulLaunchSequence || token.nonce !== selectionNonce) return false;
            const index = items.indexOf(token.item);
            if (index < 0) return false;
            items.splice(index, 1);
            successfulLaunchSequence += 1;
            scanRotationCursor = 0;
            return true;
        }

        return Object.freeze({
            enqueue,
            pruneStale,
            enforceHardCount,
            relieveSaturation,
            evaluate,
            confirmSuccessfulLaunch,
            snapshot: () => Object.freeze(items.slice()),
            successfulLaunchSequence: () => successfulLaunchSequence
        });
    }

    const api = {
        SEMANTIC_CLASSES,
        classifySemanticClass,
        createPendingItem,
        createSpecialPreferencePolicy,
        createFifoPolicy,
        createPendingQueue
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowPendingSelection = api;
})(typeof window !== 'undefined' ? window : globalThis);
