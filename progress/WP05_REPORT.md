# WP-05 実装・検証報告（進行中）

## 2026-09-25 更新

**状態：IN_PROGRESS。** WP-05のメモリ内Executorについて、承認済み計画の永続的な実行記録、複数操作の途中確定、公開結果が不明なときの読取専用照合、通常予算切れ後の別枠照合を追加した。再起動後の操作別判定、検証済みjournalの読取、既に確定した同内容操作だけのcheckpoint保存、読取専用Dry Run入口も追加した。さらにLocal本文・適用receipt・固定Source・Remote基準版を読み直す部品とUpload候補の履歴証明を読取専用の復旧判定へ接続した。完全一覧を要求するLocalスキャンをDry Run入口へ接続し、起動時の安全判定から単一の未解決v2記録を読取専用で検査する入口を追加した。完了済みの単一Upload、Download-only run、1 Upload + 複数Downloads runは、保存直前に証拠を再検証してcheckpointへ保存する限定consumerを起動時経路へ接続した。単一DownloadでLocal適用後にreceiptが欠けた場合は、checkpoint・Remote・復旧コピーを再照合して適用証拠を補い、その後に最終化してcheckpointへ保存する限定起動時入口も追加した。最終化と混在run保存では、取消世代を永続書込の直前まで確認する。AT-06/09/14/17/18/19/38/41/53/74/76の故障・境界を合成Executorまたは純粋モデルで拡張した。これらは合成Storeでのモデル動作であり、実R2・実Vault・Windows/iPhoneの成功を示さない。`5a37210`を基準に今回の作業treeを検証し、送信済み先端はGitの`origin/main`で確認する記録とした。

単一DownloadでノートがLocal適用前から開いている場合は、`DEFERRED`と専用journal markerを保存する。起動時には旧checkpoint枠・全baseline・journal・Remote祖先関係を読取で照合し、証拠が揃う場合だけ新計画へ進める。旧pendingは新計画の承認と再比較が通った後に完全一致で削除し、旧操作は再生しない。適用開始後に開状態が変わった場合、複数操作、または証拠が不一致の場合は保留を維持する。

### 追加した実装と検証対象

