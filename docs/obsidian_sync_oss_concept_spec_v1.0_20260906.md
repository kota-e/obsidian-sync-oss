---
title: "Obsidian同期OSSプロジェクト 構想仕様書"
version: "1.0"
date: 2026-09-06
status: "Approved Baseline"
document_type: "concept-spec"
tags:
  - obsidian
  - oss
  - sync
  - cloudflare-r2
  - s3
  - icloud
  - safety
  - project-spec
---

# Obsidian同期OSSプロジェクト 構想仕様書 v1.0

## 0. 文書の位置づけ

本書は、Obsidian向け同期OSSの「構想仕様書」である。

目的は、実装前に以下を明確にすること。

- 何を解決するプロジェクトか
- 誰のためのプロジェクトか
- 何を最優先するか
- どこまでを初期スコープとするか
- どのような構造で発展させるか
- 元Remotely Saveとの関係をどう扱うか
- どのような安全原則を守るか
- 何を将来対応とするか
- OSSとしてどのように公開・保守するか

本書 v1.0 は、2026-09-06時点で合意済みの構想ベースラインとして扱う。

本書は実装方法の細部までは規定しない。

API、データ構造、アルゴリズム、エラーコード、画面項目、テストケース等の具体仕様は、後続の「詳細仕様書」「テスト仕様書」で定義する。

---

# 1. プロジェクト概要

## 1.1 仮称

正式名称は未定。

本書では便宜上、以下の仮称を使用する。

**Project SafeVault Sync**

正式名称は、構想仕様書確定後からGitHub公開前までに決定する。

## 1.2 一文で表すプロジェクト

> Remotely SaveのOSSとしての成果に敬意を払いながら、安全性と継続保守性を最優先に、ObsidianのVaultを複数端末・複数ストレージ間で同期できるOSSを構築する。

## 1.3 プロジェクトの背景

Obsidianはローカルファイルを中心とした設計であり、その自由度は大きな利点である一方、Windows・iPhoneなど異なるOS間で安全かつ低コストにVaultを同期する方法には課題がある。

既存のRemotely Saveは、この問題に対して有力なOSSである。

一方、現時点では以下の課題がある。

- 正式リリースと本体コード更新が長期間停滞している
- 未マージの修正PRが残っている
- 安全性に関する重要な修正提案が存在する
- 現在のObsidian環境に対する継続的な互換性検証が十分とは言いにくい
- 将来の保守主体が不明確
- 現在の最新版にはライセンス上自由に改変できない領域が含まれる

そこで本プロジェクトでは、法的・倫理的に利用可能なコードを土台にし、必要な安全性修正と現行環境への対応を加え、継続保守可能な新しいOSSとして発展させる。

---

# 2. プロジェクトの目的

## 2.1 最上位目的

**Obsidianの同期によるデータ消失リスクを最小化しながら、低コストで複数端末同期を可能にすること。**

## 2.2 主要目的

### A. 安全な同期

以下を安全に扱えることを目指す。

- 新規ファイル
- 更新ファイル
- 削除
- 名前変更
- フォルダ移動
- 添付ファイル
- 複数端末での同時編集
- 一時的な通信障害
- クラウドAPI障害
- 初回同期
- 新端末追加

### B. 低コスト

Cloudflare R2や一般的なS3互換ストレージなど、低コストまたは小規模利用で無料枠を活用できるBackendを選択可能にする。

プロジェクト自体はOSSとして公開する。

### C. 継続保守

特定の一人の開発者だけに依存しにくい構造を目指す。

- GitHubで公開
- テストを充実
- 設計仕様を文書化
- Contributorが参加しやすい構造
- リリース手順を自動化
- 将来のObsidianアップデートに追従しやすくする

### D. 元Remotely Saveの成果を尊重する

元作者およびContributorの成果・著作権・ライセンス・信用を尊重する。

---

# 3. 対象ユーザー

## 3.1 主要ターゲット

以下の条件に当てはまるObsidianユーザー。

- 複数端末でObsidianを使用する
- WindowsとiPhoneを併用する
- Obsidian Sync以外の選択肢を求めている
- 自分のクラウドストレージを利用したい
- Markdownファイルを自分の管理下に置きたい
- 同期事故やデータ消失を強く避けたい
- 多少の初期設定は許容できる

