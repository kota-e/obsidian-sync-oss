# Reviewer Guide

This guide is a short map to the project's purpose, current evidence, and technical sources. It is not a product-readiness claim or a full translation of the Japanese source documents.

## Purpose and values

The project began with the practical need for affordable Obsidian synchronization between Windows and iPhone. Its goal is to reduce the risk to long-lived notes while keeping ordinary Markdown in each local Vault and treating cloud storage as a relay. Safety takes priority over speed and convenience: when the state cannot be established, the design calls for stopping and preserving evidence rather than guessing.

See [PROJECT_PHILOSOPHY.md](PROJECT_PHILOSOPHY.md) for the full philosophy in English, and [README.md](README.md) for the current project overview. The philosophy is a statement of goals and decision principles, not evidence that the product is complete or that data loss is impossible.

## Current implementation and evidence

This repository is an offline development preview. It contains pure core code, synthetic fixtures, and in-memory models. It is not an installable Obsidian plugin and has no connected R2 or Vault adapter.

The latest recorded test run in the project reports is npm test with 482/482 passing on 2026-09-25. This guide did not rerun that command. The same report records passing boundary and handoff checks; those checks and model tests do not establish real-service or device behavior.

Formal acceptance testing is not complete. The test plan defines 84 cases, of which 67 are MVP 0.1 targets. Individual acceptance statuses remain distinct from unit/model test counts; the WP-05 report is still marked IN_PROGRESS. The latest recorded WP-05 coverage audit did not change formal AT result statuses.

Real R2 behavior, real Vault reads and writes, and Windows/iPhone operation have not been verified. The WP-06 record is a review of public API documentation only: it did not run a probe, connect to R2, or use a real Vault. No iCloud implementation is included; its requirements are future-facing and require a separate design.

Evidence links:

- [WP-05 implementation report](progress/WP05_REPORT.md) — Japanese progress record.
- [WP-05 acceptance coverage audit](progress/WP05_AT_COVERAGE.md) — Japanese model-coverage analysis, separate from formal AT status.
- [WP-06 API audit](progress/WP06_OFFLINE_API_AUDIT.md) — Japanese public-document audit with no runtime probe.

## Short technical orientation

The detailed protocol uses three content states:

| Symbol | Meaning |
| --- | --- |
| **L — Local** | The current file bytes actually read from this device's Vault. |
| **R — Remote** | The version referenced by a validated remote manifest. |
| **B — Baseline** | The last version with evidence that it was common to this device and the Remote. It is not a timestamp. |

The design compares content hashes rather than relying on modification times. If L and R both differ from B and also differ from each other, the path is a conflict and the 0.1 plan stops before transferring unrelated changes. If L and R contain the same bytes, the design can confirm them as equal. A read or listing failure is not interpreted as absence or deletion.

Remote publication is designed around immutable content and manifest objects followed by a conditional update of one small head pointer. Compare-and-swap (CAS) means the head is updated only if it still matches the version that was read: an existing head uses a matching condition, and initial creation uses an absent-only condition. If another client changes the head first, the stale update is not accepted and the plan must be reconsidered.

Before replacing a Local file, the design preserves and verifies recovery data, then checks that the current Local bytes still match the expected old version. A write whose result is unknown is not blindly retried or called a success or failure. The client first reconciles the current state from read evidence; after restart, an old operation is evidence to inspect, not a command to replay. A new plan must be based on current state. These are protocol requirements; their presence in the specification does not mean every production adapter or device path is implemented or verified.

The authoritative technical baseline is the Japanese [detailed specification v1.0](docs/obsidian_sync_oss_detailed_spec_v1.0_20260906.md), alongside the [implementation decisions](docs/IMPLEMENTATION_DECISIONS.md), [test plan](docs/TEST_PLAN.md), and progress records. This English orientation summarizes selected safety concepts and does not amend those documents.

## Remotely Save provenance and license boundary

The scope-limited [source import manifest](docs/SOURCE_IMPORT_MANIFEST.md) identifies two reused functions from Remotely Save v0.4.25, commit 08027677267934d3a1ca6f6e3cf06ee1be53ee52: copyArrayBuffer and getSplitRanges, with the SplitRange interface. The manifest records the selected material under the upstream Apache License 2.0 and identifies the source and retained notices. The project's [NOTICE](NOTICE) credits fyears and contributors.

This is a limited reuse record, not permission to copy the wider upstream project. It excludes Pro code, the legacy synchronization engine, UI, branding, and unreviewed dependencies. The project is independent and is not an official successor or an endorsed replacement. It does not aim to make paid features available for free without authorization or to deny Remotely Save's value; it cannot guarantee that an independent public project has no effect on another project's usage or revenue. See the [dependency license review](docs/DEPENDENCY_LICENSE_REVIEW.md) for the separate third-party dependency boundaries.

## Roadmap

The documented sequence is:

1. Complete the offline core and independent negative tests.
2. Prepare an explicitly disposable R2 prefix and test Vault, then run narrowly scoped capability probes.
3. Add Windows and iPhone adapters and a manual interface only after the capability gates pass.
4. Verify recovery, interruption, conflicts, and read-only export with the required evidence.
5. Recheck dependency provenance, security reporting, user documentation, and release packaging before considering a public plugin release.

See [README.md](README.md) and the Japanese [implementation guide](docs/CODEX_IMPLEMENTATION_GUIDE.md) for the work-package sequence and release gates. Public source availability does not mean the roadmap is complete.

## Japanese historical source documents

The project retains its detailed specification, test plan, and source/license audit as Japanese verification records. The links below point to those source documents; this guide is a selective English map, not their full translation:

- [Detailed synchronization specification v1.0 — Japanese source](docs/obsidian_sync_oss_detailed_spec_v1.0_20260906.md)
- [Test plan — Japanese source](docs/TEST_PLAN.md)
- [Source import manifest — Japanese source](docs/SOURCE_IMPORT_MANIFEST.md)
- [Dependency license review — Japanese source](docs/DEPENDENCY_LICENSE_REVIEW.md)
- [Implementation decisions — Japanese source](docs/IMPLEMENTATION_DECISIONS.md)
- [iCloud requirements — Japanese source](docs/ICLOUD_REQUIREMENTS.md)

These records remain the source for their detailed technical requirements and audit evidence. Use the corresponding reports for status, and do not treat this guide as a substitute for the specification, test cases, or license notices.
