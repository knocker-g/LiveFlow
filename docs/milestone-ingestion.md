# Membership milestone ingestion evidence

## Source contract

The representative fixture in `test/milestone-ingestion.test.js` is synthetic schema evidence, not a captured YouTube service response. Repository search found no existing membership payload fixture. The parser author's [YouTube.js membership parser](https://github.com/LuanRT/YouTube.js/blob/main/src/parser/classes/livechat/items/LiveChatMembershipItem.ts), inspected on 2026-10-11, reads `message` separately from `headerPrimaryText` and `headerSubtext`, and reads author identity from `authorName`, `authorBadges`, `authorPhoto`, and `authorExternalChannelId`. Only `message.runs` enters the existing NORMAL body normalization. Membership duration/tier headers are not appended to the author's body. Header-only membership announcements do not acquire invented comment text.

## Actual source trace

1. `addChatItemAction.item.liveChatMembershipItemRenderer` enters `extractChatMessagesFromResponse` in `src/chat-read-core.js`. Before the fix, the supported renderer dispatch returned `[]`: the first bad boundary. All four new tests failed before Production changes, including the explicit one-message expectation returning zero.
2. The added dispatch uses `ChatMessage.fromRenderer(renderer, 'text')`. Ordered text/image runs use the same normalization as ordinary comments. No new body truncation, role mapping, or raw response fields are introduced. Replay uses this same Adapter inside `replayChatItemAction.actions` and preserves `replayOffsetMsec`.
3. `src/page-state-main.js` consumes the shared extractors. The normalized comment uses the existing bridge/schema with `messageType: text`, `message`, `messageRuns`, author fields, and `authorRole: guest`.
4. `scheduleDanmakuBatch` in `src/youtube-chat.js` applies `isMessageVisibleForSettings`. This accepts `text` independently of legacy visibility flags. `observeCurrentWindowSourceActivity` creates one displayable CURRENT_WINDOW fact per comment, with the same media-time rule as NORMAL. There is no role or SPECIAL weight.
5. Scheduler enqueue maps `text` to `liveChatTextMessageRenderer` and NORMAL footprint. `createPendingItem` / `classifySemanticClass` in `src/pending-selection.js` produce NORMAL. No new temporal, lane, priority, or retention branch exists.
6. `renderDanmaku` / `normalizeDanmakuMessage` use the ordinary presentation path. Empty bodies and existing displayability bounds remain ordinary NORMAL rules; membership headers do not make an empty body displayable. SPECIAL presentation is only for superChat/superSticker.

## Shared role evidence for later work

`ChatMessage.fromRenderer` currently reduces `authorBadges[].liveChatAuthorBadgeRenderer.tooltip` to strings and always assigns guest. The source field exists, but localized tooltip text alone is not reliable Member/Moderator/Owner classification. No locale-independent discriminator was established here. Unknown, missing, and member-looking tooltip evidence all remain guest while preserving the body. No role implementation or styling was added.

## Acceptance boundary

Deterministic guards cover body/run preservation, no header copy, guest fallback, absent-body behavior, Replay offset, and the executed Production batch/Source Activity functions with real normalization/filter/pending classification. Existing Adapter, NORMAL/SPECIAL presentation, pending selection, Source Activity, and READ-only guards are the targeted regression set.

Human visual smoke remains required: milestone body appears as natural NORMAL danmaku, without SPECIAL styling, and remains visible when role evidence is unavailable. Machine evidence alone does not close the issue. No additional browser run was performed.
