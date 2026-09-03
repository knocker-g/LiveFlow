# Mobile Web 初期 continuation 調査計画

## 目的

Mobile Web で Live Chat UI と `get_live_chat` が発生しない条件を確認し、Chat READ の開始に必要な初期 `continuation` がページ状態または API レスポンスに存在するかを判定する。

## 現時点の実測事実

| 環境 | Chat UI | `get_live_chat` | 初期 continuation |
| --- | --- | --- | --- |
| PC YouTube Live | 表示 | 発生 | Network の POST body に存在 |
| PC Chrome のモバイル幅 | 表示 | 発生 | 未確認 |
| Smartphone Mobile Web | 非表示 | 未発生 | 未確認 |
| Smartphone の PC 表示 | 表示 | 発生 | Network の POST body に存在 |

「初期 continuation が存在しない」と「Chat 初期化自体が行われない」は別の事象として扱う。

## 今回の比較結果

ユーザーが実ブラウザで確認した結果を、未確認情報と混ぜずに記録する。

| 観点 | PC Web | Device Toolbar の Mobile 表示 |
| --- | --- | --- |
| `ytInitialData` の chat 構造 | `contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer` が存在 | `liveChatRenderer` は存在しない |
| 初期 continuation の既知 path | `liveChatRenderer.continuations[0].reloadContinuationData.continuation` | `singleColumnWatchNextResults.results.results.continuations[0].reloadContinuationData.continuation` |
| `get_watch` | 未確認 | 発生し、レスポンスにも `reloadContinuationData` が存在 |
| `get_live_chat` | 発生、HTTP 200 | 自動発生なし |
| 手動 `get_live_chat` | Console の単純 fetch は HTTP 400 | `get_watch` 由来 continuation の単純 fetch は HTTP 400 |
| response | `continuationContents.liveChatContinuation`、actions、次回 continuation | 未取得 |

この結果から、Mobile に continuation らしい値が存在することは確認できる。しかし、その値だけで Chat セッションを開始できることは確認できていない。

## 成功した Network Request と単純 fetch の差分

現時点で確定している成功条件は「PC の YouTube 自身が生成した `get_live_chat` request が HTTP 200 になる」ことであり、以下の項目の実値はまだこの作業記録に取り込めていない。

- Request URL の query parameter 全体
- request payload の `context` 全体
- `context.client` 以外の payload key
- 認証情報以外を含む全ての重要 header
- Network の Initiator と直前 response の因果関係

したがって、成功 request が単純 fetch と異なるという結論は妥当だが、現時点で「不足している特定の header は X である」とは断定できない。

### 現時点で特定できている成功 request

ユーザーの実測に基づき、確定している範囲は以下である。

| 項目 | 確認結果 |
| --- | --- |
| URL path | `/youtubei/v1/live_chat/get_live_chat` |
| method | `POST` |
| status | `200` |
| body | `context` と `continuation` が存在。`context.client.clientName` は `WEB`、`hl` は `ja-JP` |
| response | `continuationContents.liveChatContinuation` が存在 |
| query parameter | key/value とも未取得 |
| context の全 key | 未取得 |
| context.client の全 key | 未取得 |
| 非機密 header key | 未取得 |
| Initiator | 未取得 |

Request URL の origin や query、追加 payload/header、Initiator は、この環境の統合ブラウザから DevTools Network を参照できないため、現時点では未確認である。

比較対象として確認する項目は以下である。

| 項目 | 成功した YouTube request | 現行 PoC / Console の単純 fetch |
| --- | --- | --- |
| endpoint | Network で取得した正確な URLを記録 | `/youtubei/v1/live_chat/get_live_chat?prettyPrint=false` を固定 |
| query | Network の query key 一覧を記録 | `prettyPrint` のみ |
| method | POST | POST |
| body | Network のトップレベル key、`context` key、client profile を記録 | `context.client` と continuation のみ |
| cookies | YouTube の実セッション条件を確認 | `credentials: include` を指定 |
| headers | Network の非機密 header を比較 | Content-Type、X-Youtube-Client-Name、X-Youtube-Client-Version のみ |
| initiator | DevTools で記録 | fetch 呼び出し元のみ |

Chrome DevTools の **Copy as cURL** または HAR の実データを、[summarize-live-chat-network.js](../../poc/devtools/summarize-live-chat-network.js) で要約すれば、secret、Cookie、continuation 実値を出さずにこの比較を完了できる。

