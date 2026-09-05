import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, RunDir, Target } from "../src/services";
import { claimAndBoot } from "../src/ports";
import { bootSelfhost } from "../setup/selfhost.boot";
import { SELFHOST_ADMIN } from "../targets/selfhost";
import { visit } from "../src/surfaces/browser";

scenario(
  "External OIDC · coexistence, explicit linking and deep-link return",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const runDir = yield* RunDir;
    const dataDir = mkdtempSync(join(tmpdir(), "executor-oidc-browser-"));
    const booted = yield* Effect.promise(() =>
      claimAndBoot(
        [{ envVar: "E2E_SELFHOST_OIDC_PORT", offset: 7, label: "selfhost OIDC login" }],
        async (ports) => {
          const port = ports.E2E_SELFHOST_OIDC_PORT!;
          const baseUrl = `http://localhost:${port}`;
          const procs = await bootSelfhost({
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
              EXECUTOR_SSO_DISCOVERY_URL:
                "https://sso.example.test/.well-known/openid-configuration",
              EXECUTOR_SSO_CLIENT_ID: "sso-fixture",
              EXECUTOR_SSO_CLIENT_SECRET: "synthetic-sso-secret",
              EXECUTOR_SSO_ALLOWED_DOMAINS: "example.test",
            },
          });
          return { teardown: procs.teardown, value: baseUrl };
        },
        { label: "selfhost OIDC login" },
      ),
    );
    yield* browser
      .session({ label: "anonymous" }, async ({ page, step }) => {
        await step("Disabled external OIDC leaves local login available", async () => {
          await visit(page, `${target.baseUrl}/login`);
          await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
          expect(
            await page
              .getByRole("button", { name: "Sign in with identity provider", exact: true })
              .count(),
          ).toBe(0);
        });
        await step("Both providers appear on a signed-out deep link", async () => {
          await visit(page, `${booted.value}/api-keys`);
          await page
            .getByRole("button", { name: "Sign in with identity provider", exact: true })
            .waitFor();
          await page.getByRole("button", { name: "Continue with Okta", exact: true }).waitFor();
          expect(new URL(page.url()).pathname).toBe("/api-keys");
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
      })
      .pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await booted.teardown();
            rmSync(dataDir, { recursive: true, force: true });
          }),
        ),
      );
  }),
);
