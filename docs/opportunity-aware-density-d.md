# Opportunity-aware Density D ? 2026-10-11

STATUS: FOLLOWUP_REQUIRED. One fixture-only D evaluated; HIGH restores B launch count with bounded cross-row overlap, BURST retains7-launch deficit. No final Human PASS or Production adoption. Starting HEAD d3a4f4a24a91b001befe0c83817a7ebb9f530a26.

Authority: latest KNO-208 Product follow-up explicitly authorizes one cheap selection candidate; related Locked Decisions5 and scoped NORMAL Gate; Architecture12/13/14/27 plus scoped elapsed-history clarification. No new Safety/Architecture contract is needed for this snapshot ordering experiment. Existing dirty replay-schema-probe and unrelated docs/tools remain excluded.

## Rule and limits

Input is the existing generated rectangle/lane metadata, density, current active geometry, and EXACT C collision proof. Only DENSE/MAX_READABLE NORMAL candidates are eligible; SPECIAL/unknown/other density get no promotion. Reuse existing Renderer bounds20 logical lanes/40 active comments; over40 placements or40 active => unchanged B ordering and ordinary mandatory proof. No new scalar budget.

1. Start with existing B occupancy ordering; prove each current placement under unchanged C policy once for selection.
2. Find currently safe base placements. For a proposed placement, count how many of those base rectangles its vertical footprint intersects. A new right-edge box immediately blocks an otherwise-identical incoming box on those anchors, so this is a conservative same-snapshot opportunity proxy.
3. First safe base is default. Promote the first B-ordered safe half-step only if its count is no larger than that base's count (normally1). If no safe base exists, use the first proved-safe half-step. Never discard base candidates: keep the entire permutation for the unchanged Scheduler final proof.
4. Runtime still performs its original complete proof; selection does not issue launch authority or bypass pair/aggregate/history, subtitle or SPECIAL constraints. No new trajectories, stale/time/source rules, lanes, reservation, asynchronous search or future source oracle.

This is a local occupancy proxy, NOT proof of future throughput. It discounts currently unsafe anchors; it cannot know when they regain usefulness or the next message's width/velocity. Selection adds one proof pass over supplied placements and simple interval counts; maximum15 placement proofs per item observed, bounded by existing ceilings (cohort scan remains5). This is fixture-only, not an unmeasured Production performance claim.

## Identical episode comparison

|Shape|Variant|Launch|Avg/peak visible|Capacity/stale|Base/half-step|
|---|---|---:|---|---|---|
|HIGH|B|60|21.24/24|6/1|54/6|
|HIGH|C|57|19.84/22|9/1|14/43|
|HIGH|C-selection|65|22.37/25|1/1|65/0|
|HIGH|D|60|20.67/24|6/1|17/43|
|BURST|B|81|28.41/32|83/3|81/0|
|BURST|C|73|25.54/29|91/3|7/66|
|BURST|C-selection|80|27.95/31|84/3|80/0|
|BURST|D|74|25.92/29|90/3|16/58|

D restores HIGH count relative B (avg visible -2.7%), improves original C by3 HIGH/1 BURST launches. BURST is7 fewer launches (-8.6%) and average visible -8.8% relative B, still substantially below C-selection. No exact Product numeric target is invented; both-goal closure remains unproven, so do not force a success classification or produce D2.

## Actual overlap and catch-up

New analytical measurement reconstructs executed immutable straight trajectories from each launch's initialX/time/velocity. It clips to the actual fixture surface and evaluates interval entry/exit plus edge alignments; no200ms sampling-only inference. This exposes sub-frame intervals absent from the previous sample metrics. All measurements NORMAL?NORMAL; vertical means different rows. Maximum pair area and duration are separate maxima, not simultaneous events or aggregate budgets.

