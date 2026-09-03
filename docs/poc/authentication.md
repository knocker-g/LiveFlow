# 認証検証メモ

## 公式 API 方式

- OAuth が必要
- Scope は `youtube.force-ssl` が基本
- `chrome.identity.getAuthToken()` により Chrome 拡張内でトークンを得る
- ユーザーの明示同意を要求する設計が必要
- refresh token の扱いは Google の認証モデルに沿う
- ストア公開時は権限説明と使い方の明示が必要

## Web 内部 API 方式

- YouTube ページの既存ログイン状態を活用できる可能性がある
- Cookie と session が必要になる
- `visitorData` / `context` / `client` 情報が関係する可能性がある
- `content script` と `service worker` のどこで呼ぶかが設計に影響する
- 直接利用は公開リスクが高い

## 実務上の見立て

- 公式 API: 明示的で安全だが一般用途では重い
- Web 内部 API: 実用的だが公開前提では危険

## PoC の判断

最小 PoC では、認証の実証は「公式 API の OAuth が動くか」までを確認する最低限の実装に留める。
