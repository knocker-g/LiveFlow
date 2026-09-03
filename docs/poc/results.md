# LiveFlow PoC 検証記録

## 判定一覧

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| PC Chrome で Chat READ | PARTIAL | 実ブラウザの DevTools で `POST /youtubei/v1/live_chat/get_live_chat` と `actions[].addChatItemAction.item.liveChatTextMessageRenderer` を確認済み。ただし、拡張側での実行まではこの環境では未検証 |
| continuation による継続取得 | PARTIAL | `continuations[].nextContinuationData.continuation` を実測確認済み。READ PoC は実装済みだが、実ブラウザでの継続ポーリングまでは未検証 |
| PC版の初期 continuation 取得元 | PARTIAL | `ytInitialData.contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer.continuations[0].reloadContinuationData` の存在を確認済み。ただし成功 request の値との一致、Initiator chain は未確認 |
| PC版 internal API context 取得 | NOT TESTED | MAIN world の `ytcfg` / `INNERTUBE_CONTEXT` 読み取りと whitelist 正規化を実装。実ブラウザでの field 確認は未実施 |
| PC/Mobile request profile 比較 | NOT TESTED | context root/client/header の field 名だけを比較する pure helper と PC HTML context marker 診断を追加。Network profile の入力は未取得 |
| PC watch HTML context marker | NOT TESTED | background の PC bootstrap summary に `inspectPcContextBootstrapHtml(html)` の boolean/marker 名結果を追加。PC HTML marker の実ブラウザ結果は未取得 |
| PC one-shot get_live_chat | NOT TESTED | MAIN world から page state ごとに1回だけ送信する実装を追加。HTTP status と response 構造の実ブラウザ確認待ち |
| PC READ #1/#2 parser 接続 | NOT TESTED | READ #1 の parser/next continuation 成功時だけ READ #2 を送信する実装を追加。実ブラウザでの2回確認待ち |
| PC READ #2 continuation type 対応 | NOT TESTED | `nextContinuationData`、`invalidationContinuationData`、`timedContinuationData`、`reloadContinuationData` を抽出対象に拡張。実ブラウザでの READ #2 再確認待ち |
| PC timeout-aware continuous READ | NOT TESTED | `timeoutMs` を優先する cancellable loop、SPA revision 停止、HTTP/parse/continuation failure 停止、最大500件保持を実装。実ブラウザでの複数回継続は未再確認 |
| PC LiveFlow overlay | NOT TESTED | player 内に専用 root を1つ配置し、最新20件を `textContent` で表示する実装を追加。実ブラウザ表示は未再確認 |
| Mobile bootstrap 診断 | NOT TESTED | `ytInitialData` / `ytInitialPlayerResponse` の構造を最大深度8で再帰診断する helper を追加。Mobile 実ページでの結果は未確認 |
| Mobile bootstrap 分類 | PASS | 実測 helper で Live Chat renderer/candidate がなく、Network でも `get_watch` / `get_live_chat` が発生しないことを確認。Mobile bootstrap は分類C |
| Quetta PC watch HTML profile 診断 | NOT TESTED | HTML length bucket、parse結果、PC/Mobile marker、Live Chat path、consent/login/error marker を background summary に追加。Quetta実機の profile 比較は未確認 |
| Mobile から PC watch document 取得 | NOT TESTED | Mobile User-Agent 時のみ service worker から `www.youtube.com/watch` を取得し、PC bootstrap summary を返す PoC を追加。実ブラウザ結果は未確認 |
| Mobile PC bootstrap continuation -> existing READ | NOT TESTED | background の内部 continuation を Mobile context と組み合わせ、既存 MAIN world READ loop へ接続。実ブラウザの Mobile READ は未再確認 |
| Mobile PC bootstrap continuation + PC context one-shot READ | NOT TESTED | PC HTML から normalized PC context を内部取得し、Mobile page revision ごとに1回だけ既存 request/response parser を利用する経路を追加。実ブラウザ HTTP status は未確認 |
| Mobile PC bootstrap -> continuous READ + overlay | NOT TESTED | PC bootstrap continuation/context を既存 `startReadLoop()` と既存 overlay に接続。実ブラウザで READ #2 以降の再確認待ち |
| PC get_live_chat response の parser 対応 | PASS | `continuationContents.liveChatContinuation.actions[].addChatItemAction.item.liveChatTextMessageRenderer` と次回 continuation の構造を parser/test で確認 |
| Mobile Web の初期 continuation | PARTIAL | `singleColumnWatchNextResults.results.results.continuations[0].reloadContinuationData` と `get_watch` response 内の同種データを確認済み。ただし `get_live_chat` は未発生 |
| Mobile Web から直接 Chat READ | NOT TESTED | 初期 continuation の所在と content script fetch の実ブラウザ検証が未完了 |
| Chrome Extension context からの実行 | PARTIAL | `fetch` を content script から same-origin の `https://www.youtube.com` へ送ることは可能性があるが、CORS / credentials / extension isolated world の制約を考慮する必要がある |
| YouTube Live 検出 | PASS | 実測済みの live page で通信パターンが確認できており、PoC は live page で動く前提で実装 |
| 認証 | NOT TESTED | OAuth 実装は行っていない |
| Chat 投稿 | FAIL | READ PoC のみ実装。WRITE はまだ未実装 |
| Mobile Web 対応 | NOT TESTED | 未対応 |
| UI 実装 | FAIL | UI は未実装 |

