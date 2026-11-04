/**
 * BRC relay HTTP server (Express; MCP SDK's auth router is Express-native).
 * Routes:
 *   GET  /                      home / device list (cookie session)
 *   GET  /health
 *   .well-known/*, /authorize, /token, /register, /revoke  (mcpAuthRouter)
 *   GET|POST /auth/login, POST /auth/consent, GET /auth/logout
 *   POST /device/start, POST /device/poll, GET|POST /device/verify, POST /device/approve
 *   ALL  /mcp                   Streamable HTTP (bearer, stateless per request)
 *   WS   /ws                    agent socket (device token)
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { DeviceHub } from './device-hub.js';
import { SqliteStore, verifyPassword } from './store/sqlite.js';
import { RelayOAuthProvider, SCOPES } from './auth/provider.js';
import { Sessions } from './auth/sessions.js';
import { createMcpServer } from './mcp/server.js';
import { loadWorkspaceRegistry } from './mcp/hermes-workspaces.js';
import * as pages from './pages/html.js';
import * as adminPages from './pages/admin.js';
import { LoginLimiter } from './auth/rate-limit.js';
import { withinJsonElementLimit } from 'brc-shared';
import { observerEnabled, observation, publishObservation } from './hermes-observer.js';

export interface RelayConfig {
  port: number;
  host: string;
  publicUrl: string;
  trustProxy: boolean;
  dbFile: string;
  sessionSecret: string;
  adminUser: string;
  adminPassword: string;
  relayVersion: string;
  workspaceRegistryPath?: string;
  observerDirectory?: string;
}

export function loadConfig(): RelayConfig {
  const env = process.env;
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
    dbFile: env.BRC_DB ?? 'data/relay.sqlite',
    sessionSecret: env.BRC_SESSION_SECRET ?? '',
    adminUser: env.BRC_ADMIN_USER ?? 'admin',
    adminPassword: env.BRC_ADMIN_PASSWORD ?? '',
    relayVersion: '2.0.2',
    workspaceRegistryPath: env.BRC_WORKSPACE_REGISTRY,
    observerDirectory: env.BRC_OBSERVER_DIR,
  };
}

const DEVICE_CODE_TTL_MS = 15 * 60_000;
const DEVICE_POLL_INTERVAL_S = 5;

export interface Relay { http: HttpServer; hub: DeviceHub; store: SqliteStore; close(): Promise<void> }

export function buildRelay(cfg: RelayConfig, log: (level: string, msg: string) => void): Relay {
  const workspaces = loadWorkspaceRegistry(cfg.workspaceRegistryPath);
  const store = new SqliteStore(cfg.dbFile);
  const admin = store.upsertUser(cfg.adminUser, cfg.adminPassword);
  const sessions = new Sessions(cfg.sessionSecret, cfg.publicUrl.startsWith('https://'));
  const hub = new DeviceHub(cfg.relayVersion, log);
  const publicUrl = new URL(cfg.publicUrl);

  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');
  app.use(cookieParser());
  // All owner-authorized browser mutations require an exact same-origin
  // Origin value. SameSite=Lax by itself is NOT our CSRF boundary.
  const ownerMutationPaths = new Set([
    '/auth/consent', '/device/verify', '/device/approve',
    '/auth/clients/delete', '/admin/device',
    '/auth/apikeys', '/auth/apikeys/revoke',
  ]);
  const ownerOrigin = new URL(cfg.publicUrl).origin;
  app.use((req, res, next) => {
    if (req.method !== 'POST' || !ownerMutationPaths.has(req.path)) return next();
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    if (origin !== ownerOrigin || (fetchSite && fetchSite !== 'same-origin')) {
      return res.status(403).type('text/plain').send('HERMES_BROWSER_ORIGIN_DENIED');
    }
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (cfg.publicUrl.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  const currentUser = (req: Request) => sessions.userId(req);

  /* ---------- OAuth ---------- */
  const provider = new RelayOAuthProvider({
    store,
    currentUserId: (res) => sessions.userId(res.req),
    renderLogin: (res, returnTo) => res.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
    renderConsent: (res, pendingId, client, scopes) =>
      res.type('html').send(pages.consentPage(pendingId, client.client_name ?? client.client_id, client.redirect_uris?.[0] ?? '', scopes)),
    issuer: cfg.publicUrl,
  });

  // Publish OAuth metadata explicitly so ChatGPT sees the current MCP OAuth 2.1 contract.
  const oauthMetadata = {
    issuer: cfg.publicUrl,
    authorization_endpoint: `${cfg.publicUrl}/authorize`,
    token_endpoint: `${cfg.publicUrl}/token`,
    registration_endpoint: `${cfg.publicUrl}/register`,
    revocation_endpoint: `${cfg.publicUrl}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
  };
  const protectedResourceMetadata = {
    resource: `${cfg.publicUrl}/mcp`,
    authorization_servers: [cfg.publicUrl],
    scopes_supported: SCOPES,
    resource_name: 'Better Remote Commander (BRC)',
  };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(oauthMetadata));
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResourceMetadata));
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(protectedResourceMetadata));

  // Bound unauthenticated registration collections before SDK schema validation.
  app.post('/register', express.json({ limit: '64kb' }), (req, res, next) => {
    if (!withinJsonElementLimit(req.body)) return res.status(413).json({ error: 'invalid_client_metadata' });
    next();
  });

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: publicUrl,
    baseUrl: publicUrl,
    resourceServerUrl: new URL('/mcp', publicUrl),
    scopesSupported: SCOPES,
    resourceName: 'Better Remote Commander (BRC)',
    clientRegistrationOptions: { clientSecretExpirySeconds: undefined },
  }));

  // Consent page re-entry after login (provider.authorize parked the request under `pending`).
  app.get('/auth/consent', (req, res) => {
    const pendingId = String(req.query.pending ?? '');
    const p = provider.pending.get(pendingId);
    if (!p) return res.status(400).type('html').send(pages.messagePage('Expired', 'This authorization request has expired. Retry from your AI client.', false));
    if (!currentUser(req)) return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    res.type('html').send(pages.consentPage(pendingId, p.client.client_name ?? p.client.client_id, p.params.redirectUri, p.params.scopes ?? SCOPES));
  });

  app.post('/auth/consent', (req, res) => {
    const userId = currentUser(req);
    if (!userId) return res.status(401).type('html').send(pages.messagePage('Not signed in', 'Sign in first.', false));
    const pendingId = String(req.body.pending ?? '');
    if (req.body.decision !== 'allow') {
      const url = provider.denyCode(pendingId);
      return url ? res.redirect(url) : res.type('html').send(pages.messagePage('Denied', 'Authorization denied.', false));
    }
    try { res.redirect(provider.issueCode(pendingId, userId)); }
    catch { res.status(400).type('html').send(pages.messagePage('Expired', 'This authorization request has expired. Retry from your AI client.', false)); }
  });

  /* ---------- login / logout / home ---------- */
  const safeReturn = (v: unknown) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/');

  app.get('/auth/login', (req, res) => res.type('html').send(pages.loginPage(safeReturn(req.query.returnTo))));
  const limiter = new LoginLimiter();
  app.post('/auth/login', (req, res) => {
    const { username, password, returnTo } = req.body as Record<string, string>;
    const key = `${req.ip}|${String(username ?? '').toLowerCase()}`;
    const wait = limiter.locked(key);
    if (wait) return res.status(429).type('html').send(pages.loginPage(safeReturn(returnTo), `Too many attempts. Try again in ${wait} s.`));
    const user = store.getUserByName(String(username ?? ''));
    if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
      limiter.fail(key);
      log('warn', `login failed for "${username}" from ${req.ip}`);
      return res.status(401).type('html').send(pages.loginPage(safeReturn(returnTo), 'Invalid username or password.'));
    }
    limiter.ok(key);
    sessions.issue(res, user.id);
    res.redirect(safeReturn(returnTo));
  });
  app.get('/auth/logout', (_req, res) => { sessions.clear(res); res.redirect('/'); });

  app.get('/', (req, res) => {
    const userId = currentUser(req);
    const online = new Set(hub.list(userId ?? undefined).map((d) => d.deviceId));
    const devices = userId ? store.listDevices(userId).map((d) => ({ ...d, online: online.has(d.device_id) })) : [];
    res.type('html').send(pages.homePage(cfg.publicUrl, !!userId, devices));
  });

  app.get('/health', (_req, res) => res.json({ ok: true, version: cfg.relayVersion, devices: hub.list().length, publicUrl: cfg.publicUrl }));

  /* ---------- device pairing (OAuth device-authorization style) ---------- */
  app.post('/device/start', express.json({ limit: '4kb' }), (req, res) => {
    const clientName = String((req.body as Record<string, unknown>)?.client_name ?? 'brc-agent').slice(0, 80);
    const row = store.createDeviceCode(clientName, DEVICE_CODE_TTL_MS);
    res.json({
      device_code: row.device_code, user_code: row.user_code,
      verification_uri: `${cfg.publicUrl}/device/verify`,
      verification_uri_complete: `${cfg.publicUrl}/device/verify?user_code=${row.user_code}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S,
    });
  });

  app.post('/device/poll', express.json({ limit: '4kb' }), (req, res) => {
    const { device_code, device_id, name, platform } = (req.body ?? {}) as Record<string, string | undefined>;
    const row = device_code ? store.getDeviceCode(device_code) : undefined;
    if (!row) return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown device_code' });
    if (row.expires_at < Date.now()) { store.deleteDeviceCode(row.device_code); return res.status(400).json({ error: 'expired_token' }); }
    if (row.denied) { store.deleteDeviceCode(row.device_code); return res.status(400).json({ error: 'access_denied' }); }
    if (!row.approved || !row.user_id) return res.status(400).json({ error: 'authorization_pending', interval: DEVICE_POLL_INTERVAL_S });
    const deviceId = device_id || row.device_id || `dev_${row.user_code.replace('-', '').toLowerCase()}`;
    const previousGrant = store.getDevice(deviceId);
    // Pairing may rotate a device for its owner, never steal another owner's ID.
    if (previousGrant && previousGrant.user_id !== row.user_id) {
      return res.status(409).json({ error: 'device_id_conflict' });
    }
    const token = store.issueDeviceToken(deviceId, row.user_id, name || row.client_name, platform ?? null);
    // Retire the previous connection after rotating its credential.
    hub.get(deviceId)?.socket.close(4401, 'device credential rotated');
    store.deleteDeviceCode(row.device_code);
    log('info', `device paired: ${name || row.client_name} [${deviceId}] for user ${row.user_id}`);
    res.json({ device_token: token, device_id: deviceId, token_type: 'bearer', ws_url: cfg.publicUrl.replace(/^http/, 'ws') + '/ws' });
  });

  const requireLogin = (req: Request, res: Response, next: NextFunction) =>
    currentUser(req) ? next() : res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);

  app.get('/device/verify', requireLogin, (req, res) => res.type('html').send(pages.deviceVerifyPage(String(req.query.user_code ?? ''))));
  app.post('/device/verify', requireLogin, (req, res) => {
    const row = store.getDeviceCodeByUserCode(String(req.body.user_code ?? ''));
    if (!row || row.expires_at < Date.now()) return res.status(404).type('html').send(pages.deviceVerifyPage('', 'Code not found or expired.'));
    res.type('html').send(pages.deviceApprovePage(row.user_code, row.client_name));
  });
  app.post('/device/approve', requireLogin, (req, res) => {
    const userId = currentUser(req)!;
    const row = store.getDeviceCodeByUserCode(String(req.body.user_code ?? ''));
    if (!row || row.expires_at < Date.now()) return res.status(404).type('html').send(pages.messagePage('Not found', 'Code not found or expired.', false));
    if (req.body.decision !== 'allow') { store.denyDeviceCode(row.device_code); return res.type('html').send(pages.messagePage('Denied', 'Device pairing denied.', false)); }
    store.approveDeviceCode(row.device_code, userId, row.device_id ?? '');
    res.type('html').send(pages.messagePage('Device approved', `${row.client_name} can now connect. The agent will finish pairing automatically.`));
  });


  /* ---------- OAuth clients registered automatically via DCR ---------- */
  const clientRows = () => store.listClients().map((c) => {
    const m = JSON.parse(c.metadata) as { client_name?: string; redirect_uris?: string[] };
    return { client_id: c.client_id, name: m.client_name ?? c.client_id, redirect_uris: m.redirect_uris ?? [], hasSecret: !!c.client_secret, created_at: c.created_at };
  });
  app.get('/auth/clients', requireLogin, (_req, res) => res.type('html').send(pages.clientsPage(clientRows())));
  app.post('/auth/clients/delete', requireLogin, (req, res) => {
    store.deleteClient(String(req.body.client_id ?? ''));
    res.redirect('/auth/clients');
  });

  /* ---------- MCP endpoint (stateless: new server + transport per request) ---------- */
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: SCOPES, resourceMetadataUrl: `${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp` });

  app.all('/mcp', bearer, express.json({ limit: '32mb' }), async (req, res) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth!;
    const userId = String(auth.extra?.userId ?? '');
    if (!userId) return res.status(401).json({ error: 'invalid_token' });
    if (!withinJsonElementLimit(req.body)) {
      return res.status(413).json({ jsonrpc: '2.0', error: { code: -32600, message: 'MCP request has too many elements' }, id: null });
    }
    const server = createMcpServer(hub, store, { userId, clientId: auth.clientId }, cfg.relayVersion, workspaces);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log('error', `mcp request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });

  /* ---------- admin dashboard ---------- */
  app.get('/admin', requireLogin, (req, res) => {
    const userId = currentUser(req)!;
    const online = new Set(hub.list(userId).map((d) => d.deviceId));
    const devices = store.listDevices(userId).map((d) => ({ ...d, online: online.has(d.device_id) }));
    const names = new Map(devices.map((d) => [d.device_id, d.name]));
    const audit = store.recentAudit(userId, 100).map((a) => ({ ts: a.ts, device: names.get(a.device_id ?? '') ?? (a.device_id ?? '?').slice(0, 8), client: a.client, tool: a.tool, ok: a.ok, ms: a.ms, error: a.error }));
    res.type('html').send(adminPages.adminPage(cfg.publicUrl, devices, audit, store.auditStats(userId)));
  });
  app.post('/admin/device', requireLogin, (req, res) => {
    const userId = currentUser(req)!;
    const { device_id, action, name } = req.body as Record<string, string>;
    const dev = store.getDevice(String(device_id ?? ''));
    if (!dev || dev.user_id !== userId) return res.status(404).type('html').send(pages.messagePage('Not found', 'Unknown device.', false));
    switch (action) {
      case 'rename': store.renameDevice(dev.device_id, String(name ?? '').trim().slice(0, 80) || dev.name); break;
      case 'pause': store.setDevicePaused(dev.device_id, true); break;
      case 'resume': store.setDevicePaused(dev.device_id, false); break;
      case 'delete': store.deleteDevice(dev.device_id); hub.get(dev.device_id)?.socket.close(4401, 'device removed'); break;
    }
    log('info', `admin: ${action} device ${dev.device_id}`);
    res.redirect('/admin');
  });

  /* ---------- API keys ---------- */
  app.get('/auth/apikeys', requireLogin, (req, res) => res.type('html').send(adminPages.apiKeysPage(store.listApiKeys(currentUser(req)!))));
  app.post('/auth/apikeys', requireLogin, (req, res) => {
    const userId = currentUser(req)!;
    const name = String(req.body.name ?? '').trim().slice(0, 80) || 'api-key';
    const { raw } = store.createApiKey(userId, name);
    log('info', `api key created: ${name}`);
    res.type('html').send(adminPages.apiKeysPage(store.listApiKeys(userId), { name, raw }));
  });
  app.post('/auth/apikeys/revoke', requireLogin, (req, res) => {
    store.revokeApiKey(currentUser(req)!, String(req.body.prefix ?? ''));
    res.redirect('/auth/apikeys');
  });

  /* ---------- agent WebSocket (device token) ---------- */
  const http = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', cfg.publicUrl);
    if (url.pathname !== '/ws') return socket.destroy();
    // Reject URI device tokens even when a valid Authorization header is
    // supplied. URI query params can be stored in reverse-proxy/access logs.
    if (url.searchParams.has('token')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
    const dev = token ? store.getDeviceByToken(token) : undefined;
    if (!dev) { log('warn', `agent auth failed from ${req.socket.remoteAddress}`); socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // A private, immutable hash binding, never the bearer itself.
      Object.defineProperty(ws, 'hermesAuthTokenHash', {
        value: dev.token_hash, writable: false, configurable: false, enumerable: false,
      });
      hub.attach(ws, dev.user_id, dev.device_id);
      store.touchDevice(dev.device_id);
    });
  });

  const housekeeping = setInterval(() => store.vacuumExpired(), 10 * 60_000);
  housekeeping.unref();
  const observe = () => {
    if (!cfg.observerDirectory || !observerEnabled(cfg.observerDirectory)) return;
    try { publishObservation(cfg.observerDirectory, observation(hub, store, admin.id, workspaces)); }
    catch { log('warn', 'HERMES_OBSERVER_REFUSED'); }
  };
  observe();
  const observer = cfg.observerDirectory ? setInterval(observe, 60_000) : undefined;
  observer?.unref();

  log('info', `admin user "${admin.username}" ready; db ${cfg.dbFile}`);

  return {
    http, hub, store,
    close: async () => { clearInterval(housekeeping); if (observer) clearInterval(observer); hub.close(); wss.close(); await new Promise<void>((r) => http.close(() => r())); store.close(); },
  };
}