## 3.2 将来ターゲット

- macOS
- Linux
- Android
- 複数PC
- NAS利用者
- WebDAV利用者
- 自宅サーバー利用者
- S3互換クラウド利用者

## 3.3 対象外

初期リリースでは、以下を主要対象としない。

- 完全なクラウド型ノートサービスを求めるユーザー
- Obsidianを起動していない状態でも常時リアルタイム同期を必須とするユーザー
- 数百GB規模の動画ファイルを大量同期する用途
- エンタープライズ向け中央管理・SSO・監査統制
- チーム共同編集をGoogle Docsのようにリアルタイムで行う用途

---

# 4. 設計思想

本プロジェクトでは、以下を重要度順に扱う。

## 4.1 Safety First

**同期速度よりデータ保全を優先する。**

迷った場合は、

> 「同期を止める」

を、

> 「推測して同期を続行する」

より優先する。

## 4.2 Never Interpret Failure as Deletion

通信失敗、一覧取得失敗、認証失敗、API障害を、

> 「リモートにファイルが存在しない」

と解釈しない。

失敗と削除は明確に区別する。

## 4.3 Preserve Both on Conflict

競合が発生した場合、可能な限り双方のデータを残す。

自動マージによってデータを失う可能性がある場合は、競合コピーを作成する。

## 4.4 Explain Before Destructive Actions

削除・大量上書きなど破壊的変更について、ユーザーが理解できる情報を提示する。

## 4.5 Recoverability

問題が発生しても、履歴・バックアップ・同期ジャーナル等を利用して復旧しやすい設計とする。

## 4.6 Minimal Lock-in

同期先を変更しても、ローカルVaultのMarkdownファイルは通常のObsidian Vaultとして利用できる状態を維持する。

## 4.7 Local First

各端末にローカルVaultを持ち、クラウドは同期の中継地点として扱う。

Cloudflare R2上のデータを直接Vaultとして開く方式は採用しない。

## 4.8 User Control

自動同期だけでなく、手動同期・Dry Run・一時停止などユーザーが制御できる機能を持たせる。

---

# 4A. Safety Invariants（絶対安全規則）

本プロジェクトでは、「安全」を抽象的な目標ではなく、実装が絶対に破ってはならない規則として定義する。

詳細な条件・例外・テストケースは詳細仕様書で定義するが、以下は構想レベルで固定する。

## SI-001 Remote一覧取得失敗時の削除禁止

Remote Backendの一覧取得が完全成功していない同期では、Remote側に見えないことを理由としたLocal削除を一件も実行しない。

## SI-002 未確認削除禁止

過去の正常同期状態または明示的な削除記録によって削除が確認できないファイルを、「存在しない」という理由だけで削除しない。

## SI-003 双方変更時の上書き禁止

LocalとRemoteの双方が最終正常同期以降に変更されている場合、片方を自動上書きせず競合として扱う。

## SI-004 大量削除自動停止

削除計画が設定された安全しきい値を超えた場合、自動同期では破壊的操作を実行せず停止する。

## SI-005 エラー時Fail-Safe

状態判断に必要な情報が欠ける場合は、推測による続行より同期停止を優先する。

## SI-006 同期計画と実行結果の記録

破壊的変更を含む同期では、実行予定と実行結果を後から確認できる情報を残す。

## SI-007 空端末を削除指示として扱わない

新規・空Vaultや初回接続端末の状態を、既存Remoteデータを削除すべき根拠として扱わない。

## SI-008 Safety Invariantは機能追加より優先

新機能がSafety Invariantと両立できない場合、新機能側を延期または制限する。

---

# 5. 元Remotely Saveとの関係

## 5.1 位置づけ

本プロジェクトはRemotely Saveに着想と技術的基盤を持つ派生OSSを目指す。

ただし、元作者の許諾なく「公式後継」を名乗らない。

## 5.2 表示方針

README等で以下を明示する。

- Remotely Saveを起点とすること
- 元作者およびContributorへのクレジット
- 元リポジトリへのリンク
- 利用したコードのライセンス
- 本プロジェクトが独立プロジェクトであること

## 5.3 Proコード

制限付きライセンス領域のコードは、許諾された範囲を超えて利用しない。

