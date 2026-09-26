# WP-06 使い捨てAPI能力probeの提案範囲

**状態：提案のみ・未承認・未実行。** この文書は実R2通信、実Obsidian Vault操作、資格情報の取得を許可しない。`docs/API_ADAPTER_MATRIX.md`のP-R/P-L/ClientStore試験を小さく実測するための上限案。

## 対象

- ユーザーが指定する**使い捨てR2 Standardバケットまたは専用prefix**。既存同期用prefix、公開バケット、本番ノートは対象外。実際のバケット名・account ID・鍵は本書へ記載しない。
- WindowsとiPhoneにそれぞれ用意する**空の使い捨てObsidian Vault**。現在のiCloud Vault、既存の業務Vault、他プラグインのデータは対象外。
- 追加するSDK/HTTP/XML/bundlerが必要なら、版・ライセンス・由来・推移的依存を事前に差分審査する。試験用Plugin/Transportに通常ノート同期を有効化しない。

## R2の上限案

| 項目 | 上限 |
|---|---:|
| probe専用の新規オブジェクト | 20個 |
| 1オブジェクトの本文 | 1 KiB |
| probe本文の合計 | 20 KiB |
| 条件付きPUT試行 | 40回 |
| GET/HEAD/LIST/Range試行の合計 | 300回 |
| 実行時間 | 各端末30分 |

キーは指定prefix内の`svsync-probes/<deviceId>/<probeId>/`に限定し、対象以外へ書かない。条件付きPUT、旧ETagの拒否、Range/ETag、LISTの全ページ、応答消失時の読取照合を調べる。429は連打せず合成応答で検査する。redirect先へ署名付き要求を送らず、追従を送信前に止められないHTTP経路は不合格にする。自動DELETE、バケット設定変更、公開設定変更、Lifecycle変更は行わない。残留オブジェクトと要求数を報告する。

## Local/ClientStoreの上限案

- 各テストVault内に作るMarkdownは最大20ファイル、各1 KiBまで。BOM/CRLF/非BMP/0 byte、同名衝突、`Vault.process`直前の変更、開いているノート、hidden状態と復旧保存を確認する。
- プラグインのlocal storage候補は、再起動・Vaultファイルだけのコピー・保存失敗で検査する。端末識別子を推測で作らず、マーカーが不明なら停止する。
- 実iPhoneが使えない段階はiPhone証拠を`NOT_RUN`とする。Windows結果を代用しない。

## 実施前に必要な判断

1. 上記のR2範囲と、対象バケットまたは新規専用prefixの指定・利用許可。
2. Windows/iPhoneの空の使い捨てVaultの指定と、試験Plugin導入・少量の検証ファイル作成の許可。
3. 資格情報はチャット・文書・ログに貼らず、対象バケット限定権限を安全な実行時入力で渡す方法を合意する。

許可後も、まずSDK/実Transport候補を監査し、probeごとに対象・操作・残留物を確認してから実測する。ゲート不成立を無条件PUTや元Vaultでの試行で回避しない。
