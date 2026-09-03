# PoC-B: YouTube Web / Mobile Web 内部通信

## 目的

Web 内部 API のパターンを確認し、以下を実地で比較する。

- PC Web で live chat の取得が可能か
- Mobile Web で live chat の取得が可能か
- 可能なら投稿の確認を試す
- 取得する際の request / headers / cookies / continuation を記録する

## 監視対象

- endpoint
- HTTP method
- request payload
- headers
- cookies
- continuation
- context
- client version
- response format
- PC / Mobile 差異

## 実施方針

- content script から YouTube ページのネットワーク通信を観測する
- `get_live_chat` 系の endpoint を確認する
- `continuation` を記録して次のチャット取得を確認する
- 可能な場合、ユーザー操作での投稿を試す

## 重要なリスク

- 公式仕様ではない
- `visitorData` や `SAPISID` 等の依存がある
- cookie と session 条件が複雑
- YouTube 側の変更に対して脆い
- Web Store 公開の観点で大きなリスク

## 結論

技術的には成立しうるが、公開配布前提の本体実装としては高い運用コストと審査リスクがある。
