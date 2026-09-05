# Self-hosted Executor

The single-container, self-hostable Executor server: the typed API, the MCP
server, Better Auth (cookie / bearer / API-key + MCP OAuth), QuickJS code
execution, and the web UI — all in one process over a libSQL (SQLite) file. No
external database, worker, or proxy.

## Run it

Using the published image:

```bash
docker run -d \
  --name executor-selfhost \
  -p 4788:4788 \
  -v executor-data:/data \
  ghcr.io/usefulsoftwareco/executor-selfhost:latest
```

Or build from a repository clone:

```bash
# From this directory:
docker compose up -d --build
# then open http://localhost:4788 and create the admin account
```

No configuration is required. A fresh instance shows a setup screen; the first
person to create an account becomes the owner. After that, people join via
single-use invite links you mint from the **Admin** page, and self-service
signup is closed.

See [`.env.example`](./.env.example) for optional settings (most importantly
`EXECUTOR_WEB_BASE_URL` behind a domain / TLS) and the full
[Self-Hosting guide](../../docs/self-hosting/guide.mdx) for first-run, inviting
people, backups, reverse-proxy setup, and upgrades.

## Optional external OIDC login

The normal browser login can additionally use an operator-configured external
OIDC provider. This is opt-in; local email/password login and all existing
API-key, CLI device, API, and MCP authentication paths remain in place.

Register a confidential OIDC client with this exact redirect URI, substituting
the public Executor origin:

```text
https://executor.example.com/api/auth/oauth2/callback/external-oidc
```

Then set `EXECUTOR_WEB_BASE_URL`, `EXECUTOR_OIDC_ENABLED=true`, and the exact
`EXECUTOR_OIDC_ISSUER`, `EXECUTOR_OIDC_AUTHORIZATION_URL`,
`EXECUTOR_OIDC_TOKEN_URL`, `EXECUTOR_OIDC_USERINFO_URL`, and
`EXECUTOR_OIDC_CLIENT_ID` values supplied by the provider. Every URL must be a
credential-free HTTPS URL without a query or fragment. Supply exactly one of
`EXECUTOR_OIDC_CLIENT_SECRET` or `EXECUTOR_OIDC_CLIENT_SECRET_FILE`. A secret
must be exactly 64 base64url characters. A secret file must be a non-symlink
regular file owned by the Executor process UID with mode `0600`.

OIDC cannot create an Executor user or silently attach to an email match. Each
person first signs in with their existing local account and chooses **Link
external login to an existing account**. Executor then uses authorization code
with PKCE S256 and `client_secret_basic`, and accepts identity only from the
configured UserInfo endpoint with a stable subject and verified email. UserInfo
must be HTTPS JSON, arrive within five seconds, and fit within 16 KiB;
redirects, malformed or oversized claims, and unverified email fail closed.
The separate `EXECUTOR_SSO_*` provider can coexist with external OIDC. Its
verified-domain signup and verified-email linking behavior remains independent;
`external-oidc` is reserved and cannot be used as its provider ID. Existing
setup or invite accounts can choose **Link <provider> to an existing account**
on the login page, prove their local password, and approve the matching,
verified provider identity. No local email-verification delivery or database
edit is needed. SSO linking still requires an allowed provider email domain;
failed sign-in or linking returns to the login form with the requested page retained.
After linking, either login method remains available. Raw ID tokens are not
persisted; access and refresh tokens are encrypted at rest.

To roll back, set `EXECUTOR_OIDC_ENABLED=false` (or remove it) and restart.
The OIDC controls disappear; local login and linked account records remain
unchanged, so re-enabling does not require relinking.

## Develop

```bash
bun run build                  # build the SPA (regenerates the route tree)
bun run src/serve.ts           # serve the built app
bun run --filter @executor-js/host-selfhost test   # the test suite
```

## Layout

```
src/
  app.ts            the ExecutorApp.make composition root
  serve.ts          the Bun server entry
  config.ts         env + zero-config secret/key persistence
  auth/             Better Auth wiring, the signup gate, invite codes, seed
  account/          the AccountProvider seam (members/roles via the org plugin)
  admin/            the invite-code admin HttpApi
  system/           public /api/health + /api/setup-status
  db/ · mcp/ · execution.ts · plugins.ts · observability.ts
web/                the TanStack Router SPA (setup, login, join, admin, …)
```
