---
title: "MVP 0.1 テスト計画と後続段階の受入試験"
version: "1.0"
date: 2026-09-06
status: "Ready for Implementation / Product Not Implemented"
document_type: "test-plan"
production_use_approved: false
tags: [obsidian, oss, codex, handoff, mvp01]
---

# MVP 0.1 テスト計画と後続段階の受入試験

> **結論：84件すべてを実行可能な試験手順へ展開した。MVP 0.1に必要なのは67件だが、現時点では製品の実装試験は全件NOT_RUNである。**

## 1. 正本・試験レベル・完了条件

[詳細仕様v1.0](obsidian_sync_oss_detailed_spec_v1.0_20260906.md)の付録Bを正本とし、機械可読catalogは`fixtures/ACCEPTANCE_TESTS.json`。各ATの原条件・期待値・段階・元行番号を保存した。84件中、0.1対象67件、後続専用17件。今回用意したfixtureはテスト入力であり、通過した製品テストではない。

| レベル | 実行場所 | 証明すること | 証明しないこと |
|---|---|---|---|
| model | Node + fake I/O/time | 判定、状態遷移、失敗の伝播、操作順 | 実R2・Obsidianの原子的処理 |
| windows / iphone | 実Obsidian + 使い捨てVault | ファイルAPI、保存状態、プロセス中断の挙動 | 他OS/全バージョンの対応 |
| real-r2/windows / real-r2/iphone | 各実端末 + 専用Remote | ETag条件、署名、Range、実通信経路 | 別バックエンド、全障害の発生率 |

catalogのlevelsは必要な証拠の種類である。R2が意図的に不正なRangeを返すような試験は、本物のR2設定を壊して作らない。実R2の正常契約証拠と、同じ実機Transportに制御した偽応答を入力した負試験を組み合わせる。偽secretを使い、第三者サイトへ本物の資格情報を送らない。

**AT完了条件**：要求レベルの証拠がそろい、独立した期待値と一致し、関連する安全規則に反例がないこと。全ケースに共通して、実装commit/lock・入力hash・注入位置・Local/Remote/checkpoint/journalの前後差分を記録する。

## 2. 共通ハーネス契約

純粋なドメイン型とAdapter契約を介し、productionとmodelで同じPlanner/Executorを使う。テストだけが別の安全なアルゴリズムを通る設計は禁止する。

- `FakeClock`：monotonicとwall clockを分離し、sleepを実時間待機にしない。
- `DeterministicIdSource`：固定の有効UUID v4列を返す。productionの乱数に流用しない。
- `MemoryObjectStore`：内容別blob、manifest、commitとheadを持ち、ETag条件確認と更新を同じ不可分ステップで行う。単なる存在確認と後の上書きに分解しない。
- `MemoryLocalStore`：expected bytes一致時だけ適用。新規作成は既存を置換しない。create/update/receiptの間に障害を注入できる。
- `MemoryStateStore`：durableな保存済み領域とvolatileな処理中状態を分ける。restartで後者だけ捨てる。全状態を都合よく再構築しない。
- `MemoryClientStore`：Vaultとは別の保存領域。VaultコピーとClientStoreコピーを別操作にする。
- `FaultScheduler`：名前付き注入点でpromiseをhold/resolve/reject、1バイト変更、process終了、保存失敗、context切替を再現する。
- `OperationTrace`：GET/HEAD/LIST/条件付きPUT、Local create/apply、recovery、journal、baselineの開始/結果を順序番号で記録。本文・secretを共有用ログへ含めない。

I/O失敗は`[]`/null/不在へ変換せず型付きエラーにする。MemoryモデルのCAS成功をG-R2の証拠にはしない。

## 3. fixtureと期待値

`fixtures/bytes/`は実物の合成バイト列。catalogのF-*は状態を組み立てる**レシピ**であり、既に動くfactory実装ではない。CodexはWP-01以降でfactoryを実装する。

初期共有状態S0：n.md=A、Local/Remote/baselineが一致。Remoteはgeneration0の空初期化からgeneration1へ正当に追加された履歴、正しいparent hash/ID、別々の端末マーカーを持つ。基準時刻は`2026-09-06T00:00:00.000Z`。時刻は新旧判断には使わない。

期待hashはfixture一覧にある固定値を用いる。期待JSONや選択結果は手書きのgoldenまたは独立手段で作り、検査対象関数を呼んだ結果をそのまま期待値に使わない。大きな件数・容量は仮想counterで境界検査し、別に少量の実割当で実I/Oを確認する。

元fixtureを変更しない。異常入力はrunごとの一時コピーへ注入する。実ユーザーのノート・個人情報・認証情報をfixtureにしない。

### 実バイト列一覧

| ファイル | バイト数 | SHA-256 |
|---|---:|---|
| `A.bin` | 2 | `06f961b802bc46ee168555f066d28f4f0e9afdf3f88174c1ee6f9de004fc30a0` |
| `B.bin` | 2 | `c0cde77fa8fef97d476c10aad3d2d54fcc2f336140d073651c2dcccf1e379fd6` |
| `C.bin` | 2 | `12f37a8a84034d3e623d726fe10e5031f4df997ac13f4d5571b5a90c41fb84fe` |
| `D.bin` | 2 | `7c447aa2524264a3e24df73a6fddd8db360840f895bcb5e54d643c18de26a8ae` |
| `empty.bin` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `crlf.bin` | 3 | `26ffd5886253906a36a7ea0f6e26056fc36472626cb4894bcb100a34dc69d1db` |
| `bom-ja.bin` | 10 | `d85695f624b1c66732adaac4ea04f4f72951fed143d644659fa73b3568fbea74` |
| `non-bmp.bin` | 11 | `cbb4910ac26480100877f4ec5fa075cca6a5b8338d0525b3cb7ead62fbb16eff` |
| `combining.bin` | 4 | `f979a211b00b61497349a7c753652a3d173550a368711a9f9f9845e6383db7cb` |
| `invalid-utf8.bin` | 2 | `eddf68639913a3cb8331cdfe7f87559e0beccf2c289c0d90ac4d89b3204004f8` |
| `nul-text.bin` | 4 | `3a100994c4e38751871e6e8eef9adad2b20177fdeaf650daacdcd74f4c9421e3` |

### 状態レシピ一覧

