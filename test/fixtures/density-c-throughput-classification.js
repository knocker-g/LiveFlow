// Offline causal discriminator. Never imported by Production.
const { candidates, candidateC, run } = require('./final-visual-candidates.js');
const foundations = require('../../src/scheduler-foundations.js');
const overlap = require('../../src/normal-overlap-policy.js');
const group = reason => /DURATION|HISTORY/.test(reason) ? 'HISTORY_DURATION'
    : /AGGREGATE|CONCURRENCY/.test(reason) ? 'AGGREGATE_BUDGET'
    : /DEPTH|FLOOR|CATCH_UP|GAP|COLLISION/.test(reason) ? 'PAIR_COLLISION' : 'OTHER_EXPLICIT';
const summary = ({ frames, launchesDetail, ...rest }) => rest;
const count = list => list.reduce((r, key) => (r[key] = (r[key] || 0) + 1, r), {});
function investigate(shape) {
    const audits = new Map();
    let safeBaseSelectionFailure = 0, halfLaunchedWithSafeBase = 0;
    const b = run(candidates[2].config, shape);
    const c = run(candidateC.config, shape, { onCandidates({ id, at, density, candidates: lanes, active }) {
        const allowance = candidateC.config.collisionAllowances[foundations.getDensityVisualPolicy(density).collisionAllowanceClass];
        const results = lanes.map(lane => ({ lane: lane.lane, interleaved: lane.interleaved,
            c: overlap.prove(lane.rectangle, active, allowance, overlap.C, ['DENSE', 'MAX_READABLE'].includes(density)),
            b: foundations.proveBoundedCollisionSafe(lane.rectangle, active, allowance) }));
        const entry = { at, density, results, firstSafe: results.find(r => r.c.safe) || null };
        if (!audits.has(id)) audits.set(id, []);
        audits.get(id).push(entry);
    }, onLaunch({ id, at, proof }) {
        const evaluation = audits.get(id)?.at(-1);
        if (!evaluation || evaluation.at !== at || evaluation.firstSafe?.lane !== proof.lane) safeBaseSelectionFailure++;
        if (proof.interleaved && evaluation?.results.some(r => r.c.safe && !r.interleaved)) halfLaunchedWithSafeBase++;
    } });
    // One intervention only: remove the all-interleaved-first ordering; C safety stays identical.
    const corrected = run(candidateC.config, shape, { preferInterleaved: false });
    const ids = r => new Set(r.launchesDetail.map(a => a.id));
    const bIds = ids(b), cIds = ids(c), correctedIds = ids(corrected);
    const missing = [...bIds].filter(id => !cIds.has(id));
    const rows = missing.map(id => {
        const evaluations = audits.get(id) || [];
        const safe = evaluations.find(e => e.firstSafe);
        const bCompatible = evaluations.filter(e => e.results.some(r => r.b.safe));
        const last = bCompatible.at(-1) || evaluations.at(-1);
        const representative = last?.results.find(r => r.b.safe && !r.c.safe) || last?.results[0];
        // Exclusive precedence: ranking intervention recovery > observed safe selection > never evaluated > binding rejection.
        const cause = correctedIds.has(id) ? 'RANKING_RECOVERED'
            : safe ? 'SAFE_CANDIDATE_NOT_SELECTED' : !last ? 'NOT_EVALUATED'
            : group(representative.c.reason);
        return { id, cause, recoveredByRanking: correctedIds.has(id), evaluations: evaluations.length,
            at: last?.at ?? null, density: last?.density ?? null,
            representativeLane: representative?.lane ?? null, reason: representative?.c.reason ?? null,
            sameStateBSafe: Boolean(representative?.b.safe),
            safeBaseObserved: evaluations.some(e => e.results.some(r => r.c.safe && !r.interleaved)) };
    });
    const all = [...audits.values()].flat();
    const missedSafeBaseEvaluation = all.filter(e => !e.firstSafe && e.results.some(r => r.c.safe && !r.interleaved)).length;
    const halfChosenWithSafeBase = all.filter(e => e.firstSafe?.interleaved && e.results.some(r => r.c.safe && !r.interleaved)).length;
    return { shape, b: summary(b), c: summary(c), corrected: summary(corrected),
        bOnly: missing.length, cOnly: [...cIds].filter(id => !bIds.has(id)).length,
        classified: count(rows.map(r => r.cause)), rows,
        sameStateBSafeCBlocked: count(all.flatMap(e => e.results.filter(r => r.b.safe && !r.c.safe).map(r => r.c.reason))),
        safeBaseSelectionFailure, missedSafeBaseEvaluation, halfChosenWithSafeBase, halfLaunchedWithSafeBase,
        intervention: 'B ranking with identical C safety; no scalar changes' };
}
module.exports = { investigate, group };
if (require.main === module) {
    const results = ['HIGH', 'BURST'].map(investigate);
    require('node:fs').writeFileSync(require('node:path').resolve(__dirname, '../../docs/density-c-throughput-classification.json'), JSON.stringify(results, null, 2) + '\n');
    for (const r of results) console.log(JSON.stringify({shape:r.shape,bOnly:r.bOnly,cOnly:r.cOnly,classified:r.classified,sameState:r.sameStateBSafeCBlocked,safeBaseSelectionFailure:r.safeBaseSelectionFailure,halfLaunchedWithSafeBase:r.halfLaunchedWithSafeBase,halfChosenWithSafeBase:r.halfChosenWithSafeBase,corrected:{launch:r.corrected.launches,visible:r.corrected.averageVisible,drop:r.corrected.drops,overlap:r.corrected.normalOverlap}}));
}
