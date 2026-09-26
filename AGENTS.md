# Project instructions — Obsidian sync OSS

## First read
Read `START_HERE.md`, `docs/CODEX_IMPLEMENTATION_GUIDE.md`, `docs/IMPLEMENTATION_DECISIONS.md`, then the current detailed specification and relevant test cases. Do not rely only on this short file or previous chat memory.

## Scope and authority
- MVP 0.1 only: Windows/iPhone, R2, Markdown new/update/manual sync. Start with pure logic and in-memory adapters.
- `docs/obsidian_sync_oss_detailed_spec_v1.0_20260906.md` is the safety/protocol baseline. `docs/G_BASE_COMPLETION_REPORT.md` + `docs/SOURCE_IMPORT_MANIFEST.md` define the scoped imports.
- `docs/IMPLEMENTATION_DECISIONS.md` resolves handoff details without weakening safety. A real contradiction must be recorded and resolved; never silently choose a weaker rule.
- Older v0.1 and audit HOLD documents are historical, not current permission.

## Directories
- `approved-base/` is a byte-pinned reference. Do not edit its source, package, checker, manifest or notices. Only offline installation/build outputs are permitted there.
- Run `node tools/preflight.mjs` from this root before implementing. It creates `workspace/` only if absent. It never overwrites an existing workspace.
- Add new project source under `workspace/src/product/`; product tests under `workspace/tests/unit/` and `workspace/tests/acceptance/`. Keep existing inherited/source inputs unchanged.
- Record progress and decisions under `progress/`. Do not update the immutable baseline hashes to make a failing check pass.

## Safety constraints
- Do not read, copy, scan, move, edit or delete the owner's actual Obsidian/iCloud Vault. Use the supplied synthetic fixtures.
- No R2/cloud/HTTP calls, new subscriptions, GitHub push, npm publish, real API keys or personal data during WP-00..05. Real probes require separate explicit disposable scope approval.
- Do not add an external dependency, SDK, copied PR, Pro source, branding, submodule or build tool without a scoped license/provenance review. Do not run upstream install scripts.
- Never remove content-hash verification, conditional head updates, recovery copies, journal evidence, validation, unknown-outcome reconciliation or test assertions to make execution succeed.
- No deletion propagation, attachments, E2EE, iCloud implementation, background auto-sync, other backends or telemetry in MVP 0.1.
- Mock success is not real R2/Windows/iPhone success. No product test exists at handoff; report NOT_RUN accurately.
- No security bypass flags. Keep workspace-limited file access. A permission failure is not a reason to enable unrestricted access.

## Work protocol
1. Run the preflight; stop on an integrity/provenance failure.
2. Implement only the work package requested in `CODEX_START_PROMPT.md`. First task is WP-01, not the whole plugin.
3. Write independent expected-value and negative tests. Use controlled fake time/IDs/I/O. Do not call production helpers to manufacture every expected value.
4. Run `npm test` and `npm run check:boundary` inside workspace. Run `node tools/verify-handoff.mjs` at root to confirm references stayed unchanged.
5. Report changed files, rules/tests covered, exact commands/outcomes, remaining NOT_RUN and blockers. Create `progress/WP01_REPORT.md` (or the applicable task report).
6. Do not claim MVP completion, stable release, all 84 tests passed, or general G-BASE approval from the seed tests.

## Language and attribution
Explain progress and usage in Japanese. Preserve Apache/MIT/third-party notices. Describe the project as independent, with selected code and ideas from Remotely Save. Do not call it an official successor or drop-in replacement.