| ID | 構成 |
|---|---|
| F-EQUAL | S0: n.mdのL/R/BはA。Remoteは有効なgen1 head/commit/manifest/blob。両clientは独立したidentity。 |
| F-LOCAL-EDIT | S0からLocalのみBへ。Remote・baseline=A。 |
| F-REMOTE-EDIT | S0から別clientがRemote=Bを正当にgen2へ公開。検査clientのLocal/baseline=A。 |
| F-DIVERGED | S0からLocal=B、Remote=C。共通基準A。 |
| F-EQUAL-EDIT | S0から両方Bへ別々に変更。mtimeは故意に不同。 |
| F-EMPTY-JOIN | RemoteにA。Local空、baselineなし、ClientStore新規。 |
| F-NO-BASE-CONFLICT | Remote n.md=A、Local n.md=B、baselineなし。 |
| F-EMPTY-REMOTE | 専用prefixは本当に空。LocalはA。両clientに初期化用IDと別operation ID。 |
| F-LOCAL-ABSENT | S0のLocalだけ不在。UNREADABLEやEXCLUDEDとは区別する。 |
| F-TWO-PATHS | gen1: a.md=A,b.md=A。PとQは独立baseline/ClientStore。変更は別pathにも同pathにも適用可能。 |
| F-FUTURE-CAPABILITY | S0のhashが整合するhead/manifestにunknown-future-v9を加える。known future機能は段階別に用意。 |
| F-PAGED | LIST MaxKeys=1、2ページ以上。継続token、有効空ページ、不正token/繰返しtoken、途中failureの各variant。 |
| F-TAMPER | 有効なS0または公開予定不変objectのbytesを1箇所変更。参照hash/ETagはvariantに従い保持する。 |
| F-PATHS | ../x.md、/x.md、C:/x.md、UNC、NUL、backslash、CON.md、末尾space/dot、Docs/a.md対docs/b.md、a.md対a.md/b.md、NFC/NFKC衝突、内部dir別case、%20.md、_memo.md。正常2例も対照。 |
| F-CHECKPOINT | 有効a(sequence=1)、有効b(sequence=2)、対応journal/ClientStore。破損・分岐・足りない証拠を変種で作る。 |
| F-JOURNAL | sequence1..nの連続hash鎖とClientStore下限。最後の予約済未保存、中間欠落、同番号別eventの変種。 |
| F-HISTORY | 正当gen0..n親鎖をfactoryで作る。観測anchor、別分岐、同generation別commit、循環、飛びのvariant。 |
| F-DELETED | 0.3専用。A→更新B→tombstone d→復元xと親revision鎖、Live/Deleted baselineのDT表全状態。0.1では未知機能として拒否。 |
| F-CONFLICT-COPY | 0.2専用。L=B,R=C,基準A。元pathと決定的conflictId path、既存同内容/別内容のvariant。 |
| F-DELETE-COUNTS | N,D=(0,0),(1,1),(10,4),(100,9),(100,10),(2000,100),(500,49),(500,50)、負/小数/D>N。0.3専用。 |
| F-BYTES | body-fixtures.jsonに列挙した実バイト列。内容の正規化は禁止。 |
| F-API-CAPS | required API能力のbool-map。各1能力だけfalse、全true、probe未実施、stale証跡のvariant。 |
| F-BINARY | 0.2専用、PNG風ではなく0..255の決定的テストバイト列。既存版/新版、10MiB境界をfactoryで生成。 |
| F-LIMITS | 詳細§2.7/§6.12/§8.9の各上限についてlimit-1/limit/limit+1。大容量は仮想カウンタで検査し、不要な実割当をしない。 |
| F-RESPONSES | HTTP 200/206/400/401/403/404/408/412/429/500/502/503/504、signed bytes、ETag引用符、長さ、Retry-After、Rangeの正常/異常応答。実secretなし。 |
| F-DESTINATIONS | accountIdは0を32個、bucket=test-only-bucket、認証はTEST_ONLY_*。R2偽サフィックス、port、user-info、query/fragment、redirectを模擬。 |
| F-POLICY | 期限削除予定、storage class=STANDARD_IA、兆候なしと確認未了/確認済の組合せ。実bucketのポリシーは変更しない。 |
| F-CLONED | Vault内stateをclient2へ複製し、ClientStoreは別/不在/複製/アクセス例外にする。物理端末IDは利用しない。 |
| F-UNKNOWN-INTERNAL | 既存の.svsync-state/.svsync-recovery内に所有者不明のfixtureを置く。通常fileとdirのvariant。 |


F-JSONは、`fixtures/raw-json/`の重複キー・17段ネスト・非正規JSON・単独サロゲートを使用する。正常な正規JSONも対照とする。

## 4. 注入点と不変条件

少なくともscan、plan確定、承認、source freeze、recovery保存/検証、各blob PUT/GET、manifest保存、commit保存、head送信/採用/応答、Local適用前/後、receipt前/後、checkpoint、ClientStore sequence予約、journal保存の境界で終了/障害を入れる。

成功終了しか試さないテストはG-RESTARTを満たさない。`try/finally`やunload callbackが必ず動く前提を置かず、強制終了モデルではcallbackを実行しない。

**全ケース共通オラクル**：元Local bytes、Remote headとその参照、不変物の存在/内容、baselineの因果証拠、journal鎖を前後比較する。安全停止を期待するケースは「エラー名が出た」だけでなく、禁止された副作用の回数が0であることまで検査する。

## 5. 実行順とコマンド

既存部品確認はルートで`node tools/preflight.mjs`。WP-01以降はworkspaceで`npm test`、`npm run check:boundary`。`npm run test:product`は新規のunit/acceptance試験だけを実行し、一件もなければ失敗する。**空テスト集合をPASSと扱わない。**

順番はbytes/path/schema → Planner → CAS/Remoteモデル → journal/checkpoint → Executor/Restart → 実API契約 →統合/移行とする。初期には後続専用17件を実装しないが、capability拒否と物理削除経路0は初期から確認する。

ATごとの結果は`progress/acceptance/AT-xx.json`へ、テンプレート`templates/acceptance-result.json`を基準に記録する。catalogの`test_file`は予定の命名であり、現時点でそのファイルが存在する意味ではない。

## 6. 個別試験手順

以下の「期待」は詳細仕様の原文、手順/追加検査は今回の展開である。各ケースは未実行。異常入力の具体的な値はfixtureレシピと組み合わせる。

### AT-01 — L/R/Bが同じ

**段階**：0.1。**担当スイート**：planner。**状態**：NOT_RUN。

**fixture**：F-EQUAL。**注入点**：none。

**手順**：S0でL/R/Bを一致させてplan、承認、runを実行する。

**期待（元仕様）**：本文・headを書き換えない

**追加の検査**：業務本文書込0、Remote PUT0、commit/revisionの新規発行0。状態NO_CHANGES。

**必要レベル**：model。元仕様の行番号：1789。

### AT-02 — Lだけ変更

**段階**：0.1。**担当スイート**：executor。**状態**：NOT_RUN。

**fixture**：F-LOCAL-EDIT。**注入点**：none。

**手順**：AからL=Bだけへ編集し、planを承認してheadをCAS更新する。

**期待（元仕様）**：CASで公開。旧本文・旧manifestが残る

**追加の検査**：RemoteはB、Aのblobと旧manifestを取得可能。baseline=B。無条件PUT0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1790。

### AT-03 — Rだけ変更

**段階**：0.1。**担当スイート**：executor。**状態**：NOT_RUN。

**fixture**：F-REMOTE-EDIT。**注入点**：local.beforeApply。

**手順**：R=B、L=Aの計画を作る。旧Aの保存・読戻し後に条件一致を確認してBを適用する。

**期待（元仕様）**：復旧検証後にLocal更新。内容一致後にbaseline更新

**追加の検査**：recovery=A、Local=B。RECOVERY_READYがLOCAL_APPLY_STARTEDより先。baseline更新に証拠あり。

**必要レベル**：model, windows, iphone, real-r2/windows, real-r2/iphone。元仕様の行番号：1791。

### AT-04 — LとRが別内容へ変更

**段階**：0.1。**担当スイート**：planner。**状態**：NOT_RUN。

**fixture**：F-DIVERGED。**注入点**：none。

