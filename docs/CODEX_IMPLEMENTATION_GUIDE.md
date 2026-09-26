---
title: "Codex実装ガイド — MVP 0.1着手から検証まで"
version: "1.0"
date: 2026-09-06
status: "Ready for Implementation / Product Not Implemented"
document_type: "codex-implementation-guide"
production_use_approved: false
tags: [obsidian, oss, codex, handoff, mvp01]
---

# Codex実装ガイド — MVP 0.1着手から検証まで

> **結論：最初はオフラインで純粋コアを作る。承認済み部品・試験手順・停止条件を使い、実R2と実Vaultへの接続は後段の独立ゲートに限定する。**

## 1. この文書を受け取ったCodexへの指示

本書は実装作業の契約である。プロジェクト全体を一度に作らず、指定されたWPを実装・試験し、根拠を保存して止める。初回の依頼はWP-00→WP-01。計画のみで終えず、この範囲のコードと試験まで実行する。

過去のチャットを読める前提にしない。このパッケージ内が引渡しの根拠である。「Remotely Saveをforkして全部直す」などと依頼を再解釈しない。既存コードを再取得して最新masterを使う必要はない。

## 2. 正本と読む順序

| 順序 | 文書 | 何を確認するか |
|---|---|---|
| 1 | ルートAGENTS.md、START_HERE.md | 編集許可、作業場所、最初の依頼 |
| 2 | [構想v1.0](obsidian_sync_oss_concept_spec_v1.0_20260906.md) | 目的、安全原則、対象外 |
| 3 | [詳細v1.0](obsidian_sync_oss_detailed_spec_v1.0_20260906.md) | 状態表・Remote形式・I/O契約・エラー・ゲート |
| 4 | [G-BASE完了](G_BASE_COMPLETION_REPORT.md)、[取り込み台帳](SOURCE_IMPORT_MANIFEST.md)、[依存条件](DEPENDENCY_LICENSE_REVIEW.md) | 今回使える実物と限界 |
| 5 | [実装決定](IMPLEMENTATION_DECISIONS.md) | immutable原本とworkspaceの分離・bootstrap等 |
| 6 | [TEST_PLAN](TEST_PLAN.md)、catalog、contracts | 各WPで実装する試験・境界 |
| 7 | [API検証表](API_ADAPTER_MATRIX.md)、[iCloud要件](ICLOUD_REQUIREMENTS.md) | 後段の制約を壊さない |

詳細v1.0は機能・安全契約、G-BASE資料は外部コードの許可契約であり、相互に置き換えない。後発の完了報告は「候補監査時点HOLD」を固定集合に限って更新したもの。v0.1や候補段階の仮説を現在の仕様に優先させない。

