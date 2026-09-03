# PoC-A: 公式 YouTube Data API

## 目的

公式 API では、以下を確認する。

- OAuth 認証の必要性
- 必要 scope
- Live Chat 取得の可否
- Live Chat 投稿の可否
- Chrome 拡張からの実装可否

## 実装メモ

- Scope: `https://www.googleapis.com/auth/youtube.force-ssl`
- 拡張側は `chrome.identity.getAuthToken()` を使ってトークン取得を試す
- `liveChat/messages` の POST でコメント送信を試す
- `liveChat/messages` の `list` でチャット取得も試す

## 重要な制約

- OAuth 認証を明示的に行う必要がある
- Google の承認フローが必要
- `liveChatId` を取得してから投稿する必要がある
- API quota と rate limit は現実的な制約になる
- 一般ユーザー向けの UI 連携としては分離しやすい

## 可能性

- 実際には技術的には可能
- ただし本体実装としての汎用性は低い
- 公式 API は「自分のアカウント・自分の配信」向けの設計に向く

## 結論

公式 API は PoC の一部として利用可能だが、最終実装の主経路にはしにくい。
