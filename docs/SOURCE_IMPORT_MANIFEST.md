---
title: "Obsidian同期OSS ソース取り込み台帳"
version: "1.0"
date: 2026-09-06
status: "Fixed Import Allowlist / Scope-limited G-BASE"
document_type: "source-import-manifest"
source_commit: "08027677267934d3a1ca6f6e3cf06ee1be53ee52"
production_use_approved: false
tags: [obsidian, oss, provenance, license, g-base]
---

# SOURCE_IMPORT_MANIFEST v1.0

> **結論：Remotely Saveから再利用するのは副作用のない2関数だけとする。署名用の外部部品は別の固定版から限定抽出し、旧同期エンジン・Pro・ロゴ・旧依存一式は取り込まない。**

## 1. 本書の位置づけと対象集合

[ベース監査](BASE_REPOSITORY_AUDIT.md)で保留した「実際の取り込み集合」を確定する。対象は、この文書とともに配布する `gbase_approved_20260906` の監査用モジュール作業treeである。

これは完成プラグインではなく、**新しい同期コアを作り始めるための、権利・由来を限定した部品と検証環境**である。実R2通信、Obsidianの起動・ファイル更新、UI、LIST/XML解析、バンドル、84件の製品受入試験は含まない。

G-BASEを合格とするのは本書と機械可読台帳が列挙する集合だけである。将来の外部コード・Obsidian SDK・bundler・XML parser・CI actionまで包括承認しない。追加時には差分監査を必要とする。これは元の監査書§10.2の「限定集合について確認を閉じる」方針を具体化したものであり、製品全体の確認を済ませたという意味ではない。

実装仕様は既存の詳細仕様書v1.0を維持する。今回の部品コードが仕様の代わりになることはない。

## 2. Remotely Saveの固定出典

| 項目 | 確定値 |
|---|---|
| repository | `remotely-save/remotely-save` |
| バージョン | `0.4.25` |
| commit | `08027677267934d3a1ca6f6e3cf06ee1be53ee52` |
| 対象ファイル | `src/misc.ts` |
| ファイル全体のGit blob SHA-1 | `046693e846d3c9799833a9624291aa6a5c99fc25` |
| 適用条件 | ルートApache License 2.0。選定範囲に別条件・第三者転載表示は確認されなかった |
| 取り込み先 | `src/inherited/buffer-range.ts` |

ソース：[固定版misc.ts][A]、[同版LICENSE][AL]。

Git blob SHAはGitHub APIが返した元ファイル全体の識別値である。**ここで保存したのは次の断片であり、misc.ts全文をダウンロード・再ハッシュしたとは扱わない。** 保存した断片そのものには別途SHA-256を計算した。

### 2.1 許可リスト

| ID | 元の行範囲 | 再利用するもの | 用途 | 依存 | 変更 |
|---|---|---|---|---|---|
| IMP-001 | 117–121 | `copyArrayBuffer` | 非同期処理の前に本文の独立したコピーを作る | JavaScript標準のArrayBuffer/Uint8Arrayのみ | 本体は無変更。由来・抽出日をヘッダーに追加 |
| IMP-002 | 281–307 | `SplitRange`と`getSplitRanges` | 取得するバイト範囲の分割候補を作る | 数値演算/配列のみ | 本体は無変更。呼出し前の入力検証は別の自作関数で行う |

実コピーは、インターフェースを含む**32行、関数2個**である。分岐元への敬意を示すためだけに不要コードを増やさない。旧同期エンジンや画面を再利用したわけではなく、再利用規模は小さいと明記する。

### 2.2 検査と使用条件

IMP-001/002の関数全文と前後の由来コメントを読み、直接importと内部呼出しを確認した。選定範囲に独自npm依存、Obsidian API、ネットワーク、ファイル書き込みはない。

`misc.ts`全体には外部ライブラリやStack Overflow等への参照を持つ別関数がある。このため、**ファイル全体をコピーすることは禁止**し、隣接する`bufferToArrayBuffer`、`hexStringToTypedArray`等も許可対象に含めない。

`getSplitRanges`を未検証値で直接呼ばない。自作 `checkedRanges` で整数・非負・分割サイズ・最大分割数を確認し、0バイトは空配列にする。分割の`end`は排他的な終端であり、実際のHTTP Rangeの終端とは変換が必要である。将来の実通信Adapterでこの契約を維持する。

選定断片に別の権利表示が見つからなかったことは、全Git履歴・すべての原著作者を法的に保証したことではない。問題が判明した場合は取り込みを止めて記録を改訂する。

## 3. 署名部品の選択的取り込み

### 3.1 固定出典

| 項目 | 値 |
|---|---|
| 上流 | `mhart/aws4fetch` |
| 上流バージョン | `1.0.20` |
| commit | `629b108747e066d1b93e8b72a4adbf2a4220db3b` |
| 元のファイル | `dist/aws4fetch.esm.mjs` |
| 元ファイルGit blob SHA-1 | `9c27de4db12fae710956c03888f95a4242073735` |
| 上流の利用条件 | MIT |
| 本プロジェクト側の名前 | `@svsync/aws4fetch-signer` |
| ローカル派生版 | `1.0.20-svsync.1`。上流が配布した公式版ではない |

ソース：[元ファイル][W]、[package][WP]、[LICENSE][WL]。

元ファイル全文を読み、取得した11,283バイトのGit blob SHAを再計算してGitHub側の値との一致を確認した。

### 3.2 IMP-003の変更を限定する

元ファイルの `AwsClient` クラス全体とそのexportを除去し、`AwsV4Signer`と必要な内部補助関数を残す。残した本体は元のままとし、変更内容・固定commitを先頭に追記する。

