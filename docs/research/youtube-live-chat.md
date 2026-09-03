# YouTube Live Chat 取得と投稿の技術調査

## 1. 事実ベースの整理

この章では、公式ドキュメント・既存の公開実装・実際のWeb通信のパターンを区別して整理する。

- 公式ドキュメントで確認できる事実
- Web上で実際に使われている実装パターン
- OSS/公開情報から確認できる情報
- 推測・未検証事項

## 2. 公式YouTube Data API による Live Chat

### 2.1 公式に存在するメソッド

YouTube Data API v3 では、LiveChat 関連として次を確認できる。

- `liveChatMessages.list`
- `liveChatMessages.streamList`
- `liveChatMessages.insert`
- `liveChatMessages.delete`
- `liveChatMessages.transition`

公式ドキュメントでは、`liveChatMessage` は `liveChatId` を持ち、チャットの新規メッセージやイベントを表す。`liveChatId` は `liveBroadcast` の `snippet.liveChatId` から得る。

### 2.2 認証と OAuth

YouTube Data API では一般に OAuth 2.0 が必要。

関連 scope の例:

- `https://www.googleapis.com/auth/youtube`
- `https://www.googleapis.com/auth/youtube.force-ssl`
- `https://www.googleapis.com/auth/youtube.readonly`

公式のスコープ一覧では、YouTube Data API v3 は `youtube` / `youtube.force-ssl` / `youtube.readonly` 等が中心である。

重要な点:

- これは「拡張機能側がアプリとしてユーザーの YouTube アカウントにアクセスする」設計である。
- 既にユーザーがブラウザにログイン済みでも、拡張機能はそのセッションを自動的に使うものではない。
- 画面上のユーザー操作により OAuth 同意が必要になる。

### 2.3 quota と制約

YouTube Data API は quota ベースであり、ライブチャットのポーリングや常時取得はすぐ制限にぶつかりやすい。公式ドキュメントでは、API 利用は quota と rate limit の対象になる。特にブラウザ拡張のように、ユーザーが開いているページから定期的に長時間ポーリングする設計は API の想定とは合わない。

### 2.4 ブラウザ拡張からの実用性

公式 API を拡張から利用する場合の問題点は次の通り。

- 拡張が Google OAuth を持つ必要がある
- `chrome.identity` か Google Identity 用のポップアップ認証が必要
- 規定のクライアント ID とスコープ承認が必要
- 一般利用者向けの拡張としては、毎回ユーザーへの同意が必要になる
- 1 つの拡張で「この YouTube 配信のライブチャットを読み書きしたい」といった利用には、ユーザーの明示同意が必要

つまり、公式 API は「自分のチャンネル運営者 / モデレーター向けの API」にはかなり適しているが、一般ユーザーが閲覧中の YouTube Live へ拡張が只管乗っかるという用途には不向きである。

### 2.5 結論: 公式 API の位置づけ

公式 API は、LiveFlow の「投稿」や「閲覧」のうち、ユーザーが自分の Google アカウントを明示的に使う場面には実用的である。

一方で、次の用途には不向きである。

- YouTube Web のログイン済みセッションをそのまま流用したい
- 拡張で YouTube Live を観覧中にチャット UI を再現したい
- 一般ユーザーが気軽に導入できる拡張として販売したい

## 3. YouTube Web / Mobile Web の内部 API

### 3.1 事実として知られているもの

YouTube Web の実際のライブチャットでは、ページのブラウザ JS が内部 API を呼んでいると考えられる。公開情報と OSS の観測で、以下のパターンが広く見られる。

- `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat`
- `https://www.youtube.com/youtubei/v1/next`
- `continuation` ベースのページング
- 返却データに `continuationContents.liveChatContinuation` が含まれる
- `actions` の配列にメッセージやイベントが含まれる

### 3.2 Innertube の基本構造

YouTube の Web / Mobile Web は Innertube と呼ばれる内部 API を持つと一般に理解されている。実際のリクエストには次のような値が含まれる。

- `context` オブジェクト
- `clientName` / `clientVersion`
- `visitorData`
- `key` (公開される API key 的な値)
- `continuation` / `clickTracking` / `params`
- `X-Youtube-Client-Name`
- `X-Youtube-Client-Version`
- `X-Goog-Visitor-Id`
- `X-Goog-AuthUser`
- 関連する Cookie とセッション情報

### 3.3 認証と Cookie

YouTube の Web 内部 API は、一般にログイン済みブラウザの Cookie とセッションを前提に動く。これにより、閲覧中のユーザーがチャットにアクセスできる状態と整合する。

ただし、これは公開されている一般向け「API」ではない。これらはサイト内 JS が使う内部エンドポイントであり、仕様変更やリジェクトの対象になりやすい。