特に、

- コピー
- 改変
- 再配布
- 実質的な転載

に該当する行為は行わない。

必要な機能がある場合は、権利上利用可能なコード・公開仕様・独自設計を基に実装する。

## 5.4 元プロジェクトへの還元

本プロジェクトで発見・修正した問題が元Remotely Saveにも適用可能であり、ライセンスや技術条件に問題がない場合、元リポジトリへのPR提出を検討する。

---

# 6. ライセンス戦略

## 6.1 ベースコード選定

ベースリポジトリは、構想確定後に正式決定する。

候補：

- ライセンス変更前のApache 2.0版Remotely Save
- Apache 2.0で公開されている派生版

選定基準：

1. 法的に明確に改変・再配布可能
2. S3/R2機能を持つ
3. モバイル対応しやすい
4. コードが理解可能
5. テスト可能
6. 現行Obsidianへ移行しやすい
7. Pro領域への依存を取り除ける

## 6.2 本プロジェクトのライセンス

現時点では未決定。

原則として、

- Contributorが参加しやすい
- 元コードのライセンスと矛盾しない
- OSSとして自由に利用・改良可能

なライセンスを選択する。

第一候補はApache License 2.0とする。

最終決定はベースコードの権利関係確認後に行う。

---

# 6A. Code Provenance / License Boundary Policy

本プロジェクトでは、コードの出自を追跡可能にする。

## 6A.1 由来区分

各取り込み・主要修正は、少なくとも以下のいずれかへ分類する。

- A：Apache 2.0として利用可能なRemotely Save由来コード
- B：互換ライセンスのFork由来コード
- C：ライセンス確認済みの第三者PR・Contribution
- D：本プロジェクトで独自実装したコード
- E：利用禁止または権利条件が不十分なコード

Eに該当するコードは取り込まない。

## 6A.2 PR採用ルール

未マージPRは正解集として扱わない。

採用前に以下を行う。

1. 対象コードのライセンス確認
2. 元の不具合を再現するテストの作成
3. 修正前にテストが失敗することの確認
4. 修正内容のコードレビュー
5. 修正後のテスト成功確認
6. 既存機能への回帰テスト
7. 必要に応じた実機テスト

## 6A.3 制限付きコードの扱い

PolyForm Strict等、本プロジェクトのFork・再配布目的に適合しないコードをコピー・改変・再配布しない。

必要な機能が存在する場合は、利用可能な公開仕様・API・独自要件から独立して設計・実装する。

AI/Codexにも同じルールを適用し、制限付きコードを入力して実質的な複製を生成させる運用は行わない。

---

# 7. 全体アーキテクチャ構想

## 7.1 基本構造

各端末にローカルVaultを持つ。

同期プラグインがローカルVaultとRemote Backendを比較し、安全な同期計画を作成して実行する。

概念構造：

Windows / iPhone
↓
Obsidian Vault
↓
Sync Engine
↓
Safety Layer
↓
Remote Backend Adapter
↓
Cloudflare R2 / S3

## 7.2 主要コンポーネント

### Sync Engine

- ファイル差分判定
- 同期方向決定
- 同期計画生成
- 実行
- 結果記録

### Safety Layer

- 大量削除防止
- 競合検知
- 通信障害判定
- Dry Run
- 破壊的操作確認
- 異常停止

### Metadata Store

同期状態を判断するためのメタデータを保持する。

詳細形式は詳細仕様書で決定する。

### Sync Journal

同期操作履歴を記録する。

### Backend Adapter

クラウドごとの差異を吸収する。

将来的にBackendを追加しやすい構造とする。

---

# 8. Remote Backend構想

## 8.1 Phase 1 正式サポートBackend

### Cloudflare R2

初期の**唯一の正式サポートBackend**とする。

理由：

- S3互換
- APIが明確
- 小規模利用で低コスト
- Web/JavaScript系との親和性
- 特定OSのファイル同期機能に依存しない

内部設計はS3系Backendを追加しやすいAdapter構造とするが、実機・自動テストを完了していないS3互換サービスについて「対応済み」とは表現しない。

### S3互換サービスの扱い

