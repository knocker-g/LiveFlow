# Android / Mobile Browser 研究

## 1. Chrome Android での拡張サポート

### 事実ベース

一般的な Chrome for Android では、デスクトップ版のような通常の拡張機能サポートは提供されていない。これは Chrome の多くの拡張機能モデルがデスクトップ前提であるためである。

一方で、Chromium 系ブラウザには拡張対応の実装や独自の機能が存在する場合があるが、これは一般的に「Chrome for Android の完全な互換」ではない。

### 結論

- Chrome Android を単一ターゲットにするのは現実的ではない
- モバイルとデスクトップで同じ拡張機能が同様に動くとは考えにくい
- LiveFlow の設計では、モバイル向けに「同じコードベースで動く」よりも、「別の動作モードを持つ」設計が安全

## 2. 機器種別と UI 判定

LiveFlow は以下の判定を必要とする。

- Desktop
- Mobile Portrait
- Mobile Landscape
- Mobile Landscape Fullscreen
- Desktop + standard chat visible
- Desktop + standard chat hidden

### 判定手段の候補

- `window.matchMedia('(pointer: coarse)')`
- `navigator.userAgent` の補助
- `screen.width` / `screen.height`
- `window.innerWidth` / `window.innerHeight`
- `visualViewport` の情報
- `fullscreen` の状態
- `orientationchange` / `resize` の監視

### 実務上の推奨

- UA 文字列の単純判定に依存しない
- `matchMedia` と `visualViewport` を組み合わせる
- fullscreen と orientation を分離して監視する

## 3. viewport / keyboard / fullscreen

### 3.1 `visualViewport`

モバイルではキーボード表示時に viewport が変化するため、これは LiveFlow の入力欄表示位置の制御に重要である。

- `visualViewport.height`
- `visualViewport.offsetTop`
- `visualViewport.scale`
- `resize` イベント
- `scroll` イベント

### 3.2 fullscreen

- `document.fullscreenElement`
- `fullscreenchange` 事件
- `webkitfullscreenchange` の互換対応

### 3.3 orientation

- `screen.orientation` も使えるが、実装に揺れがある
- `matchMedia('(orientation: portrait)')` と `resize` を併用するのが安全

## 4. Mobile Web の UI 制約

### 4.1 縦画面

- 入力エリアは画面下部に固定
- Visual Viewport とキーボードへの対応が必須
- 不要な UI を削除し、動画とコメント表示を優先

### 4.2 横画面

- 入力UI は通常表示しない
- 他の UI の消費領域を最小化する
- 動画とコメントが重ならないようにレイアウトを制御する

### 4.3 全画面

- 次の動画領域を非表示にする
- LIVE chat をフィルタ不要に表示しやすいように重ね合わせる
- video とチャットの可視性を最優先にする

## 5. YouTube DOM 依存の妥当性

PC と Mobile の URL / DOM は変化しやすいので、完全な DOM 依存は避けるべきである。したがって、以下のように薄いアダプタを作るのが実務上の安全策である。

- `page-state-adapter.ts`
- `youtube-dom-observer.ts`
- `device-context.ts`

監視対象の例:

- chat container の有無
- fullscreen state
- standard chat visible / hidden の状態
- video element の detection
- YouTube の class 名や attribute を捉えるためのアダプタ

## 6. 実際の運用で必要な考慮

### 推奨

- MutationObserver を使って、UI の変化を検知する
- `ResizeObserver` も有効
- DOM セレクタ依存は可能な限り1箇所に閉じる
- 「DOM を読む」ロジックと「UI レンダリング」ロジックを分離する

### 非推奨

- YouTube の class 名や DOM 仕様に強く依存する実装
- page 全体の構造を2つ3つの CSS セレクタで固定する実装
- 一つのセレクタに大きく依存したライブ要素の監視

## 7. まとめ

モバイル対応の本命は「拡張機能の共通設計を持ちつつ、モバイル向けに別レイアウトと motion 制御を分ける」ことである。

Chrome 拡張のモバイル対応は、Chrome そのものの拡張サポートの制約が大きいため、代替的に「サイト上で動く UI としての実装」または「特定フォーマットのブラウザに対して最適化した実装」を採る設計がより現実的である。

なお、Android のブラウザ差異が大きく、どの Chromium ベースのブラウザも同じ挙動を保証するわけではない。そこで LiveFlow では、拡張ではなく「YouTube ページ上で動く Overlay UI」の設計思想を採るのが安全である。
