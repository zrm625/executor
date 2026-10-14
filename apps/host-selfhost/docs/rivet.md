# Connect a private Rivet service

Rivet owns the phone connection, Google session, archive, and write authorization.
Executor consumes its private MCP endpoint and proxies owner-only setup. The
server never hosts a Google browser or forwards browser keyboard or frame input.
Google sign-in opens the installed Rivet helper on a nearby computer.

Set `EXECUTOR_RIVET_SETUP_CONFIG_FILE` to an absolute owner-only JSON file with
`endpoint`, `tokenFile`, `ownerId`, `integration`, and `browserOrigin`. The endpoint
ends in `/setup`; it must use HTTPS except for local fixtures. Its DNS addresses
must all be private. Requests pin one address and family, retain TLS hostname
validation, refuse redirects, and bound request and response sizes.

The token file contains a separate 64-character hexadecimal management credential.
It must belong to the service account and be private, regular, and not a symlink
or hard link. Keep it separate from the phone and ordinary MCP credentials. It
never reaches the browser. Only the configured existing `ownerId` may manage setup,
regardless of instance role. Browser POSTs require the exact configured origin.
Unconfigured integrations hide the panel and return 404. Invalid configuration
fails closed. Equivalent `EXECUTOR_RIVET_SETUP_*` server variables are supported.

The panel reports phone connectivity, saved Google session, and Google authentication
separately. Verify saved sessions instead of pairing again. Hiding the phone QR
does not revoke its persistent credential. A later successful check supersedes
an old pairing failure. Authentication is point-in-time evidence.

For MCP health, select an explicit read-only operation such as `texts_gm_health`.
Discovery alone reports connection health and does not authenticate Google. The
plugin does not invoke candidates while listing them. Execution errors produce
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
file inside the directory. Then run from `e2e`:

```sh
../node_modules/.bin/vitest run --project selfhost selfhost/rivet-setup-ui.test.ts
```

The scenario creates a fresh Executor session and synthetic phone/account state.
It records QR display, phone connection, cancel/retry, single-use local handoff,
emoji confirmation, and verification. It does not launch a real Google login or
read a phone. Stop the fixture before removing its disposable state. Without the
native fixture, the cross-repository scenario reports its prerequisite as a skip.

## Source delivery and rollout

Review the Rivet producer and Executor consumer separately. Deploy the compatible
producer before enabling consumer management configuration, under separate operator
authority. Choose the exact owner and browser origin without changing account roles.
Rollback the consumer independently. Preserve the producer's current session,
archive, credentials, and deduplication receipts across runtime changes.

Source checks do not authorize deployment or prove phone pairing, real passkey
login, authenticated restart, natural refresh, or restore.