| 対象 | 今回の内容 |
|---|---|
| `state/pending-execution.ts`, `state/guards.ts`, `state/startup.ts` | 完全な承認計画とRemote提案・Source・証拠参照をチェックサム付きv2封筒へ保存。16 MiB上限、create-if-absent、同一bytesの読戻しを要求。完了済みの封筒はjournal・checkpoint・各baseline証拠を突き合わせてから起動時に無害と判断し、未完了・改変・旧v1は再照合へ止める。 |
| `state/pending-execution.ts`, `state/startup.ts`, `executor/run.ts`（AT-41） | 適用前に開いている単一Downloadだけを明示的に延期。旧checkpoint枠・journal marker・全baseline・Remoteの直系履歴を照合してから、新計画の再比較と承認へ進む。開始済み・証拠欠損・別枝・状態変更では旧pendingを保持する。 |
| `executor/run.ts` | 操作前の封筒保存を必須化。複数操作では前の確定分を次の操作前にcheckpointへ保存。CAS受理後に通常予算が尽きても別枠の読取専用照合へ進み、採用済みなら最終化、未確認なら再送せず停止する。 |
| `executor/inspect-pending.ts` | journalの順序、重複、Remote提案、Local適用証拠を厳格に照合する読取専用分類を追加。 |
| `executor/bounded-read.ts`, `domain/errors.ts` | HEADの長さ・強いETag、最大256 KiBの条件付きRange、Content-Range・長さ・encodingを検証する純粋モデル。R2宛先の許可範囲、redirect拒否、保存期限・retention・storage classの兆候を安全停止へ分類する。実HTTP adapterは未接続。 |
| `executor/transport.ts`, `domain/errors.ts` | 下層が明示した型付き原因だけを分類する読取モデル。permissionは即時停止、offline/timeoutは読取だけ最大4回、書込のtimeoutは盲目的に再送しない。未知の`E_REMOTE_IO`は従来どおり有限再試行し、エラーを不在や空本文へ変換しない。実HTTP adapterは未接続。 |
| `executor/join-existing.ts` | 既存Remote参加前に、adapterが完全列挙で空と報告した場合だけ、番号0の読取専用anchorを作る。state初期化・ClientStore/identity・通常Executorへの接続前は実行をブロックし、Remote書込を行わない。 |
| `executor/state-capacity.ts` | stateとrecoveryを別々の512 MiB枠で測り、stateの64 MiB最終化余裕、完全なbyte長一覧、計画追加量の保守的上界を純粋関数で検査する。実Executorには未接続。 |
| `recovery/pending-plan.ts` | v2封筒、検証済みjournal、Remote採用証拠、Local適用receiptを操作別に照合する純粋判定。旧Local反映と旧head CASを再実行せず、確定候補・保留・再計画・要確認に分類する。完了済み単一UploadとDownload-only runの限定保存へ判定結果を使う。 |
| `recovery/load-pending-journal.ts` | v2封筒を再解析し、ClientStoreとhash鎖を検証したjournalから同じrun/planの操作証拠を読取専用で投影。欠落・重複・順序違い・別run混入を拒否する。 |
| `recovery/collect-local-facts.ts`, `recovery/collect-source-facts.ts`, `recovery/collect-remote-facts.ts` | v2封筒を再検証してLocal旧/新/第三版、適用receipt、Upload固定Source、Remote基準版を読み直す。欠落・読取不能・改変・head変更を区別し、UploadのRemote採用は推測せず保留する。 |
| `recovery/inspect-pending-plan.ts` | 検証済みjournalの後に3種類の読取証拠を結合し、`planPendingRecovery`へ渡す。journalが不正・読取不能ならLocal/Remoteを読まずに止める。旧操作の再実行やcheckpoint保存は行わない。 |
| `executor/startup-inspect.ts` | 起動時のcheckpoint・pending隔離判定に続いて、単一の未解決v2記録だけを読取専用の復旧検査へ渡す。旧v1・複数記録・journal tailのみの場合は自動再開せず確認待ちにする。 |
| `executor/startup-recover.ts` | 起動時の読取専用判定の後、全操作の最終化と`RUN_COMPLETED`を確認してから限定consumerへ渡す。単一Upload、Download-only、1 Upload + 1〜4999 Downloadsを対象にする。混在runの一般検査でDownload Remote証拠が未知でも、専用consumerで独立に再読込・検証する。旧Local反映・旧CASは再実行しない。 |
| `executor/startup-complete-apply-proof.ts` | 起動時監査で単一の現行v2 Downloadが見つかり、Local新版と適用証拠の欠落が一致する場合だけ、限定consumerへ渡す。pending実キーを読み直し、receipt作成とjournal予約・追記の前にも一致を確認する。旧Local反映・旧CAS・checkpoint保存は行わない。 |
| `executor/startup-finalize-download.ts` | 前段の適用証拠補完後、同じ単一Download pendingが実キーに残ることを確認して最終化consumerへ渡す。journal予約・追記とcheckpoint書込の直前にも封筒と取消世代を照合し、変更・消失なら保留。 |
| `recovery/collect-upload-adoption.ts` | v2候補commit/manifest/head、基準版と変更path、現Remoteのtipまたは祖先関係を上限付き読取で照合。候補存在だけでは公開済みにせず、採用/未採用/未変更/不明を区別して復旧判定へ渡す。実HTTPは未接続。 |
| `recovery/commit-pending.ts` | 既に`OPERATION_FINALIZED`が永続化された`CONFIRM_EQUAL`だけを、検証済みRemote snapshotとcheckpoint/journal再読込後に保存。同じ保存の再実行は一致証拠がある場合だけ無害に返す。Upload/Downloadの保存は明示停止する。 |
| `recovery/commit-upload-pending.ts` | 単一Uploadで実行器が残した完了journal、固定Source、旧checkpointとRemote基準版、提案blobとcommit、公開済み候補から現headまでの祖先関係を読取で再検証して保存する。旧CASを再送せず、同じcheckpoint markerの再実行だけ無害に返す。 |
| `recovery/commit-download-pending.ts` | Download-onlyの完了runについて、全操作のreceipt・適用確認・最終化を照合し、Local/Remote/checkpoint/journalを保存直前に再読込。1操作でも未解決なら全体を保留し、後から編集されたLocalには触れない。Remote revisionの直系関係を証明できない場合も保留する。 |
| `recovery/commit-mixed-pending.ts` | 1 Upload + 1〜4999 Downloadsの完了runに限定。固定Source、Remote候補の公開、各Downloadの適用receipt、journal順序と残存する2枠の中間checkpointを再読込する。隣接checkpointのbaseline差分を照合し、最後のDownloadだけを最終checkpointへ加える。取消世代を各永続書込直前にも確認。現headの移動や証拠欠落は保留。8件まで実Executor由来の記録で検証し、5000件の負荷・容量は未検証。 |
| `recovery/complete-pending-apply-proof.ts` | 単一DownloadのLocal適用開始記録、現在のLocal内容、Remote基準版、更新前の復旧コピー、旧checkpointを照合し、欠けた適用receiptとjournal証拠だけを補う限定consumer。Local本文・Remote・checkpointは書き換えない。 |
| `recovery/finalize-single-download-pending.ts` | 単一DownloadでLocal新版、適用receiptとjournal証拠、Remote基準版、Update復旧コピー、旧checkpointが揃う場合だけ`OPERATION_FINALIZED`と`RUN_COMPLETED`を追記し、既存のDownload committerでcheckpointへ保存。各追記前に再読込し、journal予約・追記・checkpoint保存の各直前に取消世代を確認する。後からの編集や欠番は保留。Local本文・Remoteは書き換えない。 |
| `executor/scan-local.ts`, `executor/dry-run.ts` | 完全フラグ付きLocal一覧をfresh readし、Remote/baselineの既知pathが一覧にない時だけ明示的不在にする。重複・除外項目を含む名前衝突・不完全一覧・容量超過は停止。検証済みRemote snapshotを1回読んでLocalスキャンと同じ計画に使うDry Run入口へ接続。実Local adapterは未実装。 |
| `workspace/tests/unit/wp05-*.test.mjs`, `workspace/tests/acceptance/WP05-*.test.mjs` | 複数操作、封筒故障、読取専用再照合、AT-06 read-only join intent、AT-09の型付き・一般的な読取失敗、AT-18受信blob破損、AT-31削除禁止、AT-36/83遅延応答、AT-69 Range 2回目の変化、AT-74旧blob欠損、AT-75予算切れ、AT-76容量ゲート、AT-78固定Source再試行、AT-82 Planner部分Dry Run、起動時適用証拠補完、混在run checkpoint復旧などを合成データで追加。 |
| `progress/WP05_AT_COVERAGE.md` | MVP 0.1対象67件をcatalogのIDと照合し、モデルでのassertと実機必須の境界を分けて記録。正式AT結果JSONは変更していない。 |
| `progress/WP05_JOIN_HANDOFF_ANALYSIS.md` | `joining`計画の番号0と通常Executorのcheckpoint番号1の間に必要な、初回Remote信頼アンカー・端末状態作成・再計画の安全条件を調査。設計メモであり接続実装ではない。 |
| `progress/G_PROTOCOL_MODEL_ASSESSMENT.md` | G-PROTOCOLの型・状態表・履歴/revision/capability・CAS条件を具体的なassertへ対応づけ、モデル範囲だけを`PASS_MODEL_ONLY`と判定。 |

