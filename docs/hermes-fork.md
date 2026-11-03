# Hermes fork of Better Remote Commander

This fork starts at upstream [`cbe511702dd0147650353c29ac6ab1decd8afda1`](https://github.com/shahidx0x/better-remote-commander/commit/cbe511702dd0147650353c29ac6ab1decd8afda1).
Upstream `LICENSE`, `NOTICE`, and the Desktop Commander attribution remain in the tree.
Hermes changes were reviewed against its source at [`f2b6bafad4dcb620596291519456f6b8654f6a11`](https://github.com/MikeMoore1337/hermes/tree/f2b6bafad4dcb620596291519456f6b8654f6a11).

| Capability | Upstream | Hermes fork candidate | Remaining work |
| --- | --- | --- | --- |
| MCP relay | Streamable HTTP and device routing | Reused; reviewed tool catalog and invocation allowlist | Verify the deployed image and clients |
| OAuth | PKCE, client registration, refresh and revoke | Reused; browser mutation origin guard | Recheck authorization and revocation in the target environment |
| Windows and Linux agents | Outbound WebSocket and reconnect | Reused; stop after authorization refusal | OS isolation, reboot and device-specific acceptance |
| Files, search and edit | Desktop Commander-derived tools | Reused; URL transfer/config tools denied, safer error and mutation handling | Cross-process write conflicts, binary and large-file parity |
| Terminal and processes | Interactive sessions and process tools | Reused; bounded timing output, drained output streams and error reporting for completed nonzero exits | Complete descendant cleanup and resource limits |
| Git | Shell runs locally available Git | Reused; no extra Git implementation | Verify Git in each approved agent image and workspace |
| Multiple devices | Pairing and explicit device selection | Owner and socket-token grants checked; configured project names resolve to their device | Control Center onboarding, automatic path routing and native Windows |
| Recovery | Reconnect with backoff | Old/foreign replies rejected; pending calls fail on disconnect | Prove real reboot/reconnect; a completed side effect cannot be undone |
| Security | Agent has its OS user's rights | Device-grant, CSRF and relay policy hardening | OS sandbox, per-device authorization and independent review |

`kill_process` rejects process groups, PID 1 and the agent's own PID. Other
positive PIDs remain subject to the agent's OS permissions; a successful result
only confirms that a signal was sent, not that the process or descendants exited.
Shell commands can still signal processes allowed by the OS, so use a dedicated
identity and isolated process namespace.
When upstream telemetry is disabled, the agent's `capture` path returns before
creating a telemetry identifier or reading telemetry configuration.
PDF creation uses an installed system Chrome, Chromium or Windows Edge. It does
not download a browser, prune cached builds or execute a browser from the
agent-writable cache; missing system browsers produce an explicit error.

The existing Hermes schema-1 workspace registry, native Windows bridge, observer
and Control Center remain in [the Hermes repository](https://github.com/MikeMoore1337/hermes).
They are not yet integrated with this fork. Existing deployment and rollback
procedures remain authoritative until a separately approved and verified cutover.

## Development workspace catalog

An optional, owner-controlled `BRC_WORKSPACE_REGISTRY` points to an absolute schema-2 JSON
file loaded once when the relay starts. The synthetic [test fixture](../scripts/hermes-workspaces-fixture.json)
shows the format. Each entry names its approved sandbox root, Git origin and branch,
and a stable device identity. Aliases must be unique across projects. Only roots
directly under `/workspace/projects/` and GitHub HTTPS origins are accepted in this
candidate; no Git operation or filesystem inspection occurs during resolution.
The model can call `resolve_workspace` and use its result for subsequent tools;
the result explicitly says Git and process execution are not verified.
The two-agent test demonstrates a client checking the resolved top-level, Git
origin and branch before proceeding, including negative cases for a missing
repository and mismatched origin or branch. The relay does not enforce that
check on writes; clients and the OS sandbox remain responsible for the boundary.

The registry file must be a regular file, at most 16 KiB, without hard links;
on POSIX it must be owned by root or the relay user and not group/world writable.
The agent must not be able to modify this file or its parent directories. Windows
ACLs and parent-directory protection are not verified by these checks. A registry
entry and a path name do not enforce an OS sandbox or prove that production data
is absent; device-specific OS isolation and owner approval remain required. No
dedicated registry mutation tool is exposed; shell access must be blocked by OS
permissions. Changes take effect only after a controlled restart.

The authenticated `/mcp` route rejects JSON requests with more than 10,000
array elements and object properties before SDK validation; the existing 32 MiB
body limit remains. The 2026-11-03 `pnpm audit --prod` still reports one high
[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), plus 12 moderate
and two low findings. The MCP limit does not establish complete mitigation for
every Zod use or ingress. A compatible fix and independent security review are
required before any runtime cutover.

The scoped `exceljs > unzipper` override uses MIT-licensed `unzipper@0.12.3`
and removes `binary > buffers@0.1.1` from the lockfile. The MCP XLSX
read/write/edit paths and an ordered-fixture streaming read are tested. ExcelJS
streaming cannot read some archives produced by its own writer when sheet entries
precede workbook metadata; the same failure occurs with the previous unzipper.

License inventory remains incomplete. The installed Windows native dependency
`@img/sharp-win32-x64@0.35.5` declares `Apache-2.0 AND LGPL-3.0-or-later` and
includes third-party notices. Review redistribution terms, source availability
and exact shipped platform artifacts before publishing packages or images; the
upstream MIT notice does not cover all dependencies.

The upstream automatic publishing workflow has been removed from this branch:
it could push directly to `main` and publish npm packages and container images.
CI only builds and tests. A future release needs its own approved procedure.

For development, use Node 24 and the pinned `pnpm@11.24.0`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:hermes
```

Docker base images, JavaScript dependency resolutions and the agent's Debian
snapshot are pinned. Bit-for-bit image reproducibility has not been verified.
No production deployment is approved by these commands or by CI.

## Migration and rollback

The existing [Hermes transactional relay guide](https://github.com/MikeMoore1337/hermes/blob/f2b6bafad4dcb620596291519456f6b8654f6a11/docs/operations/h15-brc-transactional-cutover.md)
describes a protected SQLite backup, disposable restore rehearsal and retained
old container. Its artifact admission and runtime contract were designed for the
previous Hermes build: compatibility with this fork is **not verified**. Do not
run its cutover mode for a fork image until that contract has been reviewed and
tested for the exact candidate.

Before any separately approved cutover:

1. Identify the actual running relay, agents, device grants, paths and endpoint;
   pin the old and candidate source revisions, OCI image identities and runtime
   configuration. Review the unresolved security, license and OS isolation risks.
2. Check endpoint and OAuth issuer/callback compatibility and prepare an approved
   owner-only backup of configuration and SQLite. A backup contains credentials;
   never put it in Git, CI artifacts or logs. Rehearse restoration separately.
3. Test the candidate with disposable identities and workspaces. Do not attach
   a second agent with the identity of a running agent. Verify project-to-device
   routing and the sandbox's actual Git origin and branch before any writes.
4. Obtain explicit approval for the exact devices, paths, endpoint and maintenance
   action. Quiesce requests, keep the old image/configuration and checkpoint,
   switch one verified identity at a time, and check both real clients and each
   approved device before considering the new route accepted.
5. On failure, stop the candidate and recover the old service using its verified
   image/configuration. Check whether the current database is backward compatible.
   Never automatically overwrite newer state with an old snapshot: it can undo
   token revocations and device rekeys. If data restoration is necessary, stop and
   follow a separately authorized recovery procedure. Confirm service health and
   live clients after rollback before removing any checkpoint.

On 2026-11-03, a disposable, non-root, network-isolated Linux container ran
[`hermes-rollback-rehearsal.mjs`](../scripts/hermes-rollback-rehearsal.mjs)
with synthetic data. It used the SQLite module from local evaluation image
`sha256:1c23e527da84ee1908d481ab9b62e681aa9986113c41a8a189384a8a44cdc2a3`
(upstream label `cbe511702dd0147650353c29ac6ab1decd8afda1`), the fork module
at `22bf5df2035094acb5aac06c2e33a4ff2c2ea2d9`, and the existing Hermes backup
and restore helpers at `f2b6bafad4dcb620596291519456f6b8654f6a11`. Backup and
disposable restoration passed; the synthetic store opened old → fork → old while
preserving a later token revocation and device rekey. Restoring the earlier
snapshot instead reintroduced the revoked synthetic token, demonstrating why it
must not be restored blindly. This tested store modules and helpers, not a relay
switch, the current production image, actual device credentials or live rollback.

To repeat the disposable module rehearsal, mount only these files read-only in a
Linux container that has Node 24 and Python 3, no network, a read-only root,
an unprivileged UID and a writable private `/tmp`:

| Container path | Source |
| --- | --- |
| `/fixtures/rehearse.mjs` | `scripts/hermes-rollback-rehearsal.mjs` in this fork |
| `/fixtures/old-store.mjs` | `packages/relay/dist/store/sqlite.js` from the explicitly identified old image |
| `/fixtures/new-store.mjs` | `packages/relay/dist/store/sqlite.js` built from the candidate fork |
| `/fixtures/backup.py` | Hermes `deploy/h15/backup-relay.py` |
| `/fixtures/restore.py` | Hermes `deploy/h15/rehearse-restore.py` |

Run `node /fixtures/rehearse.mjs`. Never mount an actual relay database or secrets;
the test creates and deletes its own synthetic SQLite data in `/tmp`.

| Fork acceptance | ChatGPT | Codex |
| --- | --- | --- |
| Initialize, tools, OAuth and revoke | NOT_VERIFIED | NOT_VERIFIED |
| Files, shell, process control and Git/Python | NOT_VERIFIED | NOT_VERIFIED |
| Multiple real devices, reconnect and project routing | NOT_VERIFIED | NOT_VERIFIED |
| Live cutover and rollback | NOT_VERIFIED | NOT_VERIFIED |

The existing Hermes parity record describes a different deployed implementation;
its results must not be reported as acceptance of this fork.
