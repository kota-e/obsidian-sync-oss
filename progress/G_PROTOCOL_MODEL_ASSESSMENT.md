# G-PROTOCOL モデル評価

評価日：2026-09-25
判定：**PASS_MODEL_ONLY**
範囲：型・実行時schema、ST/IN状態表、祖先・revision/capability整合、CASの合成モデル試験。

## 判定根拠

詳細仕様§A.2のG-PROTOCOLは、上記のモデル試験を要求する。実装ガイドのWP-05完了条件も、モデル条件の確認と、実通信・実Vault操作がまだ0であることを求める。本評価はメモリ内Storeと固定fixtureのassertに限り、実R2・Windows/iPhone・利用者Vaultの合格や統合版の配布許可を示さない。

| 条件 | 直接assertの根拠 | 確認した期待と結果 |
|---|---|---|
| 型・実行時schema | `workspace/tests/unit/wp01.test.mjs` — `AT-47: canonical JSON exact golden value, duplicate keys, depth, surrogate and unknown form`、`AT-15/47 core: valid remote records parse, unknown fields and capabilities fail` | canonical JSONの独立期待値と正常snapshotを確認。重複key、非正規JSON、深さ超過、未知field/capability、不正なtombstoneを拒否。 |
| 全状態表 | `workspace/tests/unit/wp02.test.mjs` — `ST-01..11: table decisions use content hashes and distinguish uncertain states`、`IN-01..07: new-client table never picks a winner or revives tombstones` | ST 11行、IN 7行それぞれのrule/kind/errorを期待値と比較。競合時に勝者を選ばず、削除済み内容を新規作成しない。 |
| head/commit/manifest・祖先整合 | `workspace/tests/unit/wp01.test.mjs` — `AT-18/58 core: cross-record hash, generation and immediate parent linkage fail closed`。`workspace/tests/unit/wp03.test.mjs` — `history rejects rollback, a sibling branch, missing parent and altered parent bytes`、`history proof chunks at 128 and accepts 4096, but refuses 4097 without resetting anchor` | 識別子/hash/世代/親リンク不一致を拒否。祖先の巻戻り、分岐、欠損、改変を拒否し、128世代の継続、4096上限、改変cursor、4097超過をassert。 |
| 循環祖先 | `workspace/tests/unit/wp05-g-protocol-negative.test.mjs` — `cyclic Remote ancestry stops in history proof before any write` | 同一commit IDの再訪を`E_REMOTE_HISTORY_CHANGED`で停止し、fixtureのkey集合不変、immutable PUT 0、head PUT 0をassert。v1の有効な親鎖ではgenerationが1ずつ減るため循環は成立しない。テストは矛盾する循環fixtureを作り、世代進行と再訪ガードが安全停止することを検査する。 |
| revision整合 | `workspace/tests/unit/wp02.test.mjs` — `ST-02 and IN-02: update keeps old revision; new create has no old revision; staging is only reserved`、`workspace/tests/unit/wp03.test.mjs` — `upload update verifies old A, stages B/manifest/commit, then conditionally publishes head`。追加：`wp05-g-protocol-negative.test.mjs` — `proposed revision with an unrelated parent is rejected before immutable or head writes` | 更新は直前revisionを親にし、新規作成は親なし。無関係revisionを親にした承認済み提案は`E_METADATA_INVALID`で拒否し、既存key集合不変、immutable PUT 0、head PUT 0をassert。 |
| capability整合 | `workspace/tests/unit/wp01.test.mjs` — `AT-15/47 core: valid remote records parse, unknown fields and capabilities fail`。追加：`wp05-g-protocol-negative.test.mjs` — `manifest capabilities that disagree with the head fail record validation before snapshot; zero writes` | 未知・重複capabilityを拒否。MVP v1は完全・重複なし・ソート済みの固定集合`identity-content-v1`, `manifest-v1`だけを許すため、両方が単体で有効なのに異なる集合は構成できない。追加fixtureのmanifestは不完全な集合なので、head/manifest間の有効集合比較を試すものではなく、無効recordの拒否とwrite 0を確認する。 |
| CASと不明結果の照合 | `workspace/tests/unit/wp03.test.mjs` — `two clients on different paths: stale CAS cannot erase first update; replan preserves both`、`two clients on the same path: stale CAS leads to conflict and preserves both bytes`、`unknown head response is reconciled from tip or unchanged ETag, never from orphan commit`、`orphan candidate after another client wins is classified as not adopted`、`unknown commit can be proven in verified ancestry after another Remote update` | 競合時に無条件上書きをせず、異なるpathの変更を保持。同一path競合を検出。応答不明を採用済み・未採用・祖先採用へ分類し、盲目的な再送に進まない。 |
| WP-05再試行境界 | `workspace/tests/unit/wp05.test.mjs` — `safe reads retry transient failure; CAS is never blindly retried`、`retry has four-attempt cap and respects Retry-After / remaining time`、`repeated 429 stops after four total head attempts`、`stale head permits at most three new approved replans`、`fourth stale head reaches replan limit without changing baseline` | 読取再試行とCAS結果不明を分離し、4試行上限・Retry-After・延期・3回の再計画上限を確認。通常再試行上限と再計画上限を混同しない。 |

上表の既存テストについては、親が2026-09-25に全体`npm test`を再実行し、250/250 PASS（失敗・skip 0）を確認した。新規否定試験3件は個別実行でも3/3 PASSを確認した。

## 実行結果と境界

- 追加否定試験は本評価で `node --test --test-isolation=none tests/unit/wp05-g-protocol-negative.test.mjs` を実行し、**3/3 PASS**。通常のNode test isolationでは実行環境の`spawn EPERM`が出たため、同じ3テストをisolationなしで実行して確認した。
- 全体の`250/250 PASS`は親の再実行結果。個々の根拠は上表の実際のassertを読んで対応づけた。このゲートの対象根拠は上表の試験に限定する。
- 新しい純粋pending-recovery plannerはこのゲート判定に算入していない。再起動後の復旧・確定は別のG-RESTART判定で扱う。
- 実HTTP/R2、Windows/iPhone API、実端末保存領域、実Vault、配布前の統合試験は未実施。`PASS_MODEL_ONLY`を実機PASS、G-R2/G-LOCAL/G-CLIENT-STATE/G-RESTARTの合格、または配布許可へ読み替えない。

## 出典

- [詳細仕様 §A.2 必須ゲート](../docs/obsidian_sync_oss_detailed_spec_v1.0_20260906.md)（G-PROTOCOLの定義）
- [実装ガイド WP-05/WP-06](../docs/CODEX_IMPLEMENTATION_GUIDE.md)（WP-05のモデル完了条件とWP-06実API probeの範囲）
- 実装・assert：`workspace/src/product/metadata/remote-schema.ts`、`workspace/src/product/protocol/history.ts`、`workspace/tests/unit/wp01.test.mjs`、`wp02.test.mjs`、`wp03.test.mjs`、`wp05.test.mjs`、`wp05-g-protocol-negative.test.mjs`