### 確認結果

| コマンド | 結果 |
|---|---|
| `$env:NODE_OPTIONS='--test-reporter=tap'; node tools/preflight.mjs`（ルート、昇格実行） | 10/10 PASS。既存workspace保持。 |
| `npm run build`（workspace） | PASS。 |
| `npm test`（workspace、昇格実行） | 482/482 PASS。失敗・skip 0。 |
| `npm run check:boundary`（workspace） | PASS。`newProjectSourceFiles: 46`、`productCorrectnessVerified: false`。 |
| `node tools/verify-handoff.mjs`（ルート） | H01〜H11すべてPASS。固定原本・出自に変更なし。 |
| `git diff --check` | PASS。 |

### 残る作業と判定境界

- WP-05はまだ完了していない。起動時の読取専用判定と、完了済み単一Upload、Download-only、1 Upload + 複数Downloads runの限定保存は合成Storeの起動経路で接続した。単一Downloadの途中操作も、証拠補完から最終化・保存まで合成Executor由来の記録で起動時入口を通して確認した。混在runは8件のDownloadまで実Executor由来のモデルで確認済み。実Local列挙adapterを通る製品の起動、上限付近の負荷・容量、全故障注入境界は未完了。G-PROTOCOLはモデル範囲のみ別紙で判定済み。
- 1 Upload + 2 Downloadsの最終checkpoint故障は、実行器由来のB+1/B+2中間保存、全操作の最終化、B+2からB+3への差分を照合し、Local/Remoteを再書込せず保存できた。保存済み状態への再実行、receipt欠落、保存slot改変、取消も専用試験で確認した。2 slotのローテーションで消えたB/B+1のbytesは独立に再構成できないため、残ったB+2のhash、journalマーカーとB+2→B+3遷移を検証する境界とする。
- 1 Upload + 3〜8 Downloadsでも、実Executorの最終checkpoint故障から、残った2枠とjournal・receiptを照合して一度だけ最終checkpointを保存した。古いLocal反映とRemote公開を再実行せず、破損した残存slotや別操作のreceiptでは停止する。コード上限は計画全体5000操作だが、8件を超える実行と性能は未検証。
- AT-19では0バイトMarkdownを新規Uploadと新規Downloadの両方向でlive内容として同期し、空blob・Local・baselineのsize/hashを確認した。AT-41では単一Downloadが適用前に開いている場合の延期、閉じた後の新計画での適用、第三版Cへの編集時の競合、旧pendingの完全一致削除を合成Storeで確認した。適用開始後の開状態変化と複数操作は保留のまま。AT-53では新journalと新checkpointの記録を残した上で新slotだけを破損させ、古いbaselineへ戻して実行しないことを確認した。
- AT-02ではUpload後に旧A blobと旧manifestを保存APIから取得し、旧revisionとAの参照、Remote B、baseline B、条件付きhead更新1回を確認した。AT-03ではDownload前のA復旧receipt/blobを読み直し、Local B、baseline B、確定journalに結び付いた適用証拠を確認した。どちらもモデル試験であり、実R2・両端末は未確認。
- AT-06では、adapterが完全列挙で空と報告した場合だけ既存Remoteを読み、番号0のRemote anchorを含むread-only join intentを作ることを確認した。identity/device ID、ClientStore、ownership、checkpoint、journalを作らず、通常Executorへ渡す前にstate初期化を要求して実行をブロックし、Remote immutable/head PUTを0回に保つ。不完全一覧、内部state、所有者、ClientStore marker、Remote identity/head異常は読み取り前または公開前に停止する。初回checkpoint済みのDownloadモデルとは接続しておらず、実Local adapterもないため、AT-06のモデル判定は部分のまま。
- AT-08では既存接続のRemote headだけを欠損させ、通常Executorが`E_REMOTE_HEAD_MISSING`で新操作前に止まり、Remote PUT、Local・state書込0を合成Storeで確認した。AT-10ではbootstrap候補準備時のLIST 2ページ目失敗を、1ページ目が空・非空の両方で注入し、head/immutable PUT 0を確認した。高位bootstrap実行入口と実R2は未確認。
- AT-09では、一般的な`E_REMOTE_IO`をhead・commit・manifest・必須blobへ4回注入して従来どおり`E_LIMIT`で有限再試行を終え、不在や空データへの誤変換なし、Remote/Local書込0、既存内容とbaselineの不変を確認した。追加の型付きモデルではpermissionを1回で`E_PERMISSION`停止、offline/timeoutを読取だけ最大4回再試行し、書込timeoutを盲目的に再送しないこと、明示されないnative Errorからtimeout等を推測しないことを確認した。HTTP 403・切断・timeoutを実HTTP adapterで識別する機能、実R2・端末経路は未接続のため、AT-09のモデル判定は部分のまま。
- 起動時の追加否定試験で、pendingなしjournal tail、複数未解決pending、別run混入、checkpoint marker保存失敗を成功扱いしないことを確認した。Download適用後にreceipt保存が失敗した場合も、起動時に保留し、後続のLocal編集を保持する。AT-36/83では旧接続のpendingを旧identity・旧Remoteだけで読取照合し、新接続の状態不変を確認した。
- AT-17ではLocal書込の直後、applyの応答前に取消した。未証明の適用を確定扱わず、pendingと開始journalを残し、同じ計画の再実行で二重適用しないことを合成Storeで確認した。単一Downloadの証拠補完と最終化・保存は、実Executorのreceipt故障記録を起動時入口に渡す一連のモデル試験でも通した。実プロセス終了と実端末の永続化は未確認。
- AT-18では受信blobを1 byte改変し、Local適用・receipt・checkpoint・head更新を止めた。AT-74ではUpdate前の旧Remote blobを消して公開を止めた。どちらも合成Remoteの故障注入であり、実R2の証拠ではない。
- AT-40では承認後にRemote headを信頼済み版より古い版へ戻す場合と、同じ世代の兄弟枝へ変える場合、Executorが`E_REMOTE_HISTORY_CHANGED`で新操作前に停止し、Local・Remote・pending・staging・復旧・journal・checkpoint・ClientStoreを書き換えないことを合成Storeで確認した。実R2は未確認。
- AT-82は完全フラグ付きLocal一覧を含む読取専用Dry Run入口と合成fixtureで反復・書込0を確認した。実Obsidian Local列挙adapter、実R2/Windows/iPhoneとprobeを含む実経路は未確認。
- bounded readerは純粋モデルで、実HTTP adapterの受信上限、認証情報の送信先・redirect遮断、429/Date/Retry-After変換、R2の保存ポリシーは未実測。
- AT-34/76の64 MiB最終化余裕は純粋な境界検査のみ。追加した容量ゲートはstateとrecoveryを別々の512 MiB枠で測り、stateでは最終化用64 MiBを残し、完全なbyte長一覧と計画追加量の保守的上界がない場合は`E_STATE_SPACE`で止める。これはOS全体の空き容量ではない。現行Executorに完全な管理領域の使用量と計画による追加量を測る入力がなく、この検査を実行経路で呼んでいない。状態の完全列挙とbyte長集計、およびpending・journal・checkpoint・receiptを含む追加量の上界が必要。測定不能時に素通りする任意入力は設けず、新しい操作を容量不足の前に止める機能は未実装として扱う。模擬Storeの保存失敗を、事前余裕確保の合格証拠にはしない。
- 容量接続の調査では、現行Storeが個別キーの読み書きだけで、state・recoveryの全件列挙と実byte長を返せないことを確認した。`estimatedUploadBytes`/`estimatedDownloadBytes`も本文量だけで、pending・journal・checkpoint・receiptの追加量を含まない。stateとrecoveryは別々の512 MiB枠として、全件測定の必須契約と追加量の安全上界を作るまでExecutorへ容量ゲートを接続しない。
- 正式AT結果JSONの既存statusは据え置き。モデル試験数を受入67件の合格数へ換算しない。実R2・Windows/iPhone・実VaultはNOT_RUN。WP-06以降の実probeには別途、使い捨て対象と範囲の明示が必要。