**手順**：L=B、R=C、B基準=Aからplanを生成する。

**期待（元仕様）**：両本文を変えず競合停止

**追加の検査**：blockedPathsにn.md、本文/公開head/baseline不変。無関係ノートも転送しない。

**必要レベル**：model。元仕様の行番号：1792。

### AT-05 — 双方が同内容へ変更、時計は逆転

**段階**：0.1。**担当スイート**：planner。**状態**：NOT_RUN。

**fixture**：F-EQUAL-EDIT。**注入点**：clock.skew。

**手順**：L=R=B、基準=Aで両端末の時刻を前後へ逆転して計画する。

**期待（元仕様）**：時刻で競合にせず内容一致として扱う

**追加の検査**：CONFIRM_EQUALとなり、時刻による勝者なし。本文/Remote PUT0、共通版だけ証拠に基づき更新。

**必要レベル**：model。元仕様の行番号：1793。

### AT-06 — 空の新端末から既存Remoteへ接続

**段階**：0.1。**担当スイート**：bootstrap。**状態**：NOT_RUN。

**fixture**：F-EMPTY-JOIN。**注入点**：none。

**手順**：Aを持つRemoteへ、baselineもLocalも空の新しいclientで参加する。

**期待（元仕様）**：Downloadのみ。削除/空manifest上書きゼロ

**追加の検査**：Downloadと新端末の記録だけ。Remote head不変、削除命令0。

**必要レベル**：model, windows, iphone, real-r2/windows, real-r2/iphone。元仕様の行番号：1794。

### AT-07 — 初回に同名・別内容がある

**段階**：0.1。**担当スイート**：bootstrap。**状態**：NOT_RUN。

**fixture**：F-NO-BASE-CONFLICT。**注入点**：none。

**手順**：baselineなし、同名のLocal=BとRemote=Aで参加ウィザードの比較まで進める。

**期待（元仕様）**：一括Local優先/Remote優先を行わない

**追加の検査**：一括優先操作なし、E_CONFLICT、両内容不変。

**必要レベル**：model。元仕様の行番号：1795。

### AT-08 — 既存headを削除した状態で接続

**段階**：0.1。**担当スイート**：bootstrap。**状態**：NOT_RUN。

**fixture**：F-EQUAL。**注入点**：remote.head.missing。

**手順**：既存identityとbaselineを保持してheadだけを欠損させ、同期する。

**期待（元仕様）**：新規初期化せず停止

**追加の検査**：E_REMOTE_HEAD_MISSING、新規世代0の作成なし、全PUT0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1796。

### AT-09 — 403、通信切断、必要なGETの失敗

**段階**：0.1。**担当スイート**：transport。**状態**：NOT_RUN。

**fixture**：F-REMOTE-EDIT。**注入点**：remote.read.fail。

**手順**：head、commit、manifest、必要blobの各GETに403・disconnect・timeoutを別々に注入する。

**期待（元仕様）**：不在に変換しない。破壊的操作ゼロ

**追加の検査**：型付き失敗。[]/nullの正常応答に置換しない。通常書込0。再試行分類一致。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1797。

### AT-10 — 初期化時LISTの2ページ目でエラー

**段階**：0.1。**担当スイート**：bootstrap。**状態**：NOT_RUN。

**fixture**：F-PAGED。**注入点**：remote.list.page2.fail。

**手順**：初期化確認のLISTを2ページに分け、1ページ目空/非空の双方で2ページ目を失敗させる。

**期待（元仕様）**：空判定しない。head作成なし

**追加の検査**：完全一覧を返さず初期化停止。head PUT0。成功した1ページ目だけで空判定しない。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1798。

### AT-11 — baselineのあるLocalファイルだけ不在

**段階**：0.1。**担当スイート**：planner。**状態**：NOT_RUN。

**fixture**：F-LOCAL-ABSENT。**注入点**：none。

**手順**：baseline=A、Remote=A、Localだけ不在として同期する。

**期待（元仕様）**：自動削除も自動復活もせず保留

**追加の検査**：不在候補としてBLOCKED。Remote削除0、Local再作成0、baselineを捨てない。

**必要レベル**：model。元仕様の行番号：1799。

### AT-12 — 二端末が別ファイルを同時公開

**段階**：0.1。**担当スイート**：protocol。**状態**：NOT_RUN。

**fixture**：F-TWO-PATHS。**注入点**：remote.cas.race。

**手順**：client Pはa.mdをBへ、Qはb.mdをCへ。双方H0読後、P公開、Qのstale CASを実行。Qは新計画を再承認する。

**期待（元仕様）**：片方は再計画し、最終manifestに両変更がある

**追加の検査**：Qは412後に再計画し、最終manifestはa=B,b=C。旧H0の強制上書き0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1800。

### AT-13 — 二端末が同じファイルを別内容で同時公開

**段階**：0.1。**担当スイート**：protocol。**状態**：NOT_RUN。

**fixture**：F-DIVERGED。**注入点**：remote.cas.race。

**手順**：PとQが同じn.mdを別内容へ更新。片方のCAS成功後にもう片方を実行する。

**期待（元仕様）**：後続の無条件上書きをせず競合へ

**追加の検査**：後続は再読込後E_CONFLICT。先行内容と後続Localの双方が残る。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1801。

### AT-14 — head PUTは成功、応答だけ失われる

**段階**：0.1。**担当スイート**：restart。**状態**：NOT_RUN。

**fixture**：F-LOCAL-EDIT。**注入点**：remote.head.afterCommit.beforeResponse。

**手順**：headの更新はRemoteへ反映させ、応答のみ失わせてプロセスを作り直す。

**期待（元仕様）**：commitの採用を照合し、重複・失敗扱いを避ける

**追加の検査**：祖先またはtipで同じcommitを証明。二重revisionや別操作を作らない。照合前Local更新0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1802。

### AT-15 — 未知の必須capabilityを受信

**段階**：0.1。**担当スイート**：schema。**状態**：NOT_RUN。

**fixture**：F-FUTURE-CAPABILITY。**注入点**：none。

**手順**：未知capabilityを持つhead/manifestを正常ハッシュで用意する。

**期待（元仕様）**：Local/Remote/baselineの変更なし

**追加の検査**：E_FORMAT_UNSUPPORTED、Local/Remote/baseline不変。診断以外の転送なし。

**必要レベル**：model。元仕様の行番号：1803。

### AT-16 — 復旧用コピーの書き込み/読み戻し失敗

**段階**：0.1。**担当スイート**：recovery。**状態**：NOT_RUN。

**fixture**：F-REMOTE-EDIT。**注入点**：recovery.write.fail, recovery.verify.fail。

**手順**：復旧本文書込失敗と読戻しhash不一致を独立に注入する。

**期待（元仕様）**：対象ノートの更新・退避ゼロ

**追加の検査**：E_RECOVERY_WRITE。対象更新0、先行するRemote公開も0。失敗を復旧済みにしない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1804。

### AT-17 — Local更新直後、checkpoint前に終了

**段階**：0.1。**担当スイート**：restart。**状態**：NOT_RUN。

**fixture**：F-REMOTE-EDIT。**注入点**：local.afterApply.beforeReceipt。

**手順**：LocalをBへ更新した直後に終了し、receipt/checkpointなしで再起動する。

