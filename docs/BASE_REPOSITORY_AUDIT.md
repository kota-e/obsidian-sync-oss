---
title: "Obsidian同期OSS Phase 0.5 ベースリポジトリ監査"
version: "1.0"
date: 2026-09-06
status: "Static Selection Audit Completed / G-BASE Import Gate HOLD"
document_type: "base-repository-audit"
baseline: "obsidian_sync_oss_detailed_spec_v1.0_20260906.md"
preferred_source_commit: "08027677267934d3a1ca6f6e3cf06ee1be53ee52"
production_use_approved: false
tags:
  - obsidian
  - oss
  - repository-audit
  - license
  - cloudflare-r2
  - safety
---

# Phase 0.5 ベースリポジトリ監査 v1.0

> **結論：継承元としてRemotely Save v0.4.25の固定commitを第一候補に選定する。ただし、丸ごとの実行基盤採用は見送る。同期中核は詳細仕様v1.0に合わせた独立実装が必要であり、「未採用PRを追加すれば完成」という計画ではない。**
>
> 候補比較・主要コードの静的監査は実施した。全ソース・全依存物の利用許諾確認、元プラグインのビルド、実機試験が完了したとは扱わない。**外部コードを実際に取り込むG-BASEゲートは保留**である。

## 0. この文書で決まったこと

| 判断 | 監査結果 |
|---|---|
| 継承元として選ぶ版 | `remotely-save/remotely-save` v0.4.25、commit `08027677267934d3a1ca6f6e3cf06ee1be53ee52` |
| 推奨する継承の仕方 | 固定版を出自・参照の基準にし、許諾と依存を確認した小さい単位だけ選択的に利用する |
| 既存の同期エンジン | そのまま再利用しない。旧判定・実行方式と新仕様が違う |
| 現行masterとPR1175修正版の丸ごと採用 | 見送り。混在ライセンスとPro依存が解消していない |
| Remotely Sync | 今回のMVPの基盤には選ばない。比較対象としての知見は残す |
| 詳細仕様v1.0 | 今回上書きしない。新プロトコル・安全規則・MVP範囲は維持 |
| iCloudの本番Vault | 移動・変更しない。本監査ではアクセスしない |
| 進めてよい作業 | 引渡し資料、取り込み台帳の確定、独立した純粋関数・モックの設計／試作 |
| まだ進めない作業 | 未監査コードの一括取り込み、旧版をそのまま実データへ接続、安定版として配布 |

ここでいう「継承元」は、実際のプログラム一式を無修正で継承するという意味ではない。**ソースの出発点の選定と、個々のソースを取り込む許可は別**に管理する。

## 1. 監査の目的・基準・限界

### 1.1 判断基準

上位文書は[構想仕様書v1.0](obsidian_sync_oss_concept_spec_v1.0_20260906.md)と[詳細仕様書v1.0](obsidian_sync_oss_detailed_spec_v1.0_20260906.md)。進行管理は[前回のレビュー結果](obsidian_sync_oss_review_and_next_steps_v1.0_20260906.md)による。

今回の採否は、最終更新日やスター数だけでは決めない。次を重視する。

- 対象commitと利用条件を特定できるか。
- R2＋Windows＋iPhoneという初期範囲に適するか。
- 内容ハッシュによる共通版比較、条件付きhead公開、復旧・ジャーナルを実装しやすいか。
- モバイルのHTTP・ファイル操作を検証可能な形へ分離できるか。
- テスト・依存物・ビルド・運営の負担を説明できるか。

詳細仕様v1.0は既に、通常Markdownをローカルに残し、R2側は独自のblob/manifest/head方式とする。旧Remoteの互換実装ではない。したがって本監査では、既存同期機構への小修正に無理にこだわらない。一方で、無断で全面新規開発へ方針を切り替えたことにもせず、再利用量が限られる事実を明記する。

### 1.2 実施方法

GitHubの接続ツールで公開リポジトリのcommit、tree、LICENSE、主要ソース、package、CI、PR説明を読み、固定commitのURLを記録した。公式ライセンス原文、Node.js公式情報、R2の互換表を確認した。[L-APACHE][L-POLYFORM][NODE][R2-API]

さらに、コードの特定の論理を切り出した**独立した小規模モデル3件**をNode.jsで実行した。元リポジトリをビルドして試験したものではない。実行結果とモデル全文は[監査証跡](BASE_REPOSITORY_AUDIT_EVIDENCE.md)に残した。

