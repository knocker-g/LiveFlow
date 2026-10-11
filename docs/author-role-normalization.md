# Author role normalization contract

The existing normalized field is `authorRole: 'guest' | 'member' | 'moderator' | 'owner'`. Guest means no elevated role; it is not a new scheduling class. This contract uses the existing enum and bridge field.

## Evidence and reliability boundary

The earlier milestone evidence established that localized badge tooltip strings alone are insufficient and that the shared Adapter always returned guest. That evidence is reused here.

Additional parser-author source inspected on 2026-10-11:

- [YouTube.js MetadataBadge](https://github.com/LuanRT/YouTube.js/blob/main/src/parser/classes/MetadataBadge.ts) reads `icon.iconType` separately from tooltip/label.
- [YouTube.js LiveChatAuthorBadge](https://github.com/LuanRT/YouTube.js/blob/main/src/parser/classes/LiveChatAuthorBadge.ts) reads `customThumbnail` on the author badge renderer.
- [pytchat BaseRenderer](https://github.com/taizan-hokuto/pytchat/blob/master/pytchat/processors/default/renderer/base.py), `get_badges`, interprets exact `OWNER` and `MODERATOR` icon values and custom author badge thumbnails as membership evidence.

The fixtures are synthetic examples of this schema, not new real-service captures. The accepted discriminator is scoped to `authorBadges[].liveChatAuthorBadgeRenderer`, not arbitrary images, renderer names, author names, channel IDs, colors, localized tooltips, accessibility text, or URL fragments.

- Exact `icon.iconType === 'OWNER'` -> owner.
- Exact `icon.iconType === 'MODERATOR'` -> moderator.
- An author badge without an icon and with a valid HTTP(S) `customThumbnail.thumbnails` image -> member. The custom-thumbnail field is the discriminator; the URL is validated for structural safety, not interpreted to infer identity.
- Tooltip-only, malformed, missing, and unrecognized evidence -> guest. An unknown icon does not become Member merely because it also has a custom thumbnail.
- Repeated evidence for the same role is idempotent. Multiple distinct recognized roles across badges -> guest because the existing single-role field has no approved precedence contract. No visual/retention precedence is guessed.
- Unrelated VERIFIED badges alone do not elevate; they do not erase an independently recognized role.

This is a bounded supported-schema contract, not a claim that every future YouTube schema variant can be recognized. Unrecognized variants keep the body and fail unprivileged.

## Adapter and downstream trace

`ChatMessage.fromRenderer` now normalizes the raw author badges before the existing tooltip-string reduction loses structural evidence. All supported text, paid message, paid sticker, and membership renderers share this Adapter. Replay shares it and retains source ordering and video offsets.

`src/page-state-main.js` already carries `authorRole` across the bridge. `normalizeDanmakuMessage` already preserves recognized lower-case roles and falls unknown to guest; `createDanmakuNode` records the role on its dataset. No bridge schema expansion or Presentation styling is required here.

Scheduling still derives NORMAL/SPECIAL only from message/renderer type. Source Activity still uses one displayable CURRENT_WINDOW fact per comment without role inputs. Acquisition, request authorization, ordering, temporal semantics, lane selection, stale lifetime, and retention are unchanged.

## Reuse by later responsibilities

Retention and styling consume normalized `authorRole`; they must not reinterpret raw badge strings. Member is still ordinary NORMAL for retention. Owner/Moderator protection and Member/Moderator/Owner colors are separate work and are not implemented here. Paid messages retain SPECIAL regardless of author role; ordinary and milestone messages retain NORMAL.

## Validation

Before the Production change, the new role tests had five expected failures and one fallback PASS: all three positive role fixtures still returned guest. After the Adapter change, the six new tests pass, including three roles across NORMAL/SPECIAL, false-elevation negative fixtures, conflicting roles, duplicate evidence, Live/Replay order and offsets, and Member milestone body retention. Existing tooltip-only milestone and ordinary-comment fixtures remain guest.
