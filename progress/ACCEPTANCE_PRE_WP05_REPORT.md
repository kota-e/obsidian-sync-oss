# WP-05前の受入試験・モデル実行結果

実行日：2026-09-24。実装commit：`63ea4338f53184b7f12453524c365c9a06504a4e`。環境：Windows、Node.js v24.15.0、npm 11.12.1。試験用入力は`fixtures/`の合成データであり、実Vault・実R2への操作は0。

## 判定

| ケース | 実行した範囲 | ケース状態 | 残る条件 |
|---|---|---|---|
| AT-04 | L=B/R=C/共通版=Aで計画を作り、別パスも含め転送操作0、head/Local/基準不変を確認 | NOT_RUN（モデル一部PASS） | WP-05の承認済み計画→Executor実行停止を未確認 |
| AT-15 | 未知capabilityをheadとmanifestへ別々に注入し、Remote読取を拒否、PUT0 | PASS | 必要レベルはmodelのみ |
| AT-16 | 復旧コピーの書込失敗・読戻し破損で旧Local不変、receiptなしを確認 | NOT_RUN（モデル一部PASS） | WP-05のRemote公開0・Local適用0を含む一連の実行、Windows/iPhoneが未確認 |
| AT-47 | 正本の重複キー・過大ネスト・非正規JSON・単独サロゲート、未知キーを拒否 | PASS | 必要レベルはmodelのみ |
| AT-54 | ClientStoreがsequence 2を予約しjournalが1までの状態で起動判定を拒否 | PASS_MODEL_ONLY | Windows/iPhoneの実保存・再起動は未確認 |
| AT-55 | 別の計算手段で整合する同sequenceの二つのcheckpointを作り、分岐停止 | PASS_MODEL_ONLY | Windows/iPhoneの実保存・再起動は未確認 |

個別の入力・注入点・前後証拠は`progress/acceptance/AT-xx.json`に保存した。`PASS_MODEL_ONLY`は正式な全レベル合格ではない。AT-04/16は試験コードが成功してもケース全体を`NOT_RUN`のままにした。

今回の6ケースに限った状態は、`PASS` 2件、`PASS_MODEL_ONLY` 2件、`NOT_RUN` 2件。84件全体では残り78件に今回の判定を行っていない。MVP 0.1対象67件の全体完了は主張しない。正本`docs/TEST_PLAN.md`と`fixtures/ACCEPTANCE_TESTS.json`の作成時点`NOT_RUN`は履歴として変更していない。

## 実行と原本確認

| コマンド | 結果 |
|---|---|
| `$env:NODE_OPTIONS='--test-reporter=tap'; node tools/preflight.mjs`（ルート） | 10/10工程PASS |
| `npm run test:product`（workspace） | 68件PASS（既存62件＋新受入モデル6件） |
| `npm test`（workspace） | 全98件PASS（製品68件＋既存部品30件） |
| `npm run check:boundary`（workspace） | PASS。新プロジェクトソース18ファイルのまま |
| `node tools/verify-handoff.mjs`（ルート） | 11項目PASS。固定原本・試験計画・fixture未変更 |
| `git diff --check` | PASS |

`npm run check:boundary`の`productCorrectnessVerified: false`、`verify-handoff`の`productTestsExecuted: false`は各検査単独の対象範囲を表し、上記で実行した製品テストを否定するものではない。

## 次に必要なこと

WP-05で同じPlanner/Remote/stateを通るExecutorを作り、AT-04/16を計画承認から失敗停止まで再実行する。続いてAT-01〜84のうち0.1対象のモデル可能分を広げる。実R2・Windows/iPhoneでの証拠が必要なケースは、使い捨て環境を限定して確認するまで合格にしない。