### 1.3 対象外・未実施

全リポジトリの逐行レビュー、全履歴の権利調査、全依存ライブラリのライセンス／脆弱性監査、元プラグインのビルドと試験、実R2・Windows・iPhoneでの動作確認は未実施である。今回のコンテナから通常の外部取得ができず、完全なcloneと依存インストールを成立させていない。

GitHubツールによるソース閲覧は成功している。この制約を「GitHubの中身が読めなかった」とは扱わない。また、ビルドを実施できていないことを「ビルドが失敗する版」と言い換えない。

本書は技術的な選定監査であり、法務専門家による全権利保証や、独立した第三者セキュリティ監査ではない。

## 2. 候補と固定版

| ID | 候補 | 監査対象commit | 判断 |
|---|---|---|---|
| A | Remotely Save v0.4.25 | `08027677267934d3a1ca6f6e3cf06ee1be53ee52` | **継承元の第一候補。選択的利用のみ** |
| B | Remotely Sync v0.4.49 | `21a9e0145260dc409a9720930565f267380a56d5` | 今回は非選定 |
| C | 現行Remotely Saveの確認時default branch先頭 | `34db181af002f8d71ea0a87e7965abc57b294914` | 丸ごとの採用不可 |
| D | PR1175の修正ブランチ | `283cb34619aa54370c0f5d3485b69c4e41ff3785` | 丸ごとの採用不可。問題の参考情報として利用 |

Aは2024-05-25、Bは2024-05-04、Cは2024-11-10のcommitである。いずれも公開版の番号やcommit日時が、そのまま安全性や現行Obsidian互換性を証明するわけではない。特に、別プロジェクトの`0.4.49`と`0.4.25`を番号だけで新旧比較しない。[A-COMMIT][B-COMMIT][C-COMMIT]

Dは元のCをbaseとする修正提案で、確認時は未マージだった。PRにはテスト成功が記載されているが、本監査で再現した結果ではない。[PR1175]

## 3. 候補Aを選んだ理由

### 3.1 ライセンス変更直前を正確に特定できた

LICENSEを変更したcommitは`06dad54d4ceac0ed0b2343a9e71ed57b09434400`、メッセージは`pro and smart conflict`である。その直前の親commitがAであることを確認した。Aのpackage.jsonの版は`0.4.25`、ルートLICENSEはApache License 2.0である。[A-TRANSITION][A-COMMIT][A-PACKAGE][A-LICENSE]

このため、単に「古い版」「最新版ではない版」と曖昧に指定せず、**正確なcommitを一つに固定**できる。tag名やmasterだけに依存しない。

### 3.2 元プロジェクトとの連続性が確認しやすい

Aの`src/main.ts`は同期処理を`./sync`から読み込み、現行版Cは`../pro/src/sync`から読み込む。Aのルートtreeには`pro`ディレクトリがない。これは混在ライセンス化以前を参照する根拠となる。ただし、これだけで全ファイルの権利調査を完了したとは扱わない。[A-MAIN][A-ROOT][C-MAIN]

### 3.3 候補Bの優位点が、今回の初期範囲と一致しない

Remotely SyncのREADMEは暗号化変更、S3・モバイル対応、旧Remotely Saveとの非互換性を記載する。一方、変更日時を中心とした判定であることも記載している。S3処理ではVault操作と暗号化・通信が結び付いている。[B-README][B-S3]

今回、暗号化は初期範囲外である。したがってBに固有の機能を得るために別系列の複雑さを引き受けるメリットは小さい、と評価する。Bの暗号化が実証済みで安全だと比較認定したわけではない。

Bには`pnpm-lock.yaml`がある点を評価する。ただし`src/langs`は別リポジトリのsubmoduleで、追加の由来管理が必要である。lockfileの存在だけで、依存の安全性やビルド再現性が確認済みにはならない。[B-ROOT][B-SUBMODULE][B-SRC]

## 4. ライセンス監査

### 4.1 「旧版なら全部Apache」という説明を訂正する

**ルートLICENSEがApache 2.0でも、リポジトリ内の全素材が同じ条件とは限らない。** Aの`assets/branding/LICENSE.txt`にはCC BY-SA 4.0が記載されている。したがって、以前の「完全Apache版」という表現は厳密ではなかった。[A-LICENSE][A-ASSET]