**期待（元仕様）**：再起動後に内容照合し、盲目的に再上書きしない

**追加の検査**：現物Bを検証して補完証拠を作るか停止。Aで上書きしない。新しい変更には触らない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1805。

### AT-18 — blobまたはmanifestの1バイトを変更

**段階**：0.1。**担当スイート**：schema。**状態**：NOT_RUN。

**fixture**：F-TAMPER。**注入点**：remote.read.corrupt。

**手順**：blobとmanifestそれぞれ1バイト改変する。参照hashは改変前のまま。

**期待（元仕様）**：ハッシュ不一致として停止

**追加の検査**：E_CHECKSUMまたは先行schema拒否。head公開とLocal書込0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1806。

### AT-19 — 正常な0バイトMarkdown

**段階**：0.1。**担当スイート**：bytes。**状態**：NOT_RUN。

**fixture**：F-BYTES。**注入点**：none。

**手順**：empty.binの0バイトを新規Upload/Downloadとして往復する。

**期待（元仕様）**：不在扱いせず同期できる

**追加の検査**：0バイトのLIVEとして保持。不在ではない。0長Rangeは作らない。

**必要レベル**：model, windows, iphone, real-r2/windows, real-r2/iphone。元仕様の行番号：1807。

### AT-20 — `../`、絶対パス、別ケース名、Unicode衝突

**段階**：0.1。**担当スイート**：paths。**状態**：NOT_RUN。

**fixture**：F-PATHS。**注入点**：none。

**手順**：危険パス・予約名・別ケース・NFC/NFKC衝突を独立入力する。

**期待（元仕様）**：Vault外書き込み・既存別ファイル上書きゼロ

**追加の検査**：E_PATH_UNSAFE/E_PATH_COLLISION、Vault外操作0、既存内容不変、自動改名0。

**必要レベル**：model, windows, iphone。元仕様の行番号：1808。

### AT-21 — `.obsidian`と変更されたconfigDirをRemoteから指定

**段階**：0.1。**担当スイート**：paths。**状態**：NOT_RUN。

**fixture**：F-PATHS。**注入点**：none。

**手順**：configDir=.privatecfgとして、.obsidianと実configDir以下へのRemote参照を投入する。

**期待（元仕様）**：同期対象から保護し書き込まない

**追加の検査**：両領域へ書込0。保護対象を不在/削除候補にしない。エラー/対象外の表示あり。

**必要レベル**：model, windows, iphone。元仕様の行番号：1809。

### AT-22 — checkpoint片方/両方を破損

**段階**：0.1。**担当スイート**：recovery。**状態**：NOT_RUN。

**fixture**：F-CHECKPOINT。**注入点**：checkpoint.corrupt。

**手順**：新しい片方だけ、両方、checksum不一致を独立試験する。

**期待（元仕様）**：古い正常版だけで書き込まず、journal/ClientStoreの証拠で補完または停止

**追加の検査**：journal/ClientStoreで補完証明できる場合のみ回復。それ以外は停止、空baselineを作らない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1810。

### AT-23 — tombstone到着前にLocalを編集

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：none。

**手順**：削除前AのbaselineがあるLocalをBへ編集してからtombstoneを読む。

**期待（元仕様）**：内容を保持し削除対編集の競合

**追加の検査**：DT-02、元Local=Bを保持し競合。退避/削除/自動復活なし。

**必要レベル**：model。元仕様の行番号：1811。

### AT-24 — 大量削除の境界値を投入

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETE-COUNTS。**注入点**：none。

**手順**：N,Dの全境界対を判定する。0/0、不正整数、D>Nも含める。

**期待（元仕様）**：D/Nの定義どおり追加承認を要求

**追加の検査**：通常承認必須。massDelete/allDeleteは仕様式と一致し追加承認。入力不正を0に丸めない。

**必要レベル**：model。元仕様の行番号：1812。

### AT-25 — 大きな削除計画を内部で分割

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETE-COUNTS。**注入点**：plan.partition。

**手順**：大きな一ユーザー操作を下位batchへ分けて実行しようとする。

**期待（元仕様）**：元の操作集合でガードし回避できない

**追加の検査**：元plan全体のD/Nで停止。小batch化で承認を迂回しない。

**必要レベル**：model。元仕様の行番号：1813。

### AT-26 — 長期オフライン端末に古いファイルが残る

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：client.offline。

**手順**：古いAを持つ端末を長期オフラインとし、その間のtombstoneを保持して再参加させる。

**期待（元仕様）**：tombstoneを保持し、無断復活しない

**追加の検査**：削除履歴が残り、Aを無断Uploadしない。必要な履歴確認または競合停止。

**必要レベル**：model。元仕様の行番号：1814。

### AT-27 — 接続先bucket/prefix/epochを変更

**段階**：0.1。**担当スイート**：bootstrap。**状態**：NOT_RUN。

**fixture**：F-EQUAL。**注入点**：connection.change。

**手順**：bucket/prefix/epochを一つずつ変更して設定保存し、旧planで実行を試す。

**期待（元仕様）**：旧baselineを使わず再接続へ

**追加の検査**：旧baselineを新Remoteへ流用しない。E_APPROVAL_STALE/再接続が必要。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1815。

### AT-28 — 同じ競合解消処理を繰り返す

**段階**：0.2。**担当スイート**：conflict。**状態**：NOT_RUN。

**fixture**：F-CONFLICT-COPY。**注入点**：executor.replay。

**手順**：同じL/R/Bの解消計画を実行し、再起動後に同じ処理を要求する。

**期待（元仕様）**：同内容のコピーを再利用し増殖しない

**追加の検査**：同内容同名コピーを再利用し、毎回新コピーを増やさない。証拠を確認。

**必要レベル**：model。元仕様の行番号：1816。

### AT-29 — 競合コピーの保存先に別内容がある

**段階**：0.2。**担当スイート**：conflict。**状態**：NOT_RUN。

**fixture**：F-CONFLICT-COPY。**注入点**：path.occupied。

**手順**：予定保存先へ無関係なCを置いてから競合解消を計画/実行する。

**期待（元仕様）**：既存を残して別名保存

**追加の検査**：Cは不変。計画前は別名、承認後に発見したら再計画・再承認。

**必要レベル**：model。元仕様の行番号：1817。

### AT-30 — Vault.process直前にLocalを書き換える

**段階**：0.1。**担当スイート**：local。**状態**：NOT_RUN。

**fixture**：F-REMOTE-EDIT。**注入点**：local.beforeApply。

**手順**：復旧A作成後、process callbackの直前にLocal=Cへ変更する。

**期待（元仕様）**：期待内容と不一致を検知して中止

**追加の検査**：E_LOCAL_CHANGED、Cを保持しBで上書きしない。復旧Aは残す。

**必要レベル**：model, windows, iphone。元仕様の行番号：1818。

### AT-31 — 通常同期のAPI呼び出しを監視

**段階**：0.1〜0.3。**担当スイート**：boundary。**状態**：NOT_RUN。

**fixture**：F-EQUAL。**注入点**：all.operations。

**手順**：全対象段階の全同期ケースでLocal/Remote操作トレースを収集する。

**期待（元仕様）**：物理削除APIが呼ばれない

