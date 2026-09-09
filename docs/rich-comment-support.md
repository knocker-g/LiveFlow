# Rich comment support boundary

LiveFlow parses only structures confirmed by repository fixtures from the existing credentialless `get_live_chat` response. It does not add another endpoint or use Native Chat DOM as a message source.

## Implemented

- `addChatItemAction.item.liveChatTextMessageRenderer`
- ordered text runs
- author name and validated HTTP(S) author photo
- Guest fallback role
- Guest visibility and avatar preferences, applied without page reload

The normalized model carries `authorBadges`, `authorRole`, and `messageRuns`. Raw response objects are not sent to the renderer. Rendering uses DOM nodes and text nodes rather than response-derived HTML.

## Deferred pending fixture evidence

- locale-independent Member, Moderator, Owner, and current-user classification
- emoji/image runs
- Super Chat, Super Sticker, membership, and milestone renderers
- pin, replacement, and unpin actions

Their Popup controls remain disabled. Polls are outside the v1 scope. Deferred features must use the existing READ response and may not expand the READ-only network boundary.