全文を一度に読むと長い場合も、省略した部分を読んだふりをしない。対象WPに関する章を読み、他章との接点は契約で照合する。AGENTSの自動読込は長い仕様書の自動読込の保証ではない。[公式AGENTS.md](https://developers.openai.com/codex/guides/agents-md/)

## 3. 最初の作業環境

ルートで`node tools/preflight.mjs`を実行する。これが失敗したまま新規実装へ進まない。旧G-BASEチェックはapproved-base内、開発中の境界チェックはworkspaceに適用する。

| 種類 | 置き場所・方針 |
|---|---|
| 監査済み部品 | approved-base。内容不変 |
| 開発用ソース | workspace/src/product |
| 新規単体試験 | workspace/tests/unit |
| AT受入試験 | workspace/tests/acceptance |
| 既存部品の回帰試験 | workspace/tests/imports.test.mjs。30件を維持 |
| 正本入力 | fixtures。変更しない |
| 新しい結果 | progress。実行IDと環境を保存 |
| コピー不可 | pro、旧同期エンジン、元ロゴ、未監査SDK、既存Vault本文 |

準備ツールが作るworkspaceには、部品3ファイルと署名依存、コンパイラ、部品試験しかない。`src/product/`は空。これはMVP実装済みではない。

Node/npmが利用できる環境で、同梱依存からオフライン構成できる。Codex本体へのAI要求には別に通常の接続が必要である。既存契約枠の使用を想定し、新しいAPIキーや追加クレジット購入をこのプロジェクトの必須手順にしない。

## 4. アーキテクチャ境界

共有コアはObsidian、Node fs、R2 SDKの具象型に依存しない。外部世界はLocalStore、StateStore、ClientStore、ObjectStore、Clock、IdSource、ContentHasher等の契約で受ける。契約案はcontractsにあるが、APIの存在を保証するものではない。

依存方向は「型と検証器 → 純粋判定 → 不変計画 → 実行/照合 → Adapter」。UIからraw write/PUTへ直接到達させない。Remote公開とLocal適用は別の確定点であり、全端末一括トランザクションを偽装しない。

推奨モジュール分割：`domain/`（types/errors/capabilities）、`bytes/`、`paths/`、`metadata/`、`planner/`、`protocol/`、`state/`、`recovery/`、`executor/`。いずれもworkspace/src/product内に置く。テスト用のメモリAdapterはtests/supportへ置き、本番bundleへ混ぜない。

## 5. 作業パッケージと完了判定

### WP-00：引渡し検証

入力：パッケージ全体。実行：preflight。出力：reports-local/preflight/RESULT.json。合格条件は10ステップ、元部品37件とG-BASE、workspace部品30件、型契約チェックの成功。37+30は異なる67製品試験ではなく、同じ部品の二つの場所での検証である。

preflightは再実行できるが、workspaceの新規コードを消さない。新しい実装後に原本seedの承認hashを更新してはならない。

### WP-01：型・パス・本文ハッシュ・正規JSONと実行時スキーマ

対象：詳細§1.1〜1.5、§2.6/2.7、§7.1〜7.3、付録I。まず後続のtombstone実行を実装せず、受信時の未知機能拒否と0.1のLive構造を定義する。

作るもの：純粋なbytes/UTF-8検査、ContentRef、パス成分の衝突・禁止検査、canonical JSON、Head/Commit/Manifestのruntime validators、型付きエラー、注入可能なSHA-256境界。raw受信とverified値を分ける。

試験：AT-15/18/19/20/21/39/47/58/65/67のコア部分と全正規化ベクター、境界値。完全ATと部分カバーを区別。unknown、単独サロゲート、重複キー、巨大ネスト、予約名、大小ケース衝突を含む。0バイトと通常の`_memo.md`は正常対照とする。NULの本文とパスを同一規則で誤判定しない。

完了：strict compile、独立オラクルの単体試験、30部品回帰、境界チェック、正本不変。通信/実Vault操作0。progress/WP01_REPORT.mdを作る。**初回依頼はここまで。**

### WP-02：L/R/B判定・計画・承認

対象：詳細§1.6〜1.10、§3、§4.2、§7.7。全ST-01〜11、IN-01〜07の0.1分岐、unknown capability拒否を網羅する。old baselineが破損した場合を「baselineなし」へ落とさない。

作るもの：既知状態に対する純粋Planner、blockedPathsがあると一件も転送しないSafety層、承認digest、予約SourceSnapshotRef、bootstrap専用intent。`CONFIRM_EQUAL`で本文やRemote commitを発行しない。

試験：AT-01/04/05/07/11/27/35/82、承認後変更と作成/更新の違い。完了：判断表の各分岐への試験、期待結果が表と一致、I/Oなし。

### WP-03：メモリ内Remoteプロトコル

対象：詳細§6.5〜6.11/6.16、§7.3。入力fixtureから有効なgen0..nを作るテストfactoryと、head CASを不可分に扱うMemoryObjectStoreを作る。

作るもの：不変物検証、初期化、条件付きhead公開、親鎖検証、同一内容の再利用、旧blob保全検証。HTTPや本物のSDKは使わない。

試験：AT-02/08/10/12/13/14/18/38/40/44/48/50/56/57/58/74のモデル。完了：同時書込・応答消失・128/4096制限・正常空Remoteと不完全LISTを区別できる。

### WP-04：journal・checkpoint・復旧・ClientStore

対象：詳細§2.3/2.5、§7.4〜7.9、§8.7。永続/揮発状態を分けたモデルを作る。sequence予約直後の終了など、保存順の空白を隠さない。

作るもの：検証済み復旧receipt、journal鎖、a/b checkpoint、共通履歴の証拠、ClientStore下限、pending隔離。古い正常checkpoint単独で続行しない。

試験：AT-16/17/22/37/45/51/52/53/54/55/66/76/80。完了：各永続化境界で停止して再照合できるか、安全停止する。第三のLocal版を上書きしない。

### WP-05：メモリ内Executor・再試行・中断

対象：詳細§1.8/1.9、§6.12、§8。Plannerとprotocol/stateを結び、実行世代、固定Source、Local条件付き反映、公開済み証拠、予算分離を実装する。

試験：AT-03/09/14/17/30/31/34/36/41/46/49/50/51/52/68/69/70/71/72/73/75/78/82/83のモデル、全故障注入境界。4試行上限と3再計画を区別。Retry-Afterを短縮しない。型のreadonlyでbytesの不変性を保証したと扱わない。

完了：67件の0.1対象のうちモデル実施可能部分の結果を集約。実機必須はPASS_MODEL_ONLY。G-PROTOCOLのモデル条件を確認。通信・実Vault操作はまだ0。

### WP-06：不足依存の差分監査と実API能力probe

対象：[API検証表](API_ADAPTER_MATRIX.md)。採用するObsidian SDK/型、bundler、HTTP経路、LIST XML解析方式を必要時だけ監査する。署名部品の承認をSDK全体の承認へ拡大しない。

実装：最小テストPlugin／Transport probe。必要能力だけを少量の非機密データで調べる。通常ノート同期はまだ有効にしない。WindowsとiPhoneの実バージョンを記録する。

完了：G-R2/G-LOCAL/G-CLIENT-STATEが実測で満たされるか、失敗能力を限定して停止した理由が明らか。失敗時に強制上書きへ代替しない。要件が成立しなければ、影響と代替を記録して設計を再判断する。秘密鍵を文書・ログへ保存しない。

### WP-07：MVP 0.1の最小UIと統合

接続ウィザード、用途確認、R2 accountId/bucket/参加ID、セッション資格情報、初期化/参加、比較プレビュー、同期実行、中止、競合/エラー/対象外表示、診断を実装する。利用者の入力をそのまま低レベルI/Oへ渡さない。

UI最低契約：manual start、plan前後のsource/destination識別、create/update/equal/blocked/excluded件数、Remote公開済みと当該Local反映済みの別表示、開いているノートの更新延期、session-only credential表示、暗号化未実装・添付未同期・削除未対応を明記。大量popup、hidden強制初期化、一括片側優先、バックグラウンド同期は作らない。

完了：モデルと同じcoreを実Adapterが使用し、実使い捨てVaultで初回/手動同期・停止・復旧を検証する。モバイルエミュレーションだけでiPhone完了にしない。

### WP-08：読み取り専用エクスポート・移行検証

対象：詳細§3.7、付録H、AT-42/81。Windowsの別の空出力先へ固定snapshotを通常ファイルとして取り出し、全bytesを検証する。旧Remotely Save Remoteの直接インポーターは作らない。

完了：現在のVault/Remote/baselineを書き換えず、欠損を推測せず報告。中断と衝突を確認。合意したテストコピーから新prefixへ移行する試験が通る。

### WP-09：MVP 0.1の完了判定

67件の対象ATについて必要レベルの証拠を集約する。モデルだけ、実機未実施、欠落ケースがある場合はMVP0.1完了と報告しない。後続17件はDEFERREDとして残す。G-RESTART/G-MIGRATION等も確認する。

MVP0.1開発完了と、一般利用推奨・安定版・Community Plugin申請は別である。G-RELEASEには依存脆弱性確認、公式配布物の由来再確認、権利表示、運営窓口、バックアップ案内、公開手順などを含める。今回その合格を先取りしない。

## 6. 各WPで使う検証コマンド

ルート：

```sh
node tools/verify-handoff.mjs
node tools/verify-workspace.mjs
```

workspace内：

```sh
npm test
npm run test:product
npm run check:boundary
```

`test:product`は最初の未実装状態では意図的に失敗する。新規試験を作成した後に使う。既存部品30件だけで製品試験が通ったと報告しない。

## 7. レビュー・変更管理

各WPで、修正前の反例、修正後の試験、正しい入力での回帰を残す。自分で作ったテストに通ったことだけで、要求の読み間違いがないと判断しない。状態表と禁止副作用を別の観点からレビューする。

新しい外部コードを使うときは、採用理由・正確な版・hash・利用条件・推移的依存・表示義務を記録する。元の承認済み資料を消して「最新だからよい」としない。プロトコル変更は形式・移行・旧クライアント停止・ATを一緒に改訂する。

## 8. 完了報告の様式

各WPは`templates/work-package-report.md`を使う。含めるもの：実装範囲、変更ファイル、原本不変チェック、対応ルールID、試験コマンドとexit、成功/失敗/未実施、仕様との差分、追加依存の有無、実機条件、次のWP。内部の非公開推論は不要で、監査可能な結果と理由を記録する。

## 9. 中止すべき条件

原本hash不一致、権利不明ソース、実Vaultを求める予期せぬ処理、証拠なしの結果成功化、復旧なしの上書き、無条件head PUT、未対応APIを安全扱いするfallback、必要なsecretがログへ流れる経路があれば、その処理を進めず記録する。

一方、正式名称・将来のiCloud API・将来の寄付ページの未決定を理由にWP-01を止めない。今必要な条件と後工程の条件を分離する。