**追加の検査**：Remote物理DELETEと通常Vault永久削除0。0.1ではtombstone・退避の実行経路も0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1819。

### AT-32 — iPhoneで必要API・依存ライブラリが使えない

**段階**：0.1。**担当スイート**：platform。**状態**：NOT_RUN。

**fixture**：F-API-CAPS。**注入点**：capability.missing。

**手順**：必要なWeb/API能力を一つずつ未対応にし、実iPhone記録と突き合わせる。

**期待（元仕様）**：書き込みゲートを閉じる。PCエミュレーションのみで合格にしない

**追加の検査**：能力未成立ならwriteGate=false。PC模擬のみの結果をiPhone合格にしない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1820。

### AT-33 — 未検証のバイナリ上書き経路を実行

**段階**：0.2。**担当スイート**：attachment。**状態**：NOT_RUN。

**fixture**：F-BINARY。**注入点**：local.binaryReplace.unsupported。

**手順**：既存バイナリの置換能力をfalseとして別内容の添付を同期要求する。

**期待（元仕様）**：元パスを変えずコピー/保留へ

**追加の検査**：元パス不変。確認済み別名保存か保留。0.1では対象外。

**必要レベル**：model。元仕様の行番号：1821。

### AT-34 — API数・保存量・ローカル容量の上限へ到達

**段階**：0.1。**担当スイート**：limits。**状態**：NOT_RUN。

**fixture**：F-LIMITS。**注入点**：budget.exhausted。

**手順**：API回数/Remote保存量/Local管理上限に境界値を与える。

**期待（元仕様）**：新操作を停止し、確定済み状態を記録

**追加の検査**：新通常操作停止、確認済み証拠を最終化。復旧物を空けるために削除しない。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1822。

### AT-35 — 端末時計を進める/戻す

**段階**：0.1。**担当スイート**：planner。**状態**：NOT_RUN。

**fixture**：F-DIVERGED。**注入点**：clock.skew。

**手順**：同じ本文状態に対してmtimeとwall clockを正負方向に変更する。

**期待（元仕様）**：mtimeでデータを捨てない

**追加の検査**：L/R/Bの判定は不変。署名時刻誤差エラーを内容の新旧へ流用しない。

**必要レベル**：model。元仕様の行番号：1823。

### AT-36 — iPhone中断後、旧通信が遅れて完了

**段階**：0.1。**担当スイート**：restart。**状態**：NOT_RUN。

**fixture**：F-LOCAL-EDIT。**注入点**：run.cancel.beforeLateResponse。

**手順**：PUTを保留しrunを中断、generationを進めた後に旧応答を解放する。

**期待（元仕様）**：古いコールバックからLocal/baselineを変更しない

**追加の検査**：旧callbackのLocal/baseline書込0。Remoteの採用可能性はpending照合へ残す。

**必要レベル**：model, windows, iphone。元仕様の行番号：1824。

### AT-37 — journalの破損・連番欠落

**段階**：0.1。**担当スイート**：recovery。**状態**：NOT_RUN。

**fixture**：F-JOURNAL。**注入点**：journal.corrupt。

**手順**：中間/末尾の連番欠落、previous hash不一致、同sequence異内容を投入する。

**期待（元仕様）**：自動再開せず要確認

**追加の検査**：E_JOURNAL_INVALID、自動再開/空履歴化0。診断を保存。

**必要レベル**：model, windows, iphone。元仕様の行番号：1825。

### AT-38 — 複数blobの途中でPUT/検証を失敗

**段階**：0.1。**担当スイート**：protocol。**状態**：NOT_RUN。

**fixture**：F-TWO-PATHS。**注入点**：remote.blob2.fail。

**手順**：複数Upload中の2つ目のPUT/検証GETを失敗させる。

**期待（元仕様）**：未完成manifestをheadから公開しない

**追加の検査**：未完成一覧をhead公開しない。保存済み不変blobは残り勝手に削除しない。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1826。

### AT-39 — Content-Lengthと実データ長が違う

**段階**：0.1。**担当スイート**：transport。**状態**：NOT_RUN。

**fixture**：F-RESPONSES。**注入点**：response.length.mismatch。

**手順**：HEAD/GET/Rangeで宣言長より短い/長い本文を返す。

**期待（元仕様）**：解析・適用を拒否

**追加の検査**：E_RESPONSE_LIMIT、JSON解析やLocal適用へ渡さない。

**必要レベル**：model, windows, iphone, real-r2/windows, real-r2/iphone。元仕様の行番号：1827。

### AT-40 — 観測済みより古いheadを取得

**段階**：0.1。**担当スイート**：protocol。**状態**：NOT_RUN。

**fixture**：F-HISTORY。**注入点**：remote.history.rollback。

**手順**：観測アンカーより古いgenerationのheadを返す。

**期待（元仕様）**：履歴異常として書き込み停止

**追加の検査**：E_REMOTE_HISTORY_CHANGED。旧状態へLocalを戻さず書込0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1828。

### AT-41 — 受信対象ノートがエディタで開いている

**段階**：0.1。**担当スイート**：local。**状態**：NOT_RUN。

**fixture**：F-REMOTE-EDIT。**注入点**：local.editor.open。

**手順**：受信対象を開いたタブを残す。閉じるまで延期し、閉じた後にさらにLocal=Cへ変更する。

**期待（元仕様）**：更新を延期し、閉じた後も再照合する

**追加の検査**：開いている間は適用0。閉じた後も再比較し古いB更新を盲実行しない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1829。

### AT-42 — manifestとblobからテストVaultをエクスポート

**段階**：0.1。**担当スイート**：export。**状態**：NOT_RUN。

**fixture**：F-TWO-PATHS。**注入点**：none。

**手順**：固定manifest/blobから新しい空テスト出力へエクスポートする。

**期待（元仕様）**：通常ファイルとして元バイト列を再現できる

**追加の検査**：相対パスと元bytes一致。metadataを通常ノートへ混ぜない。Remote書込0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1830。

### AT-43 — ローカル退避の直前/直後に別編集が入る

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：local.beforeMove, local.afterMove。

**手順**：退避の直前と直後の二つの試験に分け、別内容Bを元パスまたは退避先に発生させて再照合する。

**期待（元仕様）**：新内容も残し、補償復元/要確認へ

**追加の検査**：新内容も保持。非上書き補償復元またはDELETE_EDIT_RACEで停止。

**必要レベル**：model。元仕様の行番号：1831。

### AT-44 — 同じprefixを二端末が同時初期化

**段階**：0.1。**担当スイート**：bootstrap。**状態**：NOT_RUN。

**fixture**：F-EMPTY-REMOTE。**注入点**：remote.initialization.race。

**手順**：同一prefixを2端末が空と観測し、同時にgeneration0を公開する。

**期待（元仕様）**：headは条件付きで一方だけ採用。強制上書きなし

**追加の検査**：If-None-Matchでheadは一方のみ採用。412側は再読込、無条件上書き0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1832。

### AT-45 — 別端末へstateを含むVaultをコピー

**段階**：0.1。**担当スイート**：identity。**状態**：NOT_RUN。

**fixture**：F-CLONED。**注入点**：client.clone。

**手順**：stateを含むVaultだけを別clientへコピー。ClientStoreは別のまま。

**期待（元仕様）**：ClientStoreマーカー不一致で停止。物理端末完全識別とは表示しない