これによってこの部品からHTTP送信と自動再試行の経路を外した。**署名文字列の生成と、実際に通信することを分離**する。除去以外に署名アルゴリズムを独自に作り直したわけではない。

配布用のローカルpackageには独自に記述した最小TypeScript型契約も含む。この型定義はApache-2.0、上流由来のJavaScriptはMITのまま保持するため、packageの表記は `MIT AND Apache-2.0` とした。MITとApacheの全文を同梱する。

Cloudflare公式にはaws4fetchのR2使用例がある。[CF] これは採用候補の根拠の一つであり、**今回の派生版やiPhoneでの動作をCloudflareが認証した意味ではない。**

### 3.3 認める使い方と、未実装の部分

今回の `signR2Request` は、固定のR2形式の接続先、GET/HEAD/条件付きPUT、本文ハッシュ、ETag、Rangeを署名に渡すための、ネットワーク接続しない契約試作である。

セッション内の仮の認証情報だけをテストに使う。署名キャッシュは呼出し単位で破棄するが、メモリの完全消去を保証するものではない。

本部品にはS3全操作の実装、R2からの応答検証、URLのリダイレクト制御、LIST、実際の再試行、manifestの公開判断はない。これらは詳細仕様に従って後続実装する。署名が作れることだけで、R2接続が成功したとは扱わない。

## 4. 自作コードの由来

| ファイル | 分類 | 役割 |
|---|---|---|
| `src/core/checked-range.ts` | 本プロジェクトの新規実装 | 抽出関数へ渡す引数の検証 |
| `src/r2/sign-request.ts` | 本プロジェクトの新規実装 | 署名専用部品への限定的な入力Adapter |
| `evidence/derived/aws4fetch-signer/index.d.mts` | 本プロジェクトの新規記述 | 使用する型だけを記した契約。上流のSDK型を転載していない |
| `tests/*.test.mjs` | 本プロジェクトの新規実装 | 実取り込み部品・署名・境界検査を検証 |
| `scripts/verify-gate.mjs` | 本プロジェクトの新規実装 | 正確な許可集合、ハッシュ、依存・ライセンスを照合 |

自作部分はApache-2.0で扱う。AI生成という理由で権利や正しさの確認を省略しない。

## 5. 取り込みを許可しないもの

| 対象 | 理由 |
|---|---|
| Remotely Saveの`pro/`、現行版を丸ごと含むtreeや履歴 | 今回の許可範囲外 |
| 旧`sync.ts`、`fsLocal.ts`、`metadataOnRemote.ts`、`configPersist.ts` | 現在の安全仕様・保存形式と不一致 |
| 旧`fsS3.ts`のHTTP送信部全体 | Range上限・応答不明・条件付き公開等の契約と異なる |
| 元ロゴ・branding・未確認画像・翻訳submodule | 個別権利と不要な混入を避ける |
| 旧package.json／旧lock／旧CIの一式 | R2以外の依存と元作者環境を引き継がない |
| aws4fetchの`AwsClient.fetch()`、上流の開発依存 | 自動送信・重複再試行・依存拡大を避ける |
| 既存の未マージPR全体 | 提出は採用承認や利用許諾の代わりにならない |

許可リストにないものは、同じライセンスらしく見えても自動で追加しない。今回、GitHub上のFork作成・公開・PR提出は行っていない。

## 6. 機械可読台帳と取り違え防止

`evidence/source-imports.json`に元commit、Git blob、行範囲、断片SHA-256、移植先、依存、変更内容を記録した。

`evidence/approved-set.json`は、承認対象のソース・package・lock・ライセンス・テスト・検査スクリプトと、生成したコンパイル結果を列挙する。`npm run gate`で同一性を確認する。

SHAは改変検知の手段であって、外部から信頼を保証するデジタル署名ではない。manifestと検査スクリプトを同時に改変できる攻撃者に対する認証を意味しない。配布したZIPと完了報告の照合値も併用する。

## 7. 元作者への敬意と公開時の扱い

元作者fyearsと貢献者、aws4fetchのMichael Hartの出典をNOTICEへ残す。改変ファイルには変更した事実を明示し、原著作権・許諾表示を削除しない。[AP]

「Remotely Saveの全機能を引き継いだ」「公式後継」「旧Remoteと完全互換」「絶対に消えない」とは説明しない。実態に合わせ、Remotely Saveの一部コードと知見に基づく独立プロジェクトと記載する。

ライセンス遵守によって元作者の売上に影響が一切ないと保証することはできない。成果と権利を尊重することと、OSSとして認められた改良を行うことを両立する。

## 8. 次のコード追加に必要な条件

追加するファイル・関数・npm package・型定義・ビルドツールの正確な版と由来、個別条件、全推移的依存、必要な表示を更新し、境界検査とテストを通してから許可集合を更新する。

自作の同期判定やモックの実装は、この許可済み部品を基準に進められる。Obsidianと実R2への結合はG-R2/G-LOCAL/G-CLIENT-STATE等の別ゲートを通す。現在のiCloud Vaultへ接続しない。

## 参照

[A]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/misc.ts
[AL]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/LICENSE
[W]: https://github.com/mhart/aws4fetch/blob/629b108747e066d1b93e8b72a4adbf2a4220db3b/dist/aws4fetch.esm.mjs
[WP]: https://github.com/mhart/aws4fetch/blob/629b108747e066d1b93e8b72a4adbf2a4220db3b/package.json
[WL]: https://github.com/mhart/aws4fetch/blob/629b108747e066d1b93e8b72a4adbf2a4220db3b/LICENSE
[CF]: https://developers.cloudflare.com/r2/examples/aws/aws4fetch/
[AP]: https://www.apache.org/licenses/LICENSE-2.0
