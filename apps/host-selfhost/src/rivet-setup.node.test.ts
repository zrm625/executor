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
const config = (ownerId: string) =>
  writeFileSync(
    process.env.EXECUTOR_RIVET_SETUP_CONFIG_FILE!,
    JSON.stringify({
      endpoint: "http://127.0.0.1:1/setup",
      tokenFile: join(directory, "not-created.token"),
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
