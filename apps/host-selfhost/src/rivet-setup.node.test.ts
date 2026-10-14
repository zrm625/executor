import { createServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "@effect/vitest";

const directory = mkdtempSync(join(tmpdir(), "executor-rivet-owner-"));
process.env.EXECUTOR_DATA_DIR = directory;
process.env.BETTER_AUTH_SECRET = "synthetic-rivet-setup-secret-0123456789abcdef";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@rivet-setup.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "synthetic-admin-password-123";
process.env.EXECUTOR_RIVET_SETUP_CONFIG_FILE = join(directory, "setup-config.json");
const config = (
  ownerId: string,
  endpoint = "http://127.0.0.1:1/setup",
  tokenFile = join(directory, "not-created.token"),
) =>
  writeFileSync(
    process.env.EXECUTOR_RIVET_SETUP_CONFIG_FILE!,
    JSON.stringify({
      endpoint,
      tokenFile,
      ownerId,
      integration: "synthetic-rivet",
      browserOrigin: "http://localhost:4788",
    }),
    { mode: 0o600 },
  );
config("not-the-owner");
const { makeSelfHostApiHandler } = await import("./app");
let app = await makeSelfHostApiHandler();
afterAll(async () => {
  await app.dispose();
  rmSync(directory, { recursive: true, force: true });
});

test("Rivet management uses the real session gate, exact configured account owner, and same-origin requests", async () => {
  const url = "http://localhost:4788/api/rivet-setup/synthetic-rivet/";
  expect((await app.handler(new Request(url + "status"))).status).toBe(401);
  const signedIn = await app.handler(
    new Request("http://localhost:4788/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
      }),
    }),
  );
  expect(signedIn.status).toBe(200);
  const session = (await signedIn.json()) as { user: { id: string } };
  const token = signedIn.headers.get("set-auth-token")!;
  expect(token).toBeTruthy();
  const auth = { Authorization: `Bearer ${token}` };
  expect((await app.handler(new Request(url + "status", { headers: auth }))).status).toBe(403);
  config(session.user.id);
  const post = (origin: string | null) =>
    app.handler(
      new Request(url + "phone-qr", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: "{}",
      }),
    );
  expect((await post(null)).status).toBe(403);
  expect((await post("https://another.example.test")).status).toBe(403);
  expect((await post("http://localhost:4788")).status).toBe(502); // Authorized; missing owner token refuses upstream access.
  expect(
    (
      await app.handler(
        new Request(url.replace("synthetic-rivet", "another-integration") + "status", {
          headers: auth,
        }),
      )
    ).status,
  ).toBe(404);
});

test("The configured SSO account can own setup without an instance admin role", async () => {
  // Close the app before opening a fixture writer; never create competing WAL
  // connections to the running self-host database.
  await app.dispose();
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: `file:${join(directory, "data.db")}` });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- fixture boundary: close the offline database writer even when setup fails
  try {
    await db.execute("UPDATE member SET role = 'member'");
  } finally {
    db.close();
  }
  app = await makeSelfHostApiHandler();
  const signedIn = await app.handler(
    new Request("http://localhost:4788/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
      }),
    }),
  );
  expect(signedIn.status).toBe(200);
  const session = (await signedIn.json()) as { user: { id: string } };
  config(session.user.id);
  const headers = { Authorization: `Bearer ${signedIn.headers.get("set-auth-token")!}` };
  expect(
    (
      await app.handler(
        new Request("http://localhost:4788/api/rivet-setup/synthetic-rivet/status", { headers }),
      )
    ).status,
  ).toBe(502);
  config("another-owner");
  expect(
    (
      await app.handler(
        new Request("http://localhost:4788/api/rivet-setup/synthetic-rivet/status", { headers }),
      )
    ).status,
  ).toBe(403);
});

test("IPv6 setup transport preserves TLS, pins management identity, and keeps upstream failures retryable", async () => {
  const run = promisify(execFile);
  const certPath = join(directory, "fixture.crt"),
    keyPath = join(directory, "fixture.key");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:::1",
  ]);
  const originalTrust = getCACertificates("default");
  setDefaultCACertificates([...originalTrust, readFileSync(certPath, "utf8")]);
  let upstreamStatus = 200,
    requests = 0;
  let setupEndpoint = "";
  const upstream = createServer(
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    (req, res) => {
      requests++;
      expect(req.headers.authorization).toBe("Bearer " + "b".repeat(64));
      res.writeHead(upstreamStatus, {
        "content-type": "application/json",
        ...(upstreamStatus === 302 ? { location: "/setup/status" } : {}),
      });
      res.end(
        JSON.stringify({
          phoneConnected: false,
          phoneEndpoint: "wss://phone.example.test:8778/phone",
          setupEndpoint,
          googleConfigured: true,
          googleSessionPresent: false,
          googleAuthenticated: false,
          checkedAt: null,
          error: null,
          google: null,
        }),
      );
    },
  );
  await new Promise<void>((resolve) => upstream.listen(0, "::1", resolve));
  const address = upstream.address();
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: the native TLS fixture requires an allocated port
  if (!address || typeof address === "string") throw new Error("Fixture port required");
  const endpoint = `https://[::1]:${address.port}/setup`;
  setupEndpoint = endpoint;
  const tokenFile = join(directory, "fixture.token");
  writeFileSync(tokenFile, "b".repeat(64), { mode: 0o600 });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: always close the native TLS server and restore per-worker CA trust
  try {
    const signedIn = await app.handler(
      new Request("http://localhost:4788/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
          password: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
        }),
      }),
    );
    const session = (await signedIn.json()) as { user: { id: string } };
    config(session.user.id, endpoint, tokenFile);
    const url = "http://localhost:4788/api/rivet-setup/synthetic-rivet/status";
    const get = () =>
      app.handler(
        new Request(url, {
          headers: { authorization: `Bearer ${signedIn.headers.get("set-auth-token")!}` },
        }),
      );
    expect((await get()).status).toBe(200);
    for (const status of [401, 403, 404]) {
      upstreamStatus = status;
      const result = await get();
      expect(result.status).toBe(502);
      expect(await result.json()).toEqual({
        error:
          status === 404
            ? "SETUP_UPSTREAM_ROUTE_UNAVAILABLE"
            : "SETUP_UPSTREAM_AUTHORIZATION_FAILED",
      });
    }
    upstreamStatus = 200;
    setupEndpoint = "https://[::1]:1/setup";
    const mismatch = await get();
    expect(mismatch.status).toBe(502);
    expect(await mismatch.json()).toEqual({ error: "SETUP_ENDPOINT_MISMATCH" });
    setupEndpoint = endpoint;
    expect((await get()).status).toBe(200);
    upstreamStatus = 302;
    const before = requests;
    expect((await get()).status).toBe(502);
    expect(requests).toBe(before + 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: adapt Node server shutdown errors to the test lifecycle
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    setDefaultCACertificates(originalTrust);
  }
});
