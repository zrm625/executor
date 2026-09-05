import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { EXTERNAL_OIDC_PROVIDER_ID } from "../config";
import { decodeExternalOidcUserInfo, makeExternalOidcConfig } from "./better-auth";

const provider = makeExternalOidcConfig({
  issuer: "https://identity.example.test",
  providerId: EXTERNAL_OIDC_PROVIDER_ID,
  authorizationUrl: "https://identity.example.test/oauth2/authorize",
  tokenUrl: "https://identity.example.test/oauth2/token",
  userInfoUrl: "https://identity.example.test/oauth2/userinfo",
  clientId: "executor-test",
  clientSecret: "A".repeat(64),
});

afterEach(() => vi.restoreAllMocks());

describe("external OIDC contract", () => {
  it("uses authorization code, PKCE, client_secret_basic, and no signup", () => {
    expect(provider.authorizationUrl).toBe("https://identity.example.test/oauth2/authorize");
    expect(provider.tokenUrl).toBe("https://identity.example.test/oauth2/token");
    expect(provider.userInfoUrl).toBe("https://identity.example.test/oauth2/userinfo");
    expect(provider.responseType).toBe("code");
    expect(provider.pkce).toBe(true);
    expect(provider.authentication).toBe("basic");
    expect(provider.scopes).toEqual(["openid", "profile", "email"]);
    expect(provider.issuer).toBe("https://identity.example.test");
    expect(provider.requireIssuerValidation).toBe(true);
    expect(provider.disableImplicitSignUp).toBe(true);
    expect(provider.disableSignUp).toBe(true);
  });

  it("accepts only stable-subject, verified-email UserInfo", () => {
    expect(
      decodeExternalOidcUserInfo({
        sub: "opaque-subject",
        email: "OPERATOR@EXAMPLE.TEST",
        email_verified: true,
        preferred_username: "operator",
      }),
    ).toEqual({
      id: "opaque-subject",
      email: "operator@example.test",
      emailVerified: true,
      name: "operator",
    });
    expect(
      decodeExternalOidcUserInfo({
        sub: "opaque-subject",
        email: "operator@example.test",
        email_verified: false,
        name: "Operator",
      }),
    ).toBeNull();
    expect(
      decodeExternalOidcUserInfo({ email: "operator@example.test", email_verified: true }),
    ).toBeNull();
    for (const claims of [
      { sub: `s${"x".repeat(255)}`, email: "operator@example.test", email_verified: true },
      { sub: " subject ", email: "operator@example.test", email_verified: true },
      { sub: "subject", email: "not-an-email", email_verified: true },
      {
        sub: "subject",
        email: "operator@example.test",
        email_verified: true,
        name: "x".repeat(257),
      },
      {
        sub: "subject",
        email: "operator@example.test",
        email_verified: true,
        preferred_username: 42,
      },
      {
        sub: "subject",
        email: "operator@example.test",
        email_verified: true,
        picture: "http://images.example.test/avatar.png",
      },
    ]) {
      expect(decodeExternalOidcUserInfo(claims)).toBeNull();
    }
  });

  it("does not trust ID-token claims and reads identity from fixed HTTPS UserInfo", async () => {
    const fetchUserInfo = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          sub: "verified-subject",
          email: "operator@example.test",
          email_verified: true,
          name: "Operator",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      provider.getUserInfo?.({ idToken: "forged-id-token-with-claims" }),
    ).resolves.toBeNull();
    expect(fetchUserInfo).not.toHaveBeenCalled();

    await expect(
      provider.getUserInfo?.({
        accessToken: "opaque-access-token",
        idToken: "forged-id-token-with-claims",
      }),
    ).resolves.toEqual({
      id: "https://identity.example.test\nverified-subject",
      email: "operator@example.test",
      emailVerified: true,
      name: "Operator",
    });
    expect(fetchUserInfo).toHaveBeenCalledWith(
      "https://identity.example.test/oauth2/userinfo",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer opaque-access-token" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects non-JSON, malformed, advertised-large, and chunked-large UserInfo", async () => {
    const fetchUserInfo = vi.spyOn(globalThis, "fetch");
    fetchUserInfo.mockResolvedValueOnce(
      new Response("not json", { headers: { "content-type": "text/plain" } }),
    );
    await expect(provider.getUserInfo?.({ accessToken: "access" })).resolves.toBeNull();

    fetchUserInfo.mockResolvedValueOnce(
      new Response("{", { headers: { "content-type": "application/json" } }),
    );
    await expect(provider.getUserInfo?.({ accessToken: "access" })).resolves.toBeNull();

    fetchUserInfo.mockResolvedValueOnce(
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "16385" },
      }),
    );
    await expect(provider.getUserInfo?.({ accessToken: "access" })).resolves.toBeNull();

    const cancelled = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9_000));
        controller.enqueue(new Uint8Array(9_000));
      },
      cancel: cancelled,
    });
    fetchUserInfo.mockResolvedValueOnce(
      new Response(oversized, { headers: { "content-type": "application/json; charset=utf-8" } }),
    );
    await expect(provider.getUserInfo?.({ accessToken: "access" })).resolves.toBeNull();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
