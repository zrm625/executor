import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmulator } from "@executor-js/emulate";
import { expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, RunDir, Target } from "../src/services";
import { claimAndBoot } from "../src/ports";
import * as selfhostBoot from "../setup/selfhost.boot";
import { SELFHOST_ADMIN } from "../targets/selfhost";
import { visit } from "../src/surfaces/browser";

const bootOidcBrowser = (dataDir: string, runDir: string) =>
  claimAndBoot(
    [
      { envVar: "E2E_SELFHOST_OIDC_PORT", offset: 7, label: "selfhost OIDC login" },
      { envVar: "E2E_SELFHOST_SSO_IDP_PORT", offset: 8, label: "selfhost SSO IdP" },
    ],
    async (ports) => {
      const port = ports.E2E_SELFHOST_OIDC_PORT!;
      const baseUrl = `http://localhost:${port}`;
      const idp = await createEmulator({
        service: "okta",
        port: ports.E2E_SELFHOST_SSO_IDP_PORT!,
      });
      // Setup can fail before claimAndBoot receives a teardown.
      try {
        const registration = await fetch(`${idp.url}/oauth2/v1/clients`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "browser-sso",
            redirect_uris: [`${baseUrl}/api/auth/oauth2/callback/okta`],
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "client_secret_post",
          }),
        }).then(
          (response) => response.json() as Promise<{ client_id: string; client_secret: string }>,
        );
        for (const email of [SELFHOST_ADMIN.email, "denied@outside.test"]) {
          await fetch(`${idp.url}/api/v1/users`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "SSWS test" },
            body: JSON.stringify({
              profile: { login: email, email, firstName: "Synthetic", lastName: "User" },
            }),
          });
        }
        const procs = await selfhostBoot.bootSelfhost({
          port,
          webBaseUrl: baseUrl,
          admin: SELFHOST_ADMIN,
          dataDir,
          logFile: join(runDir, "oidc-boot.log"),
          authEnv: {
            EXECUTOR_OIDC_ENABLED: "true",
            EXECUTOR_OIDC_ISSUER: "https://identity.example.test",
            EXECUTOR_OIDC_AUTHORIZATION_URL: "https://identity.example.test/authorize",
            EXECUTOR_OIDC_TOKEN_URL: "https://identity.example.test/token",
            EXECUTOR_OIDC_USERINFO_URL: "https://identity.example.test/userinfo",
            EXECUTOR_OIDC_CLIENT_ID: "browser-fixture",
            EXECUTOR_OIDC_CLIENT_SECRET: "A".repeat(64),
            EXECUTOR_SSO_PROVIDER_ID: "okta",
            EXECUTOR_SSO_DISCOVERY_URL: `${idp.url}/.well-known/openid-configuration`,
            EXECUTOR_SSO_CLIENT_ID: registration.client_id,
            EXECUTOR_SSO_CLIENT_SECRET: registration.client_secret,
            EXECUTOR_SSO_ALLOWED_DOMAINS: "e2e.test",
          },
        });
        return {
          teardown: async () => {
            try {
              await procs.teardown();
            } finally {
              await idp.close();
            }
          },
          value: baseUrl,
        };
      } catch (error) {
        await idp.close();
        throw error;
      }
    },
    { label: "selfhost OIDC login" },
  );