本プロジェクトでは、元ロゴ・アイコン素材を初期取り込み対象から外す。独自の名称・素材にして、出自のクレジットは文書で残す。テスト画像にも別のLICENSEファイルがあるため、画像一式を無確認でコピーしない。[A-TESTS]

### 4.2 領域別の判断

| 領域 | 確認できた条件・問題 | 採用ルール |
|---|---|---|
| AのルートLICENSEとその下の通常コード | Apache-2.0を確認。個別表記・第三者由来は別途維持が必要 | 範囲を確定し、由来と依存を確認してから利用 |
| Aのbranding素材 | CC BY-SA 4.0 | 初期は除外 |
| C/Dの`pro/` | PolyForm Strict 1.0.0 | 本プロジェクトへ取り込まない |
| C/DのApacheと記載された領域 | Apache領域でもProをimportし得る | フォルダ名だけで許可せず、依存を追跡する |
| AのS3 HTTP Handler | AWS由来でApache-2.0とのコメントあり | 継承する場合はAWS側の出典・表示も保全する |
| Bの`src/langs` | 別repository・固定gitlinkあり | 別途監査なしに取り込まない |
| npm等の依存物 | ルートLICENSEは各依存物へ一律適用されない | 採用版を固定し、ライセンス一覧と必要なNOTICEを作る |

根拠：[A-LICENSE][A-ASSET][C-LICENSE][D-LICENSE][C-MAIN][A-S3][B-SRC]

### 4.3 許可と義務

Apache-2.0は条件付きで改変・再配布を許諾する。再配布時はライセンス同梱、変更表示、該当する著作権・帰属表示の維持、元にNOTICEがある場合の適切な扱いが必要であり、商標の利用権まで一律に付与するわけではない。[L-APACHE]

PolyForm Strict原文の著作権許諾は、配布、変更、派生物の作成を除外している。**このライセンスだけを根拠にProコードを改造してOSSとして再配布する方針は取れない。** 別許諾の取得や法的例外が存在しないと断言する趣旨ではない。[L-POLYFORM]

公開PRにも権利確認が必要である。今回の監査ではPRの全寄与について許諾が確定したとは判断しない。また、機能の考え方を独立設計することと、制限付きコードをAIへ渡して言い換えさせることを同一視しない。

## 5. 主要な技術所見と対策

以下は「元プロジェクトが常に壊れる」という判定ではなく、**今回の仕様でそのまま採用できない具体的な理由**である。

| ID | 優先度 | 確認した事実・懸念 | 新仕様との関係と対策 | 根拠 |
|---|---|---|---|---|
| AUD-01 | 高 | Aの等価判定にmtimeとsizeEncの一致を使う分岐がある | 内容SHA-256によるL/R/B判定へ置換。旧Plannerをそのまま採用しない | [A-SYNC] |
| AUD-02 | 最重要 | Aの通常ファイル更新は`adapter.writeBinary`を直接呼ぶ | `Vault.process`等による内容条件確認＋復旧コピー＋検証を新Local Adapterで実装 | [A-LOCAL] |
| AUD-03 | 最重要 | AのS3アップロードには確認範囲でhead/manifest型CAS公開がなく、通常PUT/Uploadと直接削除がある | 独自の不変blob/manifest/commitとhead条件付きPUTへ。削除APIを通常Backendへ公開しない | [A-S3] |
| AUD-04 | 高 | HTTP Handlerはrequest・timeout・abort通知をPromise.raceする | 結果不明と本当の通信中断を区別。送信済みPUTは照合してから再計画 | [A-S3][B-S3] |
| AUD-05 | 高 | Handlerは既に受信済みのarrayBufferをStreamで包む | ストリーミング型の上限制御とは異なる。上限付き受信／ETag固定Rangeを実機で検証 | [A-S3][B-S3] |
| AUD-06 | 高 | Handlerは`requestUrl`を呼び、通常のエラー応答の扱いを新契約どおりに定義していない | 403・404・412・429・5xxと本文取得失敗を区別できるAdapter試験が必要 | [A-S3] |
| AUD-07 | 高 | accurate-mtimeのHEADキューでerror時にpause/clear/throwし、最後はonIdleを待つ | エラー伝播の実動作は未再現。新仕様では日時キューを継承せず、全取得成功条件を明確にする | [A-S3][PR1175] |
| AUD-08 | 高 | LISTでContentsがundefinedならループを抜ける。繰返しtokenの検査は確認範囲にない | 想定外応答や部分一覧を成功一覧にしない。正常な空一覧と異常応答を分ける | [A-S3] |
| AUD-09 | 中 | metadataのversion設定箇所が代入でなく比較式 | 元関数の欠陥を確認。新schemaでは版と必須項目を検証し、旧serializerは使わない | [A-META] |
| AUD-10 | 高 | settingsをbase64変換＋文字列反転する保存方式 | 難読化と秘密値保護を区別。初期MVPは鍵をメモリのみへ | [A-CONFIG] |
| AUD-11 | 中 | A mainは多Backend、旧設定、旧DBと結合 | Pluginの登録部分など小さい範囲だけ参照。全mainを入口として採用しない | [A-MAIN] |
| AUD-12 | 高 | Aルートにlockfileがなく、packageは範囲指定が多い | 古い全依存の一括導入をせず、必要最小限の依存と新lockfileを作る | [A-ROOT][A-PACKAGE] |
| AUD-13 | 中 | AのCIはNode16・旧Actionsと元作者側のOAuth環境を前提に記述 | 新しい独立CIへ。元作者のsecrets・リリース先を引き継がない | [A-CI][NODE] |
| AUD-14 | 高 | 検査した既存メタデータ試験は比較関数中心で、serializerのversion設定を検査しない | 新仕様の受入条件を別に実装。既存テスト成功を新安全規則の証拠にしない | [A-METATEST] |

