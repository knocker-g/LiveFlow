# Chrome Web Store 公開可能性と審査リスク

## 1. Chrome Web Store 公開の前提条件

Chrome Web Store に公開する拡張機能には、基本的に次が求められる。

- Manifest V3 での実装
- 明確な機能説明と利用規約
- 影響範囲の説明
- 利用する権限の説明
- 重大なプライバシーリスクの説明
- もし OAuth を使うなら、Google Cloud / OAuth Client との整合

## 2. YouTube と拡張の関係

LiveFlow のような拡張は、YouTube のページに対して次のような権限やアクセスを含む可能性がある。

- YouTube ページへのアクセス
- YouTube DOM の監視
- Live Chat 取得
- Live Chat 投稿
- Cookie / session 依存
- OAuth 認証
- host permissions

これは技術的には成立しうるが、Web Store の審査の観点からはかなり慎重に扱う必要がある。

## 3. 「技術的には動くが公開困難」な典型パターン

以下は典型的に公開困難な設計である。

### 3.1 YouTube の内部 API をブラウザから直接利用する方式

- YouTube の内部 API / session を利用する
- 標準の公開仕様にない通信を使う
- ログイン済みページの Cookie を使ってチャットを取得/投稿する

この方式は技術的には動く可能性が高いが、以下の理由で危険である。

- YouTube の利用規約・サービス利用条件との関係
- ブラウザ拡張が内部 API を用いて裏技的に閲覧/投稿するリスク
- 監査/レビュー時に「それはサービスの正常な利用ではない」と判断される可能性

### 3.2 すべての YouTube Live に対して、拡張が勝手に自動投稿する設計

- あるユーザーが閲覧中のライブに勝手にコメントを送る
- そのコメントがユーザーの意図と無関係に送られる
- Google や YouTube 側で不正利用と見なされるリスク

### 3.3 一般ユーザー向けに、認証なしで YouTube セッションを横断する設計

- Chrome 拡張が特定のユーザーセッションを横断して読む
- そのページの cookies を覗き見するような挙動
- Chrome Web Store のレビュー上、加盟的に高リスク

## 4. OAuth と API key の扱い

### OAuth Client ID

公式 API を使う場合、Google OAuth を背景に持つ設計であれば、通常は Google Cloud 上に OAuth Client ID を置く必要がある。これは技術的には正当な設計である。

ただし、一般公開の拡張で「ユーザーの YouTube アカウントにアクセスしてライブチャットを送受信する」には、利用目的と権限の説明が厳密に必要になる。

### API key

YouTube Data API では API key は利用可能な場面もあるが、ライブチャットの読み書きに関する高権限アクセスには通常 OAuth が必要であり、API key だけでは不十分である。

## 5. Chrome Web Store 審査観点の最大の注意点

- YouTube の内部 API 利用はレビューで不透明な部分が大きい
- Cookie / session の自動利用は高リスク
- バックグラウンドで YouTube Live のユーザー操作を誘発する挙動は査定対象になる
- 権限が多すぎると「弱い説明」になりやすい

## 6. 実務上の推奨

### 推奨しない方式

- YouTube の内部 API を拡張から直接呼ぶことを前提にした公開拡張
- YouTube の Web セッションを extension によって勝手に横断する設計
- 完全に非公式な通信だけで動く一般向け公開版

### 実用的な設計

- 公式 API を使う「自分のアカウント・自分のライブ用」設計
- YouTube page 上での閲覧/オーバーレイ UI は content script と DOM 分離で扱う
- 内部 API は adapter に閉じ込め、最小限のアクセスに留める
- 実運用前に Chrome Web Store 審査観点でテストする

## 7. 結論

LiveFlow は技術的には成立しうるが、公開対象として「YouTube 内部 API と Cookie を利用してログイン済みセッションをそのまま利用する」設計は、Chrome Web Store での公開リスクが非常に高い。

少なくとも公開版は、次のどちらかに限定するのが現実的である。

1. 明示的な OAuth による自分のアカウント向け機能
2. YouTube ページ上で動く UI を補助するだけの限定的な extension

## 8. 重要な判断

「技術的には動くが Card Store では公開困難」な設計は、主に以下である。

- YouTube 内部通信を拡張がそのまま利用する設計
- ログイン済みユーザーのセッションを自動利用する設計
- Google の公開 API ではなく、Web UI / internal API を無制限に使う設計

これは実装可能性はあるが、公開性と審査の両面でかなり難しい。