以下は2026-09-24時点の記録で、試験件数などは更新前の履歴として残す。

---

## 2026-09-24 時点の記録

## 結論

状態：**IN_PROGRESS**。確認日：2026-09-24。開始時Git HEAD：`025b781cb4184485cc3329722d4e628cd437203b`。Windows、Node.js v24.15.0。

判定・Remoteプロトコル・復旧状態をつなぐメモリ内Executorを追加し、合成データで更新・中断・故障の一部を検証した。429/Retry-After、同一headへの送信間隔、3回の再計画上限を確認した。中断したRemote公開の読取専用検査を追加し、候補の採用・未採用・head未変更を検査できるようにした。WP-05の完了条件である全故障境界と67件のMVP対象モデル試験集約は未完了。G-PROTOCOLのモデル判定は保留。実R2・実Vault操作は0。

## 変更ファイルと確認した規則

| ファイル | 内容 |
|---|---|
| `workspace/src/product/executor/run.ts` | 承認済み計画を再検証し、固定Source・復旧コピー・Remote公開証拠・Local条件付き反映・checkpointを順序付ける。信頼済みbaselineとRemote履歴を照合 |
| `workspace/src/product/executor/local.ts` | アップロード本文をコピー・保存・読戻しで固定。Local新規作成と旧本文一致を条件にした更新。開いているノートを停止 |
| `workspace/src/product/executor/control.ts` | Vault単位の実行世代、通常/再照合の別予算、4試行上限、Retry-After解析、同一headの1,000ms間隔、3回再計画の上限部品 |
| `workspace/src/product/executor/transport.ts` | 要求数とバイト数の計測。GETと不変オブジェクトPUTを有限再試行。head CASは確定した429だけを間隔・Retry-Afterを守って再送し、通信不明時は照合へ送る |
| `workspace/src/product/executor/inspect-pending.ts` | 検証済みjournalとRemoteオブジェクトを照合し、中断した公開を読取専用で分類。旧計画の自動再実行やbaselineの昇格はしない |
| `workspace/src/product/recovery/recovery.ts` | 新規ダウンロードの適用前状態を「不存在」(`null`)としてreceiptに記録し、再起動時の分類にも使用 |
| `workspace/src/product/domain/errors.ts` | 429の確定拒否を他の通信結果不明と区別する停止コード |
| `workspace/src/product/state/guards.ts` | Local適用receiptの管理namespaceを許可 |
| `workspace/tests/support/memory-executor-store.mjs` | 条件付きLocal操作の合成Adapter |
| `workspace/tests/unit/wp05.test.mjs` | WP-05の正常・故障・取消・429・競合を試す28件 |

