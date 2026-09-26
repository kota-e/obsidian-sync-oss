# Codexへの最初の依頼

下の本文を、展開したプロジェクトのルートフォルダを開いたCodexへ貼り付ける。最初の対象はWP-00とWP-01だけ。`/init`で既存AGENTS.mdを上書きしない。

```text
このフォルダのAGENTS.mdとSTART_HERE.mdを読み、Obsidian同期OSSのMVP 0.1開発を始めてください。

最初にdocs/CODEX_IMPLEMENTATION_GUIDE.md、docs/IMPLEMENTATION_DECISIONS.md、承認済み詳細仕様v1.0、取り込み台帳、TEST_PLAN.mdを確認してください。
node tools/preflight.mjsを実行し、失敗した場合は原因を記録して停止してください。検査やハッシュを書き換えて通してはいけません。

合格したらWP-01「型・パス・本文ハッシュ・正規JSONと実行時スキーマ」に限定して、workspace/src/product/とworkspace/tests/unit/に実装・テストを追加してください。設計の説明だけで終えず、この範囲の実装と検証まで行ってください。

approved-base/は変更禁止です。既存のiCloud/Obsidian Vaultにはアクセスせず、ネットワーク接続・R2認証情報の要求・依存追加・公開・削除同期・iCloud実装はしないでください。
原本fixtureを変更せず、一時コピーに障害を注入してください。未知のcapability、危険パス、非正規JSON、不正UTF-8は安全側に拒否してください。

完了時にnpm test、npm run check:boundary、ルートのnode tools/verify-handoff.mjsを実行し、progress/WP01_REPORT.mdへ変更点、対応仕様ID、実行した試験、未実施項目、次工程を記録してください。
部品37件と製品のAT-01〜84を混同しないでください。WP-01だけでMVP全体が完成したとは報告しないでください。WP-02以降へは今回進まないでください。
```
