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

On token rotation or device removal, the relay disconnects the current socket
and rejects its pending calls; a result received after a changed grant is also
rejected. An agent sends a result only on the connection that received the call,
so reconnect does not replay it. Revocation does not cancel an OS process or
undo side effects that already began; local WebSocket tests do not prove runtime
isolation or behavior on an owner's devices.

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
An explicitly supplied empty or non-string `deviceId` is refused; only an omitted
ID can use the existing single-device default.
A device pairing code approved for a **new** device does not silently authorize
replacing an already registered device belonging to the same owner. If the
poller's `device_id` collides with an existing registration, the relay now
requires the approved pairing record itself to bind that exact ID; otherwise
it returns `device_id_conflict` and preserves the existing token and socket.
The current browser pairing flow does not offer an explicit repair-target
confirmation, so re-pairing that preserves an existing ID through the browser
is intentionally unavailable until that owner-visible confirmation exists.
The owner may explicitly delete the old registration and enroll a new identity;
workspace bindings then require separate review. This does not itself prove
host OS isolation or authorize real agent enrollment.

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
body limit remains. Dynamic client registration has a 64 KiB and 10,000-element
limit. Structured PDF JSON strings are separately bounded before parsing.
Zod is pinned to 4.6.6 for the
[array advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5); the
2026-11-03 production dependency audit reports 12 moderate and two low findings,
with no high or critical advisories. The SDK still imports the bundled `zod/v3`
compatibility code; a local OAuth/MCP exercise passed with v3 parsing trapped,
but that does not prove every SDK path avoids it. Independent security review
and OS isolation remain required before runtime cutover.

PDF rendering uses an already installed system Chrome, Chromium or Windows Edge.
It fails with `HERMES_BROWSER_UNAVAILABLE` when none is available; it neither
downloads a browser nor prunes browser caches. Browser ownership, executable
permissions and network isolation remain deployment responsibilities.

The optional POSIX Control Center observer is off by default. Only when
`BRC_OBSERVER_DIR` names a private non-root relay-owned directory containing a
relay-owned `0600` file `.hermes-brc-observer-enable` with `enabled\n` does it
write a bounded `hermes-brc-observation.json` there. It projects only the
configured admin owner's devices and sandbox workspaces, checks the current
device grant and socket binding, and does not expose device IDs or credentials.
Presence is not proof of command execution, Git state or host isolation. The
Hermes bridge and Control Center need the schema-2 consumer; configuration,
enabling the marker and deployment require separate owner approval.

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

The workspace's pnpm overrides do not automatically constrain transitive
dependencies when an npm consumer installs an individual published package.
Before any npm publication, test a clean consumer install for resolved
dependencies, install-time downloads, license obligations and security. The
current CI tarballs and local deploy-directory checks do not establish that.

### Dependency and distribution review (2026-11-04)

`pnpm audit --json` on the pinned workspace reported 12 moderate and 2 low
advisories before the compatible lockfile updates below. Afterwards it reported
3 moderate and no low, high or critical advisories. After the additional
`uuid` and `glob` changes below, a fresh audit reported 1 moderate advisory.
This is a workspace lockfile result, not a determination that every affected
function is reachable or that independently installed npm packages are safe.

| Updated dependency | Advisory IDs no longer reported |
| --- | --- |
| `fast-uri` 3.1.7 → 3.1.9 | [hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj), [w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), [xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp) |
| `ip-address` 10.7.0 → 10.7.5 | [j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), [h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw), [rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) |
| `hono` 4.13.7 → 4.13.16 and `@hono/node-server` 2.1.1 → 2.1.6 | [5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7), [rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) |
| `qs` 6.16.0 → 6.17.1 | [6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) |
| ExcelJS `uuid` 8.3.2 → 11.1.1 | [w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) |
| `glob` 10.5.0 and 13.0.6 → 14.0.2 | [3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) |

The updated `glob` resolves `minimatch` 11.0.4; its expansion bound, traversal
cancellation and ExcelJS `uuid` buffer checks have regression tests. ExcelJS
itself calls `uuid.v4()` without an output buffer; this observation is not a
complete reachability proof.

