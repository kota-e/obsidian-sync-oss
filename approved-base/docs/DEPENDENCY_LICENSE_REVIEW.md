---
title: "Obsidian同期OSS 依存物・ライセンス確認"
version: "1.0"
date: 2026-09-06
status: "Selected Dependency Closure Reviewed"
document_type: "dependency-license-review"
production_use_approved: false
tags: [obsidian, oss, dependency, license, g-base]
---

# DEPENDENCY_LICENSE_REVIEW v1.0

> **結論：今回取り込むnpm packageは実行用1個・開発用1個に固定し、それらが追加インストールを要求する依存は0個と確認した。内包される第三者表示は別に確認し、全文を保存した。**

## 1. 範囲

対象は [ソース取り込み台帳](SOURCE_IMPORT_MANIFEST.md) と同じ、初期モジュール作業treeの実物である。

将来のプラグイン全体のすべての依存を検査したという意味ではない。現時点でObsidianアプリ本体・SDK package・UI・bundler・ネットワークHTTP Handler・XML parser・CI Actionを取り込んでいない。これらを追加するときは差分監査を行う。

既存のRemotely Saveの多数の依存を新しいプロジェクトへ移してから不要分を消すのではなく、**使う集合だけを最初から許可**する。

## 2. 確定した依存集合

| ID | package | 正確な版 | 種別 | packageとしての追加依存 | 表示上の条件 |
|---|---|---|---|---|---|
| DEP-001 | `@svsync/aws4fetch-signer` | `1.0.20-svsync.1` | 署名用・ローカル派生版 | 0 | 上流JSはMIT、追加型はApache-2.0 |
| DEP-002 | `typescript` | `5.8.3` | 開発・型検査用 | 0 | Apache-2.0と原本ThirdPartyNoticeTextの個別条件 |

直接実行依存1、直接開発依存1、追加の推移的・optional・peer依存0。Node.jsやブラウザの標準APIはnpm依存数に含めない。**package数が少ないことは、内部に第三者素材がないことや脆弱性がないことを意味しない。**

実際のpackage.json、lockfile、配布tar、インストール後のpackage.jsonと全ファイルを照合した。上流の開発依存は、本プロジェクトでインストールする依存には含めない。TypeScriptをリポジトリのソースから再ビルドするための依存集合も今回の対象外である。

## 3. DEP-001：aws4fetch署名専用の派生版

上流v1.0.20は `629b108747e066d1b93e8b72a4adbf2a4220db3b` に固定した。上流packageに実行時dependenciesの指定はなく、元の配布ES moduleにもimportはない。[WP][W]

元配布ファイルをGit blob SHAで照合後、送信・再試行をするクラスを取り除いた。MIT本文とMichael Hartの表示を保持し、改変内容も記載した。[WL]

`vendor/packages/aws4fetch-signer-1.0.20-svsync.1.tgz`は本作業で作ったローカル派生packageであり、npmの同名公式packageをダウンロードしたものではない。上流の名前のまま変更物を公式配布と誤認させないため、`@svsync/`名、派生版番号、`private: true`を使う。この名称をnpm上で確保・公開したわけではない。

パッケージには `index.mjs`、独自型定義、package.json、MIT、追加型用Apacheの5ファイルを同梱する。署名以外の依存とinstall scriptはない。

### 3.1 実使用を制限する理由

本プロジェクトは独自に暗号署名アルゴリズムを発明せず、確認した既存実装を利用する。一方で、上流にある自動再試行が新しい同期Executorの再試行と重複することを避け、今回は署名だけを取り込む。

Cloudflare公式にR2での使用例はあるが、その事実はこの派生部品の実機動作証明ではない。[CF] 署名結果の上流比較、条件ヘッダーの維持、入力拒否は単体試験で確認し、**実アカウントで受け入れられるかは別に確認**する。

## 4. DEP-002：TypeScript 5.8.3

正確な版は5.8.3、npmメタデータのgitHeadは `68cead182cc24afdc3f1ce7c8ff5853aba14b65a` である。[T]

コンテナに既にある同版のpackageを、ファイル内容を変更せずローカルtarへまとめた。**これは公式npmのtarballそのものではない。** tarヘッダー等を独自に整えているため、公式tarballのintegrityと一致するとは主張しない。package-lockは実際に同梱したローカルtarのintegrityを記録する。

元のLICENSE.txtとThirdPartyNoticeText.txtは、公式GitHubの固定commitにあるGit blob SHAと、手元のファイルから再計算した値が一致した。[TL][TN]

| 照合対象 | Git blob SHA-1 |
|---|---|
| LICENSE.txt | `8746124b277914d0f0fd9cf4aef2ed3b587143d9` |
| ThirdPartyNoticeText.txt | `a857fb3ce77c3b43c145f94aa8d910c7791394a5` |

コンパイラの全ソース再ビルド、全JSファイルの公式配布物との独立照合、publisher署名の検証は実施していない。したがって、今回のローカル再現性の確認を、公式バイナリの来歴証明と混同しない。一般公開用CIを整える段階では、公式配布物の取得・integrity確認を含めてビルド由来を再確認する。

### 4.1 package内に含まれる第三者表示