### 5.1 変更日時の判定は実際に何が問題か

短い本文Aと本文Bが異なっていても、バイト数が同じで更新日時も同じなら、確認した旧分岐は「等しい」と判定し得る。これはMODEL-01で論理上の反例を確認した。ユーザーの実Vaultでこの条件がどれだけ発生するかは測定していない。

### 5.2 上書き・削除処理はスイッチを隠すだけでは不十分

新仕様では「削除なし」を初期要件にしている。それでも既存のwriteやrmをそのまま公開し、UIだけで使わないようにする方式は避ける。ExecutorのAPIレベルで新契約へ絞り、CASなしのRemote更新や復旧なしのLocal上書きを呼べなくする。

### 5.3 元コードにも安全対策は存在する

Aの同期コードには、片側が空の場合に前回履歴を使わず、削除を避けようとする処理がある。mainの初期設定にも変更割合を保護する項目がある。今回の結論は「元作者が安全を考えていなかった」ではなく、**新しい安全契約・Remote形式へそのまま当てはめられない**ということである。[A-SYNC][A-MAIN]

### 5.4 既存モバイル対応を否定もしない、保証もしない

A/BはObsidianのHTTP APIやweb向けバンドル設定を使っている。Node系の名前がimportにあることだけで、モバイルで動かないと断定しない。ブラウザ向け置換も確認できる。[A-PACKAGE][A-WEBPACK][B-S3]

しかし、新仕様が要求するRange上限、redirect拒否、条件付きLocal更新、端末マーカー、途中終了後の照合が、現在のiPhoneで成立するかは別の実機検証である。旧版がモバイル対応を掲げていることをG-R2/G-LOCAL/G-CLIENT-STATE合格の代用にしない。

## 6. 引き継ぐもの・引き継がないもの

### 6.1 選択的再利用の方針

| 領域 | 方針 | 理由 |
|---|---|---|
| 出自・LICENSE・貢献者表示 | 利用した範囲に応じて維持 | 権利遵守と元作者への敬意 |
| Obsidianとの接続の知見 | 参照し、取り込むなら小さく抽出 | 一から調べる負担を減らせる余地 |
| S3署名済み要求とObsidian HTTPの接続 | 設計の参考。Handler本体は再設計が必要 | 既存実装は新しい通信契約を満たさない |
| 汎用の小関数・テスト入力 | 必要なものだけ、全文・依存・由来確認後に選定 | `misc.ts`等をまとめてコピーしない |
| 同期判定・公開プロトコル | 独立実装 | hash/manifest/head CASが旧機構と違う |
| Localへの反映・復旧・journal/checkpoint | 独立実装 | 旧APIの直接writeと新保全ルールは異なる |
| 認証情報・設定画面 | 初期MVP用に再構成 | R2限定、鍵メモリ保存、正確な接続先検査 |
| プロバイダ追加・暗号化・旧Remote移行機能 | 初期対象から除外 | 合意済み範囲を維持 |
| 元ロゴ、未確認素材、Proコード | 取り込まない | 個別ライセンス、出所、誤認防止 |
| 旧CIと旧依存一式 | そのままコピーしない | 再現性・保守性・元作者環境への依存 |

