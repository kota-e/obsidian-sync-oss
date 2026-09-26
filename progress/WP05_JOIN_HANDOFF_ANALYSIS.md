# WP-05 既存Remote参加から通常同期への接続調査（2026-09-25）

**状態：未実装の設計調査。** この文書は実装許可やAT-06合格を意味しない。実R2・実Vault・Windows/iPhoneの確認はしていない。

## 現行の接続不足

- `planner/plan.ts`の`session:'joining'`はbaselineなしの計画を作り、`baseCheckpointSequence=0`にする。
- `executor/run.ts`の通常実行は`loadCheckpoint`で保存済みcheckpointを要求し、計画の基準番号と厳密に一致させる。番号0の参加計画は直接実行できない。
- `state/checkpoint.ts`の`saveCheckpoint`はClientStore下限0からcheckpoint番号1を保存できる。ただしこの初回分岐では既存slotの検査を省くため、残存slotや部分状態があるまま呼ぶと安全でない。
- 現在の`ClientStore`と内部Storeには、新しいinstallation/device ID、owner marker、空状態を一体として作成・列挙する製品入口がない。

## 安全な接続案

1. 参加用計画はプレビュー専用とし、承認済みの番号0計画を番号1に書き換えない。
2. 既存Remoteのhead・commit・manifest、vaultId・epochId・capability・hashを検証する。head不在・読取不能・不整合を空Remoteやbootstrapの根拠にしない。
3. 専用のローカル初期化で、両checkpoint slot、journal、pending、ownership、identity、ClientStoreが新規または完全に一致する状態であることを確認する。残存・部分状態は通常同期へ渡さず停止する。
4. 新しいinstallationId/deviceIdと両owner marker、ClientStoreの初期markerを確立し、検証済みRemote headを最初の信頼アンカーにした空baselineのcheckpoint番号1を保存する。`loadCheckpoint`で再読込し、保存完了を確認する。
5. LocalとRemoteを再観測し、`session:'existing'`、検証済み空baseline、checkpoint番号1で新しく計画する。この新計画に別途承認を得てから通常Executorへ渡す。受信した各ファイルの適用・内容確認が済んだ場合だけbaselineを進める。

既存Remoteへの参加はRemote読取と端末側の状態作成だけを許す。空manifestの公開・Remote初期化は別のbootstrap手順とする。

## 再起動と故障の境界

- 初回slot書込、ClientStore下限更新、`CHECKPOINT_SAVED` journalの各間で終了する場合を区別する。通常Executorは未完成の初期化を引き取らない。
- 再開を実装する場合は専用join intentと既存bytes・ID・Remote anchorの完全一致を条件にする。journal sequence予約後の欠番を推測で補修しない。
- 既存slot、journal、pending、owner不一致、ClientStore不一致を新規状態と扱わず、上書きしない。

## 合成試験と残る契約

`workspace/tests/unit/wp05-at06-new-join.test.mjs`は参加計画と、初回checkpoint済みのDownload実行を**別々に**検査した。両者をつなぐ製品入口は未実装で、AT-06のモデル判定は部分のまま。

接続実装時には正常参加、同名別内容の競合、head不在・破損・別identity、残存内部ファイル、ClientStore不一致、slot→ClientStore→journalの各故障を検査する。全ケースでRemote head・manifest・commitへの書込0を確認する。実adapterの完全な内部状態列挙、owner/identity作成、空状態の排他的確認は別途契約が必要。
