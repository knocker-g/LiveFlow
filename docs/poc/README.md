# LiveFlow PoC

## 目的

この PoC は、LiveFlow の本体実装を開始する前に、以下の技術的成立性を確認するための最小構成です。

- Chrome Manifest V3 拡張から YouTube Live を認識できるか
- Live Chat の取得が可能か
- ログイン済みユーザーの認証フローを利用できるか
- Live Chat への投稿が可能か
- PC Web と Mobile Web の差分を確認できるか

## PoC の構成

```text
poc/
├─ manifest.json
├─ popup.html
├─ src/
│  ├─ background.js
│  ├─ chat-read-core.js
│  ├─ popup.js
│  └─ youtube-chat.js
└─ README.md
```

## 実装方針

- UI は作成しない
- 取得/投稿/認証の発火点だけを検証する
- 公式 API と Web 内部 API を分離して比較する
- 1回の操作で実行される最小処理に限定する

## liveChatId 取得の比較

### 方法A: YouTube Data API から取得

- 実装可能性: 可能
- PC Web対応: 可能
- Mobile Web対応: 可能
- 認証要件: OAuth 必須
- 安定性: 高いが quota と権限が重い
- YouTube変更への耐性: 高い

### 方法B: YouTube Web ページ内部情報から取得

- 実装可能性: 可能性あり
- PC Web対応: 可能
- Mobile Web対応: 可能だが DOM 差分が大きい
- 認証要件: 既存ページセッション利用
- 安定性: 変動しやすい
- YouTube変更への耐性: 中程度

### 方法C: YouTube Web 内部 API のレスポンスから取得

- 実装可能性: 可能性が高い
- PC Web対応: 良好
- Mobile Web対応: 条件付き
- 認証要件: Cookie / session / context を前提
- 安定性: 変動が大きい
- YouTube変更への耐性: 低い

### 方法D: DOM から取得

- 実装可能性: 可能だが脆い
- PC Web対応: 可能
- Mobile Web対応: 低い
- 認証要件: なし
- 安定性: 低い
- YouTube変更への耐性: 低い

## 現在の PoC 方針

当面の PoC では、実測済みの `get_live_chat` + `continuation` を READ adapter に閉じ込める。

- 初期 continuation は DOM、iframe URL、既知の page state、関連 script の順で診断する
- 初期 continuation が解決しない場合は `get_live_chat` を発火しない
- 公式 API、OAuth、WRITE、UI は今回の READ 検証対象外とする
- Mobile Web の比較手順は [mobile-initial-continuation-investigation.md](mobile-initial-continuation-investigation.md) に記録する

## PC 初期 continuation 取得（Step 1）

現在の Step 1 は、YouTube PC watch ページの page context にある次の実測済み path から、Live Chat 用初期 continuation の存在だけを判定する。

```text
ytInitialData.contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer.continuations[0].reloadContinuationData.continuation
```

Manifest V3 では `src/page-state-main.js` を `world: MAIN` で実行し、ページ側 `window.ytInitialData` を読み取る。値は `window.postMessage` で ISOLATED world の `src/youtube-chat.js` へ渡す。content script 側は値を内部状態へ保持し、Console には `Initial live chat continuation found` または `Live chat is not available` だけを出力する。

この Step では `get_live_chat`、polling、UI、WRITE、OAuth、Mobile 対応を実行しない。

### PC Chrome 手動確認

1. `chrome://extensions` を開く
2. デベロッパーモードを有効にする
3. 「パッケージ化されていない拡張機能を読み込む」で `poc/` を選択する
4. PC Chrome で YouTube Live の watch ページを開く
5. ページの DevTools Console を開く
6. `[LiveFlow PoC] YouTube watch page detected` を確認する
7. Chat が存在する場合は `[LiveFlow PoC] Initial live chat continuation found` を確認する
8. Chat がない通常動画では `[LiveFlow PoC] Live chat is not available` を確認する
9. 別動画、別 Live 配信へ SPA 遷移し、同じ判定が再実行されることを確認する

Console に continuation の値、長さ、Cookie、認証情報は出力されない。

## PC Chat READ 2回検証（Step 4）

初回の page-state response を受け取ると、MAIN world の adapter が初期 continuation で READ #1 を1回実行する。HTTP 200 と JSON parse に成功し、response から次回 continuation が得られ、かつ同じ page revision が有効な場合だけ、READ #2 を1回実行する。

READ #1/#2 は `chat-read-core.js` の既存 parser を MAIN world で再利用する。ISOLATED world には raw response を渡さず、normalized message 配列と status/構造要約だけを渡し、`currentMessages` に message id ベースで重複排除して保持する。

確認ログ:

```text
[LiveFlow PoC] READ #1 completed: HTTP 200
[LiveFlow PoC] READ #1 parsed messages: N
[LiveFlow PoC] READ #1 next continuation available
[LiveFlow PoC] READ #2 completed: HTTP 200
[LiveFlow PoC] READ #2 parsed messages: N
```

同一 page revision で3回目は実行しない。SPA で URL が変わった場合は page revision、read count、messages をリセットし、新しいページとして最大2回まで実行する。

## 継続 READ（Step 5）