**追加の検査**：E_CLIENT_IDENTITY。旧pendingを再生しない。完全な端末複製検出は保証しない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1833。

### AT-46 — 429に長いRetry-Afterを設定

**段階**：0.1。**担当スイート**：retry。**状態**：NOT_RUN。

**fixture**：F-RESPONSES。**注入点**：response.retryAfter。

**手順**：429に秒形式/HTTP-date形式のRetry-Afterを与える。残run予算を超える値も含める。

**期待（元仕様）**：短縮して再送せず、予算超過なら延期

**追加の検査**：待機を短縮しない。上限超過なら延期、同じ要求の無限再送なし。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1834。

### AT-47 — 保存したJSONに重複キー・過大ネストがある

**段階**：0.1。**担当スイート**：schema。**状態**：NOT_RUN。

**fixture**：F-JSON。**注入点**：none。

**手順**：duplicate-keys.jsonとtoo-deep.json、未知キー、非正規JSONを受信する。

**期待（元仕様）**：正規形式/スキーマ検査で拒否

**追加の検査**：正規形式/実行時schemaを拒否。過大ネストを危険な再帰処理へ渡さない。

**必要レベル**：model。元仕様の行番号：1835。

### AT-48 — 不変オブジェクトの同じキーに別内容がある

**段階**：0.1。**担当スイート**：protocol。**状態**：NOT_RUN。

**fixture**：F-TAMPER。**注入点**：remote.immutable.occupied。

**手順**：不変keyが別内容で既存のためPUTが412になる。

**期待（元仕様）**：412後に検査し、無条件上書きしない

**追加の検査**：GETで照合し不一致停止。既存bytesを置換しない。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1836。

### AT-49 — Upload Bの応答待ちにLocalをCへ編集

**段階**：0.1。**担当スイート**：restart。**状態**：NOT_RUN。

**fixture**：F-LOCAL-EDIT。**注入点**：remote.head.beforeResponse。

**手順**：Local=Bを固定送信し、応答待ちにLocal=Cへ追記してから成功を返す。

**期待（元仕様）**：Bの公開証拠でbaseline=B、Local=Cを保持してdirty

**追加の検査**：baselineは公開B、Local=Cのままdirty。baseline=AのままにもLocal=B戻しにもならない。

**必要レベル**：model, windows, iphone, real-r2/windows, real-r2/iphone。元仕様の行番号：1837。

### AT-50 — 自分のcommit公開後、他端末がさらに更新

**段階**：0.1。**担当スイート**：restart。**状態**：NOT_RUN。

**fixture**：F-HISTORY。**注入点**：remote.afterOwnCommit。

**手順**：自分のcommit採用直後に別端末が次commitを公開してから処理を再開する。

**期待（元仕様）**：採用履歴を確認し旧Local計画を再生せず最新で再計画

**追加の検査**：自分の証拠は確定。旧Local操作は再生せず最新headで再計画・再承認。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1838。

### AT-51 — Download適用レシート後にLocalを追加編集

**段階**：0.1。**担当スイート**：restart。**状態**：NOT_RUN。

**fixture**：F-REMOTE-EDIT。**注入点**：local.afterReceipt。

**手順**：B適用の永続receipt後、Local=Cへ編集する。

**期待（元仕様）**：適用版の共通履歴を保持し、追加入力を上書きしない

**追加の検査**：共通履歴Bを証明しCを保持。現在内容不一致だけでB適用履歴を否定しない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1839。

### AT-52 — Download途中終了、レシートなし、Localは第三の版

**段階**：0.1。**担当スイート**：restart。**状態**：NOT_RUN。

**fixture**：F-REMOTE-EDIT。**注入点**：local.afterApply.beforeReceipt。

**手順**：Local反映後receipt前で終了し、その後Local=Cとして再起動する。

**期待（元仕様）**：成功を推測せず第三の版を保全して要確認

**追加の検査**：第三のCを保全、NEEDS_REVIEW。予定Bを書いたという証拠を捏造しない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1840。

### AT-53 — 新checkpoint破損、古い正常版と新journalが残る

**段階**：0.1。**担当スイート**：recovery。**状態**：NOT_RUN。

**fixture**：F-CHECKPOINT。**注入点**：checkpoint.newest.corrupt。

**手順**：古い正常checkpoint、新journal、ClientStore下限を残し新checkpointだけ破損させる。

**期待（元仕様）**：履歴を補完するか停止。古いbaseline単独で更新しない

**追加の検査**：新履歴を補完して整合確認できるか停止。古いbaselineだけで続行しない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1841。

### AT-54 — journal末尾欠落、ClientStoreの発行番号は先に進む

**段階**：0.1。**担当スイート**：recovery。**状態**：NOT_RUN。

**fixture**：F-JOURNAL。**注入点**：journal.reserved.notPersisted。

**手順**：ClientStore予約sequence=nを保存し、journalのnだけない状態で再起動する。

**期待（元仕様）**：連番欠落を検出し停止。欠落を成功扱いしない

**追加の検査**：欠番を停止条件にする。実施済み/未実施を推測して穴埋めしない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1842。

### AT-55 — 同じcheckpoint sequenceで異なる内容がある

**段階**：0.1。**担当スイート**：recovery。**状態**：NOT_RUN。

**fixture**：F-CHECKPOINT。**注入点**：checkpoint.sameSequence.branch。

**手順**：同sequenceで異なるchecksum-valid payloadのcheckpoint-a/bを用意する。

**期待（元仕様）**：分岐として停止。片方を都合よく選ばない

**追加の検査**：分岐を拒否。日時や任意のa優先で選ばない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1843。

### AT-56 — 高いgenerationだが観測headの子孫でない

**段階**：0.1。**担当スイート**：protocol。**状態**：NOT_RUN。

**fixture**：F-HISTORY。**注入点**：remote.history.fork。

**手順**：アンカーより高いgenerationだが別の親鎖のheadを返す。

**期待（元仕様）**：E_REMOTE_HISTORY_CHANGEDで書き込みゼロ

**追加の検査**：E_REMOTE_HISTORY_CHANGED、Local/Remote通常書込0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1844。

### AT-57 — 129世代以上の間隔で端末が復帰

**段階**：0.1。**担当スイート**：protocol。**状態**：NOT_RUN。

**fixture**：F-HISTORY。**注入点**：history.budget。

**手順**：129、256、4096、4097世代の親鎖を決定的factoryで用意する。

**期待（元仕様）**：128ずつ読取検証を継続でき、検証中は書き込まない

**追加の検査**：128ごとの読取継続と総上限停止を検証。未完了中は書込0、アンカーを勝手にリセットしない。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1845。

### AT-58 — parent chainの循環・世代飛び・親ハッシュ不一致

**段階**：0.1。**担当スイート**：schema。**状態**：NOT_RUN。

**fixture**：F-HISTORY。**注入点**：history.invalidParent。

**手順**：循環、generation飛び、親hash不一致を各別入力する。

**期待（元仕様）**：履歴不正として停止

**追加の検査**：予算内で拒否し無限走査なし。E_REMOTE_HISTORY_CHANGED等の原因を保持。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1846。

### AT-59 — 同じpathにlive/tombstone重複または親revision不正

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：metadata.duplicate。