### 3.4 continuation と live chat 更新方式

ライブチャットの更新は、通常次のような流れになる。

1. 初回 `get_live_chat` でチャットの初期スナップショットを取得
2. `continuation` トークンを受け取る
3. 連続する `get_live_chat` / `next` /  continuation で更新を受ける
4. 新しいコメントやイベントが追加される

この設計は YouTube の UI が本当に使っている方式と整合しており、コメントの増分取得に適している。

### 3.5 PC Web と Mobile Web の違い

公開情報から、PC と mobile では以下が異なる可能性が高い。

- `context.clientScreen` や `context.clientName` の差分
- 画面サイズや viewport が異なる
- Live Chat の UI ルートや `ytLiveChat` / `live-chat` の DOM 構造が異なる
- Mobile では `clientScreen` と `hl` / `gl` の値が異なることがある
- 取得パラメータと `continuation` の形式が変わる場合がある

ただし、内部 API の全体像は概ね共通しており、コメント取得の基礎は同じである。

### 3.6 実際に利用されている方式か

結論として、YouTube の現在の Web / Mobile Web が実際に使っているのは、公開ドキュメントではなく内部の Innertube ベースの API であると見るのが妥当である。

これは「公式 API ではなく、ブラウザ側の内部通信に対応する」設計になる。技術的には実現可能だが、以下が課題になる。

- 仕様変更の頻度
- 反ボットやセキュリティ対策
- 一般向け拡張にとっての維持コスト
- Chrome Web Store 審査との兼ね合い

## 4. Live Chat への投稿の実現可能性

### 4.1 公式 YouTube Data API による投稿

`liveChatMessages.insert` が公式に存在する。これはコメント投稿そのものをサポートしているため、技術的には可能である。

ただし条件が厳しい。

- Google OAuth の認可が必要
- 投稿対象のチャンネル / liveChatId が必要
- YouTube で「投稿可能な実行者」であること
- 一般ユーザーが見ているライブ配信に対して、拡張が勝手に投稿するには大きな権限付与が必要

### 4.2 YouTube Web 内部 API による投稿

YouTube の Web UI から投稿する操作は、内部 API の `live_chat/send_message` などのようなリクエスト群に対応する可能性がある。公開情報としては、これは一部の OSS 実装で観測されるパターンではあるが、内部 API の形式は比較的揺らぎやすい。

### 4.3 Mobile Web からの投稿

Mobile Web は PC Web と異なる `client` 経路や `context` を使う可能性が高い。実際には Web UI と同じく、ユーザーの Cookie とログイン状態を利用して投稿するパターンがあるものと推測される。

### 4.4 エモート / カスタム絵文字 / メンバーシップ絵文字

公式 API では、メッセージ投稿時に何らかのメタ情報を含めることができるが、エモートやカスタム絵文字の完全な実装は公式 API で簡単に扱えるわけではない。Web UI では内部 API と独自の UI 仕様に依存する。

- 通常のテキスト: 公式 API で可能
- カスタム絵文字や特別なアイコン: Web UI / internal API 依存の可能性が高い
- Super Chat / Super Sticker / メンバーシップ系イベント: 視聴者向けに特別なメッセージ種別があり、公式 API でも扱えるが管理は厳密に制限される

### 4.5 実用的な判断

「取得できるだけでは不十分」で、投稿も必要である。結論として:

- 公式 API による投稿: 実現可能だが「自分のアカウント・自分のライブ」に限定される
- Web 内部 API による投稿: 技術的には可能だが、公開仕様がなく、配布前提の利用は高リスク

## 5. 実際の判断

### 結論

- 取得の実現性: 高い（ただし内部 API 前提）
- 投稿の実現性: 可能だが、公式 API か内部 API のどちらかに依存し、条件が厳しい
- 一般向けの公開 Chrome 拡張としての実現性: 制約が非常に大きい

## 6. 参考にした公開情報の例

- Google Developers: YouTube Data API v3, `liveChatMessages` documentation
- Google OAuth 2.0 scope documentation
- Chrome Extension MV3 docs
- Chrome Web Store / extension policy docs
- 公開されている OSS 実装（例: yt-dlp, Invidious 系の研究、YouTube 構造を逆解析しているライブラリ）

## 7. 未検証・推測の明確化

以下は公開事実の確認が不十分な点で、推測として扱う。

- YouTube 内部 API の完全なリクエストフォーマット
- 今回の Live Chat 取得で使われている最新の `continuation` の完全な構造
- PC/モバイルの API 差分がどこまで固定されているか
- 今後の変更でどこまで破壊的変更が入るか

これらは、実装を進める前に実ブラウザでの観測が必須である。
