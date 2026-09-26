---
title: "ベースリポジトリ監査 証跡・コード由来候補・モデル検証"
version: "1.0"
date: 2026-09-06
status: "Evidence / No Source Import Approval"
document_type: "audit-evidence"
tags:
  - obsidian
  - repository-audit
  - provenance
---

# ベースリポジトリ監査の証跡

[監査結果の正本](BASE_REPOSITORY_AUDIT.md)に対応する。これは実装コードの取り込み許可書ではない。

## 1. 基準文書の照合

各値はコンテナ上の実ファイルからSHA-256を計算した。仕様書自体は上書きしていない。

| ファイル | SHA-256 |
|---|---|
| `obsidian_sync_oss_concept_spec_v1.0_20260906.md` | `0296e94a61589bb87cff6ca4396982dcc914e97be9d631a972a870b7f596af9f` |
| `obsidian_sync_oss_detailed_spec_v1.0_20260906.md` | `569e9948bdb845d9c8efcf7ca9302e9d023b9da212809596743e02b71d3ce803` |
| `obsidian_sync_oss_review_and_next_steps_v1.0_20260906.md` | `a8677afb693451da9cd87f3a68a95f6ce960de19615ccd7a532b99375e6c932d` |

## 2. 版の同一性

Git commit SHAと、個別ファイルのGit blob SHAと、文書のSHA-256は異なる識別子である。混同しない。

| 候補 | repository | commit SHA | tree SHA | UTC commit日時 | 日本時間 |
|---|---|---|---|---|---|
| A | `remotely-save/remotely-save` | `08027677267934d3a1ca6f6e3cf06ee1be53ee52` | `27351962f7e4779524195535a557fce6e8e2c2fb` | 2024-05-25T07:58:52Z | 2024-05-25T16:58:52+09:00 |
| B | `sboesen/remotely-sync` | `21a9e0145260dc409a9720930565f267380a56d5` | `994173b5d8d7e9f24ba8284c11c705bb410a6ba3` | 2024-05-04T21:10:28Z | 2024-05-05T06:10:28+09:00 |
| C | `remotely-save/remotely-save` | `34db181af002f8d71ea0a87e7965abc57b294914` | `0b7ee89d4088181cee10ff65f484de5fe326cbbd` | 2024-11-10T10:16:22Z | 2024-11-10T19:16:22+09:00 |
| D | `superabe/remotely-save` | `283cb34619aa54370c0f5d3485b69c4e41ff3785` | `未取得` | 未取得 | PRメタデータのみ。commit日時未取得 |

ライセンス変更commit `06dad54d4ceac0ed0b2343a9e71ed57b09434400` の親が候補AであることをLICENSE履歴APIで確認した。署名検証がないcommitを、暗号学的に作者本人が保証したものとは表現しない。

## 3. 一次資料の取得範囲

GitHubの内容APIから返ったGit blob SHAを記録した。部分取得したファイルでも返るSHAはファイル全体のGit blob SHAであり、読んだ範囲のハッシュではない。参照ページの範囲表示と、本監査で精査した範囲は区別する。

### A-COMMIT — Remotely Save v0.4.25のcommit

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/commit/08027677267934d3a1ca6f6e3cf06ee1be53ee52)

確認範囲：Git commit APIのメタデータ・親・treeを確認。

### A-TRANSITION — ライセンス変更commit

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/commit/06dad54d4ceac0ed0b2343a9e71ed57b09434400)

確認範囲：LICENSE履歴APIから親がA-COMMITであることを確認。変更commitの全差分は未読。

### A-ROOT — 候補Aのルートtree

資料：[固定版／一次資料](https://api.github.com/repos/remotely-save/remotely-save/git/trees/27351962f7e4779524195535a557fce6e8e2c2fb)

確認範囲：非再帰tree全件、truncated=false。直下のpro・lockfile・NOTICEの有無を確認。

### A-SRC — 候補Aのsrc直下tree

資料：[固定版／一次資料](https://api.github.com/repos/remotely-save/remotely-save/git/trees/54ed2a1731e60beb8134146cb7783b6c0850cc30)

確認範囲：直下tree全件、truncated=false。全ファイル本文の監査ではない。

### A-LICENSE — 候補A LICENSE

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/LICENSE)

確認範囲：全文。

Git blob SHA：`e72929ee99312b499c3f285e1dde6519c071a3c0`

### A-ASSET — 候補A branding LICENSE

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/assets/branding/LICENSE.txt)

