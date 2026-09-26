---
title: "Obsidian同期OSS G-BASE完了報告"
version: "1.0"
date: 2026-09-06
status: "G-BASE PASS — Fixed, Scope-limited Import Set"
document_type: "gate-completion-report"
source_commit: "08027677267934d3a1ca6f6e3cf06ee1be53ee52"
approved_set_sha256: "19e2ff63173623ec012ecb5c5fd6710483875ea747e0ce8e42e772d0765828b3"
production_use_approved: false
tags: [obsidian, oss, g-base, audit, handoff]
---

# G-BASE 完了報告 v1.0

> **結論：今回選定したソース・依存物の取り込み集合について、G-BASEの完了条件を満たした。採用台帳・権利表示・固定依存・境界検査・再実行用コードを作成し、確認した。**

## 1. 今回完了したステップ

前回の監査書で残していた次の3点を、実物の限定集合について完了した。

| 完了条件 | 実施内容 | 判定 |
|---|---|---|
| 実取り込み集合を決める | Remotely Saveの2関数、署名専用派生部品、関連する最小自作Adapterを確定。原本・行範囲・hash・直接依存・除外物を台帳化 | PASS |
| その依存物の利用条件を閉じる | 実行用package1、開発用package1、追加インストール依存0。個別LICENSE・内包第三者表示・lock・全ファイルinventoryを確認 | PASS |
| 境界を実際に検査する | 承認外のsource／package／Proディレクトリ、変更tar、欠落LICENSEを拒否する検査を実行 | PASS |

**合格範囲は、添付した初期モジュール作業treeに限る。完成プラグイン、全将来依存、実R2・実端末での安全性を承認したものではない。**

この限定判定は、前回 `BASE_REPOSITORY_AUDIT.md` §10.2の「限定集合について確認が閉じた時点で、G-BASEをその集合に対して合格にする」という条件に基づく。

以前の監査書のHOLDは履歴として残し、本書で今回の集合に限って更新する。元の監査書・構想仕様書・詳細仕様書を上書きしていない。

## 2. 成果物

| ファイル | 内容 |
|---|---|
| [SOURCE_IMPORT_MANIFEST.md](SOURCE_IMPORT_MANIFEST.md) | 正確な出典・範囲・変更・除外・使い方を定義した許可リスト |
| [DEPENDENCY_LICENSE_REVIEW.md](DEPENDENCY_LICENSE_REVIEW.md) | 固定依存、ライセンス表示、推移的依存、オフライン再現、未検証範囲 |
| `evidence/source-imports.json` | 同じ取り込み情報の機械可読版 |
| `evidence/approved-set.json` | 承認対象ファイルと生成物のhash、package・scopeの正本 |
| `scripts/verify-gate.mjs` | 12分類の境界・ハッシュ・依存・権利表示検査 |
| `tests/` | 実際の取り込み部品を検証するテストと、不正な集合を拒否する負試験 |
| `vendor/packages/` | 正確なローカル依存tar。ネットワークなしで再取得可能 |
| `LICENSE`、`NOTICE`、`licenses/` | 出典・変更表示・元のライセンスと第三者表示 |

MDをObsidianへ保管する場合、今回の3文書を同じフォルダへ置く。前回の監査書・仕様書も同じフォルダにあれば相対リンクで参照できる。ZIPは実装着手時の部品・証跡セットであり、Obsidianのpluginsフォルダへそのまま置くものではない。

## 3. 選んだコードの実態

Remotely Save v0.4.25から選んだのは `copyArrayBuffer` と `getSplitRanges` の2関数だけで、インターフェースを含め32行である。原本は固定commitの `src/misc.ts` の限定範囲から取得し、本体を変えず出典ヘッダーを追加した。

S3の署名は `aws4fetch 1.0.20` の固定commitから署名専用部分を利用する。自動送信・再試行クラスを除去し、条件ヘッダーと本文の固定を確認した。独自に暗号署名アルゴリズムを発明したわけではない。

**元プラグインをほぼそのまま使うForkではない。同期中核・Local反映・journal・manifest/head等は、合意した詳細仕様に合わせて別途実装する。** 今回の再利用が小さい事実を隠さない。

元作者fyearsと貢献者、署名部品作者Michael Hartのクレジットと許諾を保持した。Pro・元ロゴ・元作者のOAuth情報・旧クラウド接続先・旧同期コードは取り込んでいない。

## 4. 実行した検査結果

| 検査 | 結果 | 意味と限界 |
|---|---|---|
| TypeScript strictビルド | 成功 | 型契約とコンパイルを確認。Obsidian起動成功ではない |
| 選定した部品・署名の単体試験 | 30件成功 | 実コピー・分割・署名・条件・入力拒否・非同期中の入力変更を検証 |
| 境界の正例／負例 | 7件成功 | 正常集合1件、改変・混入等を拒否する負試験6件 |
| 合計 | **37件成功、失敗0、skip0** | 製品のAT-01〜84とは別の検査 |
| G-BASE機械検査 | **12分類すべてPASS** | hashとimport、依存、ライセンス・元断片・生成物を検査 |
| npmのオフラインclean install | 成功 | ローカルtar・空キャッシュから依存を構成 |
| ZIPを別フォルダで展開して再実行 | 成功 | 元作業フォルダのnode_modulesやキャッシュを使わず実行 |
| 既存の基準文書 | hash一致 | 4基準文書は変更なし |

署名の比較試験は、派生版と固定した上流版へ同じ入力を与えて結果を比較した。AWS/R2サーバーが受理することや、公開の公式署名ベクター全件と一致することは、この試験では確認していない。

### 4.1 失敗を拒否することを確かめた対象

