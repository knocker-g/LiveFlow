# Live Chat ID 取得経路の調査

## 結論

現在の YouTube Live ページでは、`liveChatId` は「常にページの最初からグローバル変数としてある」という前提ではなく、
実際には次の経路で取得される可能性が高い。

```text
Video ID
    ↓
YouTube page state / player response / browse response / live chat response
    ↓
liveChatId
```

つまり、現在の PoC で `window.__INITIAL_DATA__` か `script` の文字列検索だけで `liveChatId` を拾おうとするのは、現行の YouTube ページ構造に対して不十分である。

特に、現在の実装では次の点が問題である。

- `yt-live-chat-app` / `ytd-live-chat-frame` / `[data-live-chat-id]` は、ライブチャット UI が完全に描画される前には存在しない可能性が高い
- `script` の `liveChatId` 正規表現は、ページ全体の script にその値が含まれていないと失敗する
- `window.__INITIAL_DATA__` と `window.ytInitialData` も、YouTube の現行ページでは「その値が見える scope」ではない可能性がある
- さらに、`liveChatId` は `liveChatRenderer.clientId` と混同しやすく、実際には別物である

## 現在の実装確認

現在の `youtube-chat.js` で `liveChatId` 探索ロジックは、以下の順に試している。

1. `yt-live-chat-app` などの DOM selector
2. `data-live-chat-id` / `video-id` を持つ要素の確認
3. `document.scripts` の script text から `liveChatId` の正規表現検索
4. `window.__INITIAL_DATA__` / `window.ytInitialData` の深掘り探索

この順番自体は妥当なのだが、現在のページでは以下の理由で `not resolved yet` になりやすい。

- Live Chat UI がまだ初期化されていない
- `liveChatId` が DOM に直接入っていない
- JSON が script に含まれていても、正規表現が一致しない
- `liveChatId` は `liveChatRenderer` / `continuation` / `youtubei` リクエストの中にのみ存在する
- YouTube の SPA では、ページ遷移直後に `body` の DOM だけが作られて、Live Chat のデータが後続で補完される

## 実際の YouTube ページの構造と探索ロジックの相違

### 1. 実際の YouTube は「グローバル変数の一発取得」ではないことが多い

YouTube は live page の初期化時に、以下のような情報を持つことがある。

- `videoDetails`
- `streamingData`
- `playerConfig`
- `ytInitialPlayerResponse`
- `ytInitialData`
- `youtubei` による JSON API レスポンス

ただし、`liveChatId` はこれらのうちの一部に必ず含まれるとは限らない。

### 2. liveChatId と clientId の混同

現在の実装では、`liveChatRenderer.clientId` を `liveChatId` のように扱う可能性がある。
これは誤りである。

- `liveChatId` はライブ配信や chat の識別子
- `clientId` はクライアント・セッション識別に近いもの

現行 YouTube では、chat の取得に使う `liveChatId` は、ページのメインデータから直接見えるとは限らず、`live_chat/get_live_chat` のレスポンスの中に現れることが多い。

### 3. MutationObserver のタイミング問題

`MutationObserver` は、chat の DOM が描画され始めた後には有効だが、
その前に `liveChatId` を拾う必要があるときには弱い。

つまり、次の順番が発生している可能性がある。

1. YouTube はページ遷移した
2. video ID は取れる
3. live chat UI はまだ未描画または部分描画
4. `liveChatId` はまだ未ロード
5. content script は `MutationObserver` に到達したが、chat DOM がまだない

この場合、`not resolved yet` になるのは妥当である。

## 実際の YouTube ページを調べるための具体手順

### A. Chrome DevTools での確認手順

1. `https://www.youtube.com/watch?v=acQA6qZJk7g` を開く
2. DevTools を開く
3. Console に次を入力する

```js
window.location.href
```

```js
Object.keys(window).filter((k) => /INITIAL|DATA|YT|PLAYER|LIVE/i.test(k)).slice(0, 200)
```

```js
window.__INITIAL_DATA__
```

```js
window.ytInitialData
```

```js
window.ytInitialPlayerResponse
```

```js
window.__INITIAL_PLAYER_RESPONSE__
```

```js
document.querySelectorAll('script').length
```

4. Console で文字列検索を行う

```js
Array.from(document.scripts).map((s) => s.textContent || '').join('\n').includes('liveChatId')
```

```js
Array.from(document.scripts).map((s) => s.textContent || '').join('\n').match(/liveChatId|liveChatRenderer|continuation/i)
```

5. DevTools の Elements で以下を確認する

```js
document.querySelector('ytd-live-chat-frame')
document.querySelector('yt-live-chat-app')
document.querySelector('[data-live-chat-id]')
```

6. DevTools の Network で以下のフィルタを使う

```text
youtubei
live_chat
get_live_chat
next
player
browse
```

## Network で確認するべき項目

### 1. `youtubei` 系リクエスト

YouTube live page は、内部 API の `youtubei` に対して JSON を取得している可能性が高い。重点確認項目は以下。

- URL
- HTTP method
- request payload
- headers
- response structure
- `continuation` の有無
- `liveChatContinuation` の有無

### 2. `get_live_chat` / `live_chat`

この種の endpoint は、YouTube Live Chat を取得する際に使われる。典型的な観測ポイントは以下。

- URL に `live_chat` もしくは `get_live_chat` を含む
- POST / JSON でリクエストされる
- body に `context`, `continuation`, `params` などがある
- response 内に `continuationContents.liveChatContinuation` がある

### 3. `player` / `browse`

