# Chrome 拡張としての実現可能性 (MV3)

## 1. MV3 の基本前提

Manifest V3 を前提にした拡張では、以下の構成が中心になる。

- `content_scripts`
- `service_worker`
- `host_permissions`
- `optional_host_permissions`
- messaging (`chrome.runtime.sendMessage`, `postMessage`)
- storage API
- `chrome.cookies`（必要な場合）

## 2. YouTube ページとの通信

### 2.1 content script と service worker

典型的には次の構成になる。

- content script: YouTube ページの DOM を監視し、必要な状態（ライブ画面・chat の有無・画面向き・fullscreen 等）を抽出
- service worker: バックグラウンド状態管理、認可トークン、外部通信、メッセージ中継

本体の設計としては、YouTube ページの DOM 依存を最小化したアダプタ層を挟むと安全である。

### 2.2 通信パターン

- content script -> service worker: 現在の YouTube 状態、ライブの有無、video id など
- service worker -> content script: UI 表示/非表示、メッセージ更新、入力欄表示制御
- service worker ->外部 API: Google OAuth / YouTube Data API / YouTube internal API

### 2.3 CORS

拡張の service worker は `fetch()` を使って外部 API にアクセスできるが、ホスト権限が必要である。content script から `fetch()` する場合、同一オリジンである YouTube ドメイン向けの通信は比較的扱いやすい。

ただし、YouTube の内部 API は一般のブラウザから打つ fetch でなく、Cookie / session / page context が必要になることが多く、単純な `fetch` だけでは十分ではない。

## 3. Cookie と認証状態の利用

### 3.1 `chrome.cookies`

`chrome.cookies` は、指定したドメインの Cookie にアクセスするために使える。`host_permissions` を適切に付ければ、`youtube.com` / `m.youtube.com` / `www.youtube.com` の Cookie を取得できる可能性がある。

しかし、以下が重要である。

- すべての Cookie を読み取ることはセキュリティ上非常に大きい
- YouTube が要求するセッション認証や CSRF の条件が複雑
- 実際の YouTube アプリは cookie と script state を組み合わせている

### 3.2 YouTube のログイン済み状態を拡張から使えるか

結論として、技術的には「YouTube のログイン済み状態を利用して拡張が内部 API にアクセスする」ことは可能である。

ただし、実現方法は次の二つに分かれる。

1. 公式 API 使用: OAuth 2.0 と Google 認証が必要
2. Web 内部 API 使用: ブラウザセッションそのものを利用する前提

前者は安全だが全体として規模が大きい。後者は軽量かつ実用的なように見えるが、YouTube の内部仕様依存と公開審査のリスクが大きい。

## 4. Manifest V3 の制約

- service worker は DOM を直接持てない
- content script だけが DOM 監視に適している
- 長時間のバックグラウンド処理は制限される
- ただし event-driven で小さな通信管理なら十分実用的
- `fetch` や `storage` は利用可能

## 5. YouTube ページの内部 API を拡張から呼ぶ方法の現実的な設計

### パターン A: 公式 API

- `chrome.identity` で OAuth token を取得
- service worker で REST API を呼ぶ
- 少なくともユーザーの YouTube アカウントへの明示許可が必要

利点:

- 仕様が比較的明確
- Google の認証フレームワークに沿う
- データの扱いが明確

欠点:

- 一般化しにくい
- すべてのライブ配信に対して使えるわけではない
- YouTube Live Chat を「観覧中のページ」へボタン一発で埋め込む用途には不向き

### パターン B: page-session 内部 API

- content script が `fetch` を YouTube ドメインへ投げる
- そのとき YouTube の Cookie / session が使われるようにする
- 追加 UI をページ上にオーバーレイ表示する

利点:

- ログイン済み状態を自然に再利用できる
- 実際の YouTube の視聴体験に密着できる

欠点:

- 仕様変更が激しい
- 反スクレイピング、ToS、審査リスクが高い
- 一般ユーザーに公開する Chrome 拡張としては危うい

## 6. MV3 と Chrome Web Store での注意

- `host_permissions` はインストール時に警告が出る
- YouTube へのアクセスと cookie 利用には慎重な説明が必要
- 一般公開の拡張において、YouTube の内部通信やログインセッションを使う設計はレビュー観点でリスクが高い

## 7. 結論

Chrome 拡張 MV3 の技術としては、YouTube ページ上の live chat を取得・投稿する手段は十分にあります。

ただし、モバイル対応と Web Store 公開を含む実運用で重要なのは次の点である。

- 公式 API では汎用性が低い
- 内部 API では維持コストとリスクが高い
- 実際の運用では、「有効なページのセッションを使う」設計と「明示認証を使う」設計の両方を切り替える必要がある

## 8. 実務上の推奨

LiveFlow では、次を基本方針とする。

- まずは extension の接続点と UI を実装する
- 内部 API は adapter 層で隠蔽する
- 公式 API は「自分のチャンネル運営者向け」機能と区切る
- 一般公開版は、もし内部 API と cookie 利用が必要なら、Web Store での審査リスクに備えた設計が必須