The remaining moderate [minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
reports versions 3.1.5 and 5.1.9 through ExcelJS and `md-to-pdf`. Their inspected
sources do not contain the specific optimizer named in the advisory, but the
published affected range still includes them and [upstream clarification is open](https://github.com/github/advisory-database/issues/10811).
Version 11 is outside the consumers' declared major versions; no incompatible
override or audit suppression is used. Other denial-of-service mechanisms and
actual reachability remain unverified.

The installed Windows production dependency inventory reported no unknown
license labels, but this does not inventory every Linux optional package or OS
package in a shipped image. The Windows `sharp` package contains LGPL libraries
and their component/version inventory; LGPL applies in addition to the fork's MIT
license. The tarball notice check verifies file presence and fork source metadata,
not complete corresponding sources, modifications, installation information or
relinkability for an actual distributed binary. Those items, including the exact
Linux image inventory and available source for each native component, remain
**BLOCKED** before binary publication. See the [LGPL v3](https://www.gnu.org/licenses/lgpl-3.0.html)
and [FSF source-distribution guidance](https://www.gnu.org/licenses/gpl-faq.en.html#SourceAndBinaryOnDifferentSites).

An offline OS-package scan of local candidate images built from fork commit
`726b14218714f47d9e95f63393837a07fd5a59fb`, with Trivy 0.73.0 and a database
updated 2026-11-04 01:28 UTC, reported 66 HIGH and 2 CRITICAL package records in
the Debian agent and none in the Alpine relay. These are scanner records, not
demonstrated exploitability; the database listed no fixed Bookworm version for
the HIGH/CRITICAL records. For the two CRITICAL records, Debian describes
`libsqlite3-0` 3.40.1-2+deb12u2 as vulnerable if an attacker can execute
crafted SQL, while its tracker notes that the vulnerable minizip code for
`zlib1g` CVE-2023-45853 is not built into the Bookworm binary. See
[Debian's SQLite tracker](https://security-tracker.debian.org/tracker/CVE-2025-7458)
and [zlib tracker](https://security-tracker.debian.org/tracker/CVE-2023-45853).
No production image or real device was tested; binary distribution remains blocked.

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

### Relay state volumes
The fork relay Dockerfile no longer declares `VOLUME /data`. Docker previously
created an anonymous writable `/data` volume even for a read-only container
whose actual SQLite database was placed at `/state`. That hidden mount violates
the Hermes operator's single-explicit-state-mount requirement.

The default SQLite path is still `/data/relay.sqlite`, so any persistent
deployment must **explicitly** mount a verified owner-managed `/data` volume
or set `BRC_DB` to an explicitly mounted writable state directory.
The supplied `docker-compose.yml` already mounts `relay-data:/data`.
A read-only container with no authorized writable state mount must fail closed.

Docker CI checks the built relay image with `docker create --read-only`
and refuses image-declared volumes or unexpected runtime mounts. This test
does not prove the owner's live image identity, UID, DB permissions, OAuth
compatibility or safe cutover. The old Hermes operator must still **not** be
used for a fork image without a reviewed fork-specific admission contract.

The existing [Hermes transactional relay guide](https://github.com/MikeMoore1337/hermes/blob/f2b6bafad4dcb620596291519456f6b8654f6a11/docs/operations/h15-brc-transactional-cutover.md)
describes a protected SQLite backup, disposable restore rehearsal and retained
old container. Its artifact admission and runtime contract were designed for the
previous Hermes build: compatibility with this fork is **not verified**. Do not
run its cutover mode for a fork image until that contract has been reviewed and
tested for the exact candidate.

The Docker CI also runs `scripts/h454_fork_legacy_state_smoke.sh` against a
**disposable** fork relay. It overrides the image user to a synthetic legacy
`979:975`, binds a private tmpfs to `/state`, sets
`BRC_DB=/state/relay.sqlite`, disables networking, and verifies that SQLite
is created by that UID while the relay reports healthy with zero devices.
This is an execution check for the fork's CLI and storage path override,
not evidence that the fork image satisfies the existing Hermes OCI admission
labels/entrypoint or can migrate the owner's real SQLite/database secrets.
The production transactional upgrade operator must **not** be called with this
image until a separately reviewed fork-aware admission and owner cutover plan
are tested on exact source/image IDs.

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
