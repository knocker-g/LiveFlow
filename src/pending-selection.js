(function (global) {
    const foundations = typeof module !== 'undefined' && module.exports
        ? require('./scheduler-foundations.js')
        : global.LiveFlowSchedulerFoundations;

    const SEMANTIC_CLASSES = Object.freeze({ SPECIAL: 'SPECIAL', NORMAL: 'NORMAL' });

    function clonePendingOwner(value) {
        if (!value || typeof value.document !== 'string' || value.document.length < 1 || value.document.length > 128 ||
            typeof value.target !== 'string' || value.target.length < 1 || value.target.length > 256 ||
            !Number.isSafeInteger(value.stream) || value.stream < 1 ||
            !Number.isSafeInteger(value.lifecycle) || value.lifecycle < 0 ||
            !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
        return Object.freeze({ document: value.document, stream: value.stream, target: value.target,
            lifecycle: value.lifecycle, revision: value.revision });
    }

    function samePendingOwner(a, b) {
        return Boolean(a && b && ['document', 'stream', 'target', 'lifecycle', 'revision'].every(key => a[key] === b[key]));
    }

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
            pendingOwner: clonePendingOwner(payload?.pendingOwner),
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
                // Retention is separate from launch selection: ordinary NORMAL is relieved first.
                let index = items.findIndex((item) => item.semanticClass === SEMANTIC_CLASSES.NORMAL &&
                    !['owner', 'moderator'].includes(item.payload?.message?.authorRole));
                if (index < 0) index = items.findIndex((item) => item.semanticClass === SEMANTIC_CLASSES.NORMAL);
                if (index < 0) break;
                dropped.push(items.splice(index, 1)[0]);
            }
            return Object.freeze(dropped);
        }

        function evaluate({ scanDepth, cohortMaximumItems, cohortMaximumSpan, isSafe, policy, onDiscard } = {}) {
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
                else if (verdict?.discard === true) structurallyDiscarded.push({ item,
                    reason: verdict.reason === 'UNREPRESENTABLE_SPECIAL' ? verdict.reason : 'UNKNOWN' });
            }
            if (structurallyDiscarded.length > 0) {
                const reasons = new Map();
                for (const { item, reason } of structurallyDiscarded) {
                    const index = items.indexOf(item);
                    if (index >= 0) { items.splice(index, 1); reasons.set(reason, (reasons.get(reason) || 0) + 1); }
                }
                // Publish actual terminal removals only after queue ownership has changed.
                if (typeof onDiscard === 'function') for (const [reason, count] of reasons) {
                    try { onDiscard(Object.freeze({ reason, count, pendingCount: items.length })); } catch {}
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

        function removePendingOwner(binding) {
            const owner = clonePendingOwner(binding);
            if (!owner || items.some(item => !item.pendingOwner)) {
                return Object.freeze({ status: 'NOT_APPLIED_UNKNOWN', removed: Object.freeze([]) });
            }
            const removed = items.filter(item => samePendingOwner(item.pendingOwner, owner));
            if (removed.length) {
                for (let i = items.length - 1; i >= 0; i--) {
                    if (samePendingOwner(items[i].pendingOwner, owner)) items.splice(i, 1);
                }
                // Invalidate every outstanding selection; survivor order and launch credit remain unchanged.
                selectionNonce += 1;
            }
            return Object.freeze({ status: removed.length ? 'APPLIED' : 'STALE_OR_NOT_FOUND',
                removed: Object.freeze(removed) });
        }

        return Object.freeze({
            enqueue,
            pruneStale,
            enforceHardCount,
            relieveSaturation,
            evaluate,
            confirmSuccessfulLaunch,
            removePendingOwner,
            snapshot: () => Object.freeze(items.slice()),
            successfulLaunchSequence: () => successfulLaunchSequence
        });
    }

    const api = {
        SEMANTIC_CLASSES,
        clonePendingOwner,
        samePendingOwner,
        classifySemanticClass,
        createPendingItem,
        createSpecialPreferencePolicy,
        createFifoPolicy,
        createPendingQueue
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowPendingSelection = api;
})(typeof window !== 'undefined' ? window : globalThis);
