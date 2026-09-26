---
title: "実装着手前の設計決定・曖昧さの解消"
version: "1.0"
date: 2026-09-06
status: "Ready for Implementation / Product Not Implemented"
document_type: "implementation-decisions"
production_use_approved: false
tags: [obsidian, oss, codex, handoff, mvp01]
---

# 実装着手前の設計決定・曖昧さの解消

> **結論：承認済みの安全原則とRemote形式は維持し、実装を始めるためのフォルダ分離・試験範囲・初期化契約を補足する。**

## 適用範囲

本書は今回の引渡しの実装判断であり、既存v1.0ファイル自体は上書きしない。主に詳細仕様§0.2、§3.3、§6.4、付録Aの未具体化部分を実装可能な作業単位へ落とす。安全規則を緩めず、Remoteの既存型や既定MVP範囲を変更しない。将来これと上位仕様に矛盾が見つかった場合は、規則ID・影響・変更案を記録して解決する。

## ADR-H01：原本のG-BASEと実装用作業treeを分離する

元の`verify-gate.mjs`は、新しいソース追加も「未承認入力」として拒否する。正しい監査機能だが、そのままのtreeでMVP実装を始めると必ず衝突する。

**決定**：`approved-base/`を保存し、`workspace/`を別に生成する。前者のhash検査は変更せず、後者では継承コード・vendor・依存集合を固定して、自作の`src/product/`追加を許す。新規コードが許可ディレクトリにあることは、機能の正しさや安全性の保証ではない。別途コードレビューと製品試験が必要である。

型チェックは同梱コンパイラで行う。旧G-BASEの期待hashを書き換えること、source/importの承認を新コードへ拡大解釈することは禁止する。依存追加・継承コード改変は差分監査で新しい基準を作る。

## ADR-H02：MVP対象試験を確定する

詳細仕様付録Bの段階列をそのまま保持する。84件のうち、段階が`0.1`から始まる**67件**を0.1対象とする。`0.1〜0.3`のAT-31は初期から必須。0.2/0.3専用の17件は計画を残すが、初期版の機能として実装しない。

あるATにモデル試験と実機試験の両方が必要な場合、モデルPASSだけではAT全体をPASSにしない。WP-01の一部試験成功は、AT全体やMVP全体の完了ではない。必要なレベルと証拠はTEST_PLANとcatalogで管理する。

## ADR-H03：Remote初期化は通常SyncPlanと別のローカル計画として扱う

通常のSyncPlanは既存head/ETag/checkpointを前提とする。一方、§3.3の初期化にはまだheadがない。架空の既存ETagを埋める、普通のhead更新を無条件PUTへ変える方法は禁止する。

**決定**：ローカルのpending envelopeを`bootstrap`と`sync`の二種類に分ける。bootstrap専用の承認対象には、format、schemaVersion、planId、runId、vaultId、epochId、deviceId、connectionDigest、作成日時、生成済みcommitId、空manifestのSHA-256、初期必須capabilitiesを含める。`planDigest`はこの承認対象の正規JSONのSHA-256とする。承認情報そのものやcommitハッシュをdigestの入力へ循環して含めない。

Remoteへ保存するCommit/Head/Manifestは詳細仕様の型をそのまま使う。generation=0、parentCommitId/parentCommitSha256=null、operationCount=0、空entries。初期capabilitiesは`identity-content-v1`と`manifest-v1`をソートして使用する。commit.planId/planDigestはbootstrap計画を参照する。

対象prefixの完全確認と認証付きhead不在確認、利用者承認、前置journal、空manifest/commitの保存・読戻しを済ませてから、headをIf-None-Matchで作成する。成功証明後に通常の追加計画へ進む。412/結果不明は§6.10に準じて照合し、由来不明の残骸を空として上書きしない。停止条件と初期化競合はAT-08/10/14/44で検査する。

この補足はローカル計画形式の具体化であり、新しいRemote管理機能、強制初期化、一般ユーザーのデータ削除を追加しない。

## ADR-H04：承認前のSourceSnapshotRefは予約、実バイト保存は承認後

planには確定したsha256/sizeと決定的stagedKeyを含め、これを承認前に予約する。実stagingは§1.9.1どおり承認後に元bytesを再照合して作成する。予定keyがあるだけではSOURCE_SNAPSHOT_READYではない。

staging後に元Localへ追記されても固定版の送信と追加編集を区別する。転送が開始してから元ノートを読み直してbodyを差し替えない。予約と完了証拠を同じboolにしない。

## ADR-H05：署名部品の承認と通信機能の承認を分ける

既存signR2RequestはGET/HEAD/条件付きPUTの契約試作であり、LIST/queryや実HTTPの完備を保証しない。WP-01〜05ではネットワークを送らない。WP-06でLIST用のエンコード・署名を追加する場合、既存部品の条件を外すのではなく新しい小さなAdapterを作り、出典と試験を記録する。

署名後のHeaders/ArrayBufferはJavaScriptのreadonly型だけでは不変にならない。実Transportは所有権を分離した送信スナップショットを保持し、条件・送信先・hashを送信直前に照合する。署名生成と送信の間に外部可変参照を渡さない。

## ADR-H06：API・SDK・bundlerの未採用は、純粋コア開始の障害にしない

今はホスト非依存の契約、Nodeテストハーネス、メモリ内Adapterを使う。Obsidian SDK、XML parser、bundler、CI Actionは未承認のまま。導入する必要が出たWP-06で版・ライセンス・推移的依存・バンドルを差分審査する。

型を自作して公開APIに存在すると断言したり、Nodeのfsでモバイル対応を代替したりしない。未成立APIはゲートを閉じる。一方、未調査の将来クラウドやiCloud APIのためにコア実装を延期しない。

## ADR-H07：二種類の利用者承認を区別する

「開発者に、このフォルダ内で実装することを許可する」と「プラグインが利用者のノートを変更する計画を承認する」は別である。本チャットでの開発承認を、将来アプリの全同期計画への承認トークンにしてはならない。

実R2 probeはテスト専用prefix・最大データ量・操作種別を明示して別許可を得る。実Vaultテストも使い捨てVaultを明示する。これらは本番Vault利用・公開・クラウド課金設定変更の承認ではない。

## ADR-H08：公開する名前は未決定でも開発できる

`svsync`、`@svsync/`、フォルダ名は内部仮称であり、商標やnpm/GitHub名を確保した意味ではない。正式名称・pluginId・最小対応バージョンは実機と公開準備で固定する。初期実装で元プラグインIDを使わない。

## ADR-H09：Gitと作業記録

ローカルGit初期化は任意。初期実装にGitHub公開は必要ない。Git使用時はルートで初期化し、approved-baseを含む出自を保持し、node_modules/build/cache/実認証情報はコミットしない。`.gitattributes`は監査済み原本の改行変換を防ぐ設定を付けた。

製品コードやテストの進捗は`progress/`へ保存し、文書の作成時点NOT_RUNは過去の記録として維持する。新しい結果には実行commit・環境・証拠を残す。合格表示だけを手編集して試験実施に代えない。

## ADR-H10：検査の限界を維持する

今回の準備チェックは、固定ファイル・依存・試験計画の整合性を見るもの。文書ハッシュは署名認証ではなく、悪意ある利用者がmanifestとcheckerを両方変える攻撃を防ぐものではない。Windows/iPhone/R2の実機テストは未実施。node側検証の成功を実機保証に拡大しない。