**現時点の実ソース取り込み許可リストは未発行である。** 上表の「参照」「選択的」は、Codexへ自動コピーを許可した意味ではない。

### 6.2 改修量の評価

本監査の技術評価は、**小さなバグ修正版ではなく、同期中核を置き換える大きな改修**である。

再利用率や必要時間を数値で断定できるだけの実装試行は行っていない。何割再利用できる・何日で完成するという数字は付けない。特に、現行の独自プロトコルでは既存の同期エンジン、Remote metadata、Local writerの大部分を再利用しにくい。

これは実現不可能という結論ではないが、当初の「フォーク＋PR追加ならかなり楽」という見立ては修正する必要がある。**現金コストを抑えて試すことと、実装・保守の手間が小さいことは別**である。

### 6.3 GitHub上のFork表示との関係

本書の「派生・継承」は技術的・権利的な由来を指す。GitHub画面のForkボタンで最新treeを丸ごと取得・公開することを必須にしない。

推奨は、Aの正確な版を固定し、採用対象を確定した新しい作業treeを作る方法である。旧作者の許諾範囲とクレジットを維持する。公開historyや配布物へ後発のProコード、旧認証設定、未監査の素材が混入しないよう点検する。具体的なGit操作は後続のCodexガイドに含める。

実際に元コードを利用した場合は派生元を明示する。コードを全く利用せず知見だけ参照した場合は、「フォーク」と誤認させず参考元として記載する。

## 7. 依存関係・ビルド・テストの評価

### 7.1 依存関係

AのpackageにはTypeScript `^5.4.5`、Obsidian `^1.5.7`、AWS S3 client `^3.563.0`等が記載される。これは当時の要求範囲であり、本プロジェクトでこのまま採用する版ではない。[A-PACKAGE]

Aルートにはnpm/pnpm/yarnのlockfileを確認できなかった。実インストールで得られる正確な依存集合を、このpackageだけから保証できない。Bにはpnpm-lockが存在する点で差があるが、内容の全面監査やpackageとの一致検証は未実施である。[A-ROOT][B-ROOT]

対応は、R2のみの最小依存集合を作り、lockfile、推移的依存一覧、ライセンス、必要な第三者表示を確認すること。暗号化、OneDrive、Dropbox、WebDAV等のための依存を惰性で全部継承しない。`aws-crt`等も、名前があるだけで直ちに脆弱とはせず、採用の必要性と最終bundleへの混入を調べる。

**脆弱性スキャンは未実施であり、「脆弱性ゼロ」も具体的な脆弱性件数も報告しない。**

### 7.2 ビルド・CI

AのBuildCIはNode 16、npm install、npm test、webpack buildという設定で、Git LFSも使用する。Node 16は公式の現在のリリース一覧でEOLである。従ってこのCIをそのまま現行基盤として採用しない。[A-CI][NODE]

webpack設定にはweb向けバンドルと各種browser polyfillがある一方、minify時にコメント抽出を無効化している。配布物の帰属表示が必要な場合、別ファイルで適切に同梱する仕組みを用意する。[A-WEBPACK]

旧ビルドの完全再現は調査用、将来の本体は新しい最小基盤として区別する。元作者のOAuthアプリ設定・secrets・公開先を新OSSに流用しない。

### 7.3 既存テスト

Aのtests treeで確認した`*.test.ts`は、configPersist、encryptOpenSSL、fsWebdis、metadataOnRemote、miscの5ファイルだった。**ファイル数はテストケース数・カバレッジではない。** その一覧だけで、間接的な同期検査が全くないと断言しない。[A-TESTS]

全文を確認したmetadataOnRemote.test.tsは比較関数の試験で、serializeMetadataOnRemoteを呼んでversionの保存を確かめる試験ではなかった。[A-METATEST]

本プロジェクトでは詳細仕様のAT-01〜AT-84を基準に、障害注入・再起動・CAS・SourceSnapshot・ClientStoreまで試験を組み直す。元の試験が通ったというだけで、これらを満たしたと扱わない。

