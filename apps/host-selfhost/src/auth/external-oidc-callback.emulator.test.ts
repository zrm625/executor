import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { createEmulator, type Emulator } from "@executor-js/emulate";
import { afterAll, expect, test, vi } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";
import { EXTERNAL_OIDC_PROVIDER_ID } from "../config";

const BASE = "https://executor.example.test";
const ISSUER = "https://identity.example.test";
const AUTHORIZATION_URL = `${ISSUER}/oauth2/authorize`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const USERINFO_URL = `${ISSUER}/oauth2/userinfo`;
const CALLBACK = `${BASE}/api/auth/oauth2/callback/${EXTERNAL_OIDC_PROVIDER_ID}`;
const CLIENT_SECRET = "A".repeat(64);
const DATA_DIR = mkdtempSync(join(tmpdir(), "executor-external-oidc-emulator-"));

process.env.EXECUTOR_DATA_DIR = DATA_DIR;
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-abcdefghijklmnop-qrstuv";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "linked@example.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "linked-password-123";
process.env.EXECUTOR_WEB_BASE_URL = BASE;
// A matching SSO allowlist must never admit an unlinked external OIDC user.
process.env.EXECUTOR_SSO_PROVIDER_ID = "okta";
process.env.EXECUTOR_SSO_DISCOVERY_URL =
  "https://sso.example.test/.well-known/openid-configuration";
process.env.EXECUTOR_SSO_CLIENT_ID = "sso-client";
process.env.EXECUTOR_SSO_CLIENT_SECRET = CLIENT_SECRET;
process.env.EXECUTOR_SSO_ALLOWED_DOMAINS = "example.test";
process.env.EXECUTOR_OIDC_ENABLED = "true";
process.env.EXECUTOR_OIDC_ISSUER = ISSUER;
process.env.EXECUTOR_OIDC_AUTHORIZATION_URL = AUTHORIZATION_URL;
process.env.EXECUTOR_OIDC_TOKEN_URL = TOKEN_URL;
process.env.EXECUTOR_OIDC_USERINFO_URL = USERINFO_URL;
process.env.EXECUTOR_OIDC_CLIENT_ID = "executor";
process.env.EXECUTOR_OIDC_CLIENT_SECRET = CLIENT_SECRET;

const emulatorPort = await new Promise<number>((resolve) => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address();
    const port = typeof address === "object" && address ? address.port : 0;
    reservation.close(() => resolve(port));
  });
});

const emulator: Emulator = await createEmulator({
  service: "okta",
  port: emulatorPort,
  seed: {
    okta: {
      users: [
        {
          okta_id: "oidc-sso-subject",
          login: "sso@example.test",
          email: "sso@example.test",
          first_name: "SSO",
          last_name: "Member",
        },
        {
          okta_id: "oidc-linked-subject",
          login: "linked@example.test",
          email: "linked@example.test",
          first_name: "Linked",
          last_name: "Operator",
        },
        {
          okta_id: "oidc-other-subject",
          login: "other@example.test",
          email: "other@example.test",
          first_name: "Other",
          last_name: "Operator",
        },
        {
          okta_id: "oidc-new-subject",
          login: "new@example.test",
          email: "new@example.test",
          first_name: "New",
          last_name: "Operator",
        },
      ],
      oauth_clients: [
        {
          client_id: "sso-client",
          client_secret: CLIENT_SECRET,
          name: "SSO callback contract",
          redirect_uris: [`${BASE}/api/auth/oauth2/callback/okta`],
          response_types: ["code"],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "client_secret_post",
          auth_server_id: "default",
        },
        {
          client_id: "executor",
          client_secret: CLIENT_SECRET,
          name: "Executor callback contract",
          redirect_uris: [CALLBACK],
          response_types: ["code"],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "client_secret_basic",
          auth_server_id: "default",
        },
      ],
    },
  },
});

