# ObsidianSyncOss Project Philosophy

This document records why this project exists and the principles that guide technical, documentation, and public-facing decisions. It does not replace the detailed synchronization specifications, implementation decisions, test plans, or license audits. Consult those source documents for specific technical requirements and terms of use.

## 1. Starting Point

This project began with a real user need: an affordable, safe, and reliable way to synchronize Obsidian between Windows and iPhone.

The goal is not simply to make synchronization work.

The goal is to build open-source synchronization software that reduces, as far as practical, the risk of losing notes accumulated over many years and lets users continue to own their data.

## 2. Safety First

Safety takes priority over speed, convenience, and the number of features.

When the state cannot be determined, stop instead of guessing and continuing.

In particular:

- Never treat a communication failure as evidence that a file was deleted.
- When both Local and Remote have changed, do not choose either side automatically.
- Preserve the information needed for recovery before overwriting or deleting data.
- Do not automatically carry out large destructive changes.
- Do not guess whether an operation succeeded or failed when its outcome is unknown.
- Do not replay a stale operation unchanged after a restart.
- Do not roll back a user's newer edit because of synchronization processing.

Do not weaken these safety requirements to make implementation simpler.

## 3. Local First and User Ownership

Ordinary Markdown files should remain in each device's local Vault.

The cloud is a relay for safe synchronization between devices; it does not own the user's data.

Users should be able to keep using their notes as ordinary Markdown even if they stop using this open-source project.

Avoid locking users into a particular cloud service or this project.

## 4. Low Cost Without Sacrificing Safety

Affordable use is one of the project's important goals.

The project aims to use services such as Cloudflare R2 to avoid high ongoing costs for small-scale users.

Do not remove safety features to make the project free or reduce costs.

Protecting data takes priority over being cheap.

## 5. Respect for Remotely Save

Remotely Save and the work of its author and contributors have strongly influenced this project.

Do not dismiss the original project or present its work as if it were ours alone.

Follow these rules:

- Clearly state that Remotely Save was a starting point and a source of reference.
- Preserve credit to the original author and contributors.
- Follow the verified terms of use, including the Apache License where applicable.
- Do not use Pro code without authorization.
- The project is not intended to make paid features available for free without authorization.
- Do not use wording such as “official successor” that could mislead people about the original author's endorsement.
- Do not attack or speak negatively about the original author or the pace of development.

Use the rights that open-source licenses grant for modification and reuse, but do not treat those rights as a reason to lose respect for the original authors.

## 6. An Open-Source Project That Can Be Maintained

It is important that the project not become understandable only to one developer.

Record more than code. Keep the following understandable to future maintainers:

- specifications;
- design decisions;
- tests;
- code provenance;
- licenses;
- behavior during failures; and
- release procedures.

Aim for a structure that other contributors can understand and maintain if the current author can no longer continue development.

## 7. A Careful Approach to AI-Assisted Development

This project makes active use of Codex.

However, code is not correct simply because AI generated it.

Generated code must still be checked for:

- consistency with the specifications;
- code provenance;
- license compliance;
- automated tests;
- failure cases;
- regressions; and
- behavior on real Windows and iPhone devices.

Do not change test expectations in an unsafe direction just to make implementation easier.

## 8. Why This Project Is Open Source

This project began as a way to solve the developer's own Obsidian synchronization problem.

The aim is to make it useful to other people with the same problem, so they can use it, verify it, and improve it.

The reason for publishing it on GitHub is to grow a public, community-oriented open-source project: one that the developer would truly want to use and that others can confidently inspect, verify, and improve.

## 9. iCloud

iCloud is an important future target, but safety takes priority over implementing it early.

Keep the requirements on record now, but do not rush into implementation until the R2 synchronization core is well established.

Do not assume that the R2 synchronization method can be applied to iCloud as-is.

## 10. What This Project Aims to Be

The goal is not to build the synchronization plugin with the most features.

The goal is an Obsidian synchronization project that can explain what it will do, stops safely when something is unclear, supports users in retaining ownership of their data, and can be maintained by a community over the long term.

## Applying These Principles to Documents and Decisions

Apply this philosophy to:

- the README;
- the GitHub repository description;
- the About section and project philosophy;
- `CONTRIBUTING.md`;
- `SECURITY.md`;
- project and open-source applications, including those submitted to OpenAI;
- release notes;
- design decisions;
- user-facing warnings; and
- guidance for contributors.

Do not exaggerate technical facts in the name of this philosophy. Do not make claims that cannot be verified, such as “will never lose data,” “completely safe,” “safer than Remotely Save,” or “official successor.”

If this philosophy conflicts with a technical specification, do not resolve the conflict by unilateral interpretation. Record and report the conflicting sections, the available options, and the safety impact of each option. Also consult the detailed specifications, test specifications, and license audit results. Do not make a change that weakens safety until the conflict has been resolved and the resolution recorded.

### The Original Project's Revenue and Value

The creator's intention is not to take revenue away from the original authors. However, we cannot guarantee that publishing an open-source project will have no effect on the original project's usage or revenue.

Therefore, do not say that the project guarantees it will not affect the original project's revenue. In GitHub or OpenAI applications and other explanations, use this wording: “The project is not intended to make paid features available for free without authorization or to deny the value of the original project.” Describe the project's intent and conduct accurately; do not guarantee outcomes.
