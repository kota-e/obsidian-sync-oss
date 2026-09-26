# WP-06 公開資料による非probe API・依存候補監査

## 依頼の整理

- WP-06の実機probe前に、公開されている公式一次資料だけでAPI候補と既存署名部品の範囲を確認する。
- 対象はObsidianのVault・`requestUrl`・hidden state・client storage、Cloudflare R2の条件付きPUT・Range・LIST、および既存署名部品の不足とする。
- 実通信、実Vault、依存追加、コード変更は行わず、確認済みとprobeが必要な項目を分けて記録する。

## 結論

状態は **PUBLIC_DOC_NON_PROBE_AUDIT（公開資料による非probe監査。R2/Vaultへの実通信なし）**。公式資料から、Obsidianの公開シンボルの存在と基本契約、R2 S3互換APIが提供する条件付き操作・Range・ListObjectsV2の項目は確認できた。ただし、実行環境での応答、保存の寿命、リダイレクト、ストリーミング、実byte上限、署名受理はこの資料調査では証明できない。

したがって、採用バージョンや実能力は確定しない。`G-LOCAL`、`G-CLIENT-STATE`、`G-R2`は実機probe待ちのままとし、既存のネットワーク送信を行わない署名部品へLIST送信やHTTP実行を追加しない。

## 監査情報

| 項目 | 内容 |
|---|---|
| 確認日 | 2026-09-25（日本時間） |
| 実行した操作 | 公開Web資料の閲覧と、リポジトリ内の契約・実装との読み取り照合 |
| 行っていない操作 | 実R2への通信、実Vaultの読み書き、依存インストール、製品コード変更、probe用認証の使用 |
| 採用判断 | 未採用。依存追加・バージョン固定・実行経路接続は別承認とprobeが必要 |
| 参照したローカル資料 | `docs/API_ADAPTER_MATRIX.md`、`docs/EXTERNAL_REFERENCES.md`、`docs/IMPLEMENTATION_DECISIONS.md`、詳細仕様、`workspace/src/r2/sign-request.ts`、`workspace/src/product/protocol/object-store.ts` |

## 1. 公式一次資料

### Obsidian

