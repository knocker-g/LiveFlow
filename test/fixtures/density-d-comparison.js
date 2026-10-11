// One D only; extended comparison metrics unavailable in earlier checkpoints.
const { candidates, candidateC, run } = require('./final-visual-candidates');
const foundations = require('../../src/scheduler-foundations');
const overlap = require('../../src/normal-overlap-policy');
const { select } = require('./opportunity-aware-density');
const summary = ({ frames, launchesDetail, ...s }) => s;
function pairMetrics(launches) {
    const out = { verticalDepthPx: 0, verticalAreaPx2: 0, verticalDurationSeconds: 0,
        horizontalDepthPx: 0, horizontalDurationSeconds: 0,
        catchUpDepthPx: 0, catchUpApproachPx: 0, catchUpDurationSeconds: 0, verticalPairs: 0 };
    for (let i = 0; i < launches.length; i++) for (let j = 0; j < i; j++) {
        const follower = launches[i], leader = launches[j];
        if (follower.special || leader.special) continue;
        const a = { ...follower, x: follower.initialX }, b = { ...leader,
            x: leader.initialX - leader.velocity * (follower.at - leader.at) / 1000 };
        const v = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        if (!v) continue;
        const closing = a.velocity - b.velocity, delta = a.x - b.x;
        let start = 0, end = Math.min((a.x + a.width - a.exitX) / a.velocity, (b.x + b.width - b.exitX) / b.velocity);
        if (closing === 0) { if (delta >= b.width || delta <= -a.width) continue; }
        else { const times = [(delta - b.width) / closing, (delta + a.width) / closing];
            start = Math.max(start, Math.min(...times)); end = Math.min(end, Math.max(...times)); }
        start = Math.max(start, (a.x - a.surfaceRight) / a.velocity, (b.x - b.surfaceRight) / b.velocity);
        if (end <= start) continue;
        const times = [start, end];
        if (closing !== 0) times.push(delta / closing, (delta + a.width - b.width) / closing);
        for (const r of [a, b]) for (const edge of [r.exitX, r.surfaceRight]) {
            times.push((r.x - edge) / r.velocity, (r.x + r.width - edge) / r.velocity);
        }
        const h = Math.max(0, ...times.filter(t => t >= start && t <= end).map(t => Math.max(0,
            Math.min(a.x - a.velocity * t + a.width, b.x - b.velocity * t + b.width, a.surfaceRight) -
            Math.max(a.x - a.velocity * t, b.x - b.velocity * t, a.exitX))));
        if (h <= 1e-9) continue;
        const duration = end - start;
        out.horizontalDepthPx = Math.max(out.horizontalDepthPx, h);
        out.horizontalDurationSeconds = Math.max(out.horizontalDurationSeconds, duration);
        if (a.y !== b.y) {
            out.verticalPairs++;
            out.verticalDepthPx = Math.max(out.verticalDepthPx, v);
            out.verticalAreaPx2 = Math.max(out.verticalAreaPx2, h * v);
            out.verticalDurationSeconds = Math.max(out.verticalDurationSeconds, duration);
        }
        if (closing > 0) {
            out.catchUpDepthPx = Math.max(out.catchUpDepthPx, h);
            out.catchUpApproachPx = Math.max(out.catchUpApproachPx, closing * duration);
            out.catchUpDurationSeconds = Math.max(out.catchUpDurationSeconds, duration);
        }
    }
    return out;
}
function compare(shape) {
    const variants = [ { name: 'B', config: candidates[2].config, options: {} },
        { name: 'C', config: candidateC.config, options: {} },
        { name: 'C-selection', config: candidateC.config, options: { preferInterleaved: false } },
        { name: 'D', config: candidateC.config, options: { preferInterleaved: false, selectCandidates: select } } ];
    const raw = [], output = [];
    for (const variant of variants) {
        const rejected = {}, last = new Map();
        let safeProofViolation = 0, subtitleViolation = 0, specialViolation = 0,
            promotedWithBase = 0, promotedWithoutBase = 0, maximumForeclosed = 0, maximumProofCalls = 0;
        const r = run(variant.config, shape, { ...variant.options,
            onCandidates({ id, candidates: lanes, active, density, selection }) {
                const allowance = variant.config.collisionAllowances[foundations.getDensityVisualPolicy(density).collisionAllowanceClass];
                const results = lanes.map(c => ({ candidate: c, result: variant.config.normalOverlapPolicy
                    ? overlap.prove(c.rectangle, active, allowance, variant.config.normalOverlapPolicy, ['DENSE', 'MAX_READABLE'].includes(density))
                    : foundations.proveBoundedCollisionSafe(c.rectangle, active, allowance) }));
                for (const p of results) if (!p.result.safe) rejected[p.result.reason] = (rejected[p.result.reason] || 0) + 1;
                last.set(id, { results, selection });
                maximumProofCalls = Math.max(maximumProofCalls, selection?.proofCalls || 0);
            }, onLaunch({ id, proof }) {
                const audit = last.get(id), observed = audit.results.find(p => p.candidate.lane === proof.lane);
                if (!observed?.result.safe) safeProofViolation++;
                if (!foundations.isOutsideHardExclusions({ ...proof.rectangle, ...proof.clearanceRectangle }, [{ x: 0, y: 256, width: 960, height: 64 }])) subtitleViolation++;
                if (proof.rectangle.semanticClass === 'SPECIAL' && (proof.interleaved || proof.rectangle.height !== 68)) specialViolation++;
                if (audit.selection?.promoted) {
                    if (audit.selection.baseAvailable) promotedWithBase++; else promotedWithoutBase++;
                    maximumForeclosed = Math.max(maximumForeclosed, audit.selection.foreclosedBaseCount);
                }
            } });
        raw.push(r);
        output.push({ name: variant.name, ...summary(r), baseLaunches: r.launches - r.interleaved,
            exactOverlap: pairMetrics(r.launchesDetail), rejectedCandidateReasons: rejected,
            safety: { safeProofViolation, subtitleViolation, specialViolation },
            selection: { promotedWithBase, promotedWithoutBase, maximumForeclosed, maximumProofCalls } });
    }
    const bIds = new Set(raw[0].launchesDetail.map(a => a.id)), dIds = new Set(raw[3].launchesDetail.map(a => a.id));
    return { shape, variants: output, lostOpportunities: {
        bOnlyIds: [...bIds].filter(id => !dIds.has(id)), dOnlyIds: [...dIds].filter(id => !bIds.has(id)),
        interpretation: 'episode-level identity comparison; local cost does not forecast recovery of presently blocked anchors' } };
}
module.exports = { compare, pairMetrics };
if (require.main === module) {
    const results = ['HIGH', 'BURST'].map(compare);
    require('fs').writeFileSync(require('path').resolve(__dirname, '../../docs/density-d-results.json'), JSON.stringify(results, null, 2) + '\n');
    for (const r of results) console.log(JSON.stringify(r));
}
