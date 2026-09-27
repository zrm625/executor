import { afterEach, describe, expect, it } from "@effect/vitest";

import { loadConfig } from "../config";

const keys = [
  "EXECUTOR_OIDC_ISSUER_URL",
  "EXECUTOR_OIDC_CLIENT_ID",
  "EXECUTOR_OIDC_PROVIDER_NAME",
  "EXECUTOR_PASSWORD_SIGN_IN_ENABLED",
] as const;

const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("external OIDC configuration", () => {
  it("enables a public PKCE client and disables password sign-in by default", () => {
    process.env.EXECUTOR_OIDC_ISSUER_URL = "https://sso.example.test/";
    process.env.EXECUTOR_OIDC_CLIENT_ID = "executor";
    process.env.EXECUTOR_OIDC_PROVIDER_NAME = "Example SSO";

    const config = loadConfig();
    expect(config.oidc).toEqual({
      providerId: "executor-oidc",
      providerName: "Example SSO",
      issuer: "https://sso.example.test",
      discoveryUrl: "https://sso.example.test/.well-known/openid-configuration",
      clientId: "executor",
    });
    expect(config.passwordSignInEnabled).toBe(false);
  });

  it("allows an explicit local-password fallback", () => {
    process.env.EXECUTOR_OIDC_ISSUER_URL = "https://sso.example.test";
    process.env.EXECUTOR_OIDC_CLIENT_ID = "executor";
    process.env.EXECUTOR_PASSWORD_SIGN_IN_ENABLED = "true";

    expect(loadConfig().passwordSignInEnabled).toBe(true);
  });

  it("refuses a partial provider configuration", () => {
    process.env.EXECUTOR_OIDC_ISSUER_URL = "https://sso.example.test";
    delete process.env.EXECUTOR_OIDC_CLIENT_ID;

    expect(() => loadConfig()).toThrow(
      "EXECUTOR_OIDC_ISSUER_URL and EXECUTOR_OIDC_CLIENT_ID must be set together",
    );
  });
});
