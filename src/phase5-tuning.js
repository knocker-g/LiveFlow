(function (global) {
    const BASELINE = Object.freeze({
        fontSize: 24, lineHeight: 32, laneGap: 4,
        laneBandFractions: Object.freeze({ UPPER: 0.25, UPPER_TO_MID: 0.5, BROAD: 0.75, FULL_SAFE: 1 }),
        collisionAllowances: Object.freeze({
            CONSERVATIVE: Object.freeze({ nominalGap: 24, hardMinimumSeparation: -24, maxCatchUpRatio: 0.15, maxOverlapDuration: 0.15, maxOverlapDepthRatio: 0.08, minimumVisibleFraction: 0.92 }),
            LIMITED_CATCH_UP: Object.freeze({ nominalGap: 24, hardMinimumSeparation: -24, maxCatchUpRatio: 0.3, maxOverlapDuration: 0.3, maxOverlapDepthRatio: 0.12, minimumVisibleFraction: 0.88 }),
            BOUNDED_OVERLAP: Object.freeze({ nominalGap: 24, hardMinimumSeparation: -24, maxCatchUpRatio: 0.5, maxOverlapDuration: 0.5, maxOverlapDepthRatio: 0.18, minimumVisibleFraction: 0.82 }),
            MAXIMUM_READABLE_RESCUE: Object.freeze({ nominalGap: 24, hardMinimumSeparation: -24, maxCatchUpRatio: 0.7, maxOverlapDuration: 0.7, maxOverlapDepthRatio: 0.24, minimumVisibleFraction: 0.76 })
        }),
        minimumSpeed: 120, maximumSpeed: 240,
        lengthVelocity: Object.freeze({ mediumWidthRatio: 0.25, longWidthRatio: 0.6, veryLongWidthRatio: 1, mediumMultiplier: 1, longMultiplier: 1, veryLongMultiplier: 1 }),
        specialMaximumWidthFraction: 0.9, specialMaximumWidthPx: 960, specialMinimumBodyFontSize: 12
    });

    const CURRENT = Object.freeze({
        fontSize: 28, lineHeight: 32, laneGap: 0,
        laneBandFractions: Object.freeze({ UPPER: 0.25, UPPER_TO_MID: 0.55, BROAD: 0.95, FULL_SAFE: 1 }),
        interleavedAnchorStride: Object.freeze({ NORMAL: 0, COMPACT: 3, DENSE: 2, MAX_READABLE: 1 }),
        collisionAllowances: Object.freeze({
            CONSERVATIVE: Object.freeze({ nominalGap: 24, hardMinimumSeparation: -24, maxCatchUpRatio: 0.15, maxOverlapDuration: 0.15, maxOverlapDepthRatio: 0.08, minimumVisibleFraction: 0.92 }),
            LIMITED_CATCH_UP: Object.freeze({ nominalGap: 16, hardMinimumSeparation: -24, maxCatchUpRatio: 0.72, maxOverlapDuration: 0.65, maxOverlapDepthRatio: 0.25, minimumVisibleFraction: 0.75 }),
            BOUNDED_OVERLAP: Object.freeze({ nominalGap: 14, hardMinimumSeparation: -24, maxCatchUpRatio: 0.82, maxOverlapDuration: 0.85, maxOverlapDepthRatio: 0.32, minimumVisibleFraction: 0.68 }),
            MAXIMUM_READABLE_RESCUE: Object.freeze({ nominalGap: 10, hardMinimumSeparation: -24, maxCatchUpRatio: 0.95, maxOverlapDuration: 1.1, maxOverlapDepthRatio: 0.4, minimumVisibleFraction: 0.6 })
        }),
        minimumSpeed: 132, maximumSpeed: 340,
        lengthVelocity: Object.freeze({ mediumWidthRatio: 0.25, longWidthRatio: 0.6, veryLongWidthRatio: 1, shortMultiplier: 1.04, mediumMultiplier: 1.05, longMultiplier: 1.18, veryLongMultiplier: 1.38, extremeMultiplier: 1.55 }),
        specialMaximumWidthFraction: 0.98, specialMaximumWidthPx: 1400, specialMinimumBodyFontSize: 10.5
    });

    function applyLengthAwareVelocity(baseVelocity, measuredWidth, surfaceWidth, policy, maximumSpeed) {
        if (![baseVelocity, measuredWidth, surfaceWidth, maximumSpeed].every(Number.isFinite) || baseVelocity <= 0 || measuredWidth <= 0 || surfaceWidth <= 0 || maximumSpeed <= 0 || !policy) return null;
        const ratio = measuredWidth / surfaceWidth;
        let multiplier = policy.shortMultiplier || 1;
        if (ratio >= policy.veryLongWidthRatio * 1.5) multiplier = policy.extremeMultiplier || policy.veryLongMultiplier;
        else if (ratio >= policy.veryLongWidthRatio) multiplier = policy.veryLongMultiplier;
        else if (ratio >= policy.longWidthRatio) multiplier = policy.longMultiplier;
        else if (ratio >= policy.mediumWidthRatio) multiplier = policy.mediumMultiplier;
        return Math.min(maximumSpeed, baseVelocity * multiplier);
    }

    function stableOrigin(value, count) {
        if (!Number.isInteger(count) || count <= 0) return 0;
        const text = typeof value === 'string' ? value : '';
        let hash = 0;
        for (let index = 0; index < text.length; index += 1) hash = (hash * 33 + text.charCodeAt(index)) >>> 0;
        return hash % count;
    }

    function rankLanePlacements(candidates, activeComments, preferredSeed = '') {
        if (!Array.isArray(candidates) || !Array.isArray(activeComments)) return Object.freeze([]);
        const activeByAnchor = new Map();
        for (const active of activeComments) {
            if (!Number.isInteger(active?.anchorIndex) || !Number.isFinite(active.x) || !Number.isFinite(active.width)) continue;
            const current = activeByAnchor.get(active.anchorIndex);
            if (!current || active.x + active.width > current.x + current.width) activeByAnchor.set(active.anchorIndex, active);
        }
        const origin = stableOrigin(preferredSeed, Math.max(1, candidates.length));
        return Object.freeze(candidates.map((candidate, ordinal) => {
            const active = activeByAnchor.get(candidate.anchorIndex);
            const gap = active && Number.isFinite(candidate.rectangle?.x) ? candidate.rectangle.x - (active.x + active.width) : Infinity;
            return { candidate, ordinal, fillBehind: Number.isFinite(gap) && gap >= 0, residualGap: gap,
                phaseDistance: (ordinal - origin + candidates.length) % Math.max(1, candidates.length) };
        }).sort((left, right) => Number(right.fillBehind) - Number(left.fillBehind) ||
            left.residualGap - right.residualGap || left.phaseDistance - right.phaseDistance || left.ordinal - right.ordinal)
            .map(({ candidate }) => candidate));
    }

    function rankDensityRescuePlacements(primaryCandidates, secondaryCandidates, activeComments, preferredSeed, density) {
        const primary = rankLanePlacements(primaryCandidates, activeComments, preferredSeed);
        const secondary = rankLanePlacements(secondaryCandidates, activeComments, preferredSeed);
        if (density === 'COMPACT') return Object.freeze([...primary, ...secondary]);
        return rankLanePlacements([...primaryCandidates, ...secondaryCandidates], activeComments, preferredSeed);
    }

    function buildSyntheticTuningMatrix(config, { surfaceWidth = 1280, surfaceHeight = 360, captionReserve = 2 } = {}) {
        if (!config || !Number.isFinite(surfaceWidth) || !Number.isFinite(surfaceHeight) || surfaceWidth <= 0 || surfaceHeight <= 0) return null;
        const safeLanes = Math.max(0, Math.floor(surfaceHeight / (config.lineHeight + config.laneGap)) - captionReserve);
        const scenarios = [
            ['low', 'NORMAL', 'UPPER', 'CONSERVATIVE', 8],
            ['medium', 'COMPACT', 'UPPER_TO_MID', 'LIMITED_CATCH_UP', 18],
            ['high', 'DENSE', 'BROAD', 'BOUNDED_OVERLAP', 36],
            ['burst', 'MAX_READABLE', 'FULL_SAFE', 'MAXIMUM_READABLE_RESCUE', 60]
        ].map(([name, density, band, allowanceName, arrivals]) => {
            const lanes = Math.min(safeLanes, Math.max(1, Math.ceil(safeLanes * config.laneBandFractions[band])));
            const allowance = config.collisionAllowances[allowanceName];
            const stride = config.interleavedAnchorStride?.[density] || 0;
            const interleavedLaneUsage = stride > 0 ? Math.floor(Math.max(0, lanes - 1) / stride) : 0;
            const anchors = lanes + interleavedLaneUsage;
            const rescueCapacity = Math.floor(anchors * 2 * (1 + allowance.maxCatchUpRatio * 0.5 + allowance.maxOverlapDepthRatio));
            const launchCount = Math.min(arrivals, rescueCapacity);
            const rejected = Math.max(0, arrivals - launchCount);
            const noSafeLaneCount = Math.max(0, rejected - Math.ceil(anchors / 2));
            const collisionBlockedCount = rejected - noSafeLaneCount;
            const fillBehindSuccessCount = Math.min(launchCount, Math.floor(launchCount * Math.min(0.8, allowance.maxCatchUpRatio + 0.1)));
            return Object.freeze({ name, arrivals, launchCount, staleDropCount: noSafeLaneCount,
                collisionBlockedCount, noSafeLaneCount, laneUsageSpread: lanes / Math.max(1, safeLanes), interleavedLaneUsage,
                fillBehindSuccessCount, verticalExpansionCount: launchCount - fillBehindSuccessCount,
                averageTrailingGapUtilization: launchCount ? fillBehindSuccessCount / launchCount : 0 });
        });
        const widths = Object.freeze({ short: 160, medium: 360, long: 720, veryLong: 1100 });
        const occupancy = Object.fromEntries(Object.entries(widths).map(([name, width]) => {
            const base = Math.min(config.maximumSpeed, Math.max(config.minimumSpeed, (surfaceWidth + width) / 10));
            const velocity = applyLengthAwareVelocity(base, width, surfaceWidth, config.lengthVelocity, config.maximumSpeed);
            return [name, Object.freeze({ velocity, relativeOccupancy: (surfaceWidth + width) / velocity })];
        }));
        const specialWidths = [320, 1200, 2100];
        const maximumWidth = Math.min(surfaceWidth * config.specialMaximumWidthFraction, config.specialMaximumWidthPx);
        const minimumScale = config.specialMinimumBodyFontSize / config.fontSize;
        const unrepresentableSpecialCount = specialWidths.filter((width) => width * minimumScale > maximumWidth).length;
        const high = scenarios.find(({ name }) => name === 'high');
        const longOccupancy = occupancy.long.relativeOccupancy;
        const baselineOccupancy = 10;
        const longNormalLaunchRate = Math.min(1, high.launchCount / high.arrivals * baselineOccupancy / longOccupancy);
        const longSpecialLaunchRate = Math.max(0, longNormalLaunchRate * (1 - unrepresentableSpecialCount / specialWidths.length));
        return Object.freeze({ scenarios: Object.freeze(scenarios), occupancy: Object.freeze(occupancy),
            unrepresentableSpecialCount, longNormalLaunchRate, longSpecialLaunchRate,
            longDropCauses: Object.freeze({ UNREPRESENTABLE: unrepresentableSpecialCount, STALE: high.staleDropCount,
                COLLISION_BLOCKED: high.collisionBlockedCount, NO_SAFE_LANE: high.noSafeLaneCount, OTHER: 0 }) });
    }

    const api = Object.freeze({ BASELINE, CURRENT, applyLengthAwareVelocity, rankLanePlacements, rankDensityRescuePlacements, buildSyntheticTuningMatrix });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowPhase5Tuning = api;
})(typeof window !== 'undefined' ? window : globalThis);
