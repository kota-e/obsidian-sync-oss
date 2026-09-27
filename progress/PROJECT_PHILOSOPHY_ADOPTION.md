# Project Philosophy Adoption Record

Date: 2026-09-27

## Decision

The philosophy provided by the user was recorded in PROJECT_PHILOSOPHY.md and is treated as a governing principle for future project decisions. The philosophy states goals and decision criteria; it does not prove that a feature has been implemented or that the system is safe. Read it alongside the detailed specification, test specification, and license audit. If they conflict, report the affected passages, options, and safety impact and request a decision. Do not weaken a requirement by making an independent interpretation.

## Cross-check against existing contracts

| Principle | Reference | Assessment |
| --- | --- | --- |
| Do not treat communication failure as deletion; stop when both sides changed | Detailed Specification v1.0, §2.1 SI-001/003 and §2.2 SG-006 | Consistent |
| Preserve recovery information; do not automate large destructive changes | Detailed Specification v1.0, §2.1 SI-004/006 and §2.3 | Consistent. The MVP 0.1 prohibition on deletion propagation remains in force. |
| Do not guess unknown outcomes, replay old operations, or roll back newer edits | Detailed Specification v1.0, §1.9, §2.2 SG-002/004, and §2.3 | Consistent |
| User ownership and continued use of ordinary Markdown | CODEX_IMPLEMENTATION_GUIDE WP-08 and Detailed Specification v1.0 §3.7/Appendix H | A goal; export completion is not claimed. |
| Respect upstream authors and use only permitted code | SOURCE_IMPORT_MANIFEST §2 and DEPENDENCY_LICENSE_REVIEW §7 | Consistent. Keep the two-function scope, third-party provenance, and individual license terms. |
| Verify AI-generated work and support long-term maintenance | CODEX_IMPLEMENTATION_GUIDE §7/8 and IMPLEMENTATION_DECISIONS ADR-H02/H10 | Distinguish model tests from device tests. |
| Retain iCloud requirements without assuming the R2 design applies | ICLOUD_REQUIREMENTS §1/6/8 | Consistent. iCloud implementation remains deferred. |

No conflict was found within the passages compared above. This was not a comprehensive review of every specification and implementation, nor did it include new product testing.

## Documentation and publication practice

- Put a concise philosophy summary at the start of the README, keep the full rationale in PROJECT_PHILOSOPHY.md, and give contributors concrete rules in CONTRIBUTING.md.
- Reflect the philosophy in SECURITY.md and application drafts. Application drafts are local only and have not been submitted.
- For About text, release notes, design decisions, and user warnings, follow PROJECT_COMMUNICATION_GUIDE.md.
- Express the intent regarding the original author's revenue as: "The project does not aim to make paid features available for free without authorization or to deny the value of the original project." Do not promise zero effect on usage or revenue.
- For this documentation-only change, fixed handoff documents, AGENTS, audit hashes, code, and test expectations remained unchanged. This record captures the decision, and the README and CONTRIBUTING.md point readers to the philosophy.
- Publish only reviewed documents in the public repository, with an independent public history. Do not merge the private repository's previous history.

## Verification scope

The recorded change was documentation-only. The record reports that the diff, links, and baseline integrity were checked; it did not update product-test results or claim successful Windows, iPhone, R2, or real-Vault testing.

When a new guide was first placed under docs/, H11 detected an addition to a fixed directory. The guide was moved to the repository root as PROJECT_COMMUNICATION_GUIDE.md so that the audited set and expected hashes would not change.

The recorded final check states that node tools/verify-handoff.mjs passed 11/11 and git diff --check succeeded. It also records that relative links in six updated public documents and one local application draft existed. A draft that could be read as allowing an absolute data-safety guarantee was revised. The recorded GitHub About description was updated to describe the philosophy and development preview, and its display was checked.