AWS S3、Backblaze B2、MinIO等は将来候補とする。API互換性だけを理由に正式サポート扱いにはせず、サービスごとに互換性テストを実施してからサポート対象へ追加する。

---

## 8.2 Phase 2候補

- WebDAV
- OneDrive
- Dropbox
- Backblaze B2
- MinIO

優先順位は需要・保守コスト・API安定性を基に決定する。

---

# 9. iCloud構想

## 9.1 方針

**iCloudの要件仕様はPhase 0で作成する。一方、API・クラス構造・具体的同期アルゴリズム等の技術仕様は、実装直前の再調査後に確定する。**

iCloudを忘れた状態でアーキテクチャを作らないが、未確認のApple側技術制約を前提に実装方式を早期固定しない。

Phase 0では `ICLOUD_REQUIREMENTS.md` を作成し、目的、UX、必須要件、安全原則、Windows+iPhoneでの理想状態を定義する。

実装Phaseでは最新のApple/Obsidian仕様を再確認したうえで `ICLOUD_TECHNICAL_SPEC.md` を作成し、具体アーキテクチャを確定する。

## 9.2 iCloudの位置づけ

iCloud DriveはS3等とは性質が異なるため、

> 「S3 Adapterと同じ形で簡単に追加できる」

とは前提にしない。

将来的に以下の2案を比較する。

### 案A：iCloud Remote Backend

技術的・権利的に安全な方法でiCloud DriveをBackendとして扱える場合。

### 案B：iCloud Safety Mode

現在のiCloud Drive同期を維持しながら、

- 競合検知
- 重複検知
- 大量削除検知
- Vault Health Check
- バックアップ
- 復旧支援

を提供する。

現時点では案Bの方が現実性が高い可能性があるが、正式決定は詳細調査後とする。

---

# 10. 同期の基本構想

## 10.1 同期単位

基本単位はファイル。

Markdownだけでなく、画像・PDFなどObsidian Vault内の一般的な添付ファイルも対象とする。

## 10.2 同期方向

基本は双方向同期。

- Local → Remote
- Remote → Local

を扱う。

## 10.3 初回同期

初回同期は特に危険なため、通常同期とは別のモードとして設計する。

初回同期時に推測で大量削除を実行しない。

## 10.4 削除

削除は「存在しない」だけでは確定しない。

過去の同期状態や削除記録等を基に、安全に判断する。

具体方式は詳細仕様書で決定する。

## 10.5 競合

両端末で変更された場合、競合として扱う。

原則：

> 自動的に片方を破棄しない。

---

# 11. 安全機能構想

## 11.1 Dry Run

同期実行前に同期計画だけを作成し、実データを変更しないモード。

表示候補：

- Upload
- Download
- Delete Local
- Delete Remote
- Rename
- Conflict
- Skip
- Error

## 11.2 Mass Delete Guard

大量削除を検知した場合、自動停止する。

しきい値は固定値と割合の併用を検討する。

例：

- 100件以上
- Vault全体の10%以上

数値は詳細仕様書で決定する。

## 11.3 Conflict Preservation

競合時にコピーを作成して双方を保存できる。

## 11.4 Network Failure Guard

Remote Backendの一覧取得・個別取得・書き込みで異常が発生した場合、削除判断へ進まない。

## 11.5 Sync Journal

同期結果を後から確認できる。

## 11.6 Recovery Assistance

初期段階では「ワンクリックで全端末を過去状態へ戻す完全Rollback」は実装しない。

代わりに以下を優先する。

- Sync Journal
- Conflict Copy
- 削除前バックアップ
- 復旧対象の明示
- 復旧手順の案内

完全Rollbackは、端末間・Remote間の整合性を安全に保証できる設計が確立した後の将来機能とする。

## 11.7 Safe Defaults

初期設定では、安全側の設定を有効とする。

初心者が設定変更しなくても、危険な挙動になりにくいことを重視する。

---

# 12. UI / UX構想

## 12.1 UX原則

初心者でも、

> 今、何が起きているか

を理解できることを重視する。

専門用語だけを表示しない。

## 12.2 基本操作

最低限、以下を提供する。

- Sync Now
- Dry Run
- Pause Auto Sync
- View Sync Status
- View Last Sync
- View Errors
- View Conflicts

## 12.3 状態表示

ユーザーが一目で以下を把握できることを目指す。