## 8. PR1175の扱い

PR1175は7つの修正を説明している。下表の「内容」は提出者の説明を分類したもので、全部を自分たちで検証・採用したという意味ではない。[PR1175]

| 修正 | 対象 | 今回の扱い |
|---|---|---|
| GDrive/Yandex一覧失敗とデータ消失 | `pro/src/` | コードは取り込まない。一般的な「失敗を不在にしない」要件は自分たちの仕様で実装 |
| Dropbox削除失敗後の復活 | `src/fsDropbox.ts` | R2初期対象外。削除の成功証拠という試験観点だけ残す |
| 競合コピーの別Remoteファイル上書き | `pro/src/conflictLogic.ts` | 取り込まない。名前衝突保護は自分たちの仕様で実装 |
| smart conflictのクラッシュ | `pro/src/sync.ts` | 取り込まない。初期機能にも含めない |
| S3 accurate-mtime HEADキュー | `src/fsS3.ts` | Aに該当構造を確認。新hash方式ではそのキューを継承しない。エラー伝播の試験観点として利用 |
| metadata versionの比較式誤記 | `src/metadataOnRemote.ts` | Aの実ソースで確認。独立モデルでも確認。旧serializerの移植はしない |
| `__MACOSX`の末尾空白 | `src/misc.ts` | 今回Aの該当関数を直接検証していないため、確認済み修正とは扱わない |

DのLICENSEはCと同じ混在方式だった。修正済みブランチがあることによってProコードの許諾が変わるわけではない。[D-LICENSE]

PRを将来取り込む場合も、変更ファイルだけでなく元の関数・依存・寄与条件を確認し、修正前に失敗する試験、修正後の成功、回帰試験をセットにする。今回cherry-pickはしていない。

## 9. 実施した小規模検証

| ID | 実行した検証 | 結果 | 限界 |
|---|---|---|---|
| MODEL-01 | 同じmtimeとサイズで異なる本文を与える | 旧等価式はtrue、本文hashは不同を確認 | 元プラグインの統合試験ではない |
| MODEL-02 | version箇所の比較式と代入式を比較 | 比較式はversionを書き込まない | 元serializerの実呼出し経路・ユーザー影響率は未測定 |
| MODEL-03 | 模擬要求とタイムアウトをPromise.race | 呼出側がtimeoutを受けた後も模擬処理は完了する | 実Obsidian HTTPやR2を使っていない |

実行環境はNode.js v22.16.0。上記3件は期待した観測に一致した。「3件成功」は監査モデルの成功であって、元アプリが安全という認証ではない。

元リポジトリのビルド、npm test、84件の製品受入試験は実施していない。検証モデルはネットワーク・Vault・認証情報に接続せず実行した。

## 10. G-BASEの判定と残件

### 10.1 結果

**候補選定の監査：完了。G-BASEの一括取り込み許可：保留（HOLD）。**

監査結果がHOLDであることは、構想を否定するものではない。「安全上必要な確認を残したまま緑判定を付けない」という運用である。

| 判定項目 | 状況 | 判断材料・残件 |
|---|---|---|
| 正確な継承元commit | 確定 | Aを固定。変更直前の親関係も確認 |
| C/Dの丸ごと利用可否 | 見送りと確定 | Pro依存と混在LICENSE |
| 主要コードと仕様の差分 | 静的評価完了 | Planner、writer、HTTP、metadata等の差を特定 |
| rootと個別素材の境界 | 一部確認済み | branding例外を発見。全ての画像・翻訳・埋込み由来まで確認済みではない |
| 実際にコピーするファイル・関数の台帳 | **未確定** | 参照候補から必要最小限だけ抽出し、全文・import・由来を記録 |
| 最終採用依存物とその利用条件 | **未確定** | 依存を絞った新manifest/lockfile/ライセンス一覧が必要 |
| 元リポジトリのビルド・試験 | 未実施 | 実行可能な開発環境で調査用に実行し、新MVPの試験と区別 |
| 現行R2/Windows/iPhone互換性 | 未実施 | G-R2/G-LOCAL/G-CLIENT-STATE等の別ゲートで検証 |

G-BASEをHOLDにする直接の理由は、**実取り込み集合と依存物の権利・由来をまだ閉じていないこと**である。R2実機試験の未実施だけを理由に、ソース利用のゲートと混同しているわけではない。