確認範囲：全文。

Git blob SHA：`7c03569aae88b6f36ab9d8c70c3987cc41b14092`

### A-PACKAGE — 候補A package.json

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/package.json)

確認範囲：全文。

Git blob SHA：`96b48bcf6f464ce6fa7c74891d1aaf5efdb008e4`

### A-MAIN — 候補A src/main.ts

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/main.ts)

確認範囲：1〜115行。importと初期設定のみ。

Git blob SHA：`949f0c03be49af3cba7d16294ea14108d26dad42`

### A-SYNC — 候補A src/sync.ts

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/sync.ts)

確認範囲：1〜610行。状態結合・等価判定・競合分岐。実行部を含む全文監査ではない。

Git blob SHA：`644ba36962a184213138406fbd018b32b242bc0f`

### A-S3 — 候補A src/fsS3.ts

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/fsS3.ts)

確認範囲：1〜360行、380〜820行。HTTP Handler、LIST、GET/PUT、削除等。未読範囲あり。

Git blob SHA：`280b02d8d5a445bbccc752e51429574c46d3d7da`

### A-LOCAL — 候補A src/fsLocal.ts

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/fsLocal.ts)

確認範囲：全文。

Git blob SHA：`4ca1bfc411f5b59c1fcd07336f9a9393d40ba05d`

### A-META — 候補A src/metadataOnRemote.ts

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/metadataOnRemote.ts)

確認範囲：全文。

Git blob SHA：`b47a88329e75cb35fec5e691acfeef1d14e75d55`

### A-CONFIG — 候補A src/configPersist.ts

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/configPersist.ts)

確認範囲：全文。

Git blob SHA：`e14147ff87c9c69d519ce16752b717d5d2cd5569`

### A-CI — 候補A BuildCI

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/.github/workflows/auto-build.yml)

確認範囲：全文。実行履歴・成功結果の確認ではない。

Git blob SHA：`fc4e99a4cbc19d72135326152df41cc1e21ec66c`

### A-WEBPACK — 候補A webpack.config.js

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/webpack.config.js)

確認範囲：全文。

Git blob SHA：`036d14446446d62a67c702317c836426af4fc1da`

### A-TESTS — 候補A tests tree

資料：[固定版／一次資料](https://api.github.com/repos/remotely-save/remotely-save/git/trees/c5761cf1727383727d2a2243e17881233b747236?recursive=1)

確認範囲：tests内の全列挙、truncated=false。全試験本文の精読ではない。

### A-METATEST — 候補A metadataOnRemote.test.ts

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/tests/metadataOnRemote.test.ts)

確認範囲：全文。

Git blob SHA：`7ac64623540e0866a181dd680b5e636fc1f68408`

### B-COMMIT — Remotely Sync v0.4.49のcommit

