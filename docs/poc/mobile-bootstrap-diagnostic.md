# Mobile Web Live Chat bootstrap 診断

## 目的

Mobile Web で Live Chat READ を開始するための初期 continuation が、page bootstrap または player response に存在するかを調べる。今回のコードは診断だけを行い、Mobile の `get_live_chat` は送信しない。

## 診断 helper

MAIN world に次の helper を公開している。

```js
inspectMobileLiveChatBootstrap()
```

返却値は次の構造情報だけである。

- `hasTwoColumnWatchNextResults`
- `hasSingleColumnWatchNextResults`
- `hasLiveChatRenderer`
- `liveChatCandidatePaths`
- `continuationCandidateCount`
- `continuationCandidateTypes`
- `matchedPaths`

continuation、visitorData、trackingParams、clickTrackingParams などの値は返さない。

`get_watch` の response 本文を DevTools で確認できる場合は、MAIN world の次の helper に一時的な response object を渡して要約できる。

```js
inspectMobileGetWatchResponse(responseObject)
```

返却値は `source`、Live Chat 関連 ancestry、candidate path、continuation type 名、type/count のみである。Cookie、Authorization、continuation 実値などは返さない。response interception 自体は恒久実装していない。

## 実装上の判定規則

再帰探索は `ytInitialData` と `ytInitialPlayerResponse` を対象に、最大深度8、cycle-safe で行う。記録対象キーは次だけである。

- `liveChatRenderer`
- `liveChatContinuation`
- `continuationContents`
- `conversationBar`
- `reloadContinuationData`
- `invalidationContinuationData`
- `timedContinuationData`
- `nextContinuationData`

一般動画リストの `reloadContinuationData` は、path が Live Chat renderer / continuation 配下でないため `liveChatCandidatePaths` や `continuationCandidateCount` に含めない。

## 現時点の分類

ユーザーの実ブラウザ実測により、今回の調査では **C: Mobile Web 自身の bootstrap に Live Chat continuation がない** と分類する。

- Mobile `singleColumnWatchNextResults` に一般 continuation は存在する
- それは Live Chat renderer 配下ではない
- Mobile Web では `get_live_chat` が自動発生していない
- `get_watch` に `reloadContinuationData` があっても、それだけでは Live Chat continuation と判定できない
- Mobile の `ytInitialData` / `ytInitialPlayerResponse` に Live Chat candidate が存在するかは、対象ページで helper を実行して確定する
- 実測 helper 結果は `hasLiveChatRenderer: false`、`liveChatCandidatePaths: []`、`continuationCandidateCount: 0` だった
- Network でも `get_watch` と `get_live_chat` は発生せず、`log_event` と `heartbeat` のみ確認された

したがって、Mobile `ytInitialData` と通常の Mobile Network には Live Chat bootstrap がないと確定する。今回の実装では Mobile READ は開始しない。

## bootstrap 取得候補の比較

| 候補 | 必要な request | session/auth 依存 | Mobile からの実行 | 既存 PC parser 再利用 | Quetta Android 見込み | 仕様変更リスク |
| --- | --- | --- | --- | --- | --- | --- |
| PC Web watch document | `GET https://www.youtube.com/watch?v=...` | ページ session、region、bot 判定に依存する可能性 | extension の page/content context から試行可能。ただし `www` と `m` は別 origin | 高い。HTML 内 `ytInitialData` から既存 path を再利用できる | Chromium extension API と CORS が許せば中程度 | 高い。HTML/bootstrap 構造と UA 判定に依存 |
| `/live_chat` document bootstrap | PC で取得済みの初期 continuation を使う `GET /live_chat?...` | 初期 continuation、session に依存 | 初期 continuation がないため現時点では開始不能 | 中程度。response の `continuationContents` parser は再利用可能 | 初期値と cross-origin 制約次第で低〜中 | 高い。非公開 document endpoint |
| internal `player` / `next` / `browse` | client context を含む YouTube internal request | context、visitor/session、client profile に依存 | endpoint と Mobile context の対応を個別確認する必要 | response shape が同じ場合のみ中程度 | 実装可能性はあるが endpoint 依存が強い | 非常に高い |
| PC document を service worker から取得 | extension host permission 付き `fetch` | Cookie の自動送信、CORS、response の login/consent 状態に依存 | content script より origin 制約を回避しやすいが、page session と同一とは限らない | HTML parser を別途使う必要 | Chromium 系なら API 可否次第 | 高い |

PC watch document が `twoColumnWatchNextResults.conversationBar.liveChatRenderer` を含むかを、Mobile page の video ID に対して安全に要約できれば最有力候補Aとなる。しかし、現時点ではその GET を実行した実測結果はないため、まだ実装候補であり成功経路とは断定しない。

`/live_chat` は初期 continuation が前提であり、C の現状を単独では解決しない。internal endpoint は最後の候補で、request context と session 条件の再現が必要になる。

## request profile の調査方針

PC の成功 READ と Mobile の失敗 READ は、現在の実装上、同じ `buildLiveChatReadRequest()` と同じ `get_live_chat` transport を使用する。従って比較すべき差分は、まず continuation source と context source である。

`summarizeLiveChatRequestProfile()` は context root/client と header の field 名だけを返し、`compareLiveChatRequestProfiles()` は PC のみ、Mobile のみの field 名を返す。実際の Network request profile を入力するまで、追加 context や header を必須とは断定しない。

