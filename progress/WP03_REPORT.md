# WP-03 実装・検証報告

## 結論

状態：COMPLETE（**メモリ内Remoteプロトコルのモデル**）。確認日：2026-09-24。開始時Git HEAD：`df405e2c879e813a28d0c4bb894dbb6054298fe2`。Windows、Node.js v24.15.0、npm 11.12.1。

不変blob/manifest/commitの作成・読戻し、headの不可分な条件付き更新、初期化時の完全LIST、親commit鎖の検証、応答不明後の再照合を実装した。二端末の別パス更新・同一パス競合、初期化競争、旧blob欠損、129/256/4096/4097世代を合成データで検証した。実R2・実Vaultへの操作は0。

## 変更ファイルと規則

| ファイル | 内容 |
|---|---|
| `workspace/src/product/protocol/object-store.ts` | Remoteキーの限定、不変物の条件付き作成・読戻し、バイト単位照合、完全LIST。§6.5/6.6/6.11 |
| `workspace/src/product/protocol/remote.ts` | 検証済みRemote取得、旧blob検証→新blob→manifest→commitの準備、head CAS、bootstrap専用準備。§6.7〜6.10、META-001〜005/011〜015 |
| `workspace/src/product/protocol/history.ts` | 祖先証明を128世代ごとに区切り、最大4096世代で停止。応答不明をtip/祖先/同一CAS再試行可/不採用に分類。§6.10/6.16、META-010/013 |
| `workspace/src/product/domain/errors.ts` | Remote I/O、結果不明、履歴証明保留の停止コードを追加 |
| `workspace/tests/support/memory-object-store.mjs` | 条件付き更新を一つの不可分な操作として扱う試験専用Adapter。失敗・応答消失を注入 |
| `workspace/tests/support/remote-fixtures.mjs` | 合成bytesからgen0..nの有効な不変物と親鎖を作る決定的factory |
| `workspace/tests/unit/wp03.test.mjs` | 17件の独立したモデル試験 |

外部依存・SDK・通信・実認証情報の追加なし。`approved-base/`、正本fixture、引渡し資料は未変更。

## 試験結果

| コマンド | 結果 |
|---|---|
| `$env:NODE_OPTIONS='--test-reporter=tap'; node tools/preflight.mjs`（ルート） | 10/10工程PASS。既存workspaceを保持 |
| `npm run test:product`（workspace） | 製品単体43件PASS（WP-01:10、WP-02:16、WP-03:17） |
| `npm test`（workspace） | 全73件PASS（製品43件＋既存部品30件） |
| `npm run check:boundary`（workspace） | PASS。製品ソース累計12ファイル |
| `node tools/verify-handoff.mjs`（ルート） | 11項目PASS。固定原本・出自に変更なし |
| `git diff --check` | PASS |

AT-02/08/10/12/13/14/18/38/40/44/48/50/56/57/58/74に関係する**モデル部分の試験**を実施。特に、先行clientのhead更新後に後続の古いETagを412で拒否し、別パスだけを新manifestへ再計画すること、同一パスは競合停止すること、応答消失を公開失敗と決めつけないことを確認した。保存済み不変物は失敗時にも削除しない。

正式AT結果の84件は依然NOT_RUN。モデルだけでは必要なWindows/iPhone・実R2の合格証拠にならない。0.1対象67件の完了数にも算入しない。

## 未実施・次工程

- CAS直前の前置journal、結果不明の永続化、再起動後の候補復元はWP-04/05。現在の準備済み候補の封印はプロセス内のみ。
- 実Local本文の固定staging、復旧コピー、checkpoint/ClientStore、Download適用、実行回数予算と中断の統合はWP-04/05。
- 実R2での条件付きPUT・ETag・LIST・上限付き受信能力は未検証。WP-06で別途許可された使い捨て領域だけを調べる。
- 本モデルのLIST完全性はAdapterのページ応答を前提とする。実APIのページ解析と通信失敗分類はWP-06の対象。

次はWP-04でjournal、二重checkpoint、復旧用コピー、ClientStoreをメモリ内で実装し、保存境界ごとの中断・破損・複製を試験する。
