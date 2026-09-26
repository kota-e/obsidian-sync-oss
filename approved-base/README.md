# Obsidian同期OSS：G-BASE承認入力セット

**これはインストール可能なObsidianプラグインではありません。**
元コードの限定抽出、署名部品、依存物、ライセンス、再現手順と検証記録をまとめた開発前チェックポイントです。現在のiCloud Vault・R2アカウント・GitHub repositoryを変更しません。

## 読む順番

1. `docs/G_BASE_COMPLETION_REPORT.md`：今回の完了条件と結果・残るゲート
2. `docs/SOURCE_IMPORT_MANIFEST.md`：何を取り込んでよいか
3. `docs/DEPENDENCY_LICENSE_REVIEW.md`：依存と表示・限界
4. `evidence/approved-set.json`：検査対象の正確な集合

既存の詳細仕様書v1.0が製品要件の正本です。このチェックポイントの部品は、仕様全体の実装ではありません。

## 再実行

検証済みの環境はNode.js v22.16.0 / npm 10.9.2。Node/npm本体は含みません。

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm test
npm run gate
```

`npm test`はTypeScriptのstrictビルドと、部品テスト／境界の負試験を実行します。試験中のHTTP送信は許可しません。例示の認証情報はすべて試験専用の偽物です。
`npm run gate`は既知の許可集合のハッシュとimport・依存・ライセンスを確認します。manifestと検査コード自身を改変できる攻撃者を認証する仕組みではありません。

## 意図的に含めないもの

旧同期エンジン、Pro、旧ロゴ、実認証情報、別クラウド、Obsidian SDK・UI、実HTTP送信、公開操作、インストール先Vault、削除機能、iCloud機能。

`vendor/packages/`のローカルtarを使うため、依存取得にネットワークは不要です。署名packageは独自の限定派生版、TypeScript tarは環境内の5.8.3から作った無変更ファイルsnapshotです。公式npm tarballの同一コピーではありません。詳細な来歴・限界は依存確認書にあります。

## ライセンス

自作部分とRemotely Save断片はApache-2.0、aws4fetch由来部分はMIT。その他は個別LICENSEとNOTICEを参照してください。開発用TypeScriptには第三者表示全文を保持しています。

## 次工程

Codex引渡し用のTEST_PLAN、CODEX_IMPLEMENTATION_GUIDE、ICLOUD_REQUIREMENTS、API/Adapter検証表を整えて、最初のMVPの状態判定とモックを実装します。実機／公開判定は別ゲートです。
