# Contributing to ObsidianSyncOss

Thank you for helping improve the project. It is an early source preview, so
the safest contribution is a small, reviewable change with a clear test and a
clear statement of what remains unverified.

Read [PROJECT_PHILOSOPHY.md](PROJECT_PHILOSOPHY.md) for the project's purpose
and values. It records project intent; the detailed specification, test plan,
implementation decisions, and license audit remain the sources for concrete
technical requirements and reuse permissions.

For applying the philosophy to public descriptions, warnings, and release
notes, see [PROJECT_COMMUNICATION_GUIDE.md](PROJECT_COMMUNICATION_GUIDE.md).

## Project values and safety rules

### Safety First

- Never treat a communication or read failure as a file deletion.
- When Local and Remote have both changed, do not silently choose one side.
- Preserve the recovery information needed before overwriting or deleting data.
- Do not automatically carry out large destructive changes.
- Do not guess whether an operation with an unknown outcome succeeded or failed; reconcile it with evidence or stop.
- Do not replay an old operation unchanged after restart; check current state and operation validity first.
- Do not roll back a user's newer edit to accommodate synchronization.

Do not weaken these rules to simplify implementation or make a test pass.

### Attribution, source, and licenses

- Describe this as an independent project influenced by Remotely Save. Keep the original author and contributor credits, source references, and required notices.
- Use only code whose source and license have been reviewed and whose reuse is permitted. Do not use unauthorized Pro code.
- Respect each confirmed license and preserve its notices. A license review for selected components does not grant permission to copy the rest of an upstream project.
- Do not describe the project as an official successor or imply approval from the original author.
- The project does not aim to convert paid features into unauthorized free features or to deny the value of Remotely Save. Public OSS may still affect another project's usage or sales, so do not promise that there will be no sales impact.

### AI-assisted changes and conflicts

Review AI-generated changes against the specification, code provenance, license conditions, tests, failure cases, regressions, and—when required—Windows and iPhone devices. Do not change expected test results in an unsafe direction to fit an implementation.

If a principle conflicts with a technical requirement or a license condition, document the exact conflict, available choices, and safety impact, then report it for resolution. Do not silently choose an interpretation that weakens safety or expands reuse permissions.

## Before changing code

Read these documents in order:

1. [`START_HERE.md`](START_HERE.md)
2. [`docs/CODEX_IMPLEMENTATION_GUIDE.md`](docs/CODEX_IMPLEMENTATION_GUIDE.md)
3. [`docs/IMPLEMENTATION_DECISIONS.md`](docs/IMPLEMENTATION_DECISIONS.md)
4. [`docs/obsidian_sync_oss_detailed_spec_v1.0_20260906.md`](docs/obsidian_sync_oss_detailed_spec_v1.0_20260906.md)
5. the relevant test plan and progress report

The protocol specification and the source import manifest are the boundaries
for the current work. If a real contradiction is found, record the rule,
impact, and proposed decision instead of silently weakening the behavior.

## Scope rules

- Put new product source in `workspace/src/product/`.
- Put product tests in `workspace/tests/unit/` or
  `workspace/tests/acceptance/`.
- Keep `approved-base/`, its manifests, checkers, notices, and source files
  byte unchanged. It is an audit reference.
- Keep supplied fixtures unchanged; inject faults into a temporary copy.
- Record implementation results and decisions under `progress/`.
- Do not add an Obsidian SDK, bundler, HTTP client, or other dependency
  without a separate provenance and license review.
- Do not add deletion propagation, attachments, background auto-sync,
  encryption claims, telemetry, or a new backend to the MVP without an
  explicit scope decision.

Do not connect a real Vault, R2 account, or personal data while working on the
offline packages. A disposable test scope must name its target, data limits,
operations, and cleanup plan before an external probe is added.

## Local checks

Use Node.js 22 or later. From the repository root:

```powershell
$env:NODE_OPTIONS='--test-reporter=tap'
node tools/preflight.mjs

Set-Location workspace
npm test
npm run test:product
npm run check:boundary

Set-Location ..
node tools/verify-handoff.mjs
```

The preflight and handoff checks protect the inherited reference set. Do not
edit a hash or disable a check to make a result pass. If a command cannot run,
report the exact command, exit result, environment, and whether any side
effect occurred.

Tests must use controlled clocks, IDs, and I/O. Expected values should come
from an independent fixture or oracle rather than calling the production
helper that the test is meant to check. Negative tests should verify both the
typed failure and the absence of forbidden writes.

## Pull requests and issues

For a pull request, describe:

- the problem and the relevant specification or rule;
- the files changed and why they are in the allowed directory;
- the tests run and their exact results;
- any acceptance cases that remain `NOT_RUN`, `PASS_MODEL_ONLY`, or
  otherwise require a real environment;
- dependency, license, provenance, or documentation changes.

Keep one focused change per pull request when possible. Do not describe an
offline model result as Windows, iPhone, R2, or real-Vault validation. Do not
claim a stable release, data-loss prevention, or zero-data-loss guarantee
without the required evidence.

For an issue, include a small synthetic reproduction where possible. Remove
note contents, account identifiers, access tokens, URLs containing secrets,
and private logs. Security reports have a separate process in
[`SECURITY.md`](SECURITY.md).

## Attribution and license

The project is independent and retains the notices for selected Remotely Save
material and the aws4fetch-derived signer. Contributions to original project
files are released under the Apache License 2.0 unless a different license is
stated for the affected file or dependency. Preserve third-party notices when
copying or changing those files.
