---
title: "引渡し資料の一次情報・確認範囲"
version: "1.0"
date: 2026-09-06
status: "Ready for Implementation / Product Not Implemented"
document_type: "external-references"
production_use_approved: false
tags: [obsidian, oss, codex, handoff, mvp01]
---

# 引渡し資料の一次情報・確認範囲

確認日：2026-09-06。仕様の設計値と外部製品の事実を区別する。以下はAPIやCodexの使い方の判断資料であり、実機・通信試験の代替ではない。

| ID | 一次資料 | 確認したこと・限界 |
|---|---|---|
| EXT01 | [Codex CLI](https://developers.openai.com/codex/cli/) | プロジェクトのフォルダからCLIを起動しローカルコードを扱う。既存導入と権限はユーザー環境で確認 |
| EXT02 | [AGENTS.md](https://developers.openai.com/codex/guides/agents-md/) | 階層に沿う指示読み込み。短い入口にし、関連仕様は明示的に読む |
| EXT03 | [Codex Windows](https://developers.openai.com/codex/windows/) | Windowsで作業範囲を限定した実行。無制限アクセスを前提にしない |
| EXT04 | [Obsidian Vault](https://docs.obsidian.md/Plugins/Vault) | 通常ファイルとhidden領域、read/modify/processの設計上の参考。実API採用は版固定とprobe |
| EXT05 | [Mobile development](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development) | モバイルではNode/Electron前提を避ける |
| EXT06 | [同期方式案内](https://obsidian.md/help/sync-notes) | iCloudとWindowsの組合せの注意。安全モード実現の保証ではない |
| EXT07 | [R2 S3 API互換表](https://developers.cloudflare.com/r2/api/s3/api/) | 条件付きPUT、GET/HEAD/Range、LIST等の対応情報 |
| EXT08 | [R2制限](https://developers.cloudflare.com/r2/platform/limits/) | 同一keyの頻度制限。実行の予算・条件競合と区別 |
| EXT09 | [R2 aws4fetch例](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/) | 上流ライブラリ使用の公式例。派生署名部品の保証ではない |

OpenAIのdevelopers.openai.comの上記ページは今回の取得時にlearn.chatgpt.comの公式資料へリダイレクトされた。画面やブランド名の細部に依存せず、ローカルフォルダを指定してCLIまたは利用中のIDE環境で実行する手順にした。

Obsidianの一部の深いTypeScript API参照URLは取得時にNot Found/取得不可となった。`App.loadLocalStorage/saveLocalStorage`等の正確な現行型や保存保証を、このリンクだけで確認済みとはしていない。API検証表の未検証候補として残す。

固定ソースの権利・依存来歴は既存のSOURCE_IMPORT_MANIFEST/DEPENDENCY_LICENSE_REVIEWが正本。これらの公式文書を読むことが、新しいnpm依存の一括追加許可にはならない。
