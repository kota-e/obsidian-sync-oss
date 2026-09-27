# ObsidianSyncOss

WindowsとiPhoneでObsidianを使う課題から始まり、低コストでも安全性を犠牲にせず、長く蓄積したノートを守る同期OSSを目指します。\
ノートは各端末のVaultに通常のMarkdownとして残し、クラウドは端末間同期の中継地点として扱います。\
速度・便利さ・機能数より安全性を優先し、状態が分からないときは推測せずに停止します。\
Remotely Saveの作者・Contributorとライセンスを尊重し、誰もが検証・改善できる公共的なOSSを目指します。

理念の全文は [PROJECT_PHILOSOPHY.md](PROJECT_PHILOSOPHY.md) を参照してください。理念を公開文書・警告文・Release notesへ反映する手順は
[PROJECT_COMMUNICATION_GUIDE.md](PROJECT_COMMUNICATION_GUIDE.md) に記載します。

ObsidianSyncOss is an independent open source project for exploring safe,
manual synchronization of Markdown notes between Windows/iPhone clients and a
Cloudflare R2 backed remote. The design emphasizes content hashes, conditional
updates, recovery copies, journals, and a clear stop when the state is not
known.

> **Development preview:** this repository is not an installable Obsidian
> plugin and is not ready for a real Vault, a real R2 bucket, or an iPhone.
> The current work is an offline core and test model. Do not place it in an
> Obsidian `plugins` directory or point it at personal data.

このプロジェクトは、ObsidianのMarkdownを安全に手動同期する仕組みを
検証するためのOSS開発中コードです。現在は合成データを使うオフラインの
コアと試験モデルだけで、実際のVault・R2・iPhoneで使えるプラグインではありません。

## Why this project exists

Syncing a Markdown Vault can lose information when two devices edit the same
file, a request finishes after the user has stopped it, or a read failure is
mistaken for an empty remote. This project turns those cases into explicit
plans, evidence, and reviewable stop states before any real file or remote
write is attempted.

The initial MVP target is manual Markdown new/update synchronization for
Windows and iPhone using Cloudflare R2. The target is deliberately narrower
than a general backup or background-sync product.

## Current status

The repository currently contains:

- a reviewed protocol and safety specification;
- a scope-limited, hash-pinned import set and its license notices;
- pure core code and in-memory test models under `workspace/`;
- synthetic fixtures and progress reports for the offline work packages.

The repository currently does **not** contain:

- an Obsidian plugin bundle or installer;
- a connected Obsidian Vault adapter;
- a connected R2 adapter or credentials;
- proof from Windows, iPhone, or a real R2 bucket;
- a stable release or a recommendation to use this with personal notes.

The test plan defines 84 acceptance cases. A passing offline model test proves
only the model's behavior. It does not prove that an Obsidian file API, an
iPhone, or R2 has the same behavior. Progress reports keep these levels
separate.

## Safety boundaries

The current MVP does not implement deletion propagation, attachments,
encryption at rest, background auto-sync, other storage backends, or telemetry.
Unknown remote state, incomplete listings, failed reads, stale plans, and
ambiguous write results must stop or remain pending. The project does not use
the current owner's Vault during development.

This project is independent. It includes selected code and ideas from
Remotely Save under the applicable notices; it is not an official successor,
fork claim, or drop-in replacement. See [`NOTICE`](NOTICE),
[`docs/SOURCE_IMPORT_MANIFEST.md`](docs/SOURCE_IMPORT_MANIFEST.md), and
[`docs/DEPENDENCY_LICENSE_REVIEW.md`](docs/DEPENDENCY_LICENSE_REVIEW.md).

## Safe offline check

The following commands work on a development copy and use the supplied
synthetic inputs. They do not connect to R2, GitHub, or an Obsidian Vault.

Requirements: Node.js 22 or later and npm. The vendored packages are used
offline; do not replace them with unreviewed latest versions.

```powershell
# Run from the repository root
$env:NODE_OPTIONS='--test-reporter=tap'
node tools/preflight.mjs

Set-Location workspace
npm test
npm run check:boundary

Set-Location ..
node tools/verify-handoff.mjs
```

`npm run test:product` runs the product model tests only. The acceptance
catalog remains a plan until each required environment and evidence record is
available. A successful offline command is not permission to use a personal
Vault or a production bucket.

## Read next

- [`START_HERE.md`](START_HERE.md) — project handoff and safe setup;
- [`docs/CODEX_IMPLEMENTATION_GUIDE.md`](docs/CODEX_IMPLEMENTATION_GUIDE.md) —
  work packages and completion rules;
- [`docs/IMPLEMENTATION_DECISIONS.md`](docs/IMPLEMENTATION_DECISIONS.md) —
  decisions that keep the implementation and tests separated;
- [`docs/obsidian_sync_oss_detailed_spec_v1.0_20260906.md`](docs/obsidian_sync_oss_detailed_spec_v1.0_20260906.md)
  — protocol and safety baseline;
- [`progress/`](progress/) — implementation reports and remaining gates.

## Roadmap

1. Finish the offline core and independent negative tests.
2. Prepare an explicitly disposable R2 prefix and test Vault, then run the
   smallest read and write capability probes.
3. Add the Windows/iPhone adapters and manual UI only after those capability
   gates pass.
4. Test recovery, interruption, conflicts, and read-only export with the
   required evidence.
5. Recheck dependency provenance, security reporting, user documentation, and
   release packaging before considering a public plugin release.

The project may be visible as an early source preview while this roadmap is in
progress. Public source visibility must not be read as product readiness.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the safe development workflow.
Please keep reports reproducible and do not include personal Vault contents,
R2 credentials, API keys, or private logs in issues or pull requests.

## License and notices

Original project-owned additions are provided under the Apache License 2.0.
Selected third-party and derived components keep their own license and
attribution requirements. Read [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and
the files under [`approved-base/licenses/`](approved-base/licenses/) and
[`workspace/licenses/`](workspace/licenses/) before redistributing a build.
