import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

const LoginConfiguration = Schema.Struct({
  needsSetup: Schema.Boolean,
  oidcEnabled: Schema.optional(Schema.Boolean),
  oidcProviderName: Schema.optional(Schema.String),
  passwordSignInEnabled: Schema.optional(Schema.Boolean),
});

const decodeLoginConfiguration = Schema.decodeUnknownSync(LoginConfiguration);

scenario(
  "Login · offers only the configured sign-in methods",
  { timeout: 60_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const configuration = yield* Effect.promise(async () => {
      const response = await fetch(new URL("/api/setup-status", target.baseUrl));
      expect(response.ok).toBe(true);
      const data: unknown = await response.json();
      return decodeLoginConfiguration(data);
    });
    expect(configuration.needsSetup && !configuration.oidcEnabled).toBe(false);
    yield* browser.session({ label: "Anonymous visitor" }, async ({ page, step }) => {
      await step("Open the instance without an authenticated session", async () => {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
        if (configuration.oidcEnabled) {
          await page
            .getByRole("button", {
              name: `Continue with ${configuration.oidcProviderName ?? "SSO"}`,
              exact: true,
            })
            .waitFor();
        }
        const expectedPasswords = configuration.passwordSignInEnabled === false ? 0 : 1;
        expect(await page.getByLabel("Password", { exact: true }).count()).toBe(expectedPasswords);
        expect(await page.getByLabel("Email", { exact: true }).count()).toBe(expectedPasswords);
        expect(await page.getByRole("button", { name: "Have an invite code? Join" }).count()).toBe(
          expectedPasswords,
        );
      });
      await step("Check the same sign-in choices on a phone screen", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        const button = page.getByRole("button", {
          name: `Continue with ${configuration.oidcProviderName ?? "SSO"}`,
          exact: true,
        });
        expect(await button.isVisible()).toBe(configuration.oidcEnabled === true);
        expect(await page.getByLabel("Password", { exact: true }).isVisible()).toBe(
          configuration.passwordSignInEnabled !== false,
        );
      });
    });
  }),
);