### 10.2 次に行う限定作業

G-BASEを閉じる作業は「再び候補を無制限に探す」ことではなく、次の成果物に限定する。

1. **SOURCE_IMPORT_MANIFEST.md**：Aからコピーするファイル／関数を実際に選び、commit、blob SHA、行範囲、個別ライセンス、第三者由来、直接import、移植先、変更点を記録する。採用しない候補も理由を残す。コピーするものがほぼない場合は、その事実を明示する。
2. **DEPENDENCY_LICENSE_REVIEW.md**：新MVPで必要な依存だけに絞り、正確な版と全推移的依存の利用条件を確認する。NOTICE・ライセンス添付方法を定義する。旧packageの一括導入を承認しない。
3. **取り込み境界検査**：Pro領域、未確認のsubmodule、branding、元作者用OAuth設定、不要な書込・削除経路が新しい作業tree／bundleへ混入していないことを記録する。

この限定集合について確認が閉じた時点で、G-BASEをその集合に対して合格にできる。将来追加する外部コードまで一括許可はしない。

## 11. その後のステップ

| 順序 | 作業 | 成果物・完了条件 |
|---|---|---|
| 1 | 上記の取り込み台帳・依存境界を確定 | G-BASEを具体的な集合に対して閉じる |
| 2 | Codex引渡し資料を整える | TEST_PLAN.md、CODEX_IMPLEMENTATION_GUIDE.md、ICLOUD_REQUIREMENTS.md、Adapter検証表 |
| 3 | 新仕様の純粋関数とメモリ内モデルを実装 | hash/LRB判定、schema、CAS、journalの試験。実Vault書込なし |
| 4 | 最小Pluginと専用probeでAPIの実現性を確認 | Windows/iPhoneの通信、Local操作、ClientStoreを限定データで試験 |
| 5 | MVP 0.1を統合 | Markdown新規・更新・手動のみ。競合停止、上書き保全、途中終了、exportを試験 |
| 6 | 限定公開・段階拡張 | 公開条件と権利表示を確認。添付・競合UI、確認付き削除、iCloud実装は段階化 |

iCloud要件はStep 2で文書化するが、現在のVaultをR2へ引っ越させない。要件を書くことと、iCloud同期を操作することを分ける。

## 12. 代替案と今回の推奨

| 選択肢 | 良い点 | 不利な点 | 判断 |
|---|---|---|---|
| Aを由来にした選択的継承＋新同期中核 | 合意済み安全仕様を維持し、元の知見を利用できる | 大きめの改修。単純差し替えではない | **今回の推奨** |
| Aの既存プロトコルを維持した小さな保守Fork | 変更範囲を小さくできる可能性 | 詳細仕様v1.0とは別計画。安全性が同等とは限らない | 採用するなら正式な仕様変更が必要 |
| 完全新規のPlugin骨組みから独立実装 | 古い不要依存を排除しやすい | 再実装範囲が増える。元の「Fork」構想とは距離が出る | 抽出の利点が薄いと判明した場合の代替 |
| C/DへPRをまとめて取り込む | 一見すぐ使えるように見える | 許諾問題と新仕様不一致が残る | 採用しない |

本監査では「ゼロから全部作り直すこと」を勝手に確定していない。**Aを継承元にする方針を保ち、取り込み台帳で実際の再利用価値を確認する**。小さなパッチで済まないことは、今の段階で認識を揃える必要がある。

## 13. 元作者への敬意を保つ運営

元作者とContributorの貢献をクレジットし、必要な著作権・ライセンス表示を残す。旧作者の仕事・更新頻度から人格や意図を推測しない。新OSSの目的は安全性と保守性の改善であり、Pro機能の無断無料配布ではない。

不具合を確認した場合も、再現条件と影響範囲を分け、全ユーザーにデータ消失が起きるような表現をしない。元プロジェクトへのPRや連絡は将来の選択肢であり、この監査で勝手に投稿していない。

独立した派生OSSであることと、旧Remoteの互換品ではないことを明示する。作者の売上への影響を完全にゼロにできるとは約束しないが、権利の境界・出自の透明性・非敵対的な説明は自分たちで守れる。

## 14. 監査の最終評価

**進める価値はある。ただし、進めるべきなのは「旧版をそのまま信頼して使うこと」ではなく、「許諾と由来を限定して、必要な安全設計を自分たちで実装・試験すること」である。**

