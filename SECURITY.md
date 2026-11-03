# Security

## Model
- The agent runs with the OS permissions of the user who started it. File path and blocked-command settings do not confine shell processes; enforce isolation with a separate OS identity, filesystem permissions and network restrictions.
- The relay receives credentials to authenticate requests and stores device tokens as hashes and passwords as scrypt hashes. OAuth access tokens live 1 h, refresh tokens 30 d and rotate on use.
- Agents only make outbound connections. The relay is the only thing that needs a public endpoint.
- Per-call audit log: tool name, args hash, device, client, result, latency. Arguments and outputs are never stored.

## Defaults you should keep
- `BRC_ADMIN_PASSWORD` strong; `BRC_SESSION_SECRET` random (32+ bytes)
- `PUBLIC_URL` must be `https://` in any real deployment (HSTS + secure cookies switch on automatically)
- Login: 5 failures per IP+user -> 5 min lock. Consent is required per OAuth client.
- Agent: restrict file access with `--allow-dir` and an OS sandbox; pause a device from `/admin` when you do not need it

## Threat notes
- A compromised AI client session can invoke permitted tools on unpaused devices. Revoke: `/admin` -> Delete device (closes the socket, invalidates the token) or `/auth/clients` -> Delete client (revokes its tokens).
- OAuth clients use S256 PKCE. ChatGPT and Claude register clients dynamically through the relay's OAuth metadata.
- Quick tunnels (`trycloudflare.com`, random ngrok URLs) are for testing: the hostname changes on restart and OAuth clients registered against it become invalid.

## Reporting
Open a private issue or email the maintainer. Please include relay version (`/health`) and steps to reproduce.