資料：[固定版／一次資料](https://github.com/sboesen/remotely-sync/commit/21a9e0145260dc409a9720930565f267380a56d5)

確認範囲：default branch先頭をcommits APIで確認。

### B-ROOT — 候補Bのルートtree

資料：[固定版／一次資料](https://api.github.com/repos/sboesen/remotely-sync/git/trees/994173b5d8d7e9f24ba8284c11c705bb410a6ba3)

確認範囲：全列挙、truncated=false。LICENSEのblob SHAがAと同じこと、pnpm-lockを確認。

### B-README — 候補B README

資料：[固定版／一次資料](https://github.com/sboesen/remotely-sync/blob/21a9e0145260dc409a9720930565f267380a56d5/README.md)

確認範囲：1〜100行。対応表記、暗号化変更、非互換、mtime判定等。

Git blob SHA：`bacf68e466a7d5523e7e1ac4f4cde3ed52369c86`

### B-PACKAGE — 候補B package.json

資料：[固定版／一次資料](https://github.com/sboesen/remotely-sync/blob/21a9e0145260dc409a9720930565f267380a56d5/package.json)

確認範囲：全文。

Git blob SHA：`b0937b24b9d5fd6118add6d7a24c6db00de7a4e5`

### B-S3 — 候補B src/remoteForS3.ts

資料：[固定版／一次資料](https://github.com/sboesen/remotely-sync/blob/21a9e0145260dc409a9720930565f267380a56d5/src/remoteForS3.ts)

確認範囲：1〜320行。HTTP Handler、S3設定、アップロード準備。全文監査ではない。

Git blob SHA：`b74a232a3110ee1ad7bed786752b441449dda202`

### B-SUBMODULE — 候補B .gitmodules

資料：[固定版／一次資料](https://github.com/sboesen/remotely-sync/blob/21a9e0145260dc409a9720930565f267380a56d5/.gitmodules)

確認範囲：全文。

Git blob SHA：`03d25a8e11d625d5a45cefa0eb09007d807d0045`

### B-SRC — 候補B src tree

資料：[固定版／一次資料](https://api.github.com/repos/sboesen/remotely-sync/git/trees/7da57af7dd08ec29c65299d1ede42c794c2b5c73)

確認範囲：src/langsのgitlink f5569a6b25e7c53e99b1c5994a75f7c843349e6d を確認。submoduleの中身は未監査。

### C-COMMIT — 現行Remotely Save先頭commit

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/commit/34db181af002f8d71ea0a87e7965abc57b294914)

確認範囲：default branch先頭をcommits APIで確認。

### C-LICENSE — 現行Remotely Save LICENSE

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/LICENSE)

確認範囲：全文。

Git blob SHA：`7d5e8f875f886ded0760f94559fefcfce4eda432`

### C-MAIN — 現行Remotely Save src/main.ts

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/main.ts)

確認範囲：1〜95行。proへのimport境界のみ。pro本文はこの監査で取得していない。

Git blob SHA：`c174dd830c4286181b83b8c49ad734da3da5f7d2`

### PR1175 — 未採用の修正提案 PR #1175

資料：[固定版／一次資料](https://github.com/remotely-save/remotely-save/pull/1175)

確認範囲：get_pr_infoで説明、open/merged=false、base/headを確認。全パッチ実行・権利承認・テスト再現は未実施。

### D-LICENSE — PR1175 headのLICENSE

資料：[固定版／一次資料](https://github.com/superabe/remotely-save/blob/283cb34619aa54370c0f5d3485b69c4e41ff3785/LICENSE)

確認範囲：全文。

Git blob SHA：`7d5e8f875f886ded0760f94559fefcfce4eda432`

### L-APACHE — Apache License 2.0公式原文

資料：[固定版／一次資料](https://www.apache.org/licenses/LICENSE-2.0)

確認範囲：利用・改変・再配布、表示義務、商標、無保証に関する条項。

### L-POLYFORM — PolyForm Strict 1.0.0公式原文

資料：[固定版／一次資料](https://polyformproject.org/licenses/strict/1.0.0)

確認範囲：著作権許諾に改変・派生物・配布が含まれない点。例外・別許諾の有無を全件調べたわけではない。

### R2-API — Cloudflare R2 S3互換表

資料：[固定版／一次資料](https://developers.cloudflare.com/r2/api/s3/api/)

確認範囲：条件付きPutObject等の対応確認。実SDK/実アカウント試験ではない。

### NODE — Node.js公式リリース一覧

資料：[固定版／一次資料](https://nodejs.org/en/about/previous-releases)

確認範囲：Node 16 EOLの確認。今後の採用Node版は未固定。


## 4. 由来・取り込み候補の台帳

以下のactionは監査上の処遇であり、実装ソースの許可リストではない。`reference_only`や`not_approved`を、丸ごとコピーしてよいという意味に変換しない。

| 候補 | ファイル／領域 | action | 理由 |
|---|---|---|---|
| A | `LICENSE` | `retain_when_reusing` | Apacheの許諾・条件の正本。由来を保持 |
| A | `src/main.ts` | `reference_only_pending_extraction` | Plugin登録等の参照候補。旧同期・OAuth・設定への依存をまとめて引き継がない |
| A | `src/fsS3.ts` | `reference_only_rewrite_transport` | 署名済みHTTP統合の知見は参考。CAS、Range、エラー、中断、上限を新契約へ |
| A | `src/sync.ts` | `do_not_import_runtime` | mtime/size判定と現行プロトコルが新L/R/Bハッシュ・head CASと不一致 |
| A | `src/fsLocal.ts` | `do_not_import_runtime_writer` | 通常ノートの無条件writeBinaryを引き継がない |
| A | `src/metadataOnRemote.ts` | `do_not_import_runtime` | 旧Remote形式。version誤記あり。新スキーマで独立実装 |
| A | `src/configPersist.ts` | `do_not_import_runtime` | 難読化は秘密値保護と同じでない。初期MVPはメモリのみ |
| A | `src/localdb.ts` | `not_approved_not_fully_read` | 新journal/checkpoint/causal evidenceとは別。全文未監査 |
| A | `src/misc.ts` | `not_approved_not_fully_read` | 小関数をコピーする場合も関数範囲と依存を個別に確認 |
| A | `src/settings.ts` | `not_approved_rebuild_minimal_ui` | 多Backend設定の一括継承は不要。全文未監査 |
| A | `package.json` | `rebuild_minimal_dependencies` | 旧全依存を採用せず新lockfileとNOTICEを作る |
| A | `webpack.config.js` | `reference_only` | web向けbundleの参考。minify後のライセンス表記を別途確保 |
| A | `.github/workflows/auto-build.yml` | `rewrite` | 旧Node16・旧Actions・OAuth環境前提を除去 |
| A | `tests/` | `selective_reference_not_safety_evidence` | 新プロトコルの84受入条件は別途実装する |
| A | `assets/branding/` | `exclude` | CC BY-SA 4.0・ブランド混同。新しい独自素材を使う |
| A | `src/encrypt* / src/fsEncrypt.ts` | `out_of_initial_scope` | 暗号化は将来。依存と既存パスまで一緒に持ち込まない |
| A | `src/fsDropbox.ts / src/fsOnedrive.ts / src/fsWebdav.ts / src/fsWebdis.ts` | `out_of_initial_scope` | R2限定 |
| B | `src/langs (submodule)` | `exclude_unless_separately_audited` | 別リポジトリの正確なcommitと権利確認が必要 |
| C/D | `pro/` | `do_not_import` | 今回のOSS改変・配布をこのライセンスだけでは許諾されていない |

### 実装時に追加する記録項目

`SOURCE_IMPORT_MANIFEST.md`には、上表から実際に採用するものだけを記録する。各項目は次の形式とする。

```yaml
id: "IMPORT-0001"
source_repository: "owner/repository"
source_commit: "exact-commit-sha"
source_path: "path/to/file"
source_blob_sha: "exact-git-blob-sha"
source_line_range: "start-end, or full"
source_license: "SPDX-id-and-evidence"
third_party_origin: "none-confirmed-or-evidence"
reviewed_imports: []
destination_path: "path/in/new/project"
modifications: "summary"
license_notice_action: "what-is-preserved"
status: "pending"
```

この記入例に実ソース取り込み承認の効力はない。行数や第三者由来を推測で埋めない。

## 5. 実行したモデル検証

次のモデルは監査の説明用に作成した独立コードである。元repositoryをそのまま実行する試験ではなく、実サービス、実Vault、秘密値へ接続しない。コード中のNode組込みAPIはコンテナでの監査用であり、Obsidianモバイル実装での採用を意味しない。

実行コマンド：

```sh
node audit_models.mjs
```

### モデル全文

```javascript
/**
 * Dependency-free, isolated audit models. Not Remotely Save's test suite.
 * No network, no Vault access, no credentials, no production-file writes.
 * Model source: original minimal examples for the audit, 2026-09-06.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const results = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Model A: the inspected time/size equality predicate can miss different bytes.
const left = Buffer.from('AA\n', 'utf8');
const right = Buffer.from('BB\n', 'utf8');
const local = { mtimeCli: 1700000000000, sizeEnc: left.length };
const remote = { mtimeCli: 1700000000000, mtimeSvr: 1700000000000, sizeEnc: right.length };
const metadataEqual = (local.mtimeCli === remote.mtimeCli || local.mtimeCli === remote.mtimeSvr)
  && local.sizeEnc === remote.sizeEnc;
assert.equal(metadataEqual, true);
assert.notEqual(hash(left), hash(right));
results.push({ id: 'MODEL-01', passed: true, metadataEqual,
  contentEqual: hash(left) === hash(right),
  scope: 'Counterexample to time/size predicate only; no upstream integration run.' });

// Model B: equality comparison has no assignment side-effect.
const oldRecord = {};
if (oldRecord.version === undefined) oldRecord.version === '20220220';
assert.equal(Object.hasOwn(oldRecord, 'version'), false);
const intendedRecord = {};
if (intendedRecord.version === undefined) intendedRecord.version = '20220220';
assert.equal(intendedRecord.version, '20220220');
results.push({ id: 'MODEL-02', passed: true, oldExpressionWritesVersion: false,
  assignmentWritesVersion: true,
  scope: 'Language-level expression check; serializer call-path impact not measured.' });

// Model C: rejecting the racing timeout does not cancel a separate pending effect.
let completeRequest;
let expireTimeout;
const events = [];
const request = new Promise(resolve => { completeRequest = resolve; })
  .then(() => { events.push('simulated_remote_write_completed'); return 'ok'; });
const timeout = new Promise((_, reject) => { expireTimeout = reject; });
const race = Promise.race([request, timeout]);
expireTimeout(new Error('logical timeout'));
await assert.rejects(race, /logical timeout/);
events.push('caller_observed_timeout');
completeRequest();
await request;
assert.deepEqual(events, ['caller_observed_timeout', 'simulated_remote_write_completed']);
results.push({ id: 'MODEL-03', passed: true, events,
  scope: 'Promise scheduling model; not a real Obsidian/R2 cancellation test.' });

console.log(JSON.stringify({
  type: 'isolated_audit_models_not_upstream_tests',
  auditDate: '2026-09-06',
  runtime: process.version,
  modelCount: results.length,
  passed: results.every(result => result.passed),
  upstreamBuildExecuted: false,
  upstreamTestsExecuted: false,
  r2RequestsSent: false,
  results
}, null, 2));
```

### 実行結果

```json
{
  "type": "isolated_audit_models_not_upstream_tests",
  "auditDate": "2026-09-06",
  "runtime": "v22.16.0",
  "modelCount": 3,
  "passed": true,
  "upstreamBuildExecuted": false,
  "upstreamTestsExecuted": false,
  "r2RequestsSent": false,
  "results": [
    {
      "id": "MODEL-01",
      "passed": true,
      "metadataEqual": true,
      "contentEqual": false,
      "scope": "Counterexample to time/size predicate only; no upstream integration run."
    },
    {
      "id": "MODEL-02",
      "passed": true,
      "oldExpressionWritesVersion": false,
      "assignmentWritesVersion": true,
      "scope": "Language-level expression check; serializer call-path impact not measured."
    },
    {
      "id": "MODEL-03",
      "passed": true,
      "events": [
        "caller_observed_timeout",
        "simulated_remote_write_completed"
      ],
      "scope": "Promise scheduling model; not a real Obsidian/R2 cancellation test."
    }
  ]
}
```

## 6. 実施と未実施の境界

| 対象 | 状態 |
|---|---|
| GitHub接続ツールでのソース・メタデータ読み取り | 実施 |
| 比較対象のcommit固定 | 実施 |
| 主要コードと詳細仕様v1.0の静的比較 | 実施 |
| 独立モデル3件 | 実行し、期待した観測に一致 |
| 元ソース一式のビルド | 未実施 |
| 元のnpm test | 未実施 |
| 実装予定の84受入試験 | 未実施 |
| 全推移的依存物の許諾・脆弱性監査 | 未実施 |
| R2実アカウント・Windows/iPhone実機 | 未実施 |
| GitHub repository作成・Fork・PR・Issue投稿 | 未実施 |
| ユーザーの本番Vault変更 | 未実施 |

通常のコンテナ外部取得が成立しないため、ネットワーク依存のclone・インストール・元ビルドを再現できていない。ソースの読み取りはGitHubツールで実施した。未実施を合格や不合格に読み替えない。

## 7. 引渡し時の利用方法

まず監査結果の正本を読み、次に本書の取得範囲を確認する。コードを取り込む際は固定commitで再取得し、Git blob SHAを照合する。新しい公開版を使いたくなった場合は、この台帳を流用せず差分と利用条件を再確認する。

`audit_evidence.json`は同じ情報の機械可読版である。監査ZIPにはこの文書、監査結果、独立モデル、モデル結果、機械可読証跡、ファイル照合値だけを含める。元repositoryのソース一式・依存物・認証情報は含めない。