**手順**：同pathのLive/Deleted重複、parent/deletedFromの不整合を作る。

**期待（元仕様）**：schema/整合検査で拒否

**追加の検査**：0.3の整合規則で拒否。0.1はcapabilityで先に拒否。

**必要レベル**：model。元仕様の行番号：1847。

### AT-60 — deleted baseline、同じtombstone、Local不在

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：none。

**手順**：B=deleted(d)、R=同d、Local不在のDT-07を実行する。

**期待（元仕様）**：DT-07で変更なし。Live版の表へ落とさない

**追加の検査**：NO_CHANGES、Live比較へ誤分岐なし、通常ノート作成0。

**必要レベル**：model。元仕様の行番号：1848。

### AT-61 — 削除後に正規復元、Local不在または同内容

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：none。

**手順**：dから正当に復元したxを含む履歴で、Local不在/同xのDT-09/10を実行する。

**期待（元仕様）**：DT-09/10どおり履歴を検証し取り込み/一致確認

**追加の検査**：親revisionを検証してDownload候補または一致確認。削除履歴は保持。

**必要レベル**：model。元仕様の行番号：1849。

### AT-62 — 削除後に正規復元、Localに別の編集

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：none。

**手順**：復元xに対しLocal=y、xとyは不同としてDT-11を実行する。

**期待（元仕様）**：DT-11で競合。両本文を保持

**追加の検査**：競合停止、両方のbytes保持。最新時刻で勝者を決めない。

**必要レベル**：model。元仕様の行番号：1850。

### AT-63 — Remoteで更新後に削除、端末baselineは更新前

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：none。

**手順**：端末B=A、RemoteはA→B更新→削除としてDT-04を実行する。

**期待（元仕様）**：DT-04で要確認。未確認の削除前版と誤同一視しない

**追加の検査**：E_DELETE_HISTORY。削除前Bを端末確認済みAと誤同一視しない。

**必要レベル**：model。元仕様の行番号：1851。

### AT-64 — 元パスへ復元する

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：none。

**手順**：元pathのtombstone dを明示復元してLive xへ公開する。

**期待（元仕様）**：現行はLive、旧manifestのtombstoneと本文は残る

**追加の検査**：新revisionのparent/restoredFrom=d、現行はLive、過去manifestのdと旧blob不変。

**必要レベル**：model。元仕様の行番号：1852。

### AT-65 — Docs/a.mdとdocs/b.md、a.mdとa.md/b.md

**段階**：0.1。**担当スイート**：paths。**状態**：NOT_RUN。

**fixture**：F-PATHS。**注入点**：none。

**手順**：親名別ケース・ファイル対フォルダ衝突を全path集合として検証する。

**期待（元仕様）**：親成分/型衝突を検出し自動改名・上書きなし

**追加の検査**：Docs/aとdocs/b、a.mdとa.md/bを拒否。末尾名のみの検査では合格しない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1853。

### AT-66 — 既存の.svsync-stateにユーザーファイルがある

**段階**：0.1。**担当スイート**：local。**状態**：NOT_RUN。

**fixture**：F-UNKNOWN-INTERNAL。**注入点**：local.internal.occupied。

**手順**：.svsync-state/.svsync-recoveryに所有者不明ファイルを先に置いて起動する。

**期待（元仕様）**：ownership不明として初期化しない

**追加の検査**：E_STATE_NAMESPACE、初期化/所有者markerの押付け/上書き0。

**必要レベル**：model, windows, iphone。元仕様の行番号：1854。

### AT-67 — UTF-8 BOM、CRLF、非BMP、0バイトを保存

**段階**：0.1。**担当スイート**：bytes。**状態**：NOT_RUN。

**fixture**：F-BYTES。**注入点**：none。

**手順**：BOM、CRLF、非BMP、combining文字、0長をread→stage→process→readの経路で往復する。

**期待（元仕様）**：元バイト列を再現、非対応APIなら元を変更せず停止

**追加の検査**：完全なbytes一致。エンコード不能ならE_UNSUPPORTED_ENCODINGで元を変えない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1855。

### AT-68 — head候補が受信サイズ上限を超える

**段階**：0.1。**担当スイート**：transport。**状態**：NOT_RUN。

**fixture**：F-RESPONSES。**注入点**：response.oversized。

**手順**：headのHEAD長が上限超、length不明、実GETが巨大の各応答を模擬する。

**期待（元仕様）**：本文無制限受信前に拒否するかHandlerを不合格にする

**追加の検査**：受信前拒否またはbounded readerで停止。全量buffer後の拒否だけは合格不可。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1856。

### AT-69 — Range途中でETagが変わる・Rangeを無視した応答

**段階**：0.1。**担当スイート**：transport。**状態**：NOT_RUN。

**fixture**：F-RESPONSES。**注入点**：response.range.changed。

**手順**：Range 2個目をETag変更、HTTP200でRange無視、412にそれぞれする。

**期待（元仕様）**：不完全データを採用せず再読込/停止

**追加の検査**：混ぜて結合しない。mutable headは再読込、不変物は異常停止。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1857。

### AT-70 — 圧縮Content-Encodingや不正なContent-Range

**段階**：0.1。**担当スイート**：transport。**状態**：NOT_RUN。

**fixture**：F-RESPONSES。**注入点**：response.encoding.invalid。

**手順**：gzip等の変換、ずれたContent-Range、合計長不一致を返す。

**期待（元仕様）**：黙って展開/結合せずE_RESPONSE_LIMIT

**追加の検査**：E_RESPONSE_LIMIT。暗黙展開、補正、切捨てで続行しない。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1858。

### AT-71 — 任意URL・偽R2サフィックス・port・リダイレクト

**段階**：0.1。**担当スイート**：transport。**状態**：NOT_RUN。

**fixture**：F-DESTINATIONS。**注入点**：response.redirect。

**手順**：偽サフィックス/任意port/資格情報URLを入力し、別hostへの3xxも制御した偽secretで試す。

**期待（元仕様）**：資格情報を外部へ転送せず送信拒否

**追加の検査**：送信前URL拒否、redirect追従0。実secretで第三者転送試験をしない。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1859。

### AT-72 — 同一headへの連続送信で429となる

**段階**：0.1。**担当スイート**：retry。**状態**：NOT_RUN。

**fixture**：F-RESPONSES。**注入点**：response.rateLimit。

**手順**：偽時計でhead初期化直後/再送を発火し、429を注入する。

**期待（元仕様）**：端末内の最低間隔とRetry-Afterを守り、412と区別

**追加の検査**：同端末の開始間隔1000ms以上。Retry-After遵守、412のCAS競合と別分類。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1860。

### AT-73 — 期限削除/IA移行の兆候がある

**段階**：0.1。**担当スイート**：transport。**状態**：NOT_RUN。

**fixture**：F-POLICY。**注入点**：response.policy。

**手順**：期限切れ予定/IA移行の兆候を返し、ヘッダーなしの場合も試す。

**期待（元仕様）**：E_REMOTE_POLICY、設定確認。ヘッダー不在だけで安全扱いしない

**追加の検査**：兆候時E_REMOTE_POLICY。なしは自動安全証明にせず初回利用者確認を要求。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1861。

### AT-74 — Remoteの旧本文blobが欠損した状態で更新公開

