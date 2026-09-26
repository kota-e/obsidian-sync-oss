# WP-01 実装・検証報告

## 結論

状態：COMPLETE（WP-00とWP-01のオフライン範囲のみ）

確認日：2026-09-24（Windows、Node.js v24.15.0、npm 11.12.1）
開始時のGit HEAD：`4a2bfad14802f691826eeb77cf72732a07ab6a91`。

本文・パス・Remoteメタデータを外部I/Oなしで検証する土台を実装した。同期の判定・実行、R2接続、実Vault操作は未実装。

## WP-00の結果

`$env:NODE_OPTIONS='--test-reporter=tap'; node tools/preflight.mjs`：exit 0、10/10工程PASS。`reports-local/preflight/RESULT.json`を保存。元部品37件PASS、workspace部品30件PASS。Node.js 24の標準試験表示を既存の件数抽出が読めず、最初の試行はFAILとなった。TAP形式を環境変数で指定して同じ検査を再実行した。検査・承認済みハッシュ・原本は変更していない。

## 実装

対象：詳細仕様§1.3、§2.6、§2.7、§7.1〜7.3、META-001〜004/006/008/009/012/013のWP-01で検査できる部分。AT-15/18/19/20/21/39/47/58/65/67の純粋コア部分。

| ファイル | 役割 |
|---|---|
| `workspace/src/product/domain/errors.ts` | 停止理由を型付きエラーで返す |
| `workspace/src/product/bytes/content.ts` | UTF-8往復、原バイトのSHA-256参照、長さ検証。ハッシュ実装は注入 |
| `workspace/src/product/paths/safe-path.ts` | 相対Markdownパス、予約名・内部領域・親成分を含む衝突検査 |
| `workspace/src/product/metadata/canonical-json.ts` | 最大16段・決定的JSONと、受信バイトの正規形式照合 |
| `workspace/src/product/metadata/remote-schema.ts` | Head/Commit/Manifestの実行時検証、未対応capability拒否、相互ハッシュ・直近親参照の検査。検証済み値を型で区別 |
| `workspace/tests/unit/wp01.test.mjs` | 独立した固定ハッシュ・JSON期待値と正常/異常の10試験 |

追加した外部依存：なし。承認済み部品・fixture・契約文書の変更：なし。

## 実行結果

| コマンド | exit | 結果 |
|---|---:|---|
| `npm test`（workspace） | 0 | 40件PASS（部品回帰30、製品単体10） |
| `npm run test:product`（workspace） | 0 | 製品単体10件PASS |
| `npm run check:boundary`（workspace） | 0 | 新規製品ソース5件、境界PASS |
| `node tools/verify-handoff.mjs`（ルート） | 0 | 原本と引渡し資料の11チェックPASS |

製品単体試験では`fixtures/body-fixtures.json`のSHA-256（`f62d8a7cf35f1a36d7ac8a5fb96ce593114c9e389764bbafa5dee3c756c3bd61`）に列挙されたバイト列を利用し、各本文の固定期待ハッシュを照合した。空本文、BOM、CRLF、非BMP、結合文字、本文中のNULを保持し、不正UTF-8を拒否した。`_memo.md`を正常入力とした。危険パス、大小文字・Unicode・親フォルダ衝突、重複JSONキー、単独サロゲート、16段超、未知フィールドとcapability、ハッシュ不一致を拒否した。

上記AT番号は**部分カバー**。AT本体の状態は全84件ともNOT_RUNのままであり、67件のMVP 0.1対象の合格数には算入しない。通信やLocal書込回数まで検証する完全なATは後続WPと実機ゲートで実施する。

## 安全性と保全

原本ハッシュ照合：PASS。同期機能による通信・R2・実Vault本文の読み書き：0。進捗表示用のObsidian TODOノート1件だけ、利用者の明示承認に沿って更新した。正本fixtureは変更せず読取のみ。製品テストは実I/Oを作らず、Node標準の暗号ハッシュを注入した。境界チェックは正しさの保証ではないため、製品単体試験と区別した。

## 未実施・制約

- WP-02以降のPlanner、CAS、journal、Executor、実Adapter、UIは未実装。
- 直近親参照の検査はあるが、128/4,096世代の祖先追跡と循環検出はWP-03。AT-58全体は未実施。
- パスの実保存API上の衝突・リンク・接合点検査、BOMを扱う実Obsidian APIの往復は実機段階で確認する。
- Node.js 24ではpreflightの既定テスト表示が件数抽出と合わないため、次回のpreflightもTAP指定が必要。原本checkerを変更して通す措置はしていない。

## 次の作業

引渡しの初回依頼はWP-01まで。次回はWP-02でL/R/Bの判断表、blockedPathsによる停止、承認digestとSourceSnapshotRef予約を純粋ロジックとして実装・検証する。