process.env.EXECUTOR_SSO_DISCOVERY_URL = `${emulator.url}/oauth2/default/.well-known/openid-configuration`;

const nativeFetch = globalThis.fetch;
const providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(rawUrl);
  if (url.origin !== new URL(ISSUER).origin) return nativeFetch(input, init);
  const mappedPath =
    rawUrl === TOKEN_URL
      ? "/oauth2/default/v1/token"
      : rawUrl === USERINFO_URL
        ? "/oauth2/default/v1/userinfo"
        : url.pathname;
  const mapped = new URL(mappedPath + url.search, emulator.url);
  return nativeFetch(input instanceof Request ? new Request(mapped, input) : mapped, init);
});

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();

afterAll(async () => {
  providerFetch.mockRestore();
  await dispose();
  await emulator.close();
});

const cookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""])
    .filter(Boolean)
    .map((value) => value.split(";", 1)[0]!)
    .join("; ");

const callbackError = (response: Response): string | null => {
  const location = new URL(response.headers.get("location") ?? BASE, BASE);
  return location.searchParams.getAll("error").at(-1) ?? null;
};

const localSignIn = async (email: string, password: string): Promise<string> => {
  const response = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(response.status).toBe(200);
  return cookieHeader(response);
};

const startOidc = async (mode: "signin" | "link", sessionCookie?: string) => {
  const response = await handler(
    new Request(`${BASE}/api/auth/${mode === "signin" ? "sign-in/oauth2" : "oauth2/link"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(sessionCookie ? { cookie: sessionCookie } : {}),
      },
      body: JSON.stringify({
        providerId: EXTERNAL_OIDC_PROVIDER_ID,
        callbackURL: "/",
        errorCallbackURL: "/login?error=oidc",
        ...(mode === "signin" ? { requestSignUp: false } : {}),
      }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { url: string };
  return {
    authorization: new URL(body.url),
    cookie: [sessionCookie, cookieHeader(response)].filter(Boolean).join("; "),
  };
};

const finishOidc = async (
  started: Awaited<ReturnType<typeof startOidc>>,
  userRef: string,
): Promise<Response> => {
  const query = started.authorization.searchParams;
  const selected = await nativeFetch(
    new URL("/oauth2/default/v1/authorize/callback", emulator.url),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_ref: userRef,
        redirect_uri: query.get("redirect_uri") ?? "",
        scope: query.get("scope") ?? "openid profile email",
        state: query.get("state") ?? "",
        nonce: query.get("nonce") ?? "",
        client_id: query.get("client_id") ?? "",
        response_mode: "query",
        code_challenge: query.get("code_challenge") ?? "",
        code_challenge_method: query.get("code_challenge_method") ?? "",
        auth_server_id: "default",
      }),
      redirect: "manual",
    },
  );
  expect(selected.status).toBe(302);
  const callback = new URL(selected.headers.get("location") ?? "");
  if (callback.pathname.endsWith(EXTERNAL_OIDC_PROVIDER_ID))
    callback.searchParams.set("iss", ISSUER);
  return handler(new Request(callback, { headers: { cookie: started.cookie } }));
};

test("real OIDC callbacks deny signup and takeover while explicit matching links remain usable", async () => {
  const ssoStart = await handler(
    new Request(`${BASE}/api/auth/sign-in/oauth2`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ providerId: "okta", callbackURL: "/" }),
    }),
  );
  expect(ssoStart.status).toBe(200);
  const ssoBody = (await ssoStart.json()) as { url: string };
  const ssoCallback = await finishOidc(
    { authorization: new URL(ssoBody.url), cookie: cookieHeader(ssoStart) },
    "oidc-sso-subject",
  );
  expect(ssoCallback.status).toBe(302);
  expect(callbackError(ssoCallback)).toBeNull();
  // Even a verified local email must remain unlinked after an SSO callback.
  const verificationDb = createClient({ url: `file:${join(DATA_DIR, "data.db")}` });
  await verificationDb.execute({
    sql: "UPDATE user SET emailVerified = 1 WHERE email = ?",
    args: ["linked@example.test"],
  });
  verificationDb.close();

  const unknown = await finishOidc(await startOidc("signin"), "oidc-new-subject");
  expect(unknown.status).toBe(302);
  expect(callbackError(unknown)).toBe("signup_disabled");

  const unlinked = await finishOidc(await startOidc("signin"), "oidc-linked-subject");
  expect(unlinked.status).toBe(302);
  expect(callbackError(unlinked)).toBe("account_not_linked");

  const adminCookie = await localSignIn("linked@example.test", "linked-password-123");
  const mismatch = await finishOidc(await startOidc("link", adminCookie), "oidc-other-subject");
  expect(mismatch.status).toBe(302);
  expect(callbackError(mismatch)).toBe("email_doesn't_match");

  const linked = await finishOidc(await startOidc("link", adminCookie), "oidc-linked-subject");
  expect(linked.status).toBe(302);
  expect(new URL(linked.headers.get("location") ?? BASE, BASE).pathname).toBe("/");

  const signedIn = await finishOidc(await startOidc("signin"), "oidc-linked-subject");
  expect(signedIn.status).toBe(302);
  expect(new URL(signedIn.headers.get("location") ?? BASE, BASE).pathname).toBe("/");

  const inviteCode = await mintInviteCode(handler);
  const attackerSignup = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        email: "attacker@example.test",
        password: "attacker-password-123",
        name: "Attacker",
        inviteCode,
      }),
    }),
  );
  expect(attackerSignup.status).toBe(200);

  const changedIdentity = await nativeFetch(
    new URL("/api/v1/users/oidc-linked-subject", emulator.url),
    {
      method: "POST",
      headers: {
        authorization: "SSWS test_token_admin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        profile: { login: "attacker@example.test", email: "attacker@example.test" },
      }),
    },
  );
  expect(changedIdentity.status).toBe(200);

  const attackerCookie = cookieHeader(attackerSignup);
  const alreadyLinked = await finishOidc(
    await startOidc("link", attackerCookie),
    "oidc-linked-subject",
  );
  expect(alreadyLinked.status).toBe(302);
  expect(callbackError(alreadyLinked)).toBe("account_already_linked_to_different_user");

  const db = createClient({ url: `file:${join(DATA_DIR, "data.db")}` });
  const users = await db.execute("SELECT email FROM user ORDER BY email");
  expect(users.rows.map((row) => row.email)).not.toContain("new@example.test");
  const accounts = await db.execute({
    sql: "SELECT a.userId, u.email, a.accessToken, a.refreshToken, a.idToken FROM account a JOIN user u ON u.id = a.userId WHERE a.providerId = ?",
    args: [EXTERNAL_OIDC_PROVIDER_ID],
  });
  expect(accounts.rows).toHaveLength(1);
  expect(accounts.rows[0]?.email).toBe("linked@example.test");
  expect(accounts.rows[0]?.idToken).toBeNull();
  expect(String(accounts.rows[0]?.accessToken)).toMatch(/^[0-9a-f]{64,}$/i);
  expect(String(accounts.rows[0]?.accessToken)).not.toContain("okta_");
  expect(String(accounts.rows[0]?.refreshToken)).toMatch(/^[0-9a-f]{64,}$/i);
  expect(String(accounts.rows[0]?.refreshToken)).not.toContain("r_okta_");
  db.close();

  const ledger = await emulator.ledger.list();
  expect(ledger.map((entry) => entry.path)).toContain("/oauth2/default/v1/token");
  expect(ledger.map((entry) => entry.path)).toContain("/oauth2/default/v1/userinfo");

  const deniedDeepLink = await handler(
    new Request(`${CALLBACK}?error=access_denied&iss=${encodeURIComponent(ISSUER)}`),
  );
  expect(deniedDeepLink.status).not.toBe(404);
});
