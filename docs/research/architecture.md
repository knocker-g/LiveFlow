# LiveFlow 推奨アーキテクチャ

## 1. 基本方針

LiveFlow は「YouTube Live のチャットを別 UI で見られるようにする」ことが目的であり、技術的には次の 2 層に分ける設計が安全である。

- UI / overlay layer
- data access adapter layer

## 2. コア設計候補

### 候補1: 公式 API 依存

用途:

- 自分のアカウントで配信を運営している場合
- 明示ユーザー同意付きの投稿／閲覧

長所:

- Google の公開仕様に沿う
- 認証・権限・監査が明確

短所:

- 一般の YouTube Live 視聴者向けには一般化しにくい
- 拡張にとっては UI 利用の自由度が低い

### 候補2: YouTube 内部 API 依存

用途:

- YouTube Web 上での現在のログイン済みセッションを利用する
- コメントの増分取得と UI オーバーレイを行う

長所:

- 実際の YouTube UI と整合しやすい
- 取得や更新の実用性が高い

短所:

- 仕様変更が激しい
- 導入時に Web Store 審査リスクが大きい
- 実装の維持が難しい

### 候補3: hybrid アーキテクチャ

用途:

- 公式 API と internal API をドメイン境界で切り分ける
- UI は共通化し、通信の差分だけアダプタで吸収する

長所:

- バージョン差分を抑えやすい
- 設計のテスト可能性が高い
- 実装フェーズで安全に切り替え可能

短所:

- 初期設計がやや複雑

## 3. 推奨アーキテクチャ

### 3.1 推奨: Hybrid + Adapter

LiveFlow の本命設計は以下のようなものとして扱う。

- `content-script` が YouTube ページ状態を監視
- `service-worker` が認証状態・API 接続・メッセージ中継を管理
- `chat-adapter` が取得手段を隠蔽する
- `renderer` がコメントを右から左へ流す UI を描画する

### 3.2 抽象化レイヤー

以下の境界を設ける。

- `PageStateAdapter` : PC/Mobile/Portrait/Landscape/Fullscreen 判定
- `YouTubeChannelAdapter` : chat visible / hidden 判定
- `ChatSourceAdapter` : official API / internal API / fallback などを切り替え
- `RendererAdapter` : コメント描画、CSS animation、canvas などの実装を抽象化

この設計により、内部 API の変更があっても UI 層はほぼ影響されない。

## 4. UI 構造

### PC

- 標準 chat が表示中: LiveFlow を非アクティブ
- 標準 chat が非表示: overlay UI を利用
- 画面右側にコメント流し、下部の入力欄と送信ボタンを設置

### Mobile

- portrait: 下部固定入力欄、コメント overlay
- landscape: 入力欄は通常非表示、動画とコメントに集中
- fullscreen: 次の動画領域も非表示

## 5. 表示方式の評価

### 1. DOM overlay + CSS animation

長所:

- 実装が簡単
- スムーズな UI 生成が可能
- モバイルでも軽い

短所:

- コメント数が多くなると DOM が肥大化する

### 2. Web Animation API

長所:

- CSS と相性が良い
- 低負荷に見える

短所:

- コメント数の増加時に管理が複雑になる

### 3. Canvas

長所:

- 大量コメント時のパフォーマンスがいい

短所:

- 文字の描画・重なり・選択や UI 統合が難しい

### 4. SVG

長所:

- 高度な描画に向く
- テキストのレイアウト管理がしやすい

短所:

- コメント数が多いと軽いが、DOM 管理に近い

### 推奨

現時点では、LiveFlow の初期実装は「DOM overlay + CSS animation / Web Animation API の組み合わせ」が最も現実的である。

Canvas は性能面で有利だが、正確なレイアウトと再利用性の面で設計コストが高くなる。

## 6. 実装フェーズの整理

### Phase 1: 研究 PoC

- 取得可能性確認
- 投稿可能性確認
- モバイル viewport and fullscreen 収集
- extension-to-page messaging

### Phase 2: UI を page 上に overlay する PoC

- コメント流しの動作確認
- 再描画負荷の確認
- mobile portrait / landscape の切り替え

### Phase 3: 実運用設計

- API adapter を分離
- 設定 / state / permissions を整理
- Web Store 審査に対応した設計

## 7. 結論

現時点の最も安全なアーキテクチャは、以下を分離する hybrid 設計である。

- UI と render
- page detection
- auth / API access
- YouTube DOM adapter

この分離により、YouTube の内部 API が変わっても LiveFlow の UI と動作ロジックを維持しやすくなる。
