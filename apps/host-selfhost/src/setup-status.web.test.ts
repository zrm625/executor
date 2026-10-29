import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { SetupStatusError, fetchSetupStatus } from "../web/setup-status";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSetupStatus", () => {
  it("keeps password login for servers without optional authentication fields", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ needsSetup: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(fetchSetupStatus()).resolves.toEqual({
      needsSetup: false,
      oidcEnabled: false,
      oidcProviderName: "SSO",
      passwordSignInEnabled: true,
    });
  });

  it("preserves the configured SSO provider and disabled passwords", async () => {
    const status = {
      needsSetup: false,
      oidcEnabled: true,
      oidcProviderName: "Example SSO",
      passwordSignInEnabled: false,
    };
    vi.stubGlobal("fetch", async () => Response.json(status));
    await expect(fetchSetupStatus()).resolves.toEqual(status);
  });

  it("does not render a login method from an invalid successful response", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ needsSetup: false, passwordSignInEnabled: "false" }),
    );
    await expect(fetchSetupStatus()).rejects.toBeInstanceOf(SetupStatusError);
  });

  it("retries failed setup checks before surfacing an error", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    });

    await expect(fetchSetupStatus()).rejects.toBeInstanceOf(SetupStatusError);
    expect(calls).toBe(3);
  });
});