## 400 の原因候補

優先順位を付けた仮説であり、未検証のものは候補として扱う。

1. `context.client` の不足または client profile の不一致
2. Network request に存在する query parameter の欠落
3. `X-Goog-Visitor-Id` 等のセッション関連 header、または page 側で生成された状態の欠落
4. continuation の種類が endpoint が期待する continuation と異なる
5. continuation の有効期限、配信状態、または同一セッションとの結び付き
6. content script / Console fetch と page 内 YouTube request の origin、credentials、CORS 適用差

Cookie や Authorization が存在するかどうかも、値を表示せず「header key の存在」だけ確認する。`continuation` も値ではなく存在と長さだけ比較する。

## 初期 continuation の生成元

PC では `ytInitialData` の `liveChatRenderer` に初期 continuation があることまでは確認済みである。ただし、Network の成功 request がその値をそのまま使ったのか、YouTube が途中で別 continuation に変換したのかは、request payload の長さ・一致関係を秘匿比較して確認する必要がある。

Initiator 調査では次の順に記録する。

1. 最初の `get_live_chat` の Initiator chain
2. 直前の `watch` / `next` / `browse` / `get_watch` response
3. response 内の continuation の JSON path、種類、長さ
4. get_live_chat request body の continuation の長さと一致/不一致

Mobile の `get_watch` response に `reloadContinuationData` があることは確認済みだが、`get_live_chat` が自動発生していないため、その continuation は「存在するが未検証の候補」である。

## 1項目ずつの再現手順

PC の HTTP 200 request を基準に、DevTools で次の順に比較する。各試行は Network の **Copy as fetch** を同じページの Console へ貼り付け、変更する項目は1つだけにする。

1. Copy as fetch をそのまま実行し、HTTP 200 を再現できるか確認する
2. body の continuation だけを `ytInitialData` の値に置き換える
3. query parameter を1つずつ削除する
4. `context` の top-level key を1つずつ削除する
5. `context.client` の key を1つずつ削除する
6. 非機密 header を1つずつ削除する
7. `credentials` の有無を比較する
8. 最後に Mobile の `get_watch` 由来 continuation へ置き換える

各試行では、次だけを記録する。

```text
trial id
changed field
HTTP status
response top-level keys
liveChatContinuation: present / absent
continuation present: yes / no
continuation length
```

Cookie、Authorization、SID、SSID、SAPISID、Visitor ID、continuation 実値は記録しない。HTTP 200 になった試行では、成功条件を元の Network request と再度比較して、単一要因の差分と断定できるか確認する。

### Copy as fetch に関する注意

Copy as fetch は、ブラウザが管理する Cookie や `sec-*` header を含むことがある。Console に貼り付ける前に値を表示・共有せず、ローカルでのみ実行する。取得した request をリポジトリへ保存しない。

## 現段階の調査完了条件

次の全てが埋まるまで、PC の初期 continuation 経路と Mobile READ の成立を確定しない。

- PC HTTP 200 request の query key 一覧
- payload の top-level/context/client key 一覧
- 非機密 header key 一覧
- Initiator chain
- `ytInitialData` の continuation と request body の continuation の長さ・一致関係
- PC の Copy as fetch 再現結果
- Mobile の `get_watch` continuation を同条件で試した結果

## LiveFlow への実装上の結論

現段階では、Mobile Web から独立して Live Chat READ を実装できる可能性は **条件付き** と判断する。

- Mobile の page/API response に continuation 形式のデータが存在するため、完全に情報がないとは言えない
- しかし PC と Mobile で page state の構造が異なる
- continuation 単体の手動 fetch は PC/Mobile とも HTTP 400 だった
- よって、Mobile の continuation を見つけてそのまま `get_live_chat` に渡す方式は成立していない
- 成立させるには、PC 成功 request の完全な非機密 request shape と Initiator chain を特定し、Mobile で同じ前提を再現できるかを確認する必要がある

実装は `InitialContinuationProvider` と `LiveChatTransport` を分け、次のように閉じ込めるべきである。

```text
PageState / get_watch response
	↓
InitialContinuationProvider
	↓  (存在・長さのみ診断)
LiveChatTransport
	↓
get_live_chat response parser
```

