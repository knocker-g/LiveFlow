# PC get_live_chat レスポンス検証

## 判定対象

ユーザーが Chrome DevTools の Network で取得し、Copy as fetch で HTTP 200 を確認した `POST /youtubei/v1/live_chat/get_live_chat?prettyPrint=false` のレスポンス構造を、LiveFlow READ parser が処理できるか確認する。

この記録では、Cookie、Authorization、visitorData、continuation 実値、レスポンス本文は保存しない。実レスポンスの HTTP 200 実行をこの環境で再取得したものではなく、ユーザーが提示した実測構造と repository の parser/test の照合結果を記録する。

## A. 実際のレスポンスから Live Chat メッセージを取得できるか

**判定: PASS（提示された実測構造に対する parser の構造対応）**

対象経路:

```text
response
└─ continuationContents
   └─ liveChatContinuation
      └─ actions[]
         └─ addChatItemAction
            └─ item
               └─ liveChatTextMessageRenderer
```

`extractChatMessagesFromResponse()` は `actions[]` を走査し、`addChatItemAction.item.liveChatTextMessageRenderer` が存在する action だけを `ChatMessage.fromRenderer()` へ渡す。従って、測定された text message renderer を抽出できる。

取得対象:

| renderer field | ChatMessage への変換 |
| --- | --- |
| `id` | `id` |
| `authorName.simpleText` | `authorName` |
| `authorName.runs[].text` | `authorName` の fallback |
| `message.runs[].text` | `message` |
| `timestampUsec` | `timestampUsec` |
| `authorPhoto.thumbnails[0].url` | `authorPhoto` |
| `authorBadges` | `badges` |
| `authorExternalChannelId` | `authorExternalChannelId` |
| renderer の種類 | `messageType: text` |

`actions` が存在しない、空配列、または text message 以外の action は空結果または無視となる。これは live chat response の他の action を text message と誤認しないためである。

## B. 次の continuation を取得できるか

**判定: PASS（提示された実測構造に対する parser の構造対応）**

対象経路:

```text
response
└─ continuationContents
   └─ liveChatContinuation
      └─ continuations[]
         └─ nextContinuationData
            └─ continuation
```

`extractContinuationFromResponse()` は `continuations[]` を走査し、最初に見つかった `nextContinuationData.continuation` を返す。値はログへ出力しない。

## C. 現在の chat-read-core.js でそのまま処理できるか

**判定: PARTIAL**

レスポンスの抽出経路はそのまま対応できる。`ChatMessage` の最低限の項目も対応済みである。今回、実測確認済みだが従来のモデルに保持していなかった `authorExternalChannelId` のみ追加した。

continuation parser は、今回確認された `nextContinuationData.continuation` 形式に対応する。別形式の continuation（例: `reloadContinuationData`）を同じ response parser で扱う必要があることは、今回の HTTP 200 response の実測がないため未確認とする。

## D. 変更ファイルと変更内容

### `poc/src/chat-read-core.js`

- `ChatMessage.authorExternalChannelId` を追加
- renderer の `authorExternalChannelId` をモデルへ保持
- `actions`、text renderer、message runs、author name、badges、timestamp、id、next continuation の既存抽出ロジックは変更なし

### `poc/src/youtube-chat.js`

- adapter が返す normalized message に `authorExternalChannelId` を追加
- UI、WRITE、OAuth、Mobile 実装は変更なし

### `poc/test/chat-read-core.test.js`

- 実測 renderer 形式に `authorExternalChannelId` が保持されることを追加検証

## E. テスト結果

実行コマンド:

```text
node --test .\poc\test\chat-read-core.test.js
node --check .\poc\src\chat-read-core.js
node --check .\poc\src\youtube-chat.js
```

結果:

- 4 tests passed
- 0 failures
- parser syntax check passed
- adapter syntax check passed

## F. 現時点での LiveFlow READ PoC の到達点

- HTTP 200 の get_live_chat response に含まれる、提示済みの `liveChatContinuation.actions` を parser が処理できる
- `liveChatTextMessageRenderer` を `ChatMessage` へ変換できる
- message、author、author photo、badges、timestamp、id、author channel identifier を保持できる
- response の次回 continuation を取得できる
- adapter は次回 continuation を内部状態へ設定する構造になっている
- continuation 実値や認証・セッション情報をログへ出力しない

未確認:

- この環境からの実 HTTP 200 response 本文の再取得
- PC の HTTP 200 response を用いた adapter の実ブラウザ end-to-end 実行
- 連続した2回以上の Network/adapter READ
- response の別 action type、system message、paid message 等の変換

従って、READ parser の構造成立性は **PASS**、実ブラウザ extension context での end-to-end READ は **PARTIAL / 未検証** とする。
