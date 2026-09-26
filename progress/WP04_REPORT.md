# WP-04 実装・検証報告

## 結論

状態：COMPLETE（**メモリ内の永続状態・復旧モデル**）。確認日：2026-09-24。開始時Git HEAD：`9562d671c5309d9f39b22303c91455ad6df286d2`。Windows、Node.js v24.15.0。

journalの連番予約とハッシュ鎖、a/b checkpoint、ClientStore下限、旧本文の復旧コピーと検証済みreceipt、pending隔離、再起動時の安全判定を追加した。保存の途中で記録が欠けた場合は埋め合わせず停止・再照合とする。実R2・実Vaultへの操作は0。

## 変更ファイルと対応規則

| ファイル | 内容 |
|---|---|
| `workspace/src/product/state/model.ts` | Vault識別子、ClientStore契約、厳格な基本値検証。詳細§7.4 |
| `workspace/src/product/state/journal.ts` | 連番先行予約、イベントハッシュ、前イベントとの鎖、append読戻し、全件検証。§7.8 |
| `workspace/src/product/state/checkpoint.ts` | 検証済みbaseline証拠、a/b交互保存・読戻し、ClientStore下限との照合。§2.5/7.6 |
| `workspace/src/product/state/guards.ts` | 管理namespace所有検証、64MiB予備領域、pendingの接続別隔離。§7.4/7.5/7.7 |
| `workspace/src/product/state/startup.ts` | checkpoint・journal・pendingを合わせた再起動時の判定。§8.7 |
| `workspace/src/product/recovery/recovery.ts` | 旧本文のコピーと読戻し、receipt検証、Local第三版を保全する中断判定。§7.9/8.7 |
| `workspace/src/product/domain/errors.ts` | 永続状態・復旧・領域不足の停止コード |
| `workspace/tests/support/memory-state-store.mjs` | 各保存境界に故障を注入できる試験用Adapter |
| `workspace/tests/unit/wp04.test.mjs` | 新規19件の正常・否定・故障注入試験 |

外部依存・通信・実認証情報の追加なし。`approved-base/`、正本fixture、引渡し資料は未変更。

## 試験結果

| コマンド | 結果 |
|---|---|
| `$env:NODE_OPTIONS='--test-reporter=tap'; node tools/preflight.mjs`（ルート） | 10/10工程PASS。既存workspaceを保持 |
| `npm run test:product`（workspace） | 製品単体62件PASS（WP-01:10、WP-02:16、WP-03:17、WP-04:19） |
| `npm test`（workspace） | 全92件PASS（製品62件＋既存部品30件） |
| `npm run check:boundary`（workspace） | PASS。製品ソース累計18ファイル。`productCorrectnessVerified: false`は境界検査の範囲を示す |
| `node tools/verify-handoff.mjs`（ルート） | 11項目PASS。固定原本・出自に変更なし。`productTestsExecuted: false`はこの検査単独の範囲を示す |
| `git diff --check` | PASS |

AT-16/17/22/37/45/51/52/53/54/55/66/76/80に関係する**モデル部分**を試験した。連番予約後のappend失敗、checkpoint片側破損・同番号分岐、ClientStore消失、復旧コピーの読戻し失敗、第三のLocal版、未知の管理ファイル、容量予備の境界、別接続pendingの隔離を確認した。checkpointのbaselineは先行するRemote確定・操作完了journal証拠を照合する。

正式AT-01〜84は依然すべてNOT_RUN。モデル試験だけではWindows/iPhone、実Obsidian、実R2での合格証拠にはならず、0.1対象67件の正式完了数にも算入しない。

## 未実施・次工程

- 現時点のAdapterはメモリ内のみ。実際の書込・原子的なLocal条件付き反映・プロセス再起動後の保存媒体読み込みはWP-05以降。
- `auditStartup`は再照合の要否を返すだけで、Remoteの未知結果を自動解決せず、保存済み計画を再実行しない。
- Apply receiptはLocal更新の証拠ではない。Local適用後のjournal確認とRemote再照合をWP-05のExecutorで結ぶ。
- 実R2・実Vault・実機の能力検証は今回の許可範囲外。使い捨て領域のprobeはWP-06以降に別途明示された範囲だけで行う。

次はWP-05でPlanner・protocol・stateを結ぶメモリ内Executor、条件付きLocal反映、試行予算と中断を実装する。