Step 5 では、response の continuation metadata に含まれる `timeoutMs` を使って次回 READ を待機する。`setInterval` や固定間隔 polling は使わない。timeout が欠落・不正な場合は安全な fallback delay を使い、HTTP failure、JSON parse failure、continuation 欠落、SPA navigation で loop を停止する。

MAIN world の `currentLoopGeneration` と `AbortController` で多重 loop と遅延 response を無効化する。ISOLATED world の `currentMessages` は id ベースで重複排除し、`MAX_MESSAGES = 500` を超えた場合は古い message を削除する。

## 最小 overlay（Step 6）

ISOLATED world の `youtube-chat.js` は `#movie_player`（fallback: `.html5-video-player`）内に `#liveflow-overlay-root` を1つだけ配置する。root は `position: absolute; inset: 0; pointer-events: none` とし、最新20件を `textContent` で描画する。SPA 遷移と pagehide では root を除去する。

## PC 内部 API context 取得（Step 2）

`src/page-state-main.js` は MAIN world で次の順に YouTube が既に保持している値を確認する。

1. `window.INNERTUBE_CONTEXT`
2. `window.ytcfg.get('INNERTUBE_CONTEXT')`
3. `window.ytcfg.data_.INNERTUBE_CONTEXT`
4. `ytcfg.get()` / `ytcfg.data_` の `INNERTUBE_CONTEXT_CLIENT_NAME`、`INNERTUBE_CONTEXT_CLIENT_VERSION`、`HL`、`GL`、`VISITOR_DATA`

取得値は `client` 配下の whitelist フィールドだけへ正規化し、同じ page-state message で continuation と ISOLATED world へ渡す。`get_live_chat` request、header 生成、Cookie 読み取り、polling はこの Step では行わない。

## 監視ログ

以下はログの例である。秘密情報は出さない。

```text
[LiveFlow PoC] Content script loaded
[LiveFlow PoC] YouTube page detected
[LiveFlow PoC] Live page detected
[LiveFlow PoC] Video ID: XXXXX
[LiveFlow PoC] liveChatId: XXXXX
[LiveFlow PoC] Authentication status: XXXXX
[LiveFlow PoC] Chat connection: XXXXX
[LiveFlow PoC] Chat message received
[LiveFlow PoC] Message send started
[LiveFlow PoC] Message send result: XXXXX
```

## 検証フロー

1. YouTube Live のページを開く
2. content script がページ検出を行う
3. `liveChatId` を取得しようとする
4. Live Chat が見つかればログを出力する
5. 初期 continuation の発見元だけを Console で確認する
6. Chat READ と次回 continuation の有無を Console で確認する
7. 結果を [results.md](results.md) に記録する

## 重要な注意

- 自動投稿は禁止
- 一定時間ごとの連投は禁止
- API quota を浪費しない
- 実際の実行確認は、ユーザーが明示的に操作したときに限る
- ここでは UI を作らず、READ / WRITE の成立性だけを確認する

## Chrome デベロッパーモードでの検証手順

1. Chrome を開く
2. `chrome://extensions` にアクセスする
3. 右上の「デベロッパーモード」をオンにする
4. 「パッケージ化されていない拡張機能を読み込む」を選択
5. `poc/` フォルダを選択して読み込む
6. YouTube Live を開く
7. DevTools を開く
8. Console を確認する
9. 画面上に `[LiveFlow PoC] YouTube Live detected` が出るか確認する
10. `liveChatId` の取得状況を確認する
11. Live Chat が確認できたら、popup の「Send test message」を押す
12. 送信結果を Console で確認する
13. YouTube 側の Live Chat 上でも送信結果を確認する

## Mobile Web / Android 実機の検証手順

### Mobile Web であることを確認する

- Chrome の開発者ツールで「モバイル表示」を有効化する
- User-Agent を Mobile に切り替える
- `m.youtube.com` または `youtube.com` 上でライブ配信を開く

### Mobile Live の確認方法

- `m.youtube.com/watch?...` の URL を開く
- YouTube Live が表示されていることを確認する
- 拡張が Chrome で読み込まれていることを確認する
- Console のログに `[LiveFlow PoC]` の出力があるか確認する

### Chat取得の確認方法

- 画面上の Live Chat の表示があるかを確認する
- 画面が自動更新されているときに Console に `Chat message received` が出るか確認する
- `author`, `message`, `timestamp`, `message type` が出ることを確認する

### Chat投稿の確認方法

- popup の「Send test message」を押す
- 実行時に `Message send started` と `Message send result` を確認する
- YouTube 側の live chat にテストメッセージが表示されるか確認する

### Quetta Android での検証メモ

- Quetta Android の Chrome / Chromium ベースブラウザに PoC を読み込める場合、同様の手順で検証する
- `chrome://extensions` またはブラウザ側の拡張管理画面で、PoC を有効化する
- モバイル版 YouTube Live を開き、Console からログを確認する
- `liveChatId` の取得が難しい場合は、ページ script / State / DOM からの取得をデバッグログで切り分ける

## 結論

この PoC は、実ブラウザの検証に必要な最小骨格を提供する。UI は作らず、実際の `liveChatId` 取得と Chat READ / WRITE の観測が主要目的である。
