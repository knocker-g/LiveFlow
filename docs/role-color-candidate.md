# Role readability candidate B

Human feedback rejected candidate A's junction readability. Candidate B adds `paint-order: stroke fill` to Member/Moderator/Owner only. Their fill colors, .45px outline colors/widths, weight, font size, and line-height stay unchanged; no shadow is added. Guest and SPECIAL rules are unchanged.

First bad boundary: the three role CSS rules omitted the paint-order fix already used by the accepted Guest/SPECIAL baseline. With the default fill-then-stroke order, the inner half of the centered dark stroke covers colored fill, which can thin glyph junctions. Stroke-then-fill covers that inward stroke with the original fill. This establishes the styling mechanism; Human visual confirmation of the reported symptom remains required.

Validation: the added role paint-order guard failed before the Production edit. After the three-rule change, renderer/style 115/115 PASS; touched JS syntax and diff check PASS. Existing untouched scheduling/retention/Temporal/role evidence is reused. No browser reassurance run or color sweep.

The preview defaults to B and has a checkbox to compare old A on the same dark/bright samples. Exact palette and final readability acceptance remain pending. The previously inspected KNO-95 MEMBER reference and accepted paint-order fix are reused.

## Historical candidate A

Source trace found the existing palette already implemented in `src/youtube-chat.js`. Accepted role normalization now makes it reachable through `ChatMessage.authorRole` -> page-state bridge -> `normalizeDanmakuMessage` -> `createDanmakuNode.dataset.authorRole`. No Production change is needed to expose this first candidate.

| Role | Fill | Existing stroke |
| --- | --- | --- |
| Member | #66e08a | .45px #12381d |
| Moderator | #70b7ff | .45px #183b5c |
| Owner | #ffd75e | .45px #564813 |
| Guest/default | #fff | 1.1px #202020, stroke fill |

The KNO-95 Human MEMBER reference image was inspected: light vivid green text with outer contrast. Candidate A reuses the current green/blue/amber family rather than starting a new color sweep. Exact palette is not locked.

SPECIAL continues to use its separate card, explicit inline white text and dedicated .8px dark stroke. Role styles do not change its semantic or visual surface. Adapter, Scheduler, retention, Temporal, Source Activity, and Acquisition are unchanged. Existing accepted regression evidence is reused for these untouched responsibilities.

`role-color-preview.html` is a static dark/bright comparison of existing guest baseline and candidate A. It is a review aid, not real-service or motion evidence. Final Human acceptance should check both backgrounds, natural role colors, NORMAL distinction, no SPECIAL confusion, and readability without excess visual intensity. No second candidate is created without feedback.

Machine guards execute the actual Presentation node function using normalized Adapter inputs and verify exact current style mapping, guest fallback, and SPECIAL white override. Human acceptance remains pending; keep the issue In Progress.