- 同期済み
- 同期中
- 同期待ち
- 競合あり
- エラーあり
- 安全装置により停止
- Remote未接続

## 12.4 破壊的操作

大量削除や初回同期など危険性が高い処理では、通常の同期とは違うUIを使用する。

---

# 13. セキュリティ構想

## 13.1 認証情報

API Key、Secret、TokenなどをGitHubやVault本文へ保存しない。

## 13.2 暗号化

Remote Backend上でノート内容を暗号化する機能は将来候補とする。

初期MVPには原則として含めず、同期コア・安全性・復旧性が安定した後に検討する。

ただし、後から暗号化Transform Layerを挿入できるよう、アーキテクチャ上の拡張性は確保する。

## 13.3 テレメトリー

原則として、ユーザーのノート内容を外部サーバーへ送信しない。

テレメトリーを導入する場合でも、明示的オプトインを原則とする。

## 13.4 ログ

ログに以下を出さない。

- Secret Key
- Access Token
- 暗号化パスワード
- ノート本文

---

# 14. 対応環境

## 14.1 初期必須

- Obsidian Desktop on Windows
- Obsidian Mobile on iPhone

## 14.2 将来

- macOS
- Linux
- Android

## 14.3 バージョン

最小対応Obsidianバージョン、iOSバージョン、Windowsバージョンは、技術検証後に決定する。

---

# 15. `.obsidian`フォルダの扱い

`.obsidian`は競合リスクが高いため、通常ファイルとは分けて扱う。

初期方針：

- デフォルトでは全面同期しない
- 安全な項目だけ選択同期できる可能性を検討
- `workspace`等の端末固有・高頻度更新ファイルは除外候補

具体的な対象は詳細仕様書で決定する。

---

# 16. 自動同期

## 16.1 基本

Obsidianが動作中の範囲で自動同期を提供する。

## 16.2 自動同期の原則

自動同期だからといって安全チェックを省略しない。

Mass Delete Guard等は手動・自動を問わず適用する。

## 16.3 バックグラウンド同期

iOS等のOS制約を超えて常時バックグラウンド同期できることは初期要件にしない。

---

# 17. ログ・監査・診断

## 17.1 Sync Journal

各同期について以下を記録する構想とする。

- 開始時刻
- 終了時刻
- 端末識別子
- Backend
- Upload件数
- Download件数
- Delete件数
- Conflict件数
- Error件数
- 最終結果

## 17.2 Debug Log

問題調査用ログを提供する。

ユーザーがIssueを投稿するときに、安全に共有できる形式を目指す。

## 17.3 Health Check

将来的に、

- メタデータ不整合
- 重複
- 異常な差分
- 認証状態
- Backend到達性

等を診断する機能を検討する。

---

# 18. OSS公開方針

## 18.1 GitHub

GitHub上で公開する。

## 18.2 公開物

最低限以下を含める。

- README
- LICENSE
- NOTICE
- CHANGELOG
- SECURITY
- CONTRIBUTING
- ビルド手順
- テスト手順
- リリース手順
- ソースコード
- 自動テスト

## 18.3 Obsidian Community Plugins

一定の品質基準を満たした段階で申請を目指す。

初期開発版はGitHub Releaseまたは開発者向け導入方法でテストする。

## 18.4 バージョニング

Semantic Versioningを基本候補とする。

例：

- 0.x：開発段階
- 1.0：一般利用を推奨できる最初の安定版

---

# 19. 開発・レビュー方針

## 19.1 AI活用

Codex等のAIを積極的に利用する。

ただし、AIが生成したコードを無条件で採用しない。

## 19.2 実装前

必ず仕様を確認する。

## 19.3 実装後

最低限以下を行う。

1. コードレビュー
2. 自動テスト
3. TypeScript型チェック
4. Lint / 静的解析
5. セキュリティ観点レビュー
6. テストVault
7. Windows実機
8. iPhone実機

## 19.4 本番Vault

開発初期は本番Vaultを使用しない。

---

# 20. テスト思想

## 20.1 最重要テスト

正常同期だけでなく、異常時を重視する。

特に以下を重点的に試験する。

