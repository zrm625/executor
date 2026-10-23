# Connect a private Rivet service

Rivet owns the phone connection, Google session, archive, and write authorization.
Executor consumes its private MCP endpoint and proxies owner-only setup. The
server never hosts a Google browser or forwards browser keyboard or frame input.
Google sign-in opens the installed Rivet helper on a nearby computer.

Set `EXECUTOR_RIVET_SETUP_CONFIG_FILE` to an absolute owner-only JSON file with
`endpoint`, `tokenFile`, `ownerId`, `integration`, and `browserOrigin`. The endpoint
ends in `/setup` and must match the producer's `RIVET_SETUP_ENDPOINT`.
Management uses the MCP listener, normally 8779, independently of the phone's
8778 listener. Status includes both `setupEndpoint` and `phoneEndpoint`; the proxy
rejects a mismatched management endpoint before the browser can display a handoff.
Explicit HTTPS ports and private IPv6 literals are supported. It must use HTTPS
except for local fixtures. Its DNS addresses
must all be private. Requests pin one address and family, retain TLS hostname
validation, refuse redirects, and bound request and response sizes.

The token file contains a separate 64-character hexadecimal management credential.
It must belong to the service account and be private, regular, and not a symlink
or hard link. Keep it separate from the phone and ordinary MCP credentials. It
never reaches the browser. Only the configured existing `ownerId` may manage setup,
regardless of instance role. If `browserOrigin` is omitted, the server uses its
resolved canonical browser URL, including platform and localhost defaults.
Upstream authorization or missing-route failures keep an owner retry UI; only
local missing configuration or owner/session denial hides setup. Browser POSTs require the exact configured origin.
Unconfigured integrations hide the panel and return 404. Invalid configuration
fails closed. Equivalent `EXECUTOR_RIVET_SETUP_*` server variables are supported.

The panel reports phone connectivity, saved Google session, and Google authentication
separately. Verify saved sessions instead of pairing again. Hiding the phone QR
does not revoke its persistent credential. A later successful check supersedes
an old pairing failure. Authentication is point-in-time evidence.

For MCP health, select an explicit read-only operation such as `texts_gm_health`.
Discovery alone reports connection health and does not authenticate Google. The
plugin does not invoke candidates while listing them. Candidate operations must be compatible and read-only across every connection.
Pinned MCP arguments use JSON values, including numbers, booleans, arrays,
objects, and a literal argument named `body`. Call-time credential rejection is
expired; a scope shortfall requires broader grants rather than the same login.
Execution errors produce
bounded diagnostics without persisting arbitrary error content.

## Validate with synthetic fixtures

Run scoped Vitest tests in `apps/host-selfhost` for `rivet-setup*.test.ts` and
`rivet-setup.node.test.ts`, and in `packages/plugins/mcp` for `health-probe.test.ts`.
Run typechecks for the selfhost, MCP, and React packages, plus lint and the selfhost
production build.

The recorded browser scenario uses the native Rivet producer fixture. In a disposable
Rivet checkout, set `RIVET_SETUP_DEMO_DIR` to a new private directory under `/tmp`
and run `tsx scripts/setup-demo.ts`. Its `ready.json` provides the loopback endpoint.
Set `E2E_RIVET_SETUP_DIRECTORY`, `E2E_RIVET_SETUP_URL`, and
`EXECUTOR_RIVET_SETUP_CONFIG_FILE` to that fixture's directory, URL, and a new JSON
file inside the directory. Trust only the new fixture certificate by starting the
Executor process with `NODE_EXTRA_CA_CERTS` set to `ready.json`'s certificate path.
The fixture uses two separate HTTPS/WSS loopback listeners and rejects a reused
fixture directory. Then run from `e2e`:

```sh
../node_modules/.bin/vitest run --project selfhost selfhost/rivet-setup-ui.test.ts
```

The scenario creates a fresh Executor session and synthetic phone/account state.
It records QR display, phone connection, cancel/retry, single-use local handoff,
emoji confirmation, and verification. It does not launch a real Google login or
read a phone. Use a fresh fixture per run. The scenario removes its owner/config/phone-confirmation
sentinels in `Effect.ensuring`, including early failures. The controller must stop
and await its fixture process, then remove that exact disposable directory. Without the
native fixture, the cross-repository scenario reports its prerequisite as a skip.

## Source delivery and rollout

Review the Rivet producer and Executor consumer separately. Deploy the compatible
producer before enabling consumer management configuration, under separate operator
authority. Choose the exact owner and browser origin without changing account roles.
Rollback the consumer independently. Preserve the producer's current session,
archive, credentials, and deduplication receipts across runtime changes.

Source checks do not authorize deployment or prove phone pairing, real passkey
login, authenticated restart, natural refresh, or restore.
