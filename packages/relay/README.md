# brc-relay

Relay server for **Better Remote Commander** — the self-hosted bridge between AI clients (Claude, ChatGPT) and your
machines running the fork's `brc-agent`. One process, SQLite, your domain.

Doors it exposes:
- `/mcp` — remote MCP (Streamable HTTP) with OAuth 2.0 (PKCE, dynamic client registration) or API-key bearer auth
- `/admin`, `/device/verify`, `/auth/clients`, `/auth/apikeys` — browser dashboard: pair / pause / remove devices, OAuth clients, API keys, audit log
- `/ws` — agent WebSocket (agents connect outbound; nothing to open on their side)

## Install & run

This Hermes fork is a development candidate. The public `brc-relay` npm package
is upstream and does not contain the fork changes. Build from the [fork source](https://github.com/MikeMoore1337/hermes-remote-commander)
only within an approved isolated environment; publication and activation require separate approval.
Put it behind any HTTPS reverse proxy or tunnel that forwards WebSockets (Caddy, nginx, Cloudflare Tunnel, ngrok).
Docker Compose profiles for VPS / Cloudflare Tunnel / ngrok are in the repository.

## Configuration

| Env | Meaning |
|---|---|
| `PUBLIC_URL` | exact public origin; drives OAuth issuer and pairing links |
| `PORT`, `HOST` | listen address (default 3000 / 0.0.0.0) |
| `TRUST_PROXY` | `true` behind a proxy/tunnel |
| `BRC_ADMIN_USER`, `BRC_ADMIN_PASSWORD` | dashboard login (single-user) |
| `BRC_SESSION_SECRET` | cookie signing secret |
| `BRC_DB` | SQLite file (default `data/relay.sqlite`) |

## Connect clients

- **Claude**: Settings → Connectors → add `https://brc.example.com/mcp` → sign in → Allow
- **ChatGPT (MCP)**: same URL as a connector

Full docs: https://github.com/MikeMoore1337/hermes-remote-commander · License MIT.
