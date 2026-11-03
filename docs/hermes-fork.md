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
| Terminal and processes | Interactive sessions and process tools | Reused; bounded timing output and honest termination result | Complete descendant cleanup and resource limits |
| Git | Shell runs locally available Git | Reused; no extra Git implementation | Verify Git in each approved agent image and workspace |
| Multiple devices | Pairing and explicit device selection | Owner and socket-token grants checked; configured project names resolve to their device | Control Center onboarding, automatic path routing and native Windows |
| Recovery | Reconnect with backoff | Old/foreign replies rejected; pending calls fail on disconnect | Prove real reboot/reconnect; a completed side effect cannot be undone |
| Security | Agent has its OS user's rights | Device-grant, CSRF and relay policy hardening | OS sandbox, per-device authorization and independent review |

`kill_process` rejects process groups, PID 1 and the agent's own PID. Other
positive PIDs remain subject to the agent's OS permissions; a successful result
only confirms that a signal was sent, not that the process or descendants exited.
Shell commands can still signal processes allowed by the OS, so use a dedicated
identity and isolated process namespace.

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

License inventory is incomplete. The installed `exceljs > unzipper > binary >
buffers@0.1.1` package has no declared license in its npm metadata or installed
files; its original repository was unavailable during review. The installed
`@img/sharp-win32-x64@0.35.5` declares `Apache-2.0 AND LGPL-3.0-or-later`.
Review redistribution terms and platform-specific native dependencies before
publishing packages or images; the upstream MIT notice does not cover them all.

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