HTTP 400 が解消するまで、Mobile READ を PASS とせず、token 合成、`liveChatId` 代用、query/header の推測追加は行わない。

## 調査手順

### 1. PC版の発生元を特定する

1. DevTools の Network で `get_live_chat` を Preserve log 付きで記録する
2. Live Chat iframe / panel の生成前後を確認する
3. 最初の `get_live_chat` を右クリックして Copy request payload を取得する
4. Chat UI を構成する直前の `watch` / `next` / `browse` レスポンスを確認する
5. 各レスポンスで `continuation` の JSON path と発生順を記録する

記録するのは path、request URL、clientName、clientVersion、status のみとし、continuation の実値、Cookie、Authorization は保存・ログ出力しない。

### 2. Mobile Web のページ状態を比較する

同じ配信について次を比較する。

- `ytInitialData`
- `ytInitialPlayerResponse`
- `ytd-live-chat-frame` / `yt-live-chat-app` の有無
- iframe の `src` と `continuation` query parameter の有無
- `watch` / `next` / `browse` の response に含まれる chat 関連 path
- `get_live_chat` が発生しない場合、chat panel 初期化リクエスト自体の有無

Chrome の Device Mode だけでなく、実スマートフォンの Mobile Web でも確認する。Device Mode は画面幅だけを変更し、Mobile Web と同じページ初期化経路にならないためである。

### 3. 最小検証コードを実行する

PoC の `WebInternalApiAdapter.getInitialContinuation()` は、次の順で候補を調べる。

1. Live Chat 関連 DOM の `continuation` / `data-continuation`
2. Live Chat iframe URL の `continuation` query parameter
3. `ytInitialData`、`ytInitialPlayerResponse`、`ytplayer.config`、`yt` の page state
4. `live chat` または `continuation` を含む script の JSON field

発見時は source path のみをログに出し、token は出さない。見つからない場合は、空 continuation で API を呼ばずに停止する。

### 4. Mobile 側で直接 READ を試す

初期 continuation が見つかった場合だけ、実測済みの次の request を実行する。

```text
POST https://www.youtube.com/youtubei/v1/live_chat/get_live_chat
body: context.client + continuation
credentials: include
```

成功判定は次の全てとする。

- HTTP response が成功
- `continuationContents.liveChatContinuation` が存在
- `actions` から `liveChatTextMessageRenderer` を抽出できる
- 次回 `continuations[].nextContinuationData.continuation` を取得できる
- 同じ adapter インスタンスで次回 READ が成功する

## 判定

- `PASS`: Mobile Web のページ状態から初期 continuation を取得し、拡張 content script から READ と継続取得まで成功
- `PARTIAL`: continuation の所在または API response は確認できたが、拡張 context の直接 fetch または継続取得が未確認
- `FAIL`: 初期 continuation は存在するが、拡張 context の fetch が CORS / credentials 等で失敗
- `NOT TESTED`: 実スマートフォンまたは対象ページで未確認

## 実装判断

### 初期 continuation が Mobile に存在する場合

Mobile Web の page state または DOM から取得する専用 probe を adapter に追加し、`get_live_chat` の READ adapter へ渡す。PC と Mobile で source path が異なる場合は client profile と extractor を adapter 内で分離する。

### 初期 continuation が Mobile に存在しない場合

Mobile Web では Chat 初期化フローが省略されている可能性がある。その場合は、PC 版の `watch` / `next` / `browse` のどの response が初期 continuation を生成するかを先に確定し、Mobile の同等 response にその情報があるか比較する。根拠のない token 合成や `liveChatId` の代用は行わない。

## Chrome Extension context の比較

### content script から直接 fetch

- `credentials: include` でページセッション Cookie の利用を試せる
- same-origin として扱われるか、CORS の応答条件を実ブラウザで確認する必要がある
- page JavaScript の private state は取得できない

### page context -> content script -> service worker

- page の fetch / Network 初期化を観測する用途に向く
- postMessage や DOM bridge が必要
- continuation の値をログや message payload に不用意に残さない設計が必要

現段階では、まず content script の直接 fetch を検証し、失敗時だけ page bridge を検討する。

## 現在の実装範囲

- UI: 未実装
- WRITE: 未実装
- OAuth: 未実装
- Mobile 対応: 実ブラウザ検証待ち
- 初期 continuation: adapter の診断 probe を実装済み
- READ: 初期 continuation が解決した場合のみ実行
