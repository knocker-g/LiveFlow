# LiveFlow 技術調査結果のまとめ

## 1. 結論

結論は次の通りである。

- 結論: B. 実現可能だが重大な制約がある

### 理由

1. 公式 YouTube Data API で Live Chat の取得・投稿自体は技術的に可能である。
2. しかし、一般ユーザー向けのブラウザ拡張として、広く配布可能な設計ではない。
3. YouTube Web / Mobile Web の内部 API を使うと、ページにログイン済みのセッションを活用できるが、仕様変更と Chrome Web Store 審査リスクが大きい。
4. モバイル対応は技術的に可能だが、ブラウザ差異と viewport / fullscreen / keyboard 調整が大きい。

## 2. 推奨実装方式

### 1. 推奨方式

Hybrid + Adapter + content script overlay

- 実際の YouTube ページ上で `content script` が状態監視を行う
- UI は overlay として注入する
- チャット取得/投稿は adapter 層で抽象化する
- API 接続は、公式 API と内部 API を切り替え可能にする

これは、最も実用的で「将来の破壊的変更にも耐えやすい」設計である。

### 2. 次点方式

YouTube Web 内部 API を直接利用する方式

- 認証済みページのセッションを使える
- 実際のライブ chat 取得と投稿に近い
- ただし仕様変更に弱く、公開前提にはリスクが高い

### 3. 採用しない方式

一般公開向けに、YouTube の内部 API を拡張の基本手段として無制限利用する設計

- Web Store 公開の審査リスクが高い
- 実際の利用規約と齟齬しやすい
- 仕様変更に直結するため保守性が低い

## 3. 最大の技術的リスク

1. YouTube の内部 API / Innertube の仕様変更
2. Live Chat 取得と投稿用の認証手段が API と Web UI で分岐すること
3. Chrome Web Store の審査と利用規約上の制約
4. Mobile の viewport / keyboard / fullscreen への対応
5. YouTube DOM の変更耐性が低いこと
6. コメント数が多いときの描画負荷と Android 側の安定性

## 4. 最小 PoC

LiveFlow 本体を作る前に、技術的成立性を確認するべき最小 PoC は次の通りである。

### 1. Live Chat 取得

- YouTube のライブページを開く
- content script でページ状態を観測する
- `get_live_chat` / continuation の取得ができるか確認
- 受け取ったチャットを最低限の DOM に流し込む

### 2. Live Chat 投稿

- 公式 API 方式で、ユーザーの Google OAuth 認証を通じて投稿できるか確認
- その上で、内部 API 方式の投稿パスも最低限に試す
- どちらが実運用に対応しやすいか比較する

### 3. Mobile Web での動作

- portrait / landscape / fullscreen の切り替えを検出
- `visualViewport` と keyboard resize を確認
- 動画の上に overlay されたコメントが崩れないか確認

### 4. 認証

- `chrome.identity` や OAuth の flow が拡張内で動くか確認
- `youtube` scope を想定した認証権限の実装を最小構成で試す
- どのケースで「公式 API」が使え、どのケースで「内部 API」が使うべきかを切り分ける

### 5. Chrome拡張からの通信

- content script と service worker で state / UI / command をやり取りできるか確認
- background に依存する fetch 発火が動くか確認
- YouTube ページと extension との bridging が安定するか確認

## 5. 実際の推奨順序

1. まず PoC で「YouTube 分析」と「拡張通信」を確かめる
2. 次に「Live Chat 取得」の最小テストを実施する
3. その後に「投稿」の実証を行う
4. その後に mobile UI を実装する
5. 最後に Store 公開可能性と review リスクを再確認する

## 6. 研究の前提

- 公式ドキュメントで確認できる事実はそのまま記載した
- Web の内部 API や実際のリクエスト構造は、公開情報・OSS からの観測ベースで扱い、変動要因を明確にした
- 実装のラフな仮説は「推測」として区別した

## 7. 最終判断

LiveFlow は技術的には成立する可能性があるが、品質・保守性・公開性の三つを同時に満たすのは難しい。特に YouTube の内部 API を直接使う設計は、将来の仕様変更と Chrome Web Store 審査の両方に対して大きなリスクを抱える。

そのため、次の開発で最重要なのは、PoC を通じて「どのルートが現実的か」を検証することである。

---

この調査結果をもとに、次のフェーズでは実装ではなく、最小 PoC の設計と実施の可否を判断する。
