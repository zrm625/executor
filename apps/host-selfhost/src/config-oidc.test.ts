import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { EXTERNAL_OIDC_PROVIDER_ID, resolveOidcConfig } from "./config";

const original = {
  enabled: process.env.EXECUTOR_OIDC_ENABLED,
  issuer: process.env.EXECUTOR_OIDC_ISSUER,
  authorizationUrl: process.env.EXECUTOR_OIDC_AUTHORIZATION_URL,
  tokenUrl: process.env.EXECUTOR_OIDC_TOKEN_URL,
  userInfoUrl: process.env.EXECUTOR_OIDC_USERINFO_URL,
  clientId: process.env.EXECUTOR_OIDC_CLIENT_ID,
  secret: process.env.EXECUTOR_OIDC_CLIENT_SECRET,
  secretFile: process.env.EXECUTOR_OIDC_CLIENT_SECRET_FILE,
};
const VALID_CLIENT_SECRET = "provider-issued+opaque/secret=with punctuation!";
const openDescriptorCount = (): number =>
  existsSync("/proc/self/fd") ? readdirSync("/proc/self/fd").length : 0;

const setValidOidcEnvironment = () => {
  process.env.EXECUTOR_OIDC_ENABLED = "true";
  process.env.EXECUTOR_OIDC_ISSUER = "https://identity.example.test";
  process.env.EXECUTOR_OIDC_AUTHORIZATION_URL = "https://identity.example.test/oauth2/authorize";
  process.env.EXECUTOR_OIDC_TOKEN_URL = "https://identity.example.test/oauth2/token";
  process.env.EXECUTOR_OIDC_USERINFO_URL = "https://identity.example.test/oauth2/userinfo";
  process.env.EXECUTOR_OIDC_CLIENT_ID = "executor-test";
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    EXECUTOR_OIDC_ENABLED: original.enabled,
    EXECUTOR_OIDC_ISSUER: original.issuer,
    EXECUTOR_OIDC_AUTHORIZATION_URL: original.authorizationUrl,
    EXECUTOR_OIDC_TOKEN_URL: original.tokenUrl,
    EXECUTOR_OIDC_USERINFO_URL: original.userInfoUrl,
    EXECUTOR_OIDC_CLIENT_ID: original.clientId,
    EXECUTOR_OIDC_CLIENT_SECRET: original.secret,
    EXECUTOR_OIDC_CLIENT_SECRET_FILE: original.secretFile,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveOidcConfig", () => {
  it("keeps local-only auth as the default and explicit rollback", () => {
    delete process.env.EXECUTOR_OIDC_ENABLED;
    process.env.EXECUTOR_OIDC_CLIENT_SECRET = "retained-but-disabled";
    expect(resolveOidcConfig()).toBeUndefined();

    process.env.EXECUTOR_OIDC_ENABLED = "false";
    expect(resolveOidcConfig()).toBeUndefined();
  });

  it("pins the configured HTTPS endpoints and fixed external provider id", () => {
    setValidOidcEnvironment();
    process.env.EXECUTOR_OIDC_CLIENT_SECRET = VALID_CLIENT_SECRET;
    delete process.env.EXECUTOR_OIDC_CLIENT_SECRET_FILE;

    const config = resolveOidcConfig();
    expect(config?.issuer).toBe("https://identity.example.test");
    expect(config?.providerId).toBe(EXTERNAL_OIDC_PROVIDER_ID);
    expect(config?.authorizationUrl).toBe("https://identity.example.test/oauth2/authorize");
    expect(config?.tokenUrl).toBe("https://identity.example.test/oauth2/token");
    expect(config?.userInfoUrl).toBe("https://identity.example.test/oauth2/userinfo");
    expect(config?.clientId).toBe("executor-test");
  });

  it("reads an owner-only regular file", () => {
    const directory = mkdtempSync(join(tmpdir(), "executor-oidc-secret-"));
    const secretFile = join(directory, "client-secret");
    writeFileSync(secretFile, `${VALID_CLIENT_SECRET}\n`, { mode: 0o600 });
    chmodSync(secretFile, 0o600);
    setValidOidcEnvironment();
    delete process.env.EXECUTOR_OIDC_CLIENT_SECRET;
    process.env.EXECUTOR_OIDC_CLIENT_SECRET_FILE = secretFile;

    expect(resolveOidcConfig()?.clientSecret).toBe(VALID_CLIENT_SECRET);
  });

  it("rejects empty credentials and closes a rejected secret file", () => {
    setValidOidcEnvironment();
    delete process.env.EXECUTOR_OIDC_CLIENT_SECRET_FILE;
    process.env.EXECUTOR_OIDC_CLIENT_SECRET = "";
    expect(() => resolveOidcConfig()).toThrow("nonempty");
    const directory = mkdtempSync(join(tmpdir(), "executor-oidc-secret-shape-"));
    const invalidFile = join(directory, "client-secret");
    writeFileSync(invalidFile, "\n", { mode: 0o600 });
    delete process.env.EXECUTOR_OIDC_CLIENT_SECRET;
    process.env.EXECUTOR_OIDC_CLIENT_SECRET_FILE = invalidFile;
    const descriptorsBefore = openDescriptorCount();
    expect(() => resolveOidcConfig()).toThrow("nonempty");
    expect(openDescriptorCount()).toBe(descriptorsBefore);
    renameSync(invalidFile, join(directory, "closed-client-secret"));
  });

  it("rejects broad permissions, links, ambiguous custody, and flag typos", () => {
    const directory = mkdtempSync(join(tmpdir(), "executor-oidc-secret-invalid-"));
    const broad = join(directory, "broad");
    writeFileSync(broad, VALID_CLIENT_SECRET, { mode: 0o644 });
    chmodSync(broad, 0o644);
    setValidOidcEnvironment();
    delete process.env.EXECUTOR_OIDC_CLIENT_SECRET;
    process.env.EXECUTOR_OIDC_CLIENT_SECRET_FILE = broad;
    expect(() => resolveOidcConfig()).toThrow("owner-only");

    const ownerOnly = join(directory, "owner-only");
    const link = join(directory, "link");
    writeFileSync(ownerOnly, VALID_CLIENT_SECRET, { mode: 0o600 });
    symlinkSync(ownerOnly, link);
    process.env.EXECUTOR_OIDC_CLIENT_SECRET_FILE = link;
    expect(() => resolveOidcConfig()).toThrow("regular file");

    process.env.EXECUTOR_OIDC_CLIENT_SECRET = VALID_CLIENT_SECRET;
    expect(() => resolveOidcConfig()).toThrow("only one");

    process.env.EXECUTOR_OIDC_ENABLED = "TRUE";
    delete process.env.EXECUTOR_OIDC_CLIENT_SECRET;
    delete process.env.EXECUTOR_OIDC_CLIENT_SECRET_FILE;
    expect(() => resolveOidcConfig()).toThrow("exactly true or false");
  });

  it("rejects missing, non-HTTPS, credentialed, and ambiguous endpoint configuration", () => {
    setValidOidcEnvironment();
    process.env.EXECUTOR_OIDC_CLIENT_SECRET = VALID_CLIENT_SECRET;
    delete process.env.EXECUTOR_OIDC_CLIENT_SECRET_FILE;

    delete process.env.EXECUTOR_OIDC_ISSUER;
    expect(() => resolveOidcConfig()).toThrow("EXECUTOR_OIDC_ISSUER");

    process.env.EXECUTOR_OIDC_ISSUER = "http://identity.example.test";
    expect(() => resolveOidcConfig()).toThrow("credential-free HTTPS URL");

    process.env.EXECUTOR_OIDC_ISSUER = "https:identity.example.test";
    expect(() => resolveOidcConfig()).toThrow("credential-free HTTPS URL");

    process.env.EXECUTOR_OIDC_ISSUER = "https://identity.example.test";
    process.env.EXECUTOR_OIDC_USERINFO_URL = "https://user:pass@identity.example.test/userinfo";
    expect(() => resolveOidcConfig()).toThrow("EXECUTOR_OIDC_USERINFO_URL");

    process.env.EXECUTOR_OIDC_USERINFO_URL = "https://identity.example.test/userinfo?tenant=one";
    expect(() => resolveOidcConfig()).toThrow("without query or fragment");

    process.env.EXECUTOR_OIDC_USERINFO_URL = "https://identity.example.test/userinfo";
    process.env.EXECUTOR_OIDC_CLIENT_ID = "client id";
    expect(() => resolveOidcConfig()).toThrow("printable non-space ASCII");
  });
});
