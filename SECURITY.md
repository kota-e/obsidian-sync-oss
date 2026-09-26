# Security policy

ObsidianSyncOss is an early development preview. It is not approved for
personal Vaults, production R2 buckets, or unattended synchronization. The
absence of a reported issue does not mean that the current model or its
future adapters have completed a security audit.

## What to report privately

Please report issues privately when they could expose note contents,
credentials, remote objects, or another user's data. Examples include:

- credentials or signed requests being logged or sent to the wrong host;
- a failed or incomplete read being treated as an empty remote;
- an unconditional overwrite or deletion path that bypasses the safety gate;
- stale, cancelled, or unknown-outcome work changing a newer local or remote
  state;
- a path validation or archive handling bug that escapes the intended scope.

Do not include real Vault content, access keys, signed URLs, personal data, or
an exploit that would disclose them in a public issue.

If GitHub private vulnerability reporting is enabled for this repository, use
that repository feature. If it is not available, open a public issue with
only the words `private security contact needed` and no technical details; a
maintainer can then provide a private channel. The repository does not publish
a separate email address at this stage.

## What to include

Send the smallest reproducible description you can:

- affected commit or file;
- synthetic input or a redacted reproduction;
- expected safety property and observed result;
- whether a real Vault, R2 account, or credential was involved.

Do not test against another person's account or a production bucket. Use the
supplied fixtures or a disposable environment with permission.

## Supported versions

There is currently no supported plugin release. Reports against the current
development branch are welcome. The offline workspace is a model and test
environment; it is not a supported runtime for syncing a Vault.

## Response and disclosure

This project is maintained on a best-effort basis while the source preview is
being developed. We will first try to reproduce a report with synthetic data,
contain the affected path, and document the result. A fix or mitigation must
preserve the fail-safe behavior and the relevant license notices.

Please do not publish a detailed vulnerability report until a maintainer has
confirmed that private coordination is complete. No response time or fix time
is promised for the development preview.
