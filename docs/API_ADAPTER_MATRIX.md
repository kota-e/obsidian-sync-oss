---
title: "API・Adapter対応表と能力検証手順"
version: "1.0"
date: 2026-09-06
status: "Ready for Implementation / Product Not Implemented"
document_type: "api-adapter-matrix"
production_use_approved: false
tags: [obsidian, oss, codex, handoff, mvp01]
---

# API・Adapter対応表と能力検証手順

> **結論：承認済みなのは小さな署名・補助部品であり、通信・ファイル操作の能力は実機で別に確認する。未対応能力は書き込みを閉じる条件にする。**

## 1. 状態ラベル

`APPROVED_INPUT`=G-BASEの固定部品として許可、`DESIGN_CONTRACT`=要求の定義、`CANDIDATE_NOT_PROBED`=API候補で未実測、`DEFERRED`=初期範囲外。APPROVED_INPUTでも実R2/実Obsidianでの動作確認にはならない。

現時点ではすべての実API能力probeがNOT_RUN。実機の証拠が必要なものを文書確認でPASSにしない。

## 2. 対応表

| ID | 境界/能力 | 採用・候補 | 状態 | 検査/ゲート | 不成立時 |
|---|---|---|---|---|---|
| API-01 | SHA-256/UUID安全乱数 | Web Crypto、注入可能な薄い自作境界 | DESIGN_CONTRACT | bytes vectors、実Win/iPhone API存在と結果 | Math.random/時刻IDに代替せず停止 |
| API-02 | 署名のみ | 固定aws4fetch派生+signR2Request | APPROVED_INPUT | 既存部品30件、実署名受理はG-R2 | 未署名・条件除去で送信しない |
| API-03 | HTTP送受信 | Obsidian HTTP APIまたは検証済みfetch系Transport | CANDIDATE_NOT_PROBED | status/header/bytes、CORS、redirect、取消、上限 | 通常通信を有効にしない |
| API-04 | 条件付きPUT | R2 S3 PutObjectのIf-Match/If-None-Match | DESIGN_CONTRACT | stale条件、作成競合、応答消失、G-R2 | 無条件PUT禁止 |
| API-05 | 上限付き読取 | ETag固定Range、または停止可能なbounded stream | DESIGN_CONTRACT | HEAD長、206、範囲、変換、AT68〜70 | 全量buffer後チェックに落とさない |
| API-06 | 完全LIST/XML | S3 ListObjectsV2、query署名、選定後のXML処理 | CANDIDATE_NOT_PROBED | token/2page/failure/DTD/上限、G-R2 | 部分一覧を返さない |
| API-07 | ノート読取/スキャン | Vault.getFiles/read/readBinary等の公開API候補 | CANDIDATE_NOT_PROBED | 完全性・内容・hidden・0byte、G-LOCAL | 読めないを不在にしない |
| API-08 | ノート非上書き作成 | Vault.create候補 | CANDIDATE_NOT_PROBED | 同名/別case/親型競合、G-LOCAL | exists→無条件writeに代替しない |
| API-09 | ノート条件付き更新 | Vault.process候補 | CANDIDATE_NOT_PROBED | callback直前競合・開タブ・BOM、G-LOCAL | direct write禁止 |
| API-10 | hidden state/recovery | 制限付きDataAdapter境界 | CANDIDATE_NOT_PROBED | ownership、保存/読戻し/衝突/終了、G-LOCAL | 任意pathを受け付けない |
| API-11 | 端末固有マーカー | Appのlocal storage API等候補 | CANDIDATE_NOT_PROBED | 保存範囲・複製・消失・下限、G-CLIENT-STATE | 架空OS IDを生成して続行しない |
| API-12 | 停止/実行世代 | Plugin lifecycle、前面状態候補+core token | CANDIDATE_NOT_PROBED | callback未発火終了、遅延応答、G-RESTART | unloadが必ず来る前提禁止 |
| API-13 | readonly export | Windows専用の空出力先Adapter/小ツール | DESIGN_CONTRACT | AT42/81、G-MIGRATION | 元Vaultへ自動書戻し禁止 |
| API-14 | SDK/bundler | 必要時に正確な版を選定 | CANDIDATE_NOT_PROBED | license/transitive/import/bundle監査 | 一括npm install禁止 |
| API-15 | バイナリ条件付き置換/hidden move | 将来の専用Local Adapter | DEFERRED | G-DELETE/0.2契約 | 0.1へ混ぜない |
| API-16 | iCloud Drive操作 | 要件書のみ | DEFERRED | 将来IC-GATE | S3と同じ機能だと仮定しない |

Obsidian Vault、モバイル制約とR2の公開APIは[一次資料一覧](EXTERNAL_REFERENCES.md)に根拠を置いた。具体的なSDK型の版や端末の保存特性は、採用時点で確認する。取得できなかったAPI索引を読めたことにしない。

## 3. Transport契約

署名層はmethod/url/header/bodyを固定し、送信層だけがHTTPを行う。実行側はstatusとS3 error name、対象文脈を保持して分類する。403/timeout/parse failureを404/空bytesへ変更しない。SDKの自動retryは使わず、Executorの有限retryへ一元化する。

redirectは最終URLを見て事後拒否するだけでは不十分。資格情報を転送する前に追従を止められる経路を選ぶ。候補APIがその制御を公開していない場合は不成立。一般的なrequestUrlに都合のよいオプションを創作しない。

