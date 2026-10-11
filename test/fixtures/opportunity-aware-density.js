// Candidate D experiment only. Not imported by the Production manifest.
const foundations = require('../../src/scheduler-foundations.js');
const overlap = require('../../src/normal-overlap-policy.js');
const core = require('../../src/overlay-core.js');
const intersects = (a, b) => a.y < b.y + b.height && b.y < a.y + a.height;
function select({ candidates, active, density, config }) {
    // Reuse existing Renderer lane/active ceilings; excessive input gets no experimental promotion.
    if (!['DENSE', 'MAX_READABLE'].includes(density) || candidates.length > core.DANMAKU_MAX_LANES * 2 ||
        active.length > core.DANMAKU_MAX_ACTIVE_COMMENTS || !config.normalOverlapPolicy ||
        candidates.some(c => c.rectangle.semanticClass !== 'NORMAL')) return { candidates, diagnostic: { promoted: false, fallback: true } };
    const allowance = config.collisionAllowances[foundations.getDensityVisualPolicy(density).collisionAllowanceClass];
    const proofs = candidates.map(candidate => ({ candidate,
        result: overlap.prove(candidate.rectangle, active, allowance, config.normalOverlapPolicy) }));
    const safeBase = proofs.filter(p => p.result.safe && !p.candidate.interleaved);
    const safeHalf = proofs.filter(p => p.result.safe && p.candidate.interleaved);
    // Snapshot opportunity proxy: same measured incoming box at existing safe base anchors.
    // A new right-edge footprint intersects these anchors immediately, so conservatively count them as foreclosed.
    // Ignore already-unsafe anchors; no future source/timing prediction or trajectory mutation.
    const cost = candidate => safeBase.filter(p => intersects(candidate.rectangle, p.candidate.rectangle)).length;
    const base = safeBase[0]?.candidate;
    const eligible = base ? safeHalf.filter(p => cost(p.candidate) <= cost(base)) : safeHalf;
    const preferred = eligible[0]?.candidate || base;
    const diagnostic = { promoted: Boolean(preferred?.interleaved), baseAvailable: Boolean(base),
        preferredLane: preferred?.lane ?? null, safeBaseCount: safeBase.length, safeHalfCount: safeHalf.length,
        foreclosedBaseCount: preferred ? cost(preferred) : null, baseCost: base ? cost(base) : null,
        proofCalls: proofs.length, rejected: proofs.filter(p => !p.result.safe).map(p => ({ lane: p.candidate.lane, reason: p.result.reason })) };
    const rest = candidates.filter(c => c !== preferred);
    return { candidates: preferred ? [preferred, ...rest.filter(c => !c.interleaved), ...rest.filter(c => c.interleaved)] : candidates,
        diagnostic };
}
module.exports = { select };