page load時に、video / watch / browse の payload に live-chat 関連データが含まれる場合がある。特に、以下を優先して確認する。

- `videoId`
- `liveChatId`
- `isLive`
- `continuation`
- `engagementPanels`

## `liveChatId` の取得経路の候補比較

### 候補A: ページ初期化データ

- 実装可能性: 可能だが依存が強い
- PC Web: 条件付きで可能
- Mobile Web: 条件付き
- 依存: `ytInitialData` / `ytInitialPlayerResponse` / `__INITIAL_DATA__`
- 問題: liveChatId が含まれないことが多い

### 候補B: `ytInitialData`

- 実装可能性: 可能性あり
- PC Web: 一部で見つかる可能性がある
- Mobile Web: 不明
- 問題: live chat の ID が常にここに入るとは限らない

### 候補C: `ytInitialPlayerResponse`

- 実装可能性: 可能だが限定的
- PC Web: video metadata には含まれることがある
- Mobile Web: 似た形式
- 問題: liveChatId そのものは別経路にあることが多い

### 候補D: player response

- 実装可能性: 可能性あり
- 問題: liveChatId はここに直接ないことが多い

### 候補E: Innertube `next`

- 実装可能性: 高い
- PC Web: 大きい可能性
- Mobile Web: ありうる
- 問題: 実際のレスポンス構造と `context` が必要

### 候補F: Live Chat 関連レスポンス

- 実装可能性: 最も現実的
- PC Web: 高い
- Mobile Web: 条件付き
- 問題: `live_chat/get_live_chat` の endpoint や `continuation` を正しく追う必要がある

### 候補G: continuation

- 実装可能性: 可能
- 問題: まず continuation をどこから取るかが課題

### 候補H: DOM

- 実装可能性: 低い
- 安定性: 低い
- 問題: DOM 変更に弱い

## 結論としての現実的見立て

現時点での実際の YouTube Live page を前提にすると、最も現実的なアプローチは次の順序である。

1. `videoId` を取得する
2. `youtubei` / `player` / `browse` / `next` のレスポンスから chat 関連の情報を探す
3. `liveChatId` を response の `liveChatRenderer` / `continuation` / `engagementPanels` をたどって取得する
4. それでも見つからない場合は、`live_chat/get_live_chat` を発火して continuation を取得する
5. DOM は最後のフォールバックとして扱う

## Chrome Extension でのアクセス可能性

content script から `liveChatId` にアクセスできるかどうかは、取得元がどこにあるかで決まる。

### 可能な場合

- `window` に公開されている global state に存在する
- `document` に DOM 要素として存在する
- `window.postMessage` で page context から渡される
- `customEvent` や `DOM` の attribute を使って渡される

### できない場合

- ページの内部 JS のスコープにだけ存在する
- JS の実行コンテキストが content script と page で分かれている
- `window` に明示的に露出されていない

content script はページ JavaScript と完全同一ではないため、
`window` 上に見えるデータでも content script からそのまま扱えないことがある。

そのため、必要なら次の橋渡しを考える。

```text
Page Context
     ↓
DOM / CustomEvent / postMessage
     ↓
Content Script
```

このパターンは、YouTube の page script が何を持っているかに依存する。

## Mobile Web

Mobile Web では、ライブページの DOM と `youtubei` のレスポンス構造が PC 版と若干ずれる可能性が高い。

- `ytd-live-chat-frame` / `yt-live-chat-app` が存在しないことがある
- `liveChatId` の上書きタイミングが異なる
- Mobile では `player` / `browse` / `next` の request が別経路になる可能性がある

したがって、Mobile 特有の検証が必要であり、PC 版の探索ロジックをそのまま使うのは危険である。

## 安定性

`liveChatId` の取得経路の安定性は、以下で大きく変わる。

- DOM 依存: 低い
- `ytInitialData` 依存: 中程度
- Internal API の response 依存: 高いが実際に使える
- Page script string search: 非常に脆い

最も現実的なのは、YouTube 内部 API のレスポンスから `liveChatId` を辿るアプローチだが、これは公開仕様ではなく、変更耐性が最も低い。

## 次の PoC

`liveChatId` の取得が確認できた後、次は以下を検証する。

1. `videoId` を軸に `liveChatId` を取得できるか
2. `get_live_chat` の endpoint と continuation を確認する
3. 取得した chat message を Console に出す
4. Chat READ が実際に動作するか
5. その後に Chat WRITE の正規パスが実現可能か

## 実装上の注意

以下はまだ行わないこと。

- Chat READ 本体の実装
- Chat WRITE 本体の実装
- UI 実装
- OAuth 本実装
- LiveFlow 本体実装

今回の目的は、`liveChatId` の取得経路を現行の YouTube Live page と Network から特定することに限定する。

## 推奨取得方式

1. 推奨
   - `youtubei` / `player` / `browse` / `next` の実通信から `liveChatId` を取得する

2. 代替
   - `ytInitialData` / `ytInitialPlayerResponse` / `window` state からの検出

3. フォールバック
   - DOM から `data-live-chat-id` / `video-id` / `liveChatRenderer` を探す

## 重要な判断

現在の実装が `not resolved yet` になったのは、
`liveChatId` が「そのページに即座に見える値」ではなく、
`YouTube の内部 API / page data / SPA 更新の後段」で確定する可能性が高いためである。

したがって、現時点のロジックは「探索の前提そのものが弱い」状態である。

実際に YouTube Live ページで `liveChatId` を確認するには、
DevTools の Network と Console を使って、page state / response / live chat request を追う必要がある。

未確認の項目は、現時点では「未確認」と明記する。