scenario(
  "External OIDC · coexistence, explicit linking and deep-link return",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const runDir = yield* RunDir;
    const dataDir = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-oidc-browser-"))),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
    const booted = yield* Effect.acquireRelease(
      Effect.promise(() => bootOidcBrowser(dataDir, runDir)),
      (instance) => Effect.promise(() => instance.teardown()),
    );
    yield* browser.session({ label: "anonymous" }, async ({ page, step }) => {
      await step("Disabled external OIDC leaves local login available", async () => {
        await visit(page, `${target.baseUrl}/login`);
        await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
        expect(
          await page
            .getByRole("button", { name: "Sign in with identity provider", exact: true })
            .count(),
        ).toBe(0);
      });
      await step("MCP authorization survives SSO denial and local sign-in", async () => {
        const registration = await page.request.post(`${booted.value}/api/auth/mcp/register`, {
          data: {
            client_name: "browser MCP recovery",
            redirect_uris: ["http://127.0.0.1:9/callback"],
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
        });
        expect(registration.ok()).toBe(true);
        const client = (await registration.json()) as { client_id: string };
        const params = new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: "http://127.0.0.1:9/callback",
          state: "mcp-client-state",
          code_challenge: createHash("sha256")
            .update("synthetic-verifier".repeat(4))
            .digest("base64url"),
          code_challenge_method: "S256",
          scope: "openid",
          prompt: "consent",
        });
        await visit(page, `${booted.value}/api/auth/mcp/authorize?${params}`);
        await page.getByRole("button", { name: "Continue with Okta", exact: true }).click();
        await page
          .locator("form")
          .filter({ hasText: "denied@outside.test" })
          .locator('button[type="submit"]')
          .click();
        await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
        const recovered = new URL(page.url());
        expect(recovered.pathname).toBe("/login");
        for (const [key, value] of params) expect(recovered.searchParams.get(key)).toBe(value);
        const resume = page.waitForRequest(
          (request) => new URL(request.url()).pathname === "/api/auth/mcp/authorize",
        );
        await page.getByLabel("Email", { exact: true }).fill(SELFHOST_ADMIN.email);
        await page.getByLabel("Password", { exact: true }).fill(SELFHOST_ADMIN.password);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        const resumed = new URL((await resume).url());
        for (const [key, value] of params) expect(resumed.searchParams.get(key)).toBe(value);
        await page.waitForURL("**/mcp-consent**");
        // The test is the MCP client: capture its callback without leaving the UI.
        await page.route("http://127.0.0.1:9/callback**", (route) =>
          route.fulfill({ status: 204 }),
        );
        const callback = page.waitForRequest((request) =>
          request.url().startsWith("http://127.0.0.1:9/callback?"),
        );
        await page.getByRole("button", { name: "Allow", exact: true }).click();
        const completed = new URL((await callback).url());
        expect(completed.searchParams.get("state")).toBe("mcp-client-state");
        expect(completed.searchParams.get("code")).toBeTruthy();
        const token = await page.request.post(`${booted.value}/api/auth/mcp/token`, {
          form: {
            grant_type: "authorization_code",
            code: completed.searchParams.get("code")!,
            client_id: client.client_id,
            redirect_uri: "http://127.0.0.1:9/callback",
            code_verifier: "synthetic-verifier".repeat(4),
          },
        });
        expect(token.ok()).toBe(true);
        expect(((await token.json()) as { access_token: string }).access_token).toBeTruthy();
        await page.context().clearCookies();
      });
      await step("Both providers appear on a signed-out deep link", async () => {
        await visit(page, `${booted.value}/api-keys`);
        await page
          .getByRole("button", { name: "Sign in with identity provider", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "Continue with Okta", exact: true }).waitFor();
        expect(new URL(page.url()).pathname).toBe("/api-keys");
      });
      await step("A disallowed SSO account returns to login with the deep link", async () => {
        await page.getByRole("button", { name: "Continue with Okta", exact: true }).click();
        await page
          .locator("form")
          .filter({ hasText: "denied@outside.test" })
          .locator('button[type="submit"]')
          .click();
        await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
        const location = new URL(page.url());
        expect(location.pathname).toBe("/login");
        expect(location.searchParams.get("returnTo")).toBe("/api-keys");
        await page.getByText("External sign-in did not complete.", { exact: false }).waitFor();
      });
      await step("An existing local account can explicitly adopt SSO", async () => {
        await page
          .getByRole("button", { name: "Link Okta to an existing account", exact: true })
          .click();
        await page.getByLabel("Email", { exact: true }).fill(SELFHOST_ADMIN.email);
        await page.getByLabel("Password", { exact: true }).fill(SELFHOST_ADMIN.password);
        await page
          .getByRole("button", { name: "Continue to identity provider", exact: true })
          .click();
        await page
          .locator("form")
          .filter({ hasText: "denied@outside.test" })
          .locator('button[type="submit"]')
          .click();
        await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
        expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/api-keys");
        await page
          .getByRole("button", { name: "Link Okta to an existing account", exact: true })
          .click();
        await page.getByLabel("Email", { exact: true }).fill(SELFHOST_ADMIN.email);
        await page.getByLabel("Password", { exact: true }).fill(SELFHOST_ADMIN.password);
        await page
          .getByRole("button", { name: "Continue to identity provider", exact: true })
          .click();
        await page
          .locator("form")
          .filter({ hasText: SELFHOST_ADMIN.email })
          .locator('button[type="submit"]')
          .click();
        await page.waitForURL(/\/api-keys$/);
        await page.context().clearCookies();
        await visit(page, `${booted.value}/api-keys`);
        await page.getByRole("button", { name: "Continue with Okta", exact: true }).click();
        await page
          .locator("form")
          .filter({ hasText: SELFHOST_ADMIN.email })
          .locator('button[type="submit"]')
          .click();
        await page.waitForURL(/\/api-keys$/);
        await page.context().clearCookies();
        await visit(page, `${booted.value}/api-keys`);
      });
      await step("Linking asks for the existing local account", async () => {
        await page
          .getByRole("button", {
            name: "Link external login to an existing account",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: "Continue to identity provider", exact: true })
          .waitFor();
        expect(
          await page.getByRole("button", { name: "Continue with Okta", exact: true }).count(),
        ).toBe(0);
        await page.getByLabel("Email", { exact: true }).fill(SELFHOST_ADMIN.email);
        await page.getByLabel("Password", { exact: true }).fill(SELFHOST_ADMIN.password);
      });
      // Observe and abort the outgoing navigation before any provider traffic.
      // Real token/callback semantics are covered by the published Okta emulator suite.
      await page.route("https://identity.example.test/**", (route) => route.abort());
      await step("Explicit linking preserves PKCE and the requested return target", async () => {
        const providerRequest = page.waitForRequest("https://identity.example.test/**");
        const linkedResponse = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/auth/oauth2/link",
        );
        await page
          .getByRole("button", { name: "Continue to identity provider", exact: true })
          .click();
        const response = await linkedResponse;
        expect(response.status()).toBe(200);
        const authorization = new URL((await providerRequest).url());
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorization.searchParams.get("redirect_uri")).toBe(
          `${booted.value}/api/auth/oauth2/callback/external-oidc`,
        );
        const request = response.request().postDataJSON() as { callbackURL: string };
        expect(request.callbackURL).toBe("/api-keys");
      });
      await step("Local login still reaches the requested page", async () => {
        await visit(page, `${booted.value}/api-keys`);
        expect(new URL(page.url()).pathname).toMatch(/\/api-keys$/);
        expect(await page.getByRole("heading", { name: "Sign in", exact: true }).count()).toBe(0);
      });
    });
  }).pipe(Effect.scoped),
);