## 試験結果

| コマンド | 結果 |
|---|---|
| `$env:NODE_OPTIONS='--test-reporter=tap'; node tools/preflight.mjs`（ルート） | 10/10工程PASS。既存workspace保持 |
| `npm run build`（workspace） | PASS |
| `npm test`（workspace） | 全126件PASS（WP-05新規28件を含む） |
| `npm run check:boundary`（workspace） | PASS。`productCorrectnessVerified: false`は境界検査の範囲を示す |
| `node tools/verify-handoff.mjs`（ルート） | 11項目PASS。固定原本・出自に変更なし |
| `git diff --check` | PASS |

確認できたモデル動作：Local AからRemote Bのダウンロード更新は旧Aの復旧receipt後に条件付き反映し、適用証拠がある場合だけbaselineをBに更新。新規ダウンロードは適用前の不存在を記録し、途中で宛先に別内容が作られた場合は上書きしない。新規作成直後にreceipt保存が失敗した場合は、ファイルを残してbaselineを進めず、再起動時に証拠不足として分類する。アップロード元Bを固定した後にLocalがCへ変わっても、RemoteにBを公開しLocal Cを保持。復旧コピー失敗、開いているノート、第三版への変更では上書きしない。head PUTの応答消失は読戻しで公開済みか照合し、未採用なら確定しない。公開直後の取消は古いbaselineのまま再照合待ちとする。中断後の読取専用検査は、公開済み・未採用・head未変更を区別し、破損候補を要確認として止める。429が2秒のRetry-Afterを返したら2秒待ち、0秒でも同じheadへの次の送信開始を1秒以上離す。長い待機指示は短縮せず延期する。公開後の読戻しで429が続いても読取専用の再照合で採用を確認する。head競合では最大3回まで新しい承認済み計画へ進む判定を返す。

## 残作業

- 429の分類はメモリ内Adapterの明示エラーで試験した。実HTTPの429/Date/Retry-Afterヘッダー変換、初期化直後も含むhead間隔の保持、要求種別ごとの論理タイムアウトは未実装・未実測。
- head競合時の3回上限は適用したが、新しい計画の生成・利用者承認を自動化していない。中断後のRemote公開は読取専用で分類できるが、現在のpending記録は完全な計画を保持していないため、再起動後の安全な自動確定・再実行は未実装。複数操作の故障境界も追加する。
- WP-05指定のATモデルをケース単位で集約し、MVP 0.1対象67件についてモデル実施可否と実機必須部分を区別する。
- 実R2・Windows/iPhone実機・実Vaultの結果は未実施。`npm test`の126件を正式受入84件の合格数へ換算しない。

この段階でWP-05やMVP 0.1を完了扱いしない。GitHubへの送信はWP-00〜05の作業境界に従い行っていない。