上限付き受信ではHEAD長が既知でも受信時の同一ETag条件が必須。HEAD後に巨大化したobject、Range無視、変換、長さ不一致は停止。ArrayBufferを読み切ってからStreamで包んだ処理をストリーミング制御と呼ばない。

LISTのqueryを既存key欄へ直接`?list-type=2`として詰め込まない。prefix/continuation-tokenを専用に検証・一回だけencodeし、署名対象へ含める別関数を追加する。秘密値をqueryに入れない。XMLは外部実体/DTD/過大ネストを拒否し、エスケープされたキーを任意URL/pathとして解釈しない。parser導入は差分監査対象。

## 4. R2 probeの実施計画（まだ実行しない）

### 事前条件

Kotaさんがテスト専用のR2 Standardバケットまたは検証prefixを明示して許可する。権限は対象バケットに限定する。プラグインはAdmin権限・バケット公開・Lifecycle変更を要求しない。既存のRemotely Save領域と本番ノートは使わない。

probeデータは固定の非機密文字列、通常は各数百バイト。容量上限試験はモデル/制御した偽応答で行い、不必要に巨大ファイルを本物のR2へ送らない。キーは`svsync-probes/<deviceId>/<probeId>/conditional-write-test`を基準とし、追加キーが必要ならその一覧を先に許可する。

### 手順

| 順 | 操作 | 合格条件 |
|---|---|---|
| P-R01 | 条件付き新規PUT→HEAD/GET | bytesとquoted ETagを保って読み戻せる |
| P-R02 | 同じkeyへ再びIf-None-Match | 412となり既存内容不変 |
| P-R03 | 正しいETagのIf-Match更新、その後古いETag再使用 | 正しい方だけ成功、古い条件は拒否 |
| P-R04 | PUTの採用後、アプリ側が応答を捨てる | outcome unknownを記録、GET照合で確認、Local適用しない |
| P-R05 | ETag固定Range/0byte | 正しい206と範囲、0byte別経路、全bytes一致 |
| P-R06 | LIST MaxKeysを小さくし複数ページを確認 | token完全性、prefix限定、途中新規追加をsnapshotと誤認しない |
| P-R07 | 署名後の可変入力変更、偽redirect、429の制御応答 | 認証転送0、固定body、規定待機と分類 |
| P-R08 | 前面終了/再起動、保存された未知結果を再照合 | 旧callbackから新contextを書き換えない |

同一keyへの送信間隔は仕様どおり1秒以上とし、429を出すための連打・負荷試験はしない。応答429の負試験は模擬する。専用prefixの実接続は課金に影響する可能性があるため、回数・bytes・残留objectを報告する。probe終了時の自動DELETEは実装せず、後の管理者による手動整理と区別する。[R2制限](https://developers.cloudflare.com/r2/platform/limits/)

## 5. Windows/iPhone Local probe

別の空ローカルテストVaultにだけminimal pluginを導入する。既存iCloud Vaultに複製したPluginを置く手順にはしない。以下を双方で独立に実行する。

| probe | 条件 | 合格条件 |
|---|---|---|
| P-L01 | UTF8/BOM/CRLF/非BMP/0byte読取と保存 | 元bytes一致または変更せず非対応停止 |
| P-L02 | 同名/大小文字/親フォルダ型競合でcreate | 既存を置換しない |
| P-L03 | process callback直前に第三の版へ変更 | 内容不一致で拒否、追加入力保持 |
| P-L04 | 開いているノートを受信更新 | 閉じるまで延期、閉じた後も再照合 |
| P-L05 | hidden内部領域の所有者不明・書込失敗 | 勝手に初期化しない、復旧なし更新0 |
| P-L06 | journal/receipt/checkpointの各保存境界で中断 | 証拠と現物の照合、古いcheckpoint単独続行なし |
| P-L07 | 一覧読取不能/placeholder/パス型不明 | 不在/安全へ変換せず保留 |

Node fsだけで成功したテストは、Vault APIのprobeではない。エミュレーションと実iPhoneを記録上分ける。

## 6. ClientStore probe

API索引にメソッド名が見えるだけでは採用しない。使用する公開型を固定版で確認し、(a)再起動、(b)Vaultファイルだけコピー、(c)他Vault、(d)アプリデータ消去、(e)保存例外、(f)journal予約後終了を調べる。期待は「Vaultコピーだけでは同じinstallation markerを引き継がない、marker不明は停止」。OS全体のバックアップ複製まで検出できるとは言わない。

この能力が使えなければ`G-CLIENT-STATE=FAIL`。毎回ランダム再生成して既存pendingを信頼する回避は禁止する。代替保存方式を改めて設計・検証する。

## 7. 証跡・権限・失敗報告

`templates/api-probe-result.json`へ、probe ID、対象実機、OS/Obsidian/SDK、bundle hash、source commit、条件、actual、期待、送信回数、bytes、secretを除いた応答、残留object、判定を保存する。確認日が古い能力結果を、新SDKへ無条件流用しない。

利用者の認証情報はメモリのみ。共有ログにはAuthorization、鍵、本文、完全account/bucket/pathを出さない。スクリーンショットに秘密欄があればマスクする。

**これらのprobeはMVPコア実装後に行う必要がある検証であり、今回の資料完成を偽の実機PASSで埋めない。** 今すぐ着手するWP-01には追加SDKもR2アカウントも不要である。