it("releases the published emulator and claimed ports when selfhost setup fails", async () => {
  const failure = new Error("intentional selfhost setup failure");
  const boot = vi.spyOn(selfhostBoot, "bootSelfhost").mockRejectedValue(failure);
  const directory = mkdtempSync(join(tmpdir(), "executor-oidc-failure-"));
  try {
    await expect(bootOidcBrowser(directory, directory)).rejects.toBe(failure);
    const failedPort = Number(
      new URL(boot.mock.calls[0]![0].authEnv!.EXECUTOR_SSO_DISCOVERY_URL!).port,
    );
    // Reacquiring the same claim also proves claim locks were released.
    const probe = await claimAndBoot(
      [{ envVar: "E2E_SELFHOST_SSO_IDP_PORT", offset: 8, label: "selfhost SSO IdP" }],
      async (ports) => {
        const idp = await createEmulator({
          service: "okta",
          port: ports.E2E_SELFHOST_SSO_IDP_PORT!,
        });
        return { value: idp.url, teardown: () => idp.close() };
      },
      { maxAttempts: 1 },
    );
    try {
      expect(probe.ports.E2E_SELFHOST_SSO_IDP_PORT).toBe(failedPort);
    } finally {
      await probe.teardown();
    }
  } finally {
    boot.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