確信度：高 — 固定commit、LICENSE境界、確認したコードの判定・書込方式、モデルでの論理確認。

確信度：中 — Aの選択的継承が最終的な開発負担を最小にするという評価。最終的な抽出量・依存削減・ビルドと実機試験の結果で再評価する。

不明 — 現在のWindows/iPhoneでの動作成功率、元コードの全脆弱性、将来の保守工数、実利用での不具合発生頻度。推測で数値を置かない。

---

## 参照資料

固定commitのソースリンクを優先する。本文全体を読んでいないファイルの範囲とGit blob SHAは[監査証跡](BASE_REPOSITORY_AUDIT_EVIDENCE.md)に記録した。巨大な再帰treeの途中表示を、全ファイルの精査完了と扱わない。

[A-COMMIT]: https://github.com/remotely-save/remotely-save/commit/08027677267934d3a1ca6f6e3cf06ee1be53ee52
[A-TRANSITION]: https://github.com/remotely-save/remotely-save/commit/06dad54d4ceac0ed0b2343a9e71ed57b09434400
[A-ROOT]: https://api.github.com/repos/remotely-save/remotely-save/git/trees/27351962f7e4779524195535a557fce6e8e2c2fb
[A-SRC]: https://api.github.com/repos/remotely-save/remotely-save/git/trees/54ed2a1731e60beb8134146cb7783b6c0850cc30
[A-LICENSE]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/LICENSE
[A-ASSET]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/assets/branding/LICENSE.txt
[A-PACKAGE]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/package.json
[A-MAIN]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/main.ts
[A-SYNC]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/sync.ts
[A-S3]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/fsS3.ts
[A-LOCAL]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/fsLocal.ts
[A-META]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/metadataOnRemote.ts
[A-CONFIG]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/configPersist.ts
[A-CI]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/.github/workflows/auto-build.yml
[A-WEBPACK]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/webpack.config.js
[A-TESTS]: https://api.github.com/repos/remotely-save/remotely-save/git/trees/c5761cf1727383727d2a2243e17881233b747236?recursive=1
[A-METATEST]: https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/tests/metadataOnRemote.test.ts
[B-COMMIT]: https://github.com/sboesen/remotely-sync/commit/21a9e0145260dc409a9720930565f267380a56d5
[B-ROOT]: https://api.github.com/repos/sboesen/remotely-sync/git/trees/994173b5d8d7e9f24ba8284c11c705bb410a6ba3
[B-README]: https://github.com/sboesen/remotely-sync/blob/21a9e0145260dc409a9720930565f267380a56d5/README.md
[B-PACKAGE]: https://github.com/sboesen/remotely-sync/blob/21a9e0145260dc409a9720930565f267380a56d5/package.json
[B-S3]: https://github.com/sboesen/remotely-sync/blob/21a9e0145260dc409a9720930565f267380a56d5/src/remoteForS3.ts
[B-SUBMODULE]: https://github.com/sboesen/remotely-sync/blob/21a9e0145260dc409a9720930565f267380a56d5/.gitmodules
[B-SRC]: https://api.github.com/repos/sboesen/remotely-sync/git/trees/7da57af7dd08ec29c65299d1ede42c794c2b5c73
[C-COMMIT]: https://github.com/remotely-save/remotely-save/commit/34db181af002f8d71ea0a87e7965abc57b294914
[C-LICENSE]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/LICENSE
[C-MAIN]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/main.ts
[PR1175]: https://github.com/remotely-save/remotely-save/pull/1175
[D-LICENSE]: https://github.com/superabe/remotely-save/blob/283cb34619aa54370c0f5d3485b69c4e41ff3785/LICENSE
[L-APACHE]: https://www.apache.org/licenses/LICENSE-2.0
[L-POLYFORM]: https://polyformproject.org/licenses/strict/1.0.0
[R2-API]: https://developers.cloudflare.com/r2/api/s3/api/
[NODE]: https://nodejs.org/en/about/previous-releases

## 変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 1.0 | 2026-09-06 | 固定4候補の比較、選択的継承の推奨、主要技術所見、個別素材のライセンス訂正、G-BASEの未完了範囲と次工程を記録 |

この監査書はソフトウェアの安定版・安全保証・全権利保証ではない。次回の実装検証で監査結果が変わった場合は、根拠を記録して版を更新する。
