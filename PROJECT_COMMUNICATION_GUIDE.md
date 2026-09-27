# Project Communication Guide

The project's guiding principles are recorded in [PROJECT_PHILOSOPHY.md](PROJECT_PHILOSOPHY.md). This guide applies them to public descriptions, release notes, design decisions, user warnings, and contributor explanations. It is a writing and review aid; it does not change the detailed synchronization specification, test specification, or license audit.

## Language for public documents

Write public-facing project prose in plain English so readers from different backgrounds can review it. Maintainer discussions and private working records may be in Japanese. Keep retained Japanese historical specifications and audit baselines intact when they serve as verification records; English guides must identify those sources as Japanese and say when the guide is a summary rather than a full translation.

## Rules for every project statement

- Describe a goal as a goal and a capability as implemented only when the code supports it. Separate intended behavior, implemented behavior, tested behavior, and supported behavior.
- Name the scope of evidence: synthetic or in-memory tests, a specific platform, or a real service. Give the date and exact result when reporting a test run. A passing model test is not evidence of real R2, Windows, iPhone, or Vault behavior.
- Prefer bounded wording such as “is designed to,” “the offline tests cover,” and “not yet verified.” Do not claim “completely safe,” “cannot lose data,” “safer than Remotely Save,” or “official successor.”
- Keep user data ownership and local usability clear: the aim is to keep ordinary Markdown in the user's Vault, use cloud storage as a synchronization relay, and avoid lock-in. State cost as a design goal, not a guarantee about a user's bill.
- Credit Remotely Save's authors and contributors, retain each applicable license and notice, and describe only the code and ideas actually reviewed and reused. Do not use restricted Pro code or imply endorsement.
- Preserve this distinction in Japanese and English: the project does not intend to make paid features available for free without authorization or to deny the value of Remotely Save; it cannot guarantee that this independent project has no effect on Remotely Save's usage or revenue.
- AI-generated code, tests, and prose are drafts. Review them against the specifications, source provenance and licenses, independent expected values, negative and failure cases, regression behavior, and required Windows/iPhone checks. Never change a safety expectation merely to make an implementation pass.

## When a specification and a proposal conflict

Do not resolve a safety-relevant conflict by silently choosing the easier implementation or weaker rule. Record:

1. the exact documents, sections, and requirements that conflict;
2. the available choices, including stopping or deferring the work;
3. the safety and data-recovery impact of each choice; and
4. the evidence or decision needed before work can continue.

Keep the work stopped at the affected boundary until the conflict is resolved by an authorized specification decision. A communication guide cannot amend a technical contract.

## User warnings

Every warning about an uncertain operation should make four things clear:

1. **Observed fact:** what the application actually observed, such as a request timing out.
2. **Unknown state:** what could not be verified, such as whether a remote write completed.
3. **User action:** the safest next step supported by the current product and recovery procedure.
4. **Stop boundary:** what must not be retried, overwritten, or deleted until the unknown state is reconciled.

Do not turn an unknown into either a success or a failure. Stopping does not prove that the local and remote data are intact or that nothing was lost. Do not tell a user to resume using an old operation after restart unless the current state has been checked and the specification allows it.

### Warning example for an unknown remote write

> **Sync paused.** The request to write to the remote timed out. We could not confirm whether the write took effect. Until the state has been reconciled, do not retry the same operation or overwrite or delete the affected data. Check the available records and follow the recovery procedure for the current product version. Pausing does not confirm that no data was lost.

Use this only when those facts match the actual event. Replace the action with the verified procedure for the current product version; do not imply that a reconciliation screen or recovery feature exists before it has been implemented and tested.

## Project About text

Use a short summary of the project purpose and values, then link to [PROJECT_PHILOSOPHY.md](PROJECT_PHILOSOPHY.md) for the full rationale and to the detailed specification for current technical scope. Keep “independent project” and the Remotely Save attribution visible. Do not describe planned iCloud support as implemented; the iCloud requirements are future-facing until their separate design and verification are complete.

## Design decision record

For a safety-relevant decision, include:

- **Context:** the user problem and current verified project state.
- **Specification references:** exact requirement and test-case identifiers.
- **Options considered:** including a safe stop or deferral where applicable.
- **Decision and rationale:** why the selected option meets the safety rules.
- **Safety effects:** local and remote overwrite/deletion risks, recovery evidence, unknown outcomes, and protection of newer edits.
- **Evidence and limits:** tests run, tests not run, devices/services not tested, and remaining uncertainty.
- **Provenance and license:** source or dependency, permission status, notices, and attribution changes.
- **Status:** proposed, accepted, implemented, or verified; these states must not be conflated.

## Release notes template for an unreleased change

Copy this template only after checking the actual branch and current reports. Keep the heading marked as unreleased until a release is actually published.

```markdown
## Unreleased — draft

### Purpose
- [User problem this change addresses]

### Changes
- [Implemented, user-visible behavior; distinguish it from planned work]

### Safety behavior and limits
- [What happens on conflict, interruption, or unknown state]
- [What the user must do or avoid]

### Verification
- [Exact command or manual procedure, environment, date, and result]
- Not run: [R2 / Windows / iPhone / real Vault checks that remain outstanding]

### Attribution and licenses
- [New source or dependency, license review, required notices and credit]

### Status
- Unreleased; [draft / review needed / ready for release review]
```

Do not copy test counts or dates from an older release note without rerunning or checking the latest report. A release note may describe general availability or production readiness only when the corresponding release gate and evidence support that bounded status claim. Never promise that data loss is impossible or that the system is completely safe.

## Contributor explanations

When asking for or reviewing a contribution, point to the relevant specification, test cases, and provenance rules. Explain the user-visible safety reason behind the requirement in plain language. Request independent expected values and negative cases for safety-sensitive behavior, and preserve the original author's and contributors' notices when editing reused material. If the requirement is unclear or conflicts with another document, document the conflict and stop the affected change instead of asking a contributor to guess.