- 通信切断
- API 4xx / 5xx
- Rate Limit
- 認証切れ
- 一覧取得失敗
- 部分取得失敗
- 同時編集
- 同時削除と編集
- 大量削除
- 新端末追加
- 空Vault
- アプリ終了
- 不完全な前回同期
- 古いメタデータ
- 時計ずれ

## 20.2 成功基準

同期が完了することより、

> 異常時にデータを失わない

ことを優先する。

---

# 20A. 保守継続性の設計

Remotely Saveで顕在化した「一人の開発者へ依存しすぎる問題」を繰り返さないことを目指す。

初期段階から以下を整備する。

- GitHub Actionsによる自動テスト
- 自動ビルド
- 依存ライブラリ更新検知
- CONTRIBUTING
- Issue Template
- Pull Request Template
- SECURITY
- リリース手順の文書化
- アーキテクチャ文書
- Safety Invariantsの自動テスト

開発速度より、「別のContributorが後から理解・保守できる状態」を重視する。

---

# 21. 非目標

本プロジェクトでは、少なくとも初期段階で以下を目標としない。

- Obsidian Syncの完全コピー
- Google Docs型リアルタイム共同編集
- 独自クラウドサービスの運営
- ユーザーノートを中央サーバーで管理するSaaS
- Remotely Save Pro機能を無断で再実装すること
- すべてのクラウドサービスに同時対応すること
- iCloud対応をPhase 1完成条件にすること

---

# 21A. MVP段階化

安全性と検証可能性を優先し、最初から削除を含む完全同期を実装しない。

## MVP 0.1：非破壊同期

対象：

- Windows
- iPhone
- Cloudflare R2
- Markdownファイル
- 新規ファイル同期
- 更新ファイル同期
- 手動同期

**削除同期は実装しない。**

目的は、最小構成でLocal ↔ R2 ↔ Localの基礎同期とモバイル互換性を検証することである。

## MVP 0.2：競合・添付対応

追加候補：

- 添付ファイル
- Rename / Move
- Conflict Detection
- Conflict Copy
- Dry Run

## MVP 0.3：削除の安全導入

追加候補：

- Delete Sync
- Tombstone等の削除記録
- Mass Delete Guard
- Network Failure Guardの削除系テスト
- Sync Journal強化
- 削除前Recovery Assistance

削除機能は、Safety Invariantsを自動テストで検証できる状態になってから有効化する。

---

# 22. 開発ロードマップ

## Phase 0：仕様策定

- 現状整理ドキュメント
- 構想仕様書
- 詳細仕様書
- テスト仕様書
- Codex実装ガイド
- `ICLOUD_REQUIREMENTS.md`

## Phase 0.5：Base Repository Audit

詳細実装へ進む前に、ベース候補を技術・ライセンスの両面から監査する。

比較項目：

- ライセンス
- コード由来
- 同期エンジン構造
- R2/S3コード
- モバイル対応
- 既存テスト
- TypeScript/依存関係
- 現行Obsidian互換性
- 改修量
- Pro/制限付き領域への依存

監査結果を文書化し、ベースリポジトリを正式決定する。

## Phase 1：ベース技術検証 / MVP 0.1

- 現行Obsidianでビルド
- Windowsテスト
- iPhoneテスト
- Cloudflare R2接続
- Markdown新規同期
- Markdown更新同期
- 手動同期
- 既存テスト実行
- 依存ライブラリ調査
- **削除同期は行わない**

## Phase 2：MVP 0.2〜0.3 / R2安全同期

- 添付ファイル
- Rename / Move
- Conflict
- Dry Run
- Delete（安全条件を満たした後に追加）
- Mass Delete Guard
- Network Failure Guard
- Sync Journal
- Recovery Assistance

## Phase 3：品質強化

- 自動テスト拡充
- Fault Injection
- バックアップ
- 復旧
- UI改善
- 性能改善
- セキュリティレビュー

## Phase 4：Public Beta

- GitHub公開
- ドキュメント
- Issue受付
- 少人数テスター
- リリース運用

## Phase 5：Stable / Community Plugin

- 安定版
- Obsidian Community Plugin申請
- Contributor受け入れ

## Phase 6：iCloud

- Phase 0で作成済みの仕様を再評価
- 技術検証
- Safety ModeまたはBackend実装
- Windows / iPhoneテスト

