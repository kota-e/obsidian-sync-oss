# WP-02 実装・検証報告

## 結論

状態：COMPLETE（WP-02の純粋な判定・計画・承認ロジックのみ）

確認日：2026-09-24。開始時のGit HEAD：`03fc370eac110090948d4653e62b95c4201aef15`。Windows、Node.js v24.15.0、npm 11.12.1。

Local（L）、Remote（R）、証拠付き共通版（B）を比較する判断表を実装し、競合・不在候補・読取不能・パス衝突がある計画では転送操作を一件も作らない。承認digest、承認後の再照合、送信元の保存先予約、新Remote専用の初期化intentを追加した。実際の同期やRemote初期化はまだ行わない。

## 実装

対象：詳細仕様§1.4〜1.10、§3.3〜3.6、§4.2、§7.7、SYN-002〜005、ADR-H03/H04。

| ファイル | 役割 |
|---|---|
| `workspace/src/product/planner/decision.ts` | ST-01〜11、IN-01〜07の0.1判定。時計・サイズによる勝者選択なし |
| `workspace/src/product/planner/plan.ts` | 検証済みRemoteから不変計画を作る。全体停止、操作種別、旧revision証拠、SourceSnapshotRefの予約、提案manifestの固定 |
| `workspace/src/product/planner/approval.ts` | 計画の正規JSONハッシュを承認digestとし、接続先・設定・head・checkpoint・対象Localと安全フラグを実行前に再照合 |
| `workspace/src/product/planner/bootstrap.ts` | 通常SyncPlanと分離した新Remoteの初期化intent。完全な空一覧と認証付きhead不在の証拠を要求 |
| `workspace/src/product/metadata/remote-schema.ts` | 検証済みRemote snapshotの型と実行時印を追加 |
| `workspace/src/product/domain/errors.ts` | WP-02の停止理由を追加 |
| `workspace/tests/unit/wp02.test.mjs` | 判定表全18分岐、独立digestオラクル、承認後変更、境界・競合の16単体試験 |

追加・変更した外部依存：なし。`approved-base/`、引渡し正本、fixtureは変更なし。

## 実行結果

| コマンド | exit | 結果 |
|---|---:|---|
| `$env:NODE_OPTIONS='--test-reporter=tap'; node tools/preflight.mjs`（ルート） | 0 | 10/10工程PASS。既存workspaceは保持 |
| `npm run test:product`（workspace） | 0 | 製品単体26件PASS（WP-01の10件＋WP-02の16件） |
| `npm test`（workspace） | 0 | 合計56件PASS（上記26件＋既存部品回帰30件） |
| `npm run check:boundary`（workspace） | 0 | 新規製品ソース累計9件、境界PASS |
| `node tools/verify-handoff.mjs`（ルート） | 0 | 引渡しと原本の11チェックPASS |

入力は`fixtures/recipes.json`のF-EQUAL、F-LOCAL-EDIT、F-REMOTE-EDIT、F-DIVERGED、F-EQUAL-EDIT、F-EMPTY-JOIN、F-NO-BASE-CONFLICT、F-LOCAL-ABSENT、F-TWO-PATHS等を基に合成した。レシピ台帳のSHA-256は`f0d14eafb45ec073ab005843d4aa4b3a5bdc84843fa9799604045be982c21bb5`。A/B/Cの本文SHA-256は正本fixtureの固定値を使用。判定表の期待結果をテストに個別に記し、計画digestは本番の正規JSON関数を使わない別のソート処理で照合した。

AT-01/04/05/07/11/27/35/82に関係する**純粋ロジックだけの部分カバー**。正式なAT結果ファイルはPASSにしていない。全84件のAT本体はNOT_RUNで、MVP 0.1対象67件の完了数にも算入しない。

## 安全性と保全

原本hash・取り込み境界：PASS。計画にblockedPathsが1件でもあればoperations、提案commit、提案manifestを作らない。正常な`CONFIRM_EQUAL`でも本文操作・新revision・Remote commitを作らない。Dry Runの試験で通信・本文保存・probe・stagingの呼出しなし。同期処理による実R2・実Vault操作は0。進捗TODOノートだけは別途承認済みの範囲で更新する。

## 未実施・制約

- `BaselineForPlanning.kind='verified'`はWP-02の入力契約。永続checkpoint、journal、ClientStoreから実際に証明する処理はWP-04で作る。破損・不在を新規参加へ変換する経路は拒否済み。
- SourceSnapshotRefは保存先とハッシュの**予約**のみ。元本文の再読込、staging保存・読戻し、実行前条件の再検査はWP-04/05。
- 初期化intentは承認対象と安全条件のみ。LIST、認証付きhead確認、条件付き作成と結果不明時の照合はWP-03/06。
- 受入試験に必要なMemoryObjectStore、実R2、Windows/iPhoneの実Vault、UIは未実施。WP-02の試験合格を同期製品の完成と扱わない。

## 次の作業

WP-03で、不変blob/manifest/commitの保存とheadの条件付き更新をメモリ内で実装し、二端末同時更新、応答消失、長い親履歴、初期化競合を検証する。実通信はしない。
