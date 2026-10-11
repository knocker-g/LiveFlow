# Candidate C throughput classification ? 2026-10-11

STATUS: FOLLOWUP_REQUIRED (classification complete; Product packing/throughput tradeoff unresolved).
Starting HEAD:0d2cb2d7afc6137bfb554471b52f221c957d575c. Production source/config unchanged. C remains opt-in. Typography A unchanged. Existing dirty and untracked work preserved.

Authority: latest KNO-208 body/comments and canonical Architecture13/14 plus scoped NORMAL overlap Gate and elapsed-episode clarification. No safety relaxation, numeric change, architecture change or browser retry.

## Minimal discriminator

Reuse the exact HIGH/BURST fixture. Add offline hooks to inspect every generated placement before the existing Scheduler proof and verify the selected placement at actual launch. Hooks do not mutate state; captured B/C summaries exactly match the committed density-c-results.json. B/C executions are needed for message identities and same-state counterfactual proofs, not reassurance reruns of accepted tests.

Two comparisons must not be conflated:

* Same C state/candidate: evaluate unchanged B strict proof and C proof. When B is safe but C rejects, the observed first rejection is exclusively AGGREGATE_VISIBILITY (21 HIGH and13 BURST placement evaluations, including repeated comments). This is the summed visible-occlusion bound, not history/duration. These are supporting observations, not extra attributed comments.
* One full-episode intervention: keep the exact C safety policy and use the pre-existing B occupancy ranking instead of C's unconditional interleaved-first ordering. This changes prior placement choices and subsequent occupancy, not just the order at a blocked instant. No sweep or second correction.

## Exclusive message attribution

Population: messages B launched but original C never launched. HIGH5 IDs, BURST12 IDs. Original C additionally launched2 HIGH /4 BURST messages not launched by B; therefore net deficits3/8 are smaller than the attribution populations.

Assign one cause per ID with explicit priority:

1. Ranking intervention recovers the ID => RANKING_RECOVERED (episode-level counterfactual recovery; does not claim the only possible causal pathway).
2. Otherwise, C once proved a safe placement but never launched the ID => SAFE_CANDIDATE_NOT_SELECTED (cohort/opportunity selection, not necessarily lane selection).
3. Otherwise, no C evaluation => NOT_EVALUATED.
4. Otherwise inspect the last evaluation admitting B-safe placement in the SAME C state, or the last evaluation if none; take its first B-safe/C-rejected placement, or first ranked placement. Duration/history reason precedes aggregate budget category, pair collision category, then other explicit reason. Proofs return their first failure; this does not enumerate masked constraints.

| Exclusive cause | HIGH | BURST |
|---|---:|---:|
| Ranking recovered |5|9|
| Pair collision (HARD_READABILITY_FLOOR) |0|2|
| Aggregate visibility budget |0|1|
| History/duration |0|0|
| Safe candidate not selected / not evaluated / other |0|0|
| Total B-only IDs |5|12|

Remaining BURST IDs: fixed-26 and fixed-50 have pair hard-floor rejection, with B also blocked in their original C-state representative placement; fixed-46 has AGGREGATE_VISIBILITY where B is safe in the same state. Detailed per-ID witnesses, times, lanes and primary causes are stored in density-c-throughput-classification.json. Recovered IDs may have multiple rejection observations, but are counted only once under ranking.

No safe base placement was skipped by the candidate loop. Actual selected lane equals first safe ranked placement on every original C launch. Original C launched an interleaved placement despite a safe base being available32 HIGH /37 BURST times. The mechanism is indirect occupancy pressure: a half-row rectangle intersects two neighbouring base-row footprints, and prioritizing these placements creates later pair/aggregate constraints. It is not failure to try remaining base candidates at the same opportunity. Two recovered HIGH IDs had a safe interleaved placement observed but did not finally launch under original C; the ranking intervention changes the episode/cohort timeline.

## One correction candidate, fixture-only

Reproducible candidate: run(candidateC.config, shape, { preferInterleaved:false }). This uses the existing B ranking with C safety unchanged, including aggregate history and all strict-transition checks. Production standard and even the default fixture C ranking remain unchanged. No candidate is final locked.

| Shape / candidate | Launch | Average / peak visible | Capacity / stale Drop | Interleaved launch | NORMAL cross-row overlap |
|---|---:|---|---|---:|---|
| HIGH B |60|21.24/24|6/1|6|0px|
| HIGH C |57|19.84/22|9/1|43|16px|
| HIGH C-selection |65|22.37/25|1/1|0|0px|
| BURST B |81|28.41/32|83/3|0|0px|
| BURST C |73|25.54/29|91/3|66|16px|
| BURST C-selection |80|27.95/31|84/3|0|0px|

C-selection improves HIGH8 /BURST7 launches, reduces capacity Drops8/7, and restores near-B throughput without relaxing safety. However there is no sampled NORMAL overlap at all in this fixture under C-selection, and no interleaved launch. Throughput recovery does not establish the Human-requested vertical packing goal. Do not claim a final density solution or retain C merely because its extra overlap is demonstrated.

## Verification and protected evidence

Executed only the cause discriminator plus2 new report-validation tests: PASS. Tests verify unchanged B/C summaries, unique/exhaustive ID accounting, actual selection consistency, improvement and the lost-overlap tradeoff; they read the captured result instead of rerunning the episode. Syntax3 changed/new JS files PASS; git diff --check PASS.

Unchanged Production safety implementation means prior155 targeted PASS and independent review remain valid and were not rerun. All classifier episodes use original protected proof, travel-strip exclusion and existing max-one-launch assertions. All B/C/C-selection relevant runs: lostUnaccounted0, pending0, emergency0; SPECIAL launches remain1 HIGH /2 BURST; stale Drops1/3; source activity shapes unchanged. No READ-only/request, SPECIAL/subtitle, immutable active, stale, activity threshold or typography edits. No full suite or browser run.

## Stop / next exact action

Classification and one minimal intervention are complete. No safety relaxation was necessary for throughput recovery. Remaining Product decision is whether C-selection's better throughput without demonstrated vertical overlap is an acceptable comparison baseline, or whether another explicitly scoped placement-design task is needed to preserve both goals. Do not enable C in Production, tune further, alter safety or retry Edge automatically. Real-video visual decision remains pending; any future available-browser comparison comes after this classification and uses one short identical episode.