**段階**：0.1。**担当スイート**：protocol。**状態**：NOT_RUN。

**fixture**：F-LOCAL-EDIT。**注入点**：remote.oldBlob.missing。

**手順**：更新先の旧A blobを消して新Bだけ利用可能にする。

**期待（元仕様）**：旧版復旧を保証できないため公開を拒否

**追加の検査**：旧内容保全を証明できず公開拒否。新B検証だけでは合格しない。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1862。

### AT-75 — head送信後に通常API予算を使い切る

**段階**：0.1。**担当スイート**：limits。**状態**：NOT_RUN。

**fixture**：F-LOCAL-EDIT。**注入点**：budget.afterHeadSend。

**手順**：head送信直後に通常run API予算を使い切らせる。

**期待（元仕様）**：別枠の読取照合とローカル最終化、未解決なら要確認

**追加の検査**：新通常転送0。別枠GET照合＋Local記録のみ。残照合も超えれば要確認。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1863。

### AT-76 — state/staging/journalが管理上限に達する

**段階**：0.1。**担当スイート**：limits。**状態**：NOT_RUN。

**fixture**：F-LIMITS。**注入点**：state.reserve.low。

**手順**：state/journal/staging合計と64MiB余裕の境界を投入する。

**期待（元仕様）**：自動削除せず新計画停止。最終化領域を確保

**追加の検査**：余裕を消費するplanは開始しない。最終化は試行、勝手な清掃0。

**必要レベル**：model, windows, iphone。元仕様の行番号：1864。

### AT-77 — 承認後に競合コピー先や下位操作を変更する

**段階**：0.2。**担当スイート**：conflict。**状態**：NOT_RUN。

**fixture**：F-CONFLICT-COPY。**注入点**：approval.planChanged。

**手順**：承認後の下位操作・保存先・revisionを変更して旧digestの実行を要求する。

**期待（元仕様）**：digest不一致で再承認。旧承認の使い回しなし

**追加の検査**：E_APPROVAL_STALE、旧承認を使わない。新planで再承認。

**必要レベル**：model。元仕様の行番号：1865。

### AT-78 — staging後にLocalが変わる

**段階**：0.1。**担当スイート**：executor。**状態**：NOT_RUN。

**fixture**：F-LOCAL-EDIT。**注入点**：source.afterFreeze。

**手順**：staging検証後に元LocalをCへ変更し、PUT再試行を発生させる。

**期待（元仕様）**：同operationIdで別本文を送らず固定版と追加入力を分離

**追加の検査**：同operationIdの送信bodyは常にB。Cを保持。stagingの読戻し不正なら停止。

**必要レベル**：model, windows, iphone, real-r2/windows, real-r2/iphone。元仕様の行番号：1866。

### AT-79 — 管理操作でrequiredCapabilitiesを取り除こうとする

**段階**：0.2〜0.3。**担当スイート**：schema。**状態**：NOT_RUN。

**fixture**：F-FUTURE-CAPABILITY。**注入点**：metadata.capabilityReduced。

**手順**：親にあるcapabilityを子で除き、新headへ公開を要求する。

**期待（元仕様）**：親の必須集合を減らす通常更新を拒否

**追加の検査**：通常更新で集合減少を拒否。0.1のunknown拒否試験も別途継続。

**必要レベル**：model。元仕様の行番号：1867。

### AT-80 — ClientStoreを消去/複製、API利用不能

**段階**：0.1。**担当スイート**：identity。**状態**：NOT_RUN。

**fixture**：F-CLONED。**注入点**：client.marker.missing。

**手順**：ClientStore消失、別contextへの複製、読取/保存例外を独立に投入する。

**期待（元仕様）**：再参加/ゲート停止。架空の端末IDで続行しない

**追加の検査**：E_CLIENT_IDENTITY、架空OS IDや再生成して続行なし。物理端末保証を表示しない。

**必要レベル**：model, windows, iphone。元仕様の行番号：1868。

### AT-81 — Remote読み取り専用エクスポートを実行

**段階**：0.1。**担当スイート**：export。**状態**：NOT_RUN。

**fixture**：F-TWO-PATHS。**注入点**：export.remoteAdvances。

**手順**：空出力先へのreadonly export中にheadを進める。非空/元Vault出力先も試す。

**期待（元仕様）**：元Local/Remoteを書換えず空の出力先に元バイト列を再現

**追加の検査**：最初のcommitだけで一貫出力。非空/元Vaultは拒否。元Local/Remote/baseline書込0。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1869。

### AT-82 — Dry Runを繰り返す

**段階**：0.1。**担当スイート**：executor。**状態**：NOT_RUN。

**fixture**：F-EQUAL, F-LOCAL-EDIT。**注入点**：none。

**手順**：Dry Runを複数回行い、操作トレースを比較する。

**期待（元仕様）**：対象本文、Remote、probeを書き込まない

**追加の検査**：本文、Remote、probe、source staging、recovery本文書込0。許可するのは計画/診断記録だけ。

**必要レベル**：model, real-r2/windows, real-r2/iphone。元仕様の行番号：1870。

### AT-83 — 接続先変更中に旧runのPUT応答が到着

**段階**：0.1。**担当スイート**：restart。**状態**：NOT_RUN。

**fixture**：F-LOCAL-EDIT。**注入点**：connection.change.beforeLateResponse。

**手順**：旧run PUTを保留したまま接続変更し、旧応答を解放する。

**期待（元仕様）**：旧接続のpendingへ隔離。新接続でLocalやbaselineを更新しない

**追加の検査**：旧pendingを隔離し新connectionにLocal/baseline反映0。旧結果は旧contextでのみ照合。

**必要レベル**：model, windows, iphone, real-r2/windows, real-r2/iphone。元仕様の行番号：1871。

### AT-84 — hidden領域への移動APIが衝突時に上書きする

**段階**：0.3。**担当スイート**：delete。**状態**：NOT_RUN。

**fixture**：F-DELETED。**注入点**：local.move.overwrite。

**手順**：hidden領域へのmoveが既存退避先を上書きするAdapterを投入し実機契約と比較する。

**期待（元仕様）**：G-DELETE不合格。無条件APIへフォールバックしない

**追加の検査**：G-DELETE=FAIL。無条件renameを代替採用しない。0.1に実行経路を追加しない。

**必要レベル**：model。元仕様の行番号：1872。


## 7. パッケージに追加する補助試験（ATとは別）

指定したschema型だけでなく、stage0.1でfuture型が拒否されること、同じ版が持つS3条件が署名から落ちないこと、インメモリと実Transportが同じ失敗区別を返すことを検査する。時計、上限、ID生成はproductionでは安全な実装へ差し替え、テスト用deterministic IDを配布bundleへ含めない。

## 8. 未実施の扱い

NOT_RUN、PASS_MODEL_ONLY、PASS、FAIL、BLOCKED、DEFERREDを区別する。今回の84定義を自動でPASSへ変えるコードを作らない。後続専用のDEFERREDはMVP0.1で未実装という意味であり、ケース削除やチェック無効化ではない。

67件がそろっても、G-R2/G-LOCAL等の実機条件、G-RELEASEの配布条件、コードレビューを自動的に満たしたとはしない。逆にWP-01で未来の全試験が未実行であることは、WP-01自体を完了できない理由ではない。