| 表示される対象 | 原文にある条件の種類 | 今回の対応 |
|---|---|---|
| DefinitelyTyped | MIT | 帰属・許諾・免責を原文のまま保持 |
| Unicodeのデータ／ソフトウェア | Unicodeの許諾と免責 | 全文と表示を保持 |
| DOM（W3C） | W3Cのソフトウェア／文書許諾 | 表示・免責を保持 |
| DOM（WHATWG） | CC BY 4.0 | 帰属・出典・許諾全文を保持。型由来素材の条件をApacheだけに置換しない |
| Web Background Synchronization | W3C Community Final Specification Agreement等 | 当該条項・表示を省略しない。特許権の包括保証はしない |
| WebGL / Khronos | Khronosの許諾・免責 | 著作権と許諾全文を保持 |

正確な条件は `licenses/TypeScript-ThirdPartyNoticeText.txt` が正本である。上表は条件を置き換える要約ではない。内容を改変せず、元package内にも同じファイルを保持した。

TypeScriptは開発用であり、Obsidian内で実行するプラグインにコンパイラや全標準型を持ち込む設計ではない。

## 5. 実行環境と外部API

今回実行した環境はNode.js v22.16.0、npm 10.9.2、TypeScript 5.8.3。Node/npm本体はZIPに含めない。packageの`engines`表記は検証済みOS・Obsidianバージョンの一覧ではない。

署名部品はWeb Crypto、Headers、URL、TextEncoder等の標準APIを使用する。現在のWindows/iPhone上のObsidianで必要な機能が使えるかはG-R2等で確認する。Nodeで動いたことをモバイル試験の代わりにしない。

この作業treeにはObsidian packageもObsidian本体コードも含まない。将来Obsidianの型定義等をコピー／依存追加する場合、その具体物を同じ台帳へ追加する。

## 6. 再現可能な依存固定

`package-lock.json`はnpmがオフラインで作成したlockfileVersion 3で、依存の指定先は同梱したローカルtarだけである。

- tarのSHA-256、SHA-512 integrity、全ファイルinventoryを保存した。
- インストール後も全ファイルのハッシュ・件数を照合する。
- install scriptは無効にする。監査中に上流のprepare/build scriptを勝手に実行しない。
- ネットワーク未接続でも、Node/npmがあれば同じ同梱依存をインストールできる構成とした。

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm test
npm run gate
```

ネットワーク障害を理由に、未固定の最新版を取得する回避策は使わない。これらのコマンドは**プラグインをVaultへインストールするコマンドではない**。

### 6.1 準備中の不一致と修正

署名派生packageのライセンス表記を複合条件へ訂正した際、古いnode_modules由来のlockが残り、npmのintegrity検査が不一致を検出した。検査を無効化せず、作業用node_modules・lockを作り直し、別の空キャッシュからオフライン再インストールして解消した。

準備中の検出ログを証跡に残した。完了判定は修正後の再現試験に基づく。失敗した準備試行を「最初から全部成功」とは記録しない。

## 7. 表示と配布条件

| 配布対象 | 同梱する表示 |
|---|---|
| 自作・Remotely Save由来の部品 | 根拠となるApache全文、元出典・抽出の変更表示、NOTICE |
| aws4fetch派生JS | 元のMIT/copyright、派生である表示、MIT全文 |
| 独自の型定義 | Apache条件と全文 |
| 開発用TypeScript snapshot | 元packageのLICENSE.txt、ThirdPartyNoticeText、原表示を無変更で保持 |
| 証拠用の元aws4fetchファイル | 元MIT/copyright、同梱MIT全文。実行本体からは参照しない |

プロジェクト全体の自作部分はApache-2.0とするが、MIT等の第三者部分を勝手に単一ライセンスへ置き換えない。ロゴの利用権や元作者の推薦を示すものでもない。[AP]

## 8. 未確認事項を隠さない

今回完了するのは、実物の限定集合に対する依存閉包・ライセンス表示・由来・再現確認である。法務専門家による権利保証、第三者セキュリティ監査、脆弱性ゼロの確認、実R2接続成功、Windows/iPhone対応の認定ではない。

オンライン脆弱性データベース照会とnpm auditは本作業の合格条件に含めておらず、未実施である。一般公開前のG-RELEASEにおいて別途行う。古い版だから直ちに脆弱と断定することも、依存が0だから安全と断定することもしない。

将来の依存追加・バージョン変更・ライセンス変更では、その差分についてこの台帳とlockとテストを更新する。

## 参照

[W]: https://github.com/mhart/aws4fetch/blob/629b108747e066d1b93e8b72a4adbf2a4220db3b/dist/aws4fetch.esm.mjs
[WP]: https://github.com/mhart/aws4fetch/blob/629b108747e066d1b93e8b72a4adbf2a4220db3b/package.json
[WL]: https://github.com/mhart/aws4fetch/blob/629b108747e066d1b93e8b72a4adbf2a4220db3b/LICENSE
[T]: https://registry.npmjs.org/typescript/5.8.3
[TL]: https://github.com/microsoft/TypeScript/blob/68cead182cc24afdc3f1ce7c8ff5853aba14b65a/LICENSE.txt
[TN]: https://github.com/microsoft/TypeScript/blob/68cead182cc24afdc3f1ce7c8ff5853aba14b65a/ThirdPartyNoticeText.txt
[CF]: https://developers.cloudflare.com/r2/examples/aws/aws4fetch/
[AP]: https://www.apache.org/licenses/LICENSE-2.0
