(function (global) {
    const foundations = typeof module !== 'undefined' && module.exports ? require('./scheduler-foundations.js') : global.LiveFlowSchedulerFoundations;
    const C = Object.freeze({ maximumVerticalFraction: .5, maximumHorizontalFraction: .35,
        maximumPairAreaFraction: .18, maximumDuration: 1.4, maximumCatchUpRatio: 1,
        minimumVisibleFraction: .65, minimumClippedVisibleFraction: .5, maximumNeighbours: 2 });
    const valid = r => r && ['x', 'y', 'width', 'height', 'velocity', 'exitX', 'surfaceRight'].every(k => Number.isFinite(r[k])) &&
        r.width > 0 && r.height > 0 && r.velocity > 0 && r.surfaceRight > r.exitX &&
        (r.occlusionEpisodes === undefined || (Array.isArray(r.occlusionEpisodes) && r.occlusionEpisodes.every(i =>
            Array.isArray(i) && i.length === 2 && i.every(Number.isFinite) && i[1] >= i[0])));
    const vertical = (a, b) => Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const exit = r => Math.max(0, (r.x + r.width - r.exitX) / r.velocity);
    const left = (r, t) => r.x - r.velocity * t;
    const visibleWidth = (r, t) => Math.max(0, Math.min(r.surfaceRight, left(r, t) + r.width) - Math.max(r.exitX, left(r, t)));
    const intersection = (a, b, t, clipped = false) => Math.max(0,
        Math.min(left(a, t) + a.width, left(b, t) + b.width, clipped ? a.surfaceRight : Infinity) -
        Math.max(left(a, t), left(b, t), clipped ? a.exitX : -Infinity));

    function pair(a, b) {
        const horizon = Math.min(exit(a), exit(b));
        const delta = a.x - b.x, closing = a.velocity - b.velocity;
        let start = 0, end = horizon;
        if (closing === 0) { if (delta >= b.width || delta <= -a.width) end = 0; }
        else {
            const times = [(delta - b.width) / closing, (delta + a.width) / closing];
            start = Math.max(0, Math.min(...times)); end = Math.min(horizon, Math.max(...times));
        }
        const edges = [0, horizon, start, end];
        if (closing !== 0) edges.push(delta / closing, (delta + a.width - b.width) / closing);
        for (const r of [a, b]) for (const x of [r.exitX, r.surfaceRight]) {
            edges.push((r.x - x) / r.velocity, (r.x + r.width - x) / r.velocity);
        }
        const times = [...new Set(edges.filter(t => t >= 0 && t <= horizon))].sort((a, b) => a - b);
        const maximumDepth = Math.max(0, ...times.map(t => intersection(a, b, t)));
        const visibleStart = Math.max(start, 0, (a.x - a.surfaceRight) / a.velocity, (b.x - b.surfaceRight) / b.velocity);
        return { times, horizon, start: visibleStart, end, maximumDepth, duration: Math.max(0, end - visibleStart) };
    }

    function mergeIntervals(intervals) {
        const merged = [];
        for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
            const last = merged[merged.length - 1];
            if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
            else merged.push([...interval]);
        }
        return merged;
    }

    function episodeIntervals(subject, neighbours, at) {
        return mergeIntervals([...(subject.occlusionEpisodes || []).filter(i => i[1] >= at).map(i => [...i]),
            ...neighbours.filter(r => vertical(subject, r) > 0).map(r => pair(subject, r))
                .filter(p => p.end > p.start).map(p => [at + p.start, at + p.end])]);
    }

    function recordEpisodes(candidate, active, at) {
        const objects = [candidate, ...active];
        return objects.map(subject => subject.semanticClass === 'NORMAL'
            ? Object.freeze(episodeIntervals(subject, objects.filter(r => r !== subject), at).map(i => Object.freeze(i)))
            : Object.freeze([]));
    }

    function aggregate(subject, neighbours, policy, at) {
        const related = neighbours.filter(r => vertical(subject, r) > 0).map(r => ({ r, p: pair(subject, r) }));
        if (!subject.occlusionHistoryKnown && related.some(({ r }) => intersection(subject, r, 0, true) > 0)) return 'OVERLAP_HISTORY_UNKNOWN';
        const intervals = episodeIntervals(subject, neighbours, at);
        let start = null, end = null;
        for (const interval of intervals) {
            if (start === null || interval[0] > end) { start = interval[0]; end = interval[1]; }
            else end = Math.max(end, interval[1]);
            if (end - start > policy.maximumDuration) return 'AGGREGATE_OVERLAP_DURATION';
        }
        const times = [...new Set([0, exit(subject), ...related.flatMap(({ p }) => p.times)])].filter(t => t <= exit(subject)).sort((a, b) => a - b);
        function values(t) {
            return { width: visibleWidth(subject, t), area: related.reduce((sum, { r }) =>
                sum + intersection(subject, r, t, true) * vertical(subject, r), 0) };
        }
        for (let i = 1; i < times.length; i++) {
            const lo = times[i - 1], hi = times[i], mid = (lo + hi) / 2;
            const v = values(mid);
            if (v.width <= 0) continue; // entry has its own future intervals; exit has none
            const count = related.filter(({ r }) => intersection(subject, r, mid, true) > 0).length;
            if (count > policy.maximumNeighbours) return 'OVERLAP_CONCURRENCY';
            const full = v.width >= subject.width;
            const floor = full ? policy.minimumVisibleFraction : policy.minimumClippedVisibleFraction;
            for (const t of [lo, mid, hi]) {
                const value = values(t);
                // Both numerator and denominator are affine on this segment; at a zero-width edge,
                // their one-sided ratio equals the interior ratio. This is not a sampled trajectory proof.
                const fraction = value.width > 0 ? value.area / (value.width * subject.height) : v.area / (v.width * subject.height);
                if (1 - fraction < floor - 1e-10) return 'AGGREGATE_VISIBILITY';
                if (value.width >= subject.width && 1 - fraction < policy.minimumVisibleFraction - 1e-10) return 'AGGREGATE_VISIBILITY';
            }
        }
        return null;
    }

    function prove(candidate, active, allowance, policy = C, relax = true) {
        const strict = () => foundations.proveBoundedCollisionSafe(candidate, active, allowance);
        if (!policy) return strict();
        const canRelax = relax && candidate?.semanticClass === 'NORMAL';
        if (!canRelax) { const result = strict(); if (!result.safe) return result; }
        if (!Object.values(policy).every(Number.isFinite) || !Object.keys(C).every(k => Number.isFinite(policy[k])) ||
            !Number.isInteger(policy.maximumNeighbours) || policy.maximumNeighbours < 1 || policy.maximumDuration < 0 || policy.maximumCatchUpRatio < 0 ||
            ['maximumVerticalFraction', 'maximumHorizontalFraction', 'maximumPairAreaFraction', 'minimumVisibleFraction', 'minimumClippedVisibleFraction'].some(k => policy[k] < 0 || policy[k] > 1)) {
            return Object.freeze({ safe: false, reason: 'INVALID_OVERLAP_POLICY' });
        }
        if (!valid(candidate) || !Array.isArray(active) || active.some(r => !valid(r) || r.exitX !== candidate.exitX || r.surfaceRight !== candidate.surfaceRight)) {
            return Object.freeze({ safe: false, reason: 'INVALID_OVERLAP_GEOMETRY' });
        }
        const affected = [];
        const at = Number.isFinite(candidate.snapshotAt) ? candidate.snapshotAt : 0;
        for (const a of active) {
            const v = vertical(candidate, a);
            if (!v) continue;
            const p = pair(candidate, a);
            const shallow = canRelax && a.semanticClass === 'NORMAL' && v / candidate.height <= policy.maximumVerticalFraction && v / a.height <= policy.maximumVerticalFraction;
            if (!shallow) {
                const result = foundations.proveBoundedCollisionSafe(candidate, [a], allowance);
                if (!result.safe) return result;
            } else {
                if (p.maximumDepth / candidate.width > policy.maximumHorizontalFraction || p.maximumDepth / a.width > policy.maximumHorizontalFraction ||
                    p.maximumDepth * v / (candidate.width * candidate.height) > policy.maximumPairAreaFraction ||
                    p.maximumDepth * v / (a.width * a.height) > policy.maximumPairAreaFraction) return Object.freeze({ safe: false, reason: 'NORMAL_OVERLAP_DEPTH' });
                if (p.duration > policy.maximumDuration) return Object.freeze({ safe: false, reason: 'NORMAL_OVERLAP_DURATION' });
                if (Math.max(0, candidate.velocity - a.velocity) * p.horizon / candidate.width > policy.maximumCatchUpRatio) return Object.freeze({ safe: false, reason: 'NORMAL_CATCH_UP' });
            }
            if (p.duration > 0 && a.semanticClass === 'NORMAL') affected.push(a);
        }
        const objects = [candidate, ...active];
        for (const subject of [...(candidate.semanticClass === 'NORMAL' ? [candidate] : []), ...affected]) {
            const reason = aggregate(subject, objects.filter(r => r !== subject), policy, at);
            if (reason) return Object.freeze({ safe: false, reason });
        }
        return Object.freeze({ safe: true, reason: 'SAFE' });
    }
    function historyKnown(subject, neighbours) {
        return subject.occlusionHistoryKnown === true || !neighbours.some(r => vertical(subject, r) > 0 && intersection(subject, r, 0, true) > 0);
    }
    const api = Object.freeze({ C, prove, recordEpisodes, historyKnown });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.LiveFlowNormalOverlapPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);
