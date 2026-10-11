# Phase 5E geometry decision gate

Starting HEAD6745cad9599ce48c6e7bd338a652a30957e9ace4. KNO-208 latest Human screenshot-qualified decision: Typography A selected, Density B reference only; controlled vertical packing/full-motion validation required. No attachment binary was returned by the current Issue/comments; the Human screenshot judgment in the updated Issue body is reused.

## Exact collision boundary

Geometry Adapter uses actual post-style rendered height, base pitch32px and half-step offset16px. A32px NORMAL box would intersect an adjacent half-step box by16px; actual glyph ink is not identical to the32px line box. No glyph-ink or overlap-area metric exists. SPECIAL uses measured two-line height and base anchors only. Candidate rectangles are filtered against subtitle hard exclusions; rendering does not move existing nodes when candidates change.

`proveBoundedCollisionSafe` treats any vertical intersection, even1px, as the same case as complete same-row intersection. It then requires `minimumGap >= -24px` before checking finite catch-up/duration/horizontal depth/visible fraction. Increasing depth or duration alone cannot bypass this floor. B uses gap4/0, catch-up.95/1, duration1.4s; horizontal depth/visible-fraction still CURRENT (.32/.68 HIGH and .4/.6 BURST).

Bounded discriminator using B, active x500/y0/w300/h32/v150:

- new x776/w300/h32/v130 at y0,16 or31: gap-24px, time to separation1.2s, SAFE.
- new x775 with the same trajectory: gap-25px, HARD_READABILITY_FLOOR, including only1px vertical intersection.
- new x700/y16/v130: horizontal overlap100px, vertical overlap16px, HARD_READABILITY_FLOOR.
- new x900/y16/v250: starts100px behind; predicted catch-up consumes533.33px over5.33s; minimumGap-433.33px, HARD_READABILITY_FLOOR. Complete overtaking of a300px box necessarily traverses roughly300px overlap, outside both the24px floor and B depth/visible-fraction bounds.
- y32 makes the rows non-intersecting and skips these pair checks. This is why separated rows are easier to launch.

Shallow adjacent-row overlap inside24px is already legal; a ranking-only C could redistribute those slivers, but must not be represented as approval for broader vertical overlap or full overtaking. The requested complete passing behavior cannot be certified under current hard safety. Do not silently exempt NORMAL half-step rectangles or replace horizontal separation with projected overlap area. Those are hard collision-safety changes and require the requested review gate. No C was fabricated or numerically swept; no B/C real-video comparison ran before this prerequisite.

## Preview / Production trajectory distinction

The simplified preview advances candidate rectangles starting at video.right-renderedWidth and clips text to fixed synthetic widths. Production `calculateDanmakuMotion` starts at overlayWidth and ends at -commentWidth, with the DOM's measured width, and stores active trajectory startX=video.right. Thus its right-entry/left-exit path is natural by source trace, but not real-video validated here. A static screenshot cut-off is not proof of a Production clipping defect.

An additional exact mismatch deserves discrimination before a next density run: Geometry Adapter's candidate proof starts at video.right-renderedWidth, while the committed renderer/active trajectory starts at video.right (difference=one measured width). Prior fixed-fixture counters use the former consistently and must not be promoted to real-video acceptance. This is a source-confirmed position mismatch, not a measured dominant runtime Drop reason. No geometry/trajectory fix was bundled into Typography A.

Source Activity facts drive HIGH/BURST separately from pressure rescue/display DENSE/MAX_READABLE. Neither source thresholds nor stale lifetime changed. Existing B fixture evidence remains reference only: HIGH59 launches/avg15.08/capacity7/stale1; BURST91/avg25.45/capacity73/stale3; relevant lostUnaccounted0; SPECIAL1/2. Full-width overtaking was never proved by those counts. SPECIAL real-service dominant Drop remains UNDETERMINED.

## Independent authorized work

Production Typography A applied: NORMAL1.4px#101010; MEMBER1.1px#0b2011; MODERATOR1.1px#0e2338; OWNER1.1px#302709. Accepted fill colors and stroke-before-fill retained. SPECIAL stroke, layout and white presentation unchanged. No Adapter/Scheduler/retention/Temporal/request changes. Renderer/role style guards updated. Final real-video readability PASS remains pending.

STATUS: REVIEW_DECISION_REQUIRED. Human/Product/Architecture must decide whether broader adjacent-row NORMAL overlap/full overtaking may replace the existing binary-intersection horizontal hard-safety rule, with explicit finite vertical/horizontal/duration/visible-area budgets and unchanged SPECIAL/subtitle checks, or narrow the target to existing <=24px shallow overlap. After that decision, resolve proof-versus-launch position fidelity, build exactly one C, then perform the requested short B/C same-episode comparison. No Push or next issue.
