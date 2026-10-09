(function (global) {
    const DENSITY_LEVELS = Object.freeze(['NORMAL', 'COMPACT', 'DENSE', 'MAX_READABLE']);
    const SOURCE_ACTIVITY_BANDS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'BURST']);
    const PROMOTION_PROVENANCE = Object.freeze(['SOURCE_ACTIVITY', 'PRESSURE_RESCUE', 'BOTH']);
    const LANE_BAND_CLASSES = Object.freeze(['UPPER', 'UPPER_TO_MID', 'BROAD', 'FULL_SAFE']);
    const COLLISION_ALLOWANCE_CLASSES = Object.freeze(['CONSERVATIVE', 'LIMITED_CATCH_UP', 'BOUNDED_OVERLAP', 'MAXIMUM_READABLE_RESCUE']);
    const SPECIAL_FIT_RESULTS = Object.freeze({ FIT: 'FIT', SCALED: 'SCALED', UNREPRESENTABLE: 'UNREPRESENTABLE_SPECIAL' });

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function computePressure({ pendingCount, oldestEligibleTemporalAge, pendingPressureCapacity, maxPendingAge } = {}) {
        if (![pendingCount, oldestEligibleTemporalAge, pendingPressureCapacity, maxPendingAge].every(Number.isFinite) ||
            pendingCount < 0 || oldestEligibleTemporalAge < 0 || pendingPressureCapacity <= 0 || maxPendingAge <= 0) return null;
        const Qc = clamp(pendingCount / pendingPressureCapacity, 0, 1);
        const Qa = clamp(oldestEligibleTemporalAge / maxPendingAge, 0, 1);
        return Object.freeze({ Qc, Qa, pressure: Math.max(Qc, Qa) });
    }

    function computePacing({ pressure, userBaseInterval, minimumInterval, maximumRescueFraction } = {}) {
        if (![pressure, userBaseInterval, minimumInterval, maximumRescueFraction].every(Number.isFinite) ||
            pressure < 0 || pressure > 1 || userBaseInterval <= 0 || minimumInterval <= 0 ||
            minimumInterval > userBaseInterval || maximumRescueFraction < 0 || maximumRescueFraction > 1) return null;
        const rescueIntensity = pressure;
        const requestedInterval = userBaseInterval * (1 - rescueIntensity * maximumRescueFraction);
        return Object.freeze({
            rescueIntensity,
            interval: clamp(requestedInterval, minimumInterval, userBaseInterval),
            credit: 0
        });
    }

    function validActivityBinding(binding) {
        return binding && binding.target !== undefined && binding.timeline !== undefined &&
            Number.isSafeInteger(binding.generation) && binding.generation >= 0;
    }

    function freezeActivityBinding(binding) {
        return Object.freeze({ target: binding.target, timeline: binding.timeline, generation: binding.generation });
    }

    function sameActivityBinding(left, right) {
        return validActivityBinding(left) && validActivityBinding(right) && left.target === right.target &&
            left.timeline === right.timeline && left.generation === right.generation;
    }

    function createSourceActivityState(binding, band = 'LOW', promotionEvidence = 0, releaseEvidence = 0) {
        if (!validActivityBinding(binding) || !SOURCE_ACTIVITY_BANDS.includes(band) ||
            !Number.isInteger(promotionEvidence) || promotionEvidence < 0 ||
            !Number.isInteger(releaseEvidence) || releaseEvidence < 0) return null;
        return Object.freeze({
            binding: freezeActivityBinding(binding),
            band,
            promotionEvidence,
            releaseEvidence
        });
    }

    function validActivityConfig({ bandThresholdsPerSecond, promotionResidence, releaseDwell } = {}) {
        return Array.isArray(bandThresholdsPerSecond) && bandThresholdsPerSecond.length === 3 &&
            bandThresholdsPerSecond.every((value, index) => Number.isFinite(value) && value > 0 &&
                (index === 0 || value > bandThresholdsPerSecond[index - 1])) &&
            Number.isInteger(promotionResidence) && promotionResidence > 0 &&
            Number.isInteger(releaseDwell) && releaseDwell > 0;
    }

    function sourceActivityBandForRate(rate, thresholds) {
        if (rate >= thresholds[2]) return 'BURST';
        if (rate >= thresholds[1]) return 'HIGH';
        if (rate >= thresholds[0]) return 'MEDIUM';
        return 'LOW';
    }

    function evaluateSourceActivity(state, snapshot, config) {
        if (!state || !validActivityBinding(state.binding) || !SOURCE_ACTIVITY_BANDS.includes(state.band) ||
            !snapshot || !validActivityBinding(snapshot.currentBinding) || !validActivityBinding(snapshot.eventBinding) ||
            !Number.isFinite(snapshot.windowStartMs) || !Number.isFinite(snapshot.windowEndMs) ||
            snapshot.windowEndMs <= snapshot.windowStartMs || !Array.isArray(snapshot.facts) ||
            !validActivityConfig(config)) return null;

        const bindingReset = !sameActivityBinding(state.binding, snapshot.currentBinding);
        const currentState = bindingReset ? createSourceActivityState(snapshot.currentBinding) : state;
        if (!sameActivityBinding(snapshot.eventBinding, snapshot.currentBinding)) {
            return Object.freeze({
                state: currentState,
                accepted: false,
                bindingReset,
                currentWindowCount: 0,
                observedRatePerSecond: 0,
                candidateBand: currentState.band,
                promoted: false,
                demoted: false
            });
        }

        const currentFacts = snapshot.facts.filter((fact) => fact && fact.displayable === true &&
            fact.temporalClass === 'CURRENT_WINDOW' && Number.isFinite(fact.mediaTimeMs) &&
            fact.mediaTimeMs >= snapshot.windowStartMs && fact.mediaTimeMs <= snapshot.windowEndMs);
        const observedRatePerSecond = currentFacts.length / ((snapshot.windowEndMs - snapshot.windowStartMs) / 1000);
        const candidateBand = sourceActivityBandForRate(observedRatePerSecond, config.bandThresholdsPerSecond);
        const currentIndex = SOURCE_ACTIVITY_BANDS.indexOf(currentState.band);
        const candidateIndex = SOURCE_ACTIVITY_BANDS.indexOf(candidateBand);
        let nextState = currentState;
        let promoted = false;
        let demoted = false;

        if (candidateIndex > currentIndex) {
            const promotionEvidence = currentState.promotionEvidence + 1;
            if (promotionEvidence >= config.promotionResidence) {
                nextState = createSourceActivityState(snapshot.currentBinding, SOURCE_ACTIVITY_BANDS[currentIndex + 1], 0, 0);
                promoted = true;
            } else {
                nextState = createSourceActivityState(snapshot.currentBinding, currentState.band, promotionEvidence, 0);
            }
        } else if (candidateIndex < currentIndex) {
            const releaseEvidence = currentState.releaseEvidence + 1;
            if (releaseEvidence >= config.releaseDwell) {
                nextState = createSourceActivityState(snapshot.currentBinding, SOURCE_ACTIVITY_BANDS[currentIndex - 1], 0, 0);
                demoted = true;
            } else {
                nextState = createSourceActivityState(snapshot.currentBinding, currentState.band, 0, releaseEvidence);
            }
        } else {
            nextState = createSourceActivityState(snapshot.currentBinding, currentState.band, 0, 0);
        }

        return Object.freeze({
            state: nextState,
            accepted: true,
            bindingReset,
            currentWindowCount: currentFacts.length,
            observedRatePerSecond,
            candidateBand,
            promoted,
            demoted
        });
    }

    function classifyPromotionProvenance({ sourceActivityPromotes, pressureRescuePromotes } = {}) {
        if (typeof sourceActivityPromotes !== 'boolean' || typeof pressureRescuePromotes !== 'boolean') return null;
        if (sourceActivityPromotes && pressureRescuePromotes) return 'BOTH';
        if (sourceActivityPromotes) return 'SOURCE_ACTIVITY';
        if (pressureRescuePromotes) return 'PRESSURE_RESCUE';
        return null;
    }

    function createDensityState(level = 'NORMAL', residence = 0, releaseEvidence = 0) {
        if (!DENSITY_LEVELS.includes(level) || !Number.isInteger(residence) || residence < 0 ||
            !Number.isInteger(releaseEvidence) || releaseEvidence < 0) return null;
        return Object.freeze({ level, residence, releaseEvidence });
    }

    function transitionDensity(state, pressure, { attackThresholds, releaseThresholds, minimumAttackResidence, releaseDwell } = {}) {
        if (!state || !DENSITY_LEVELS.includes(state.level) || !Number.isFinite(pressure) || pressure < 0 || pressure > 1 ||
            !Array.isArray(attackThresholds) || attackThresholds.length !== 3 ||
            !Array.isArray(releaseThresholds) || releaseThresholds.length !== 3 ||
            !attackThresholds.every(Number.isFinite) || !releaseThresholds.every(Number.isFinite) ||
            !Number.isInteger(minimumAttackResidence) || minimumAttackResidence < 0 ||
            !Number.isInteger(releaseDwell) || releaseDwell <= 0) return null;
        const index = DENSITY_LEVELS.indexOf(state.level);
        const residence = state.residence + 1;
        if (index < DENSITY_LEVELS.length - 1 && pressure >= attackThresholds[index] && residence >= minimumAttackResidence) {
            return createDensityState(DENSITY_LEVELS[index + 1], 0, 0);
        }
        const releaseEvidence = index > 0 && pressure <= releaseThresholds[index - 1] ? state.releaseEvidence + 1 : 0;
        if (index > 0 && residence >= minimumAttackResidence && releaseEvidence >= releaseDwell) {
            return createDensityState(DENSITY_LEVELS[index - 1], 0, 0);
        }
        return createDensityState(state.level, residence, releaseEvidence);
    }

    function transitionLowMediumDensity(state, { sourceActivityBand, pressure } = {}, config = {}) {
        const { attackThresholds, releaseThresholds, minimumAttackResidence, releaseDwell } = config;
        if (!state || !['NORMAL', 'COMPACT'].includes(state.level) ||
            !['LOW', 'MEDIUM'].includes(sourceActivityBand) || !Number.isFinite(pressure) || pressure < 0 || pressure > 1 ||
            !Array.isArray(attackThresholds) || attackThresholds.length !== 3 ||
            !Array.isArray(releaseThresholds) || releaseThresholds.length !== 3 ||
            !attackThresholds.every(Number.isFinite) || !releaseThresholds.every(Number.isFinite) ||
            !Number.isInteger(minimumAttackResidence) || minimumAttackResidence < 0 ||
            !Number.isInteger(releaseDwell) || releaseDwell <= 0) return null;

        const sourceActivityPromotes = state.level === 'NORMAL' && sourceActivityBand === 'MEDIUM';
        const pressureRescuePromotes = state.level === 'NORMAL' && pressure >= attackThresholds[0];
        const provenance = classifyPromotionProvenance({ sourceActivityPromotes, pressureRescuePromotes });
        const residence = state.residence + 1;

        if (provenance && residence >= minimumAttackResidence) {
            return Object.freeze({
                state: createDensityState('COMPACT', 0, 0),
                sourceActivityBand,
                pressure,
                provenance
            });
        }

        const releaseEligible = state.level === 'COMPACT' && sourceActivityBand === 'LOW' && pressure <= releaseThresholds[0];
        const releaseEvidence = releaseEligible ? state.releaseEvidence + 1 : 0;
        const release = releaseEligible && residence >= minimumAttackResidence && releaseEvidence >= releaseDwell;
        return Object.freeze({
            state: createDensityState(release ? 'NORMAL' : state.level, release ? 0 : residence, release ? 0 : releaseEvidence),
            sourceActivityBand,
            pressure,
            provenance: null
        });
    }

    function getDensityVisualPolicy(level) {
        const index = DENSITY_LEVELS.indexOf(level);
        if (index < 0) return null;
        return Object.freeze({ density: level, expansionLevel: index, maximumExpansionLevel: DENSITY_LEVELS.length - 1,
            laneBandClass: LANE_BAND_CLASSES[index], collisionAllowanceClass: COLLISION_ALLOWANCE_CLASSES[index] });
    }

    function selectDensityLaneBand(safeLanes, densityPolicy, bandFractions) {
        if (!Array.isArray(safeLanes) || !densityPolicy || !LANE_BAND_CLASSES.includes(densityPolicy.laneBandClass) ||
            !bandFractions || !LANE_BAND_CLASSES.every((name) => Number.isFinite(bandFractions[name]) && bandFractions[name] > 0 && bandFractions[name] <= 1)) return Object.freeze([]);
        if (safeLanes.length === 0) return Object.freeze([]);
        const fraction = bandFractions[densityPolicy.laneBandClass];
        return Object.freeze(safeLanes.slice(0, Math.max(1, Math.ceil(safeLanes.length * fraction))));
    }

    function selectDensityRescueLaneExpansion(safeLanes, densityPolicy, bandFractions) {
        if (!Array.isArray(safeLanes) || !densityPolicy || !DENSITY_LEVELS.includes(densityPolicy.density) ||
            !bandFractions) return Object.freeze([]);
        const densityIndex = DENSITY_LEVELS.indexOf(densityPolicy.density);
        if (densityIndex <= 0 || densityIndex >= DENSITY_LEVELS.length - 1) return Object.freeze([]);
        const currentBand = selectDensityLaneBand(safeLanes, densityPolicy, bandFractions);
        const expandedPolicy = getDensityVisualPolicy(DENSITY_LEVELS[densityIndex + 1]);
        const expandedBand = selectDensityLaneBand(safeLanes, expandedPolicy, bandFractions);
        return Object.freeze(expandedBand.slice(currentBand.length));
    }

    function greatestCommonDivisor(a, b) {
        let left = Math.abs(a);
        let right = Math.abs(b);
        while (right) [left, right] = [right, left % right];
        return left;
    }

    function rotatingModularStride(count, scanDepth, successfulLaunchSequence) {
        if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(scanDepth) || scanDepth <= 0 ||
            !Number.isSafeInteger(successfulLaunchSequence) || successfulLaunchSequence < 0) return Object.freeze([]);
        if (count === 1) return Object.freeze([0]);
        const boundedStrideCandidates = [5, 7, 11, 13, 17, 19, 23, 1];
        let stride = 1;
        for (let attempt = 0; attempt < boundedStrideCandidates.length; attempt += 1) {
            const candidate = boundedStrideCandidates[(successfulLaunchSequence + attempt) % boundedStrideCandidates.length];
            if (candidate < count && greatestCommonDivisor(candidate, count) === 1) {
                stride = candidate;
                break;
            }
        }
        const start = successfulLaunchSequence % count;
        const limit = Math.min(count, scanDepth);
        return Object.freeze(Array.from({ length: limit }, (_, step) => (start + step * stride) % count));
    }

    function finiteRectangle(rectangle) {
        return rectangle && ['x', 'y', 'width', 'height', 'velocity'].every((key) => Number.isFinite(rectangle[key])) &&
            rectangle.width > 0 && rectangle.height > 0 && rectangle.velocity > 0;
    }

    function proveCollisionSafe(candidate, activeComments, horizontalGap) {
        if (!finiteRectangle(candidate) || !Array.isArray(activeComments) || !Number.isFinite(horizontalGap) || horizontalGap < 0) {
            return Object.freeze({ safe: false, reason: 'INVALID_GEOMETRY' });
        }
        for (const active of activeComments) {
            if (!finiteRectangle(active)) return Object.freeze({ safe: false, reason: 'INVALID_GEOMETRY' });
            const verticalOverlap = candidate.y < active.y + active.height && active.y < candidate.y + candidate.height;
            if (!verticalOverlap) continue;
            const initialGap = candidate.x - (active.x + active.width);
            if (initialGap < horizontalGap) return Object.freeze({ safe: false, reason: 'READABILITY_GAP' });
            const coexistence = Math.max(0, (active.x + active.width) / active.velocity);
            const finalGap = initialGap + (active.velocity - candidate.velocity) * coexistence;
            if (Math.min(initialGap, finalGap) < horizontalGap) return Object.freeze({ safe: false, reason: 'TRAJECTORY_COLLISION' });
        }
        return Object.freeze({ safe: true, reason: 'SAFE' });
    }

    function proveBoundedCollisionSafe(candidate, activeComments, allowance) {
        const required = ['nominalGap', 'hardMinimumSeparation', 'maxCatchUpRatio', 'maxOverlapDuration', 'maxOverlapDepthRatio', 'minimumVisibleFraction'];
        if (!finiteRectangle(candidate) || !Array.isArray(activeComments) || !allowance ||
            !required.every((key) => Number.isFinite(allowance[key])) || allowance.nominalGap < 0 ||
            allowance.hardMinimumSeparation > allowance.nominalGap || allowance.maxCatchUpRatio < 0 ||
            allowance.maxOverlapDuration < 0 || allowance.maxOverlapDepthRatio < 0 || allowance.maxOverlapDepthRatio > 1 ||
            allowance.minimumVisibleFraction < 0 || allowance.minimumVisibleFraction > 1) {
            return Object.freeze({ safe: false, reason: 'INVALID_GEOMETRY_OR_POLICY' });
        }
        for (const active of activeComments) {
            if (!finiteRectangle(active)) return Object.freeze({ safe: false, reason: 'INVALID_GEOMETRY_OR_POLICY' });
            const verticalOverlap = candidate.y < active.y + active.height && active.y < candidate.y + candidate.height;
            if (!verticalOverlap) continue;
            const initialGap = candidate.x - (active.x + active.width);
            const coexistence = Math.max(0, (active.x + active.width) / active.velocity);
            const relativeClosingVelocity = Math.max(0, candidate.velocity - active.velocity);
            const catchUpDistance = relativeClosingVelocity * coexistence;
            const minimumGap = initialGap - catchUpDistance;
            const overlapDepth = Math.max(0, -minimumGap);
            const overlapBasis = Math.min(candidate.width, active.width);
            const overlapDepthRatio = overlapBasis > 0 ? overlapDepth / overlapBasis : Infinity;
            const visibleFraction = 1 - Math.min(1, overlapDepthRatio);
            const catchUpRatio = catchUpDistance / candidate.width;
            const overlapStartsAt = relativeClosingVelocity > 0 ? Math.max(0, initialGap / relativeClosingVelocity) : Infinity;
            const overlapDuration = minimumGap < 0 ? Math.max(0, coexistence - overlapStartsAt) : 0;
            if (initialGap >= allowance.nominalGap && minimumGap >= allowance.nominalGap) continue;
            if (minimumGap < allowance.hardMinimumSeparation) return Object.freeze({ safe: false, reason: 'HARD_READABILITY_FLOOR' });
            if (catchUpRatio > allowance.maxCatchUpRatio) return Object.freeze({ safe: false, reason: 'EXCESSIVE_CATCH_UP' });
            if (overlapDuration > allowance.maxOverlapDuration) return Object.freeze({ safe: false, reason: 'EXCESSIVE_OVERLAP_DURATION' });
            if (overlapDepthRatio > allowance.maxOverlapDepthRatio) return Object.freeze({ safe: false, reason: 'EXCESSIVE_OVERLAP_DEPTH' });
            if (visibleFraction < allowance.minimumVisibleFraction) return Object.freeze({ safe: false, reason: 'READABILITY_FLOOR' });
        }
        return Object.freeze({ safe: true, reason: 'SAFE' });
    }

    function isOutsideHardExclusions(rectangle, exclusionRegions) {
        if (!finiteRectangle(rectangle) || !Array.isArray(exclusionRegions) || exclusionRegions.some((region) =>
            !region || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(region[key])) || region.width <= 0 || region.height <= 0)) return false;
        return exclusionRegions.every((region) => !(rectangle.x < region.x + region.width && region.x < rectangle.x + rectangle.width &&
            rectangle.y < region.y + region.height && region.y < rectangle.y + rectangle.height));
    }

    function computeSpecialSingleLineFit({ headerNaturalWidth, bodyNaturalWidth, maximumWidth, baseBodyFontSize, minimumBodyFontSize } = {}) {
        if (![headerNaturalWidth, bodyNaturalWidth, maximumWidth, baseBodyFontSize, minimumBodyFontSize].every(Number.isFinite) ||
            headerNaturalWidth < 0 || bodyNaturalWidth < 0 || maximumWidth <= 0 || baseBodyFontSize <= 0 ||
            minimumBodyFontSize <= 0 || minimumBodyFontSize > baseBodyFontSize) return null;
        const fixed = Object.freeze({ headerLines: 1, bodyLines: 1, wrap: false, ellipsis: false, logicalLaneSpan: 1,
            footprintAuthority: 'POST_STYLE_TWO_LINE_RECTANGLE' });
        const minimumScale = minimumBodyFontSize / baseBodyFontSize;
        if (headerNaturalWidth > maximumWidth) return Object.freeze({ ...fixed, result: SPECIAL_FIT_RESULTS.UNREPRESENTABLE,
            bodyFontSize: minimumBodyFontSize, scale: minimumScale });
        if (bodyNaturalWidth <= maximumWidth) return Object.freeze({ ...fixed, result: SPECIAL_FIT_RESULTS.FIT,
            bodyFontSize: baseBodyFontSize, scale: 1 });
        const requestedScale = maximumWidth / bodyNaturalWidth;
        if (requestedScale < minimumScale) return Object.freeze({ ...fixed, result: SPECIAL_FIT_RESULTS.UNREPRESENTABLE,
            bodyFontSize: minimumBodyFontSize, scale: minimumScale });
        return Object.freeze({ ...fixed, result: SPECIAL_FIT_RESULTS.SCALED,
            bodyFontSize: baseBodyFontSize * requestedScale, scale: requestedScale });
    }

    function temporalCohort(items, { maximumItems, maximumSpan, timestamp = (item) => item?.enqueuedAt } = {}) {
        if (!Array.isArray(items) || !Number.isInteger(maximumItems) || maximumItems <= 0 ||
            !Number.isFinite(maximumSpan) || maximumSpan < 0 || typeof timestamp !== 'function') return Object.freeze([]);
        if (items.length === 0) return Object.freeze([]);
        const firstTime = timestamp(items[0]);
        if (!Number.isFinite(firstTime)) return Object.freeze([]);
        const cohort = [];
        for (let index = 0; index < items.length && cohort.length < maximumItems; index += 1) {
            const itemTime = timestamp(items[index]);
            if (!Number.isFinite(itemTime) || itemTime < firstTime || itemTime - firstTime > maximumSpan) break;
            cohort.push(Object.freeze({ index, item: items[index] }));
        }
        return Object.freeze(cohort);
    }

    function simulateClosedLoop({ steps, stepDuration, arrivalsAt, blockedUntil = () => -Infinity, config } = {}) {
        if (!Number.isInteger(steps) || steps <= 0 || !Number.isFinite(stepDuration) || stepDuration <= 0 ||
            typeof arrivalsAt !== 'function' || typeof blockedUntil !== 'function' || !config) return null;
        let queue = [];
        let density = createDensityState('NORMAL', config.density.minimumAttackResidence, 0);
        let successfulLaunchSequence = 0;
        let nextOpportunityAt = 0;
        let peakQueueDepth = 0;
        let staleDropCount = 0;
        let emergencyDropCount = 0;
        let maximumObservedPressure = 0;
        let maximumRescueIntensity = 0;
        let densityTransitions = 0;
        let previousDensity = density.level;
        let maximumLaunchedWait = 0;
        const trace = [];

        for (let step = 0; step < steps; step += 1) {
            const now = step * stepDuration;
            const arrivals = arrivalsAt(step, now);
            if (Array.isArray(arrivals)) queue.push(...arrivals.map((item, ordinal) => ({ ...item, enqueuedAt: now, simulationOrdinal: `${step}:${ordinal}` })));
            while (queue.length && now - queue[0].enqueuedAt > config.maxPendingAge) {
                queue.shift();
                staleDropCount += 1;
            }
            while (queue.length > config.maxPendingCount) {
                queue.shift();
                emergencyDropCount += 1;
            }
            const oldestAge = queue.length ? Math.max(0, now - queue[0].enqueuedAt) : 0;
            const pressure = computePressure({
                pendingCount: queue.length,
                oldestEligibleTemporalAge: oldestAge,
                pendingPressureCapacity: config.pendingPressureCapacity,
                maxPendingAge: config.maxPendingAge
            });
            const pacing = computePacing({ pressure: pressure.pressure, ...config.pacing });
            density = transitionDensity(density, pressure.pressure, config.density);
            if (density.level !== previousDensity) densityTransitions += 1;
            previousDensity = density.level;
            maximumObservedPressure = Math.max(maximumObservedPressure, pressure.pressure);
            maximumRescueIntensity = Math.max(maximumRescueIntensity, pacing.rescueIntensity);

            if (queue.length && now >= nextOpportunityAt) {
                const candidates = rotatingModularStride(queue.length, config.scanDepth, successfulLaunchSequence);
                const selected = candidates.find((index) => blockedUntil(queue[index], now) <= now);
                if (selected !== undefined) {
                    const [launched] = queue.splice(selected, 1);
                    maximumLaunchedWait = Math.max(maximumLaunchedWait, now - launched.enqueuedAt);
                    successfulLaunchSequence += 1;
                }
                nextOpportunityAt = now + pacing.interval;
            }
            peakQueueDepth = Math.max(peakQueueDepth, queue.length);
            trace.push(Object.freeze({
                currentQueueDepth: queue.length,
                oldestEligibleTemporalAge: oldestAge,
                Qc: pressure.Qc,
                Qa: pressure.Qa,
                pressure: pressure.pressure,
                density: density.level,
                successfulLaunchCount: successfulLaunchSequence,
                staleDropCount,
                emergencyDropCount
            }));
        }
        return Object.freeze({
            currentQueueDepth: queue.length,
            peakQueueDepth,
            successfulLaunchCount: successfulLaunchSequence,
            staleDropCount,
            emergencyDropCount,
            maximumObservedPressure,
            maximumRescueIntensity,
            densityTransitions,
            finalDensity: density.level,
            maximumLaunchedWait,
            trace: Object.freeze(trace)
        });
    }

    const api = {
        DENSITY_LEVELS,
        SOURCE_ACTIVITY_BANDS,
        PROMOTION_PROVENANCE,
        LANE_BAND_CLASSES,
        COLLISION_ALLOWANCE_CLASSES,
        SPECIAL_FIT_RESULTS,
        computePressure,
        computePacing,
        createSourceActivityState,
        evaluateSourceActivity,
        classifyPromotionProvenance,
        createDensityState,
        transitionDensity,
        transitionLowMediumDensity,
        getDensityVisualPolicy,
        selectDensityLaneBand,
        selectDensityRescueLaneExpansion,
        rotatingModularStride,
        proveCollisionSafe,
        proveBoundedCollisionSafe,
        isOutsideHardExclusions,
        computeSpecialSingleLineFit,
        temporalCohort,
        simulateClosedLoop
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowSchedulerFoundations = api;
})(typeof window !== 'undefined' ? window : globalThis);
