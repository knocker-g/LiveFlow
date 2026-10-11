# Human FAIL follow-up: separate offline comparisons

Starting HEAD: 43dc2c7ca771ec1793a8e555e8e4cd1f11d09de1. Latest KNO-208 Human Final Gate supersedes NO_TUNING_REQUIRED. Candidate tuning and typography are offline only. The sole Production change corrects initial-overlap duration accounting, without relaxing any bound. Open `final-visual-preview.html` locally; the time slider shows synchronized HIGH/BURST snapshots. Typography comparisons use identical text, 28px/32px weight600 and bright/dark backgrounds. Canvas density text is a simplified visual illustration of fixed measured rectangles, not DOM-measured real-service evidence. All final comparisons share the corrected collision proof; baseline uses CURRENT tuning.

## Boundaries and candidates

Geometry Adapter generates actual rectangles, subtitle exclusions and existing half-step anchors. Phase5 tuning ranks fill-behind by anchor, residual gap and deterministic seed. Scheduler Runtime checks every vertically intersecting rectangle using the foundations collision proof; capacity relief follows failed selection, and common Temporal expiry remains independent. Overlap depth and visible fraction in that proof are horizontal, not vertical. Vertical intersection is binary: no new vertical allowance has been invented.

Density A changes only High/Burst nominal gap (10/6 -> 4/0), catch-up (.82/.95 -> .95/1) and duration (.85/1.1 -> 1.4 seconds). Density B adds DENSE stride2 -> stride1 using the existing interleaving mechanism. Both preserve -24px hard floor, depth/visible-fraction bounds, NORMAL/COMPACT, velocity, SPECIAL fit/base-anchor and source thresholds. No new ranking algorithm or narrower lane pitch.

Fixed inputs: 960x320 surface; bottom64px subtitle hard exclusion; 20 seconds ingress, drain to40 seconds; HIGH every300ms, BURST every120ms; NORMAL widths180/300/480/720; every37th ingress a representable650px/68px SPECIAL. Real Scheduler Runtime/config values, Geometry Adapter and collision proof execute; no network, renderer measurement or temporal promotion is simulated. Source activity facts are supplied once. Counters and residence are in `final-visual-results.json`. Collision counts are repeated evaluations, not terminal Drops.

| Shape | Baseline launch / avg visible / capacity / stale | A | B |
|---|---|---|---|
| HIGH (67 inputs) | 58 / 14.92 / 8 / 1 | same | 59 / 15.08 / 7 / 1 |
| BURST (167 inputs) | 74 / 21.08 / 90 / 3 | same | 91 / 25.45 / 73 / 3 |

A has no material benefit in this fixture. Nominal gap is a fast safe path, not a minimum spacing constraint once bounded rescue passes. B changes early candidate choices and subsequent occupancy, even after reaching MAX_READABLE; interleaved launch count itself is not a monotonic density metric. HIGH stays source HIGH but may pressure-rescue to MAX_READABLE; source and display shapes remain separate. SPECIAL launches remain1/2; dominant real-service SPECIAL Drop remains UNDETERMINED.

## Safety blocker: existing duration proof undercounts initial overlap

The fixture found sampled pair overlaps up to2.4s in baseline HIGH and2.6s in B BURST. A direct bounded discriminator confirms the first bad boundary in `proveBoundedCollisionSafe`: candidate x500,width300,y16,height32,v150 versus active x210,width300,y0,height32,v150 has initial gap -10px, vertical overlap16px and actual coexistence3.4s. CURRENT MAX duration1.1s nonetheless returns SAFE. With zero relative closing velocity, overlapStartsAt becomes Infinity and computed overlapDuration becomes0 even when already overlapping. Baseline also has this defect; stronger candidates must not claim bounded-duration safety based only on existing passing guards.

FAIL-before: two targeted regression tests failed (equal-speed and slowly opening initial overlap). The minimal Production fix charges already-overlapping equal/closing trajectories their remaining coexistence, and opening trajectories the smaller of coexistence and time until separation. It leaves future catch-up math and every configured budget unchanged. No Architecture LOCK change is required. After correction, sampled pair overlap maximum is baseline HIGH0.4s/BURST0.2s and B HIGH1.0s/BURST0.8s; horizontal overlap maxima stay below24px. Density B is an offline Human candidate, not an applied tuning decision.

## Typography independent candidates

Role fills remain MEMBER #66e08a / MODERATOR #70b7ff / OWNER #ffd75e; paint-order remains stroke fill. Baseline NORMAL1.1px #202020; roles.45px with existing tinted outlines. A: NORMAL1.4px #101010; roles1.1px darker tinted outlines (#0b2011/#0e2338/#302709). B: NORMAL1.7px, roles1.4px with A colors. SPECIAL remains.8px rgba(0,0,0,.85), original separate presentation. Neither candidate is applied to Production. Thicker stroke is outside fill under stroke-first painting; Human must judge connections, halo strength, role distinction and readability on both backgrounds.

Human can compare Density baseline/A/B and Typography baseline/A/B independently now. Density B improves this fixed BURST launch count by23% and average visible count by21%; HIGH improvement is small, so sufficient High density remains a Human decision. Vertical overlap uses existing geometry only; no new depth exemption, hard-floor relaxation or SPECIAL half-anchor is proposed. No claim of improved real-service SPECIAL survival or Human PASS. No full suite, browser continuity run, or next issue.

Validation: affected targeted259/259 PASS after the Production correction; syntax/static and diff checks required before commit. Fixture lostUnaccounted=0 in all six runs; no subtitle launches or SPECIAL half-anchor, no emergency Drops, at most one launch per opportunity. Accepted role palette/paint order and SPECIAL CSS remain unchanged in Production.