PC watch document から context の候補を調べるため、`inspectPcContextBootstrapHtml()` も追加した。これは HTML 内の `ytcfg` / `INNERTUBE_CONTEXT` 等の marker 名だけを確認する診断であり、context の値を抽出・保存・READ request へ適用する処理ではない。

現段階の優先順位は次の通りである。

1. A: PC watch document に PC 用 context の実体があるか、marker と構造を確認
2. C: PC成功/Mobile失敗 request の profile を field 名だけ比較
3. B: context 差で説明できない場合に、continuation を Mobile context 用に変換する経路を調査

この段階では Mobile READ request、header spoof、UA spoof、Authorization生成を変更しない。

## Device Toolbar 手動確認

1. PC Chrome で対象 YouTube Live watch page を開く
2. DevTools の Device Toolbar を有効にする
3. Mobile の viewport と User-Agent を設定する
4. ページを reload する
5. Console で次を実行する

```js
const result = inspectMobileLiveChatBootstrap();
console.log({
  hasTwoColumnWatchNextResults: result.hasTwoColumnWatchNextResults,
  hasSingleColumnWatchNextResults: result.hasSingleColumnWatchNextResults,
  hasLiveChatRenderer: result.hasLiveChatRenderer,
  liveChatCandidatePaths: result.liveChatCandidatePaths,
  continuationCandidateCount: result.continuationCandidateCount,
  continuationCandidateTypes: result.continuationCandidateTypes,
  matchedPaths: result.matchedPaths
});
```

6. `get_watch` の Network response を確認する
7. response を保存・共有せず、同じ診断 helper に page state を入力する場合も値を出力しない
8. `liveChatRenderer`、`liveChatContinuation`、`continuationContents` の path と type だけを記録する
9. `get_live_chat` が発生しない場合は、Mobile READ が自動開始されないことも記録する

## PC との比較

| 項目 | PC Web | Mobile Web |
| --- | --- | --- |
| page state | `twoColumnWatchNextResults.conversationBar.liveChatRenderer` | `singleColumnWatchNextResults` が中心 |
| Live Chat renderer | PC 実測で存在 | 対象ページごとに helper で確認 |
| 一般 continuation | 存在する場合あり | `reloadContinuationData` の存在を確認済み |
| Live Chat request | `get_live_chat` 発生 | 自動発生なしという実測 |
| Mobile READ | 対象外 | 今回は未実装・未送信 |

## PC watch context marker 調査

Mobile から取得した PC watch document について、background の `GET_PC_WATCH_BOOTSTRAP_SUMMARY` 処理が HTML を取得した直後に `inspectPcContextBootstrapHtml(html)` を実行する。

返却される `contextMarkers` は次の構造だけである。

- `configMarkerPresent`
- `presentFields`
- `contextObjectCandidate`

これは context の値を抽出したり、Mobile READ request に適用したりする処理ではない。実ブラウザで marker の有無を確認するための診断である。

分類は次のように行う。

- A: `contextObjectCandidate` が true。PC HTML に `INNERTUBE_CONTEXT` marker がある
- B: `contextObjectCandidate` が false だが `configMarkerPresent` と個別 field marker がある
- C: context marker がない、または必要候補が不足

現時点では、実ブラウザで確認済みなのは PC bootstrap の HTML/Live Chat 構造までで、`contextMarkers` の新しいログ結果は未取得である。従って A/B/C の context 判定は `NOT TESTED` とする。

## Quetta HTML profile 診断

background の PC watch document fetch 後に `summarizeWatchHtmlProfile(html)` を実行し、`summary.htmlProfile` として値なしの構造情報を返す。

診断項目:

- HTML length bucket: `small` / `medium` / `large`
- `ytInitialData` marker の有無
- `ytInitialData` parse 成否
- `twoColumnWatchNextResults` / `singleColumnWatchNextResults`
- `conversationBar`
- `liveChatRenderer`
- Live Chat renderer 配下の continuation array / reload data / 初期 continuation
- `INNERTUBE_CONTEXT` / `ytcfg` marker
- desktop/mobile watch marker
- consent、login/interstitial、error page marker
- `ytInitialData` の embedding form、script context、marker occurrence bucket

Mobile content script では path の段階だけをログする。HTML本文、video ID、continuation、context値はログしない。診断は PC fallback の bootstrap fetch に限定し、READ request、context適用、UA/header変更は行わない。

判定:

- A: parse 成功、two-column、liveChatRenderer、初期 continuation が全て true
- B: parse 成功、single-column、two-column false
- C: parse 成功、two-column true だが liveChatRenderer false
- D: parse 失敗
- E: consent/login/error marker

## セキュリティ

- continuation の実値を返さない
- visitorData、trackingParams、clickTrackingParams を返さない
- Cookie、Authorization、SID 系へアクセスしない
- helper の結果は path、key、type、count のみ
- Console へ値を出さない

## 今回の範囲

- Mobile page state 診断: 実装
- Mobile get_watch response interception: 未実装
- PC watch document の Mobile 専用取得 PoC: background の `GET_PC_WATCH_BOOTSTRAP_SUMMARY`
- Mobile get_live_chat: PC continuation + PC context を既存 READ loop へ接続
- Mobile continuous READ: 既存 PC READ loop を利用
- UI変更: なし
- WRITE/OAuth/Replay: 対象外