---

# 23. 成功条件

## 23.1 技術的成功

- WindowsとiPhone間でR2を介した同期が安定する
- 正常系だけでなく異常系テストに合格する
- 通信障害を削除と誤認しない
- 競合時にデータを失わない
- 大量削除を自動停止できる
- ユーザーが同期履歴を確認できる

## 23.2 OSSとしての成功

- GitHubで第三者がビルドできる
- 第三者がIssueを報告できる
- Contributorが修正を提案できる
- 元プロジェクトへのクレジットが適切
- ライセンス境界が明確
- 継続的にリリース可能

## 23.3 UXとしての成功

専門知識が少ないユーザーでも、

- 設定できる
- 同期状態を理解できる
- 問題発生時に何をすべきか分かる

こと。

---

# 23A. 安全性に関する対外表現

本プロジェクトは「絶対にデータが消えない」「Zero Data Loss」等の保証表現を使用しない。

推奨する表現は以下の方向性とする。

> データ消失リスクを低減する安全装置を備えた、Safety-focusedなObsidian同期OSS

Safety Invariantsやテスト実績を具体的に公開し、保証できないことを誇張しない。

---

# 24. プロジェクト運営原則

1. 安全性を速度より優先する
2. 破壊的変更は慎重に扱う
3. データ消失につながるIssueを最優先で扱う
4. 互換性問題を放置しない
5. 仕様と実装を分離する
6. テストを書けない修正は慎重に扱う
7. AI生成コードも通常コードと同じ基準でレビューする
8. 元作者とContributorへの敬意を維持する
9. ライセンス境界を越えない
10. 利用者に不確実性を隠さない

---

# 25. 詳細仕様書へ送る主要論点

以下は本書では方向性のみ決め、詳細仕様書で正式決定する。

## 同期アルゴリズム

- 差分判定方式
- hash
- mtime
- file size
- metadata
- 端末ID
- Vault ID

## 削除モデル

- tombstone
- soft delete
- retention
- remote metadata

## 競合モデル

- conflict detection
- conflict filename
- Markdown merge
- binary handling

## 初回同期

- Local優先
- Remote優先
- Merge
- Safety Wizard

## Backend

- S3 API
- R2設定
- credentials
- retry
- timeout
- pagination
- rate limit

## Recovery

- journal
- snapshot
- rollback
- backup retention

## Encryption

- 暗号化範囲
- key derivation
- key storage
- migration

## UI

- Settings
- Status
- Dry Run
- Conflict
- Recovery

---

# 26. 現時点の未決定事項

以下は意図的に未決定とする。

- 正式プロジェクト名
- ベースリポジトリ
- 最終ライセンス
- 暗号化を1.0必須にするか
- OneDrive/WebDAV対応時期
- 将来の完全Rollback採否（初期はRecovery Assistanceのみ）
- Backupをプラグイン内部で持つか
- `.obsidian`の同期範囲
- Remote metadata形式
- 初回同期UX
- 競合Markdown自動マージ
- 削除保留期間
- Mass Delete Guardのしきい値
- テレメトリーの完全不採用またはOpt-in
- iCloudの最終技術方式（要件はPhase 0で定義、技術仕様は実装直前に決定）

これらは詳細仕様書作成前または作成中に決定する。

---

# 27. 次工程

本構想仕様書 v1.0 をプロジェクトの構想ベースラインとして固定する。

1. プロジェクトの目的
2. 対象ユーザー
3. Safety Firstの原則
4. Remotely Saveとの関係
5. Phase 1をR2/S3中心にすること
6. iCloudは仕様化するが実装を後回しにすること
7. OSS公開を最終目標とすること
8. 初期非目標
9. ロードマップ

次工程として、Phase 0.5のBase Repository Auditに必要な評価項目を詳細化しつつ、**詳細仕様書 v0.1**の作成へ進む。

---

# 28. 現在ステータス

**Status: Concept Specification v1.0 / Approved Baseline**

次工程：

1. Base Repository Auditの実施・記録
2. 詳細仕様書 v0.1作成
3. Safety Invariantsを機械テスト可能な条件へ詳細化
4. `ICLOUD_REQUIREMENTS.md`作成（技術仕様は将来Phaseで確定）
