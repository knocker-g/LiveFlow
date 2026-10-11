# Role color candidate A

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