## 判定ルール

- PASS: 実ブラウザ検証で成功
- PARTIAL: 実測知見はあるが、拡張実行や継続確認が未完了
- FAIL: 実現不能または未実装
- NOT TESTED: 実際の環境確認が未実施

## 実測の結論

- `POST /youtubei/v1/live_chat/get_live_chat` が実際に存在し、`continuation` ベースで chat を読む経路が確認できた。
- レスポンス上、`continuationContents.liveChatContinuation.actions` と `continuationContents.liveChatContinuation.continuations` を確認済みである。
- `actions[].addChatItemAction.item.liveChatTextMessageRenderer` から `message.runs[].text`、`authorName.simpleText`、`authorPhoto.thumbnails`、`authorBadges`、`id`、`timestampUsec`、`authorExternalChannelId` を確認できた。
- この構造をもとに、READ PoC は adapter 層で閉じ込めて実装した。

## ブラウザコンテキストの制約

content script から直接 `fetch` する場合、同一 Origin の `https://www.youtube.com` へのアクセスは原則的に可能な一方で、以下の制約がある。

- YouTube は `fetch` と `credentials`、CORS、Origin policy の条件を厳密に扱う可能性がある
- extension の isolated world と page の JS 実行コンテキストが分離されているため、page 内部 state をそのまま扱うのは不安定である
- もし page からの data flow が必要なら `page context -> content script -> background/service worker` の段階を置くのが安全である

ただし、今回の PoC では依存を最小化し、実測済みの `get_live_chat` + `continuation` の通信を adapter 内に閉じ込めている。

## 実装上の方針

- UI は未実装
- Chat 投稿は未実装
- OAuth は未実装
- `continuation` の値自体はログに出さない
- YouTube の内部 API の詳細は adapter に閉じ込める

## 結論

この READ PoC は、「実測済みの YouTube Live chat API 形式を前提にした、最小限の adapter 実装」として成立した。初期 continuation は page state / DOM / script の候補を診断するが、未解決時に空値で API を呼ばない。PC/Mobile の実ブラウザ検証が完了するまでは、取得元と拡張 context の判定を `NOT TESTED` または `PARTIAL` とする。

## 追加調査結果

- PC の `liveChatRenderer` continuation と、実際に HTTP 200 になった `get_live_chat` request の値が同一かは未確認。
- PC/Mobile とも continuation 単体の Console fetch は HTTP 400。
- Mobile の `get_watch` response に continuation 形式のデータはあるが、Chat 初期化と `get_live_chat` 発生は確認できていない。
- 400 の原因を特定するため、成功 request の query key、payload の全体構造、非機密 header、Initiator を比較する必要がある。
- [mobile-initial-continuation-investigation.md](mobile-initial-continuation-investigation.md) に比較手順と安全な HAR 要約スクリプトを追加した。
- PC の HTTP 200 request 完全再現については [pc-get-live-chat-reproduction.md](pc-get-live-chat-reproduction.md) に、確認済み項目と未取得項目を分離して記録した。
