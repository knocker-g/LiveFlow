(function (global) {
    const commonJS = typeof module !== 'undefined' && module.exports;
    const foundations = commonJS ? require('./scheduler-foundations.js') : global.LiveFlowSchedulerFoundations;
    const overlap = commonJS ? require('./normal-overlap-policy.js') : global.LiveFlowNormalOverlapPolicy;
    const core = commonJS ? require('./overlay-core.js') : global.LiveFlowOverlayCore;
    const intersects = (a, b) => a.y < b.y + b.height && b.y < a.y + a.height;

    // Reorder only; the Runtime and Renderer still own launch safety/currentness.
    function select({ candidates, active, density, config }) {
        if (!['DENSE', 'MAX_READABLE'].includes(density) || candidates.length > core.DANMAKU_MAX_LANES * 2 ||
            active.length > core.DANMAKU_MAX_ACTIVE_COMMENTS || !config.normalOverlapPolicy ||
            candidates.some(c => c.rectangle.semanticClass !== 'NORMAL')) return { candidates };
        const allowance = config.collisionAllowances[foundations.getDensityVisualPolicy(density).collisionAllowanceClass];
        const proofs = candidates.map(candidate => ({ candidate,
            result: overlap.prove(candidate.rectangle, active, allowance, config.normalOverlapPolicy) }));
        const safeBase = proofs.filter(p => p.result.safe && !p.candidate.interleaved);
        const safeHalf = proofs.filter(p => p.result.safe && p.candidate.interleaved);
        const cost = candidate => safeBase.filter(p => intersects(candidate.rectangle, p.candidate.rectangle)).length;
        const base = safeBase[0]?.candidate;
        const eligible = base ? safeHalf.filter(p => cost(p.candidate) <= cost(base)) : safeHalf;
        const preferred = eligible[0]?.candidate || base;
        const rest = candidates.filter(c => c !== preferred);
        return { candidates: preferred ? [preferred, ...rest.filter(c => !c.interleaved), ...rest.filter(c => c.interleaved)] : candidates };
    }

    const api = Object.freeze({ select });
    if (commonJS) module.exports = api;
    global.LiveFlowOpportunityAwareDensity = api;
})(typeof window !== 'undefined' ? window : globalThis);