| 負試験 | 期待と実結果 |
|---|---|
| 未承認TypeScriptファイルを追加 | FAILとして拒否 |
| 許可済みソースを変更 | hash不一致で拒否 |
| 未監査の依存packageを追加 | 依存グラフ不一致で拒否 |
| 依存tarを改変 | integrity不一致で拒否 |
| MITライセンスを削除 | 表示欠落として拒否 |
| Pro名の未承認ディレクトリを追加 | 禁止領域として拒否。実Proコードは使用せず試験用の空に近いダミーを使用 |

負試験は、合格した作業treeのコピーを一時ディレクトリに作って実行した。承認済みの実物を変更して検査を通したわけではない。

### 4.2 検査グループ

| ID | 内容 |
|---|---|
| VG01 | scope・固定commit・本番不承認を確認 |
| VG02 | 承認した33ファイルのhash |
| VG03 | 実装・vendor・検査対象treeの過不足と禁止領域 |
| VG04 | 上流awsファイルのGit blobと抽出断片 |
| VG05 | 署名クラス抽出以外の意図しない変更がないこと |
| VG06 | root packageとlockの正確な依存集合 |
| VG07 | tarのintegrity・全ファイル・追加依存・install script |
| VG08 | インストール後の全ファイルinventory |
| VG09 | ソースと生成JSのimport／ネットワーク・旧API混入 |
| VG10 | LICENSE・NOTICE・TypeScript第三者表示 |
| VG11 | コンパイルされた6ファイルの一致 |
| VG12 | 自動install scriptや公開操作を行わない設定 |

検査は許可した既知の内容を照合するもので、すべての悪意あるプログラムを一般的に検出するウイルス対策ではない。

## 5. 正確な照合値

承認集合 `evidence/approved-set.json` のSHA-256：

```text
19e2ff63173623ec012ecb5c5fd6710483875ea747e0ce8e42e772d0765828b3
```

| 依存tar | SHA-256 | ファイル数 |
|---|---|---:|
| `aws4fetch-signer-1.0.20-svsync.1.tgz` | `977c6babbc560f65479d37133de37d917847f6015cb8a30a6ea25fb692042193` | 5 |
| `typescript-5.8.3-local-snapshot.tgz` | `6ed8b05aaef9597e5718015d3745c2ae945dd6aa2db4869dbf38aa74d0d35f42` | 130 |

署名tarは自作の限定派生package、TypeScript tarは既存環境の同版packageを内容無変更でまとめたローカルsnapshotである。公式npm tarそのものの同一性は主張しない。詳細は依存確認書に記録した。

## 6. 実装・実機・公開ゲートは分ける

| ゲート | 今回の状態 |
|---|---|
| **G-BASE** | **本書の固定取り込み集合に限りPASS** |
| G-PROTOCOL | 未実施。L/R/B全状態、CAS・履歴・schema等をこれから実装試験 |
| G-R2 | 未実施。条件付きPUT、Range、redirect、429等の実接続試験 |
| G-LOCAL | 未実施。Windows/iPhoneでの内容条件付き更新・復旧 |
| G-CLIENT-STATE | 未実施。端末マーカー・checkpoint・破損時挙動 |
| G-RESTART / G-MIGRATION | 未実施。中断・データ取り出し・移行 |
| G-DELETE | 初期範囲外。無効のまま |
| G-RELEASE | 未実施。権利表示・依存更新・セキュリティ・再現ビルド・利用説明を製品単位で再確認 |

TypeScriptの配布snapshotの公式バイナリとの完全照合、オンライン脆弱性スキャン、第三者の法務・セキュリティ監査は行っていない。これらの未実施を、今回の限定したsource/import確認で代替したとは扱わない。

現在のiCloud Vault、R2アカウント、ユーザーのGitHub repositoryには変更していない。テストでHTTP送信は行っていない。今回新しいクラウド契約・保存料金が必要となる操作はしていない。

## 7. 次工程

**次は、Codexに渡す実装着手資料を仕上げる。候補リポジトリ探しを繰り返す段階ではない。**

| 順番 | 資料・作業 | 完了条件 |
|---|---|---|
| 1 | `TEST_PLAN.md` | 詳細仕様のAT-01〜84を、MVP段階・fixture・障害注入・実行方法・期待値へ展開する |
| 2 | `CODEX_IMPLEMENTATION_GUIDE.md` | 本許可集合と仕様の読み順、最初の実装単位、禁止事項、確認・報告形式を定義する |
| 3 | `ICLOUD_REQUIREMENTS.md` | 現Vaultを移動しない、検知・保全・復旧の目的、Apple側を停止できるとは仮定しない制約を記す。実装は後 |
| 4 | API/Adapter検証表 | 署名と実HTTP、Local/ClientStore、Obsidian側の能力検証、追加依存が必要な場合の差分監査を定める |
| 5 | 状態判定・モックから実装 | 上記資料と許可済み部品を使い、本物のVaultを書き換えずMVP 0.1のコアを検証する |

追加する外部依存物の監査はその差分について行い、今回済ませた部品の同じ調査を無理由にやり直さない。逆に、今回のPASSを理由に未知のSDKやPRを自動承認しない。

## 8. 最終判定

**G-BASE：PASS（本書の承認集合に限定）。本番利用：未承認。**

確信度：高 — 記録したファイル・固定依存・ライセンス表示・hash照合・実行したテストの結果。

確信度：中 — これらの部品を用いた新同期ソフト全体の実用性。実端末・実R2と、製品の受入試験で評価する。

この文書は、権利者が公表した条件と確認した実物に基づくプロジェクト内の取り込み判定であり、第三者による無瑕疵保証ではない。
