# PC get_live_chat 完全再現調査

## 調査範囲

PC YouTube Web で HTTP 200 になった `get_live_chat` request と、Console の単純 fetch の差分を特定する。Mobile は今回の調査対象外とする。

## 実ブラウザで確認できた事実

ユーザーが別途確認した実測事実:

- `POST /youtubei/v1/live_chat/get_live_chat` が HTTP 200 になる
- request body に `context` と `continuation` がある
- `context.client.clientName` は `WEB`
- `context.client.hl` は `ja-JP`
- response に `continuationContents.liveChatContinuation` がある
- Console の単純 fetch は HTTP 400

この作業環境で共有されたページを検査した結果:

- `window.ytInitialData.contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer` は存在しなかった
- chat 関連の `ytInitialData` path は検出されなかった
- `get_live_chat` / `get_watch` の Resource Timing は検出されなかった
- 検出された continuation は transcript 用 endpoint のもので、Live Chat continuation と判定できるものではなかった

したがって、共有ページから PC の HTTP 200 request の実体を直接取得したとは扱わない。

## A. 成功 request

| 項目 | 結果 |
| --- | --- |
| URL path | `/youtubei/v1/live_chat/get_live_chat` はユーザー実測で確認 |
| Query parameter keys | NOT TESTED |
| Method | `POST` |
| Status | `200` はユーザー実測で確認 |
| Payload top-level keys | `context`、`continuation` の存在を確認。全 key は NOT TESTED |
| context keys | `client` の存在を確認。全 key は NOT TESTED |
| context.client keys | `clientName`、`hl` を確認。全 key は NOT TESTED |
| 非機密 header keys | NOT TESTED |
| Initiator | NOT TESTED |

## B. Copy as fetch

| 項目 | 結果 |
| --- | --- |
| そのまま実行 | NOT TESTED |
| HTTP status | NOT TESTED |
| 失敗時の error 概要 | NOT TESTED |

共有された実行環境には、対象 request を DevTools の **Copy as fetch** で取得する操作結果が提供されていないため、A/B 判定は未確定である。単純 fetch が HTTP 400 になることはユーザー実測として記録する。

## C. 最小 request shape

| 項目 | 必須性 | 検証結果 |
| --- | --- | --- |
| query parameters | 未確認 | 成功 request の query key 未取得 |
| payload `context` | 必須候補 | 成功 request と単純 fetch の双方に存在するが、最小性は未確認 |
| payload `continuation` | 必須候補 | 成功 request と単純 fetch の双方に存在するが、値の対応関係は未確認 |
| `context.client.clientName` | 未確認 | 成功 request で `WEB` を確認。削除実験は未実施 |
| `context.client.clientVersion` | 未確認 | 実測値未取得 |
| `context.client.hl` | 未確認 | 成功 request で `ja-JP` を確認。削除実験は未実施 |
| 非機密 headers | 未確認 | 成功 request の key 一覧未取得 |
| Cookie / Authorization / SID 系 | 未確認 | 実値を扱わず、存在性の比較も未実施 |
| page/session state | 未確認 | Initiator と request 生成過程未取得 |

## D. continuation

| source | 存在 | 長さ | 成功 request との関係 |
| --- | --- | ---: | --- |
| `ytInitialData` の PC `liveChatRenderer` | あり、ユーザー実測 | 未確認 | 成功 request body と同一か未確認 |
| request body | あり、ユーザー実測 | 未確認 | - |
| response next continuation | あり、ユーザー実測 | 未確認 | - |

continuation の実値は表示・保存しない。比較には「存在」「文字数」「同一/異なる」のみを使う。

## E. 結論

| 判断項目 | 判定 |
| --- | --- |
| 1. continuation だけでは不足 | PARTIAL。単純 fetch が 400 になるため強く示唆されるが、単一要因実験は未完了 |
| 2. context の追加情報が必要 | NOT TESTED |
| 3. query parameter が必要 | NOT TESTED |
| 4. header が必要 | NOT TESTED |
| 5. page/session state が必要 | NOT TESTED |
| 6. Console fetch では再現不能 | NOT TESTED。単純 fetch は 400 だが、Copy as fetch 未実行 |
| 7. Copy as fetch なら再現可能 | NOT TESTED |

現時点で最も堅い結論は、`continuation` の存在だけでは HTTP 200 を再現できないということまでである。追加 context、query、header、page/session state のどれが必要かは、成功 request の Copy as fetch を基準にした一変数削除実験なしには断定できない。

## 再現実験の手順

1. PC の対象 Live page を開く
2. DevTools Network で `get_live_chat` を検索する
3. Status `200` の request を選択する
4. **Copy > Copy as fetch** を選択する
5. Console でそのまま実行し、status のみ確認する
6. query parameter を1つだけ削除して再実行する
7. body の top-level key を1つだけ削除して再実行する
8. `context` key、`context.client` key、非機密 header の順に同じ実験を行う
9. 毎回、HTTP status と response の key 構造だけを記録する
10. PC の最小 shape が確定した後に、同じ shape を Mobile で試す

Copy as fetch に Cookie、Authorization、SID、SSID、SAPISID、`__Secure-*`、Visitor ID が含まれる場合、値は表示・保存・共有しない。認証関連は削除前後の status と「header key が存在するか」だけ記録する。

## 安全な要約ツール

[poc/devtools/summarize-live-chat-network.js](../../poc/devtools/summarize-live-chat-network.js) は HAR の request を次の情報へ要約する。

- URL path と query key
- method と status
- payload の top-level/context/client key
- continuation の存在と長さ
- 非機密 header key
- Initiator

機密値と continuation 実値は出力しない。