| 資料 | URL | 確認日 | 資料から確認できたこと |
|---|---|---|---|
| Vault API | [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault) | 2026-09-25 | Vault APIはアプリ内で見えるファイルを対象とし、`getMarkdownFiles()` と `getFiles()`、`read()` / `cachedRead()`、`create()`、`process()` などの公開操作を説明している。hidden fileはAdapter API経由で扱う必要がある。 |
| `requestUrl` | [Obsidian requestUrl API](https://docs.obsidian.md/Reference/TypeScript%20API/requestUrl) | 2026-09-25 | `requestUrl(request)` はCORS制限を受けないfetch相当の公開入口として型付けされている。 |
| TypeScript API定義 | [obsidianmd/obsidian-api](https://github.com/obsidianmd/obsidian-api) / [obsidian.d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) | 2026-09-25 | 最新APIの型定義を配布する公式リポジトリである。`App.loadLocalStorage` / `saveLocalStorage` はpublicで、型定義上は `@since 1.8.7`。API全体のバージョンはデスクトップ版リリース周期に従う。 |

### Cloudflare R2

| 資料 | URL | 確認日 | 資料から確認できたこと |
|---|---|---|---|
| S3互換API | [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) | 2026-09-25 | S3 endpoint、`PutObject` の条件ヘッダー、`GetObject` の条件操作とRange、`ListObjectsV2` のquery項目（`list-type`、`continuation-token`、`max-keys`、`prefix` 等）が記載されている。ListObjectsV2が推奨される。 |
| APIの選択肢 | [R2 API overview](https://developers.cloudflare.com/r2/api/) | 2026-09-25 | R2にはWorkers API、S3互換endpoint、REST APIという複数の接続面がある。今回の設計対象はS3互換endpointに限定する。 |
| エラーコード | [R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/) | 2026-09-25 | `NoSuchKey`（404）、条件不成立の`PreconditionFailed`（412）、範囲不正の`InvalidRange`（416）が掲載されている。 |
| S3利用例 | [R2 S3 API getting started](https://developers.cloudflare.com/r2/get-started/s3/) | 2026-09-25 | AWS SDK for JavaScript v3を使った例が示されている。ただし、これは依存採用の承認や本プロジェクトでの適合性を意味しない。 |
| 一時資格情報 | [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/) | 2026-09-25 | read-only権限とObject read/list権限を分けられる資料がある。認証情報は取得・使用していない。 |

公式ページの記載が型・機能の存在を示していても、現在のObsidian版や実R2アカウントでの挙動を保証するものとしては扱わない。

## 2. Obsidian API候補の照合

| 対象 | 公式資料で確認できたこと | 未確認・実機probeが必要なこと | 現時点の扱い |
|---|---|---|---|
| 完全なVault一覧 | `getFiles()` はVault内の全ファイル、`getMarkdownFiles()` はMarkdownを返す公開操作として説明されている。 | 一覧が同期処理中に完全であること、重複・除外・hidden fileの境界、ファイル数・名前・byte長の上限は未確認。 | `API-07`候補。G-LOCALのdisposable Vault probeが必要。 |
| 本文・byte列読取 | `read()` とbinary readの公開操作があり、`cachedRead()` はキャッシュ読取として説明されている。 | 実byte長、UTF-8/BOM、0 byte、読み取り中の変更、巨大ファイルの上限、read結果の完全性は未確認。 | 実Vaultに接続しない純粋契約のまま。 |
| 新規作成 | `create()` が公開操作として説明されている。 | 既存pathがある場合の厳密な失敗、作成後の読戻し、同時変更、実ファイルの原子的性質は未確認。 | `API-08`候補。上書きしないdisposable probeが必要。 |
| 競合付き本文更新 | `process(file, callback)` は、現在の読取から更新まで変更がないことを保証する操作として説明されている。callbackは同期変更向けで、非同期処理は別の読取と再確認が必要と説明されている。 | 実端末での競合、callbackの例外・中断時の結果、適用receiptとの組合せ、実プロセス終了時の永続化は未確認。 | `API-09`候補。非同期通信をcallback内に入れず、専用probeで確認する。 |
| hidden state / Adapter | Vault API資料は、アプリから見えないhidden fileはAdapter APIで扱う必要があると説明している。 | 現行版で使うAdapterの正確なメソッド・path正規化・hidden領域の列挙・同期性・保存失敗時の結果は、今回参照した公開ページだけでは確定できない。 | `API-10`候補。型定義と選定版を固定した後に実機probe。 |
| `requestUrl` | CORS制限を受けないfetch相当の公開入口であること、戻り値が`RequestUrlResponsePromise`であることを確認した。 | HTTP status/header/bodyの全件取得、Range応答のstreaming、キャンセル、timeout、redirectの扱い、認証情報の転送、実byte上限は未確認。 | `API-03`候補。R2 transportの完成根拠にはしない。 |
| client storage | 公式型定義の`App.loadLocalStorage(key)` / `saveLocalStorage(key, data)` はvault-specific valueを読み書きし、`data`はserializable、`null`で削除できる。`@since 1.8.7`も型定義で確認した。 | 再起動後の保持、Vaultコピーへの継承、別Vaultとの分離、アプリデータ消去、同時保存・部分書込、marker不明時の扱いは未確認。 | `API-11`候補。G-CLIENT-STATEの専用probeが必要。採用版は未確定。 |

### Obsidian側の不足資料

`docs/EXTERNAL_REFERENCES.md` が指摘しているとおり、`App.loadLocalStorage` / `saveLocalStorage` の詳細APIページは今回の参照時点でも安定して取得できず、公式APIリポジトリの型定義で公開シンボルと`@since`だけを確認した。これは保存寿命やVaultコピー時の扱いの証明ではない。Adapter APIについても、公開ページで存在の境界を確認しただけで、製品が使用する具体的な版・型・失敗契約を確定していない。

## 3. R2 API候補の照合

| 対象 | 公式資料で確認できたこと | 未確認・実機probeが必要なこと | 現時点の扱い |
|---|---|---|---|
| 条件付きPUT | S3互換資料に`PutObject`の条件操作があり、既存objectの条件ヘッダーを扱える。ローカル詳細仕様は新規headに`If-None-Match: *`、既存headに`If-Match`を要求している。 | 条件不成立時の実status・XML本文・ETag表記、応答消失後のhead読戻し、同時更新、実body byte数、redirect時の資格情報処理は未確認。 | `API-04`設計契約。G-R2の条件付きPUT probe必須。無条件PUTを追加しない。 |
| Range GET | S3互換資料に`GetObject`のRangeがある。エラー資料に範囲不正416がある。 | `206`、`Content-Range`、返却長、ETag固定、0 byte、上限超過、Range未対応時の応答は未確認。HeadObjectのRangeには効果がないと資料にあるため、HEADで範囲読取を代用しない。 | `API-05`設計契約。最大256 KiB・If-Match・応答検証はモデルのみ。 |
| ListObjectsV2 | `list-type=2`とcontinuation token、prefix、max-keys等のquery項目が公式資料にある。 | 実queryのcanonicalization、署名対象、ページ欠落・token反復・重複、XMLエラー、max-keysの実上限、全件byte長計測は未確認。 | `API-06`候補。bootstrap/capacityの完全一覧は実R2 probeまで不使用。 |
| 失敗分類 | 404/412/416の公式分類を確認した。 | 403/429、Retry-After、切断・timeout、5xx、redirect、部分bodyの組合せと再試行可否は未確認。 | transport契約の読取分類だけ維持。自動再試行の範囲を広げない。 |

R2のS3資料で機能項目が列挙されていることは、当プロジェクトの署名・応答検証・完全一覧・容量ゲートが実行可能であることを示さない。実際の計画では、ListObjectsV2の全ページと全オブジェクトbyte長が揃わない場合に成功扱いしない。

## 4. 既存署名部品との照合

対象は `workspace/src/r2/sign-request.ts` と、承認済みの `@svsync/aws4fetch-signer` 部品である。今回の監査では、既存コードを変更していない。

### 確認できた範囲

- 署名部品はネットワーク送信を行わず、許可済みのR2 endpoint・bucket・key範囲を検査してから、GET/HEAD/条件付きPUTの署名入力を作る。
- `If-Match` / `If-None-Match` と限定的なRange値、body byte上限、PUT以外のbody禁止など、既存の安全制限を持つ。
- signerの責務とHTTP送信の責務は分かれており、既存の署名部品を実R2成功の証拠にはしていない。

### 未実装・不足している範囲

- ListObjectsV2のquery生成・canonicalization・署名・XML解析はない。
- HTTP送信、status/header/bodyの全件検証、redirect拒否、資格情報転送防止、429/Retry-After分類はない。
- Range受信のstreaming、`206` / `Content-Range` / ETag / 返却長の検証は署名部品の責務外である。
- 署名が実R2で受理されること、条件付きPUTとRangeが組み合わせて期待どおり働くことはprobeしていない。

この不足は欠陥を隠すための変更対象ではなく、API-02/04/05/06とtransport責務の境界である。LISTやHTTPを追加する場合は、既存署名を拡張して安全制限を弱めず、小さい別adapterとして設計・レビューする。

## 5. 依存候補と採用境界

| 候補 | 公式資料での位置付け | 今回の判定 |
|---|---|---|
| Obsidian公式API型定義 | 公式`obsidian-api`リポジトリで最新型定義を公開。API版はデスクトップリリース周期に従う。 | 現行workspaceへ追加・固定していない。対象Obsidian版を先に決め、型差分とライセンス・出自を確認する必要がある。 |
| AWS SDK for JavaScript v3 | CloudflareのS3開始例で使用される依存候補。 | インストール・採用しない。既存のネットワーク禁止と依存追加禁止の範囲を維持する。採用するなら権限、bundle、transitive依存、署名挙動を別レビューする。 |
| XML parser | ListObjectsV2のXML処理に必要になり得る候補。 | 依存追加しない。DTD・外部実体・深すぎる構造・重複・欠損の拒否契約を先に定義し、実probeとライセンス確認後に選定する。 |
| 既存署名部品 | ネットワーク送信を行わず、限定surfaceを署名する承認済み部品。 | 維持。LIST、HTTP、retry、response parserを暗黙に提供すると解釈しない。 |

採用バージョン、対応能力、実機での性能はこの監査では確定しない。新依存、SDK、通信ライブラリ、インストールは行っていない。

## 6. Probe前の安全境界

### 実機probeが必要な項目

1. **G-LOCAL**: 実アプリ版を固定したdisposable Vaultで、完全一覧、hidden領域、UTF-8/BOM、0 byte、create、`process`競合、途中終了、read-back byte長を確認する。
2. **G-CLIENT-STATE**: `loadLocalStorage` / `saveLocalStorage` の再起動、Vaultコピー、別Vault、アプリデータ消去、保存失敗、未知markerを確認する。未知・不完全な状態は停止条件とする。
3. **G-R2**: 別途承認済みの非本番prefixで、署名、If-None-Match/If-Match、ETag、Rangeの206/Content-Range/長さ、ListObjectsV2全ページ、404/412/416、429、redirect拒否、通信不明後の読戻しを確認する。

### 現在の停止条件

- 完全な一覧、各objectのbyte長、Range応答の長さ、追加state/recovery量の上界が測れない場合は、新操作を開始しない。
- 条件付きPUTの受理が不明、headが変化、ページが欠落・重複・反復、XMLが不完全、応答が不明な場合は成功扱いしない。
- 公式資料だけで実行可能と推測して、実Vault・実R2・認証情報・既存署名制限へ接続しない。

## 7. 監査判定

| 判定 | 状態 |
|---|---|
| 公式資料の所在確認 | PASS（Obsidian公式docs/API repo、Cloudflare公式docs） |
| Obsidian公開APIの存在・基本契約 | PARTIAL（公開シンボルと説明まで。実版・実失敗契約は未確認） |
| R2条件付きPUT / Range / LISTの資料確認 | PASS（S3互換資料の機能項目まで） |
| 実署名受理・実HTTP応答・完全一覧 | NOT_RUN |
| Client storageの永続性・コピー分離 | NOT_RUN |
| 実Vaultのhidden/byte長/競合 | NOT_RUN |
| 新依存・採用バージョンの確定 | NOT_APPROVED |
| WP-06実probe開始許可 | NOT_GRANTED（対象・範囲の別承認待ち） |

## 参照したローカル契約との対応

- `docs/API_ADAPTER_MATRIX.md`: API-02〜API-12、P-R01〜P-R08、P-L01〜P-L07、ClientStore probe、および「実probe未実施」の状態。
- `docs/EXTERNAL_REFERENCES.md`: EXT04/EXT05（Obsidian）、EXT07〜EXT09（R2）と、Obsidian storage詳細ページ未確認の記録。
- `docs/IMPLEMENTATION_DECISIONS.md`: `signR2Request`はGET/HEAD/条件付きPUTの契約prototypeであり、LIST/queryや実HTTPを保証しないという決定。
- `workspace/src/r2/sign-request.ts`: 現行署名部品の許可surface・body/Range制限・送信なしの実装。
- `workspace/src/product/protocol/object-store.ts`: in-memoryのbounded read/list契約。実S3 XML、HTTP、完全一覧の証明ではない。

本書は資料監査の記録であり、WP-06の実機probe合格、R2接続成功、Obsidian対応版の採用、MVP完了を意味しない。
