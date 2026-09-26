---
title: "Codexへの引渡し手順・最初に読む文書"
version: "1.0"
date: 2026-09-06
status: "Ready for Implementation / Product Not Implemented"
document_type: "handoff-start"
production_use_approved: false
tags: [obsidian, oss, codex, handoff, mvp01]
---

# Codexへの引渡し手順・最初に読む文書

> **結論：このフォルダ一式をPC上のCodexに渡せば、追加のクラウド契約や本番Vaultの移動なしで、MVP 0.1のコア実装に着手できる。**

## 1. このパッケージが含むもの

設計の正本、取り込み許可済みの部品、オフライン依存、84件の試験計画、合成テストデータ、初回検証スクリプトをまとめた。同期プラグイン本体は未実装であり、Obsidianのpluginsへ直接置くものではない。

[今回の完了報告](docs/HANDOFF_COMPLETION_REPORT.md)、[実装ガイド](docs/CODEX_IMPLEMENTATION_GUIDE.md)、[テスト計画](docs/TEST_PLAN.md)、[iCloud要件](docs/ICLOUD_REQUIREMENTS.md)、[API検証表](docs/API_ADAPTER_MATRIX.md)を収録した。

## 2. Kotaさんが行う手順

### 手順1：ZIPをPCの通常フォルダへ展開する

例は `C:\Dev\ObsidianSyncOSS`。実際には、`AGENTS.md`、`START_HERE.md`、`approved-base`、`docs`、`tools`が同じ階層で見えるフォルダをプロジェクトのルートとする。ZIPのまま渡したり、docsだけを開いたりしない。

**iCloud、OneDrive、既存Obsidian Vaultの中には開発用一式を置かない。** WindowsのDocumentsが同期対象なら別のローカルフォルダを選ぶ。現在のiCloud Vaultは移動しない。

### 手順2：Node.jsとCodexを確認する

PowerShellで次を実行する。

```powershell
node --version
npm --version
codex --version
```

このパッケージの最低条件はNode.js 22以上とnpm。作成側の実行環境はNode.js 22.16.0、npm 10.9.2であり、他の版・Windowsでは手順3で再確認する。古い特定パッチ版を安全上の推奨として新規導入させる意味ではない。導入済みで動くなら、今回のために古い版へ変更しない。

Codex CLIが未導入なら、[公式CLI案内](https://developers.openai.com/codex/cli/)の現行手順を利用する。既に使用しているCodexのデスクトップ/IDE環境でフォルダを選べる場合、その環境でもよい。APIキーや新しい有料契約を作ることは、このパッケージの前提ではない。契約枠の消費や製品提供条件は利用中のアカウントに従う。

### 手順3：ローカルの準備確認を実行する

PowerShellで、実際に展開したルートへ移動して実行する。

```powershell
Set-Location 'C:\Dev\ObsidianSyncOSS'
node tools/preflight.mjs
```

出力が最後に`status: PASS`となれば、そのPCでの着手用確認は完了。`workspace/`が作られ、部品の検証が行われる。同期コアはまだ作られない。

このスクリプトは同梱tarから依存をインストールし、実R2、GitHub、Obsidianへ接続しない。作るのはこのルート内のworkspace、node_modules、コンパイル結果、ローカルログだけである。Codex本体のAI利用通信とは別の話であり、Codexをオフラインで使えるという意味ではない。

失敗したら`reports-local/preflight/RESULT.json`と該当ログをCodexへ読ませる。既存ファイルのハッシュ不一致を修正して通す、最新版を勝手に取得する、実行権限を無制限にする、といった回避をしない。

### 手順4：同じルートをCodexで開く

CLIを利用する場合は手順3と同じフォルダで次を実行する。

```powershell
codex
```

既存のIDE/デスクトップ環境を使う場合も、開くのはこのルートである。`approved-base/`だけ、または`workspace/`だけを開くと上位資料を見落としやすい。

Codexのファイル編集をこのプロジェクト範囲に限定し、最初は追加のインターネットアクセス・任意フォルダアクセスを許可しない。新しいAPIキーは不要。GitHub公開も最初の実装の条件ではない。[公式Windows案内](https://developers.openai.com/codex/windows/)

### 手順5：用意した依頼文を貼る

[CODEX_START_PROMPT.md](CODEX_START_PROMPT.md)のコードブロック全文を貼り付ける。最初はWP-00の再確認とWP-01の実装までに限定してある。仕様全文を一つのメッセージへコピーする必要はなく、Codexがローカル文書を読む。

AGENTS.mdは短い入口であり、全仕様の代わりではない。Codexが読む文書の順を実装ガイドにも記載した。[公式AGENTS案内](https://developers.openai.com/codex/guides/agents-md/)

### 手順6：最初の成果を確認する

期待する報告は`progress/WP01_REPORT.md`。変更ファイル、実行テスト、失敗・未実施、次の実装単位を確認する。**最初の報告で「全機能完成」「iPhone対応済み」と書かれていたら、根拠を点検する。** WP-01はコアの一部のみである。

以降は実装ガイドのWP順に進む。各WPで差分・試験・残件を記録してから次へ進み、R2/実Vault書き込みはWP-06の限定許可まで行わない。

## 3. 実機の準備は、今は不要

R2のアカウント、バケット、秘密鍵、iPhoneテストVaultは最初の純粋コア実装には不要。必要になる段階で、[API検証表](docs/API_ADAPTER_MATRIX.md)の範囲を確かめてから準備する。秘密鍵をChatGPTやGitHubの文書へ貼らない。

Windows/iPhoneでのクリックや実際のアプリ中断は、所有する端末で人が確認する必要がある。クラウド上のCodexだけでiPhone実機の合格を作ることはできない。

## 4. Obsidianに保存する資料

保管用には`docs/`内のMDをまとめて同じObsidianフォルダに保存できる。**保管用コピーと、Codexが使う開発フォルダは別物**である。node_modulesやテスト用ソースを本番Vaultへ追加しない。

## 5. フォルダの役割

| フォルダ | 役割 | 編集するか |
|---|---|---|
| approved-base | 前回G-BASEを通過した原本 | ソース・台帳・検査の変更は禁止 |
| docs | 今までの仕様と今回の引渡し資料 | 正本を黙って変更しない |
| contracts | 型・境界契約。実装ではない | 変更には記録が必要 |
| fixtures | 合成の入力・期待条件 | 原本を保ち、障害はコピーへ注入 |
| tools / templates | 着手前検査・開発場所の準備 | 通すための改変は禁止 |
| workspace | 最初のpreflightで作る開発場所 | 新規コアとテストをここに実装 |
| progress | Codexの進捗・判断記録 | 各WPで追加 |
| reports | パッケージ作成時の検証記録 | 過去の証跡 |
| reports-local | そのPCでの再検証ログ | 自動生成。公開へ無条件添付しない |

README、名称、公開形態、CIの選定などはコア実装を止める理由にしない。公開前に必要なものはG-RELEASEで確認する。