|Shape/variant|Vertical depth / max area / max duration|Horizontal depth / max overlap duration|Closing catch-up approach / duration|
|---|---|---|---|
|HIGH B|0 /0 /0|19.43px /1.131s|22.42px /1.131s|
|HIGH C|16px /969.70px? /1.277s|60.61px /1.277s|79.71px /1.277s|
|HIGH C-selection|0 /0 /0|0 /0|0 /0|
|HIGH D|16px /966.17px? /1.273s|60.39px /1.273s|0 /0|
|BURST B|0 /0 /0|0.99px /0.021s|0 /0|
|BURST C|16px /776.09px? /1.022s|48.51px /1.022s|0 /0|
|BURST C-selection|0 /0 /0|0 /0|0 /0|
|BURST D|16px /399.84px? /1.154s|24.99px /1.154s|0 /0|

D actual cross-row overlapping pairs3 HIGH /4 BURST. D overlaps open/separate as trajectories progress; faster-follower closing catch-up is0. Do not label initial overlap as observed overtaking/catch-up. Selection promotes with a safe base available27 HIGH /39 BURST actual launches; fallback with no safe base16/19. At most1 currently safe base anchor is intersected by those choices.

## Rejection and lost opportunities

Diagnostic first-proof rejections over ALL candidates, including candidates not reached by final Scheduler traversal (repeated evaluations, not unique messages or terminal Drops):

* D HIGH: HARD_READABILITY_FLOOR4889; NORMAL_OVERLAP_DEPTH4008; NORMAL_OVERLAP_DURATION912; EXCESSIVE_OVERLAP_DURATION42; AGGREGATE_VISIBILITY17.
* D BURST: HARD_READABILITY_FLOOR3176; NORMAL_OVERLAP_DEPTH904; NORMAL_OVERLAP_DURATION230; AGGREGATE_VISIBILITY9; EXCESSIVE_OVERLAP_DURATION3.

Other variants' complete reason histograms are in density-d-results.json. All returns use unchanged first-failure policy; masked constraints are not enumerated. HARD_READABILITY_FLOOR/aggregate budgets are never bypassed by D.

Episode identity comparison B versus D: HIGH B-only fixed-43, D-only fixed-61 (net0); BURST B-only fixed-26, fixed-50, fixed-70, fixed-97, fixed-117, fixed-137, fixed-157 and D-only none (net-7). These are episode-level lost opportunities, not claims of same-opportunity failure. A cost<=1 at one snapshot cannot guarantee preservation of an unsafe neighbouring corridor after it recovers; burst growth/aggregate constraints remain the design limit.

## Verification / reuse

Same HIGH/BURST8 episodes recorded once for the extended four-way metrics and identity/rejection evidence; old B/C/C-selection totals exactly match saved classification report. Their executions are necessary for previously absent exact area/catch-up/identity data, not reassurance. Existing155 safety PASS and prior review remain valid because Production Safety source is untouched and were not rerun.

New targeted5 tests PASS: safe-base retention when half-step affects two safe anchors; bounded promotion/fallback; history/aggregate rejection cannot be bypassed; existing input cap; sub200ms analytical metric; captured consistency/accounting. Syntax4 changed/new JS PASS; diff check PASS. All selected placements passed unchanged proof; SPECIAL base/full68px and subtitle travel strip violations0; lostUnaccounted0/pending0/emergency0; SPECIAL counts1 HIGH /2 BURST; stale1/3. Original fixture retains max-one-launch assertion. No READ-only/authority/source/stale/active/typography edits; no full suite, Browser retry, live request or Production manifest/default change.

Files: fixture selection hook, two experiment/measurement modules, targeted test, JSON report, this checkpoint. Reproduce only if evidence invalidated: node test/fixtures/density-d-comparison.js. Tests read the captured report instead of re-executing episodes.

## Stop and next action

Stop after this single D. D is a safe fixture comparison candidate, not final CANDIDATE_READY_FOR_HUMAN runtime evidence. HIGH shows both goals locally; BURST still loses7/81 launches and overlap only4 pairs. Human/Product must decide whether this partial throughput recovery is acceptable for bounded real-video comparison, or reject/re-scope the placement goal. If comparison is authorized and Browser later enabled, qualify an isolated D comparison build and use one short same-condition episode with Typography A. Do not auto-tune, relax Safety, enable D in Production, retry unavailable Edge or begin another issue.
