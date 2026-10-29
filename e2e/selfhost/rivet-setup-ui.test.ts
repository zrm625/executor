import { randomBytes } from "node:crypto";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
const api = composePluginApi([mcpHttpPlugin()] as const);
scenario(
  "Rivet setup · QR, cancellation, sign-in and phone confirmation",
  {
    timeout: 180_000,
    skip: process.env.E2E_RIVET_SETUP_URL
      ? undefined
      : "Requires the native synthetic Rivet fixture described in apps/host-selfhost/docs/rivet.md",
  },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const directory = process.env.E2E_RIVET_SETUP_DIRECTORY;
    const endpoint = process.env.E2E_RIVET_SETUP_URL;
    const configFile = process.env.EXECUTOR_RIVET_SETUP_CONFIG_FILE;
    if (
      !directory ||
      !directory.startsWith("/tmp/rivet-executor-fixture-") ||
      !endpoint ||
      !configFile
    )
      throw new Error("Native synthetic Rivet fixture is required");
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const slug = IntegrationSlug.make(`rivet_setup_${randomBytes(4).toString("hex")}`);
    const session = yield* Effect.promise(async () => {
      const response = await fetch(new URL("/api/auth/get-session", target.baseUrl), {
        headers: identity.headers,
      });
      return (await response.json()) as { user: { id: string } };
    });
    yield* Effect.gen(function* () {
      writeFileSync(join(directory, "owner-id"), session.user.id, { mode: 0o600 });
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 10000;
        while (!existsSync(join(directory, "native-ready.json"))) {
          if (Date.now() > deadline) throw new Error("Native fixture did not become ready");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      });
      writeFileSync(
        configFile,
        JSON.stringify({
          endpoint: endpoint + "/setup",
          tokenFile: join(directory, "setup.token"),
          ownerId: session.user.id,
          integration: slug,
          browserOrigin: new URL(target.baseUrl).origin,
        }),
        { mode: 0o600 },
      );
      yield* client.mcp.addServer({
        payload: {
          name: "Synthetic Rivet setup",
          slug,
          transport: "remote",
          endpoint: endpoint + "/mcp",
          remoteTransport: "streamable-http",
          headers: { Authorization: "Bearer " + "c".repeat(64) },
        },
      });
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open Rivet setup on the integration page", async () => {
          writeFileSync(join(directory, "setup.token"), "d".repeat(64), { mode: 0o600 });
          await page.goto(`/default/integrations/${slug}`, { waitUntil: "domcontentloaded" });
          const retry = page.getByRole("button", { name: "Retry setup check" });
          await retry.waitFor();
          await page.getByRole("alert").waitFor();
          writeFileSync(join(directory, "setup.token"), "b".repeat(64), { mode: 0o600 });
          await retry.click();
          await page.getByRole("heading", { name: "Set up Rivet" }).waitFor();
          await page.getByText("Needs connection", { exact: true }).waitFor();
        });
        await step("Show the private phone QR and detect the phone connecting", async () => {
          await page.getByRole("button", { name: "Connect phone", exact: true }).click();
          const qr = page.getByRole("img", { name: "Scan this private QR in Rivet on your phone" });
          await qr.waitFor();
          writeFileSync(join(directory, "connect-phone.synthetic"), "", { mode: 0o600 });
          await page.getByText("Connected", { exact: true }).waitFor();
          await qr.waitFor({ state: "detached" });
        });
        await step("Start local Google sign-in and cancel the attempt", async () => {
          await page.getByRole("button", { name: "Connect Google Messages", exact: true }).click();
          await page.getByRole("link", { name: "Open Google sign-in on this computer" }).waitFor();
          await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
          await page
            .getByRole("button", { name: "Connect Google Messages", exact: true })
            .waitFor();
          await page
            .getByRole("img", { name: "Interactive isolated Google sign-in" })
            .waitFor({ state: "detached" });
        });
        await step(
          "Submit synthetic handoff credentials and wait for phone confirmation",
          async () => {
            await page
              .getByRole("button", { name: "Connect Google Messages", exact: true })
              .click();

            const link = page.getByRole("link", { name: "Open Google sign-in on this computer" });
            await link.waitFor();
            const uri = new URL((await link.getAttribute("href"))!);
            expect(uri.protocol).toBe("rivet-pair:");
            expect(
              await page.getByRole("img", { name: "Interactive isolated Google sign-in" }).count(),
            ).toBe(0);
            // Synthetic credentials only. Real passkey interaction is a separate
            // acceptance gate; never invoke an OS handler in a recorded fixture.
            const destination = uri.searchParams.get("endpoint")!;
            expect(destination).toBe(endpoint + "/setup/google/credentials");
            const status = await fetch(endpoint + "/setup/status", {
              headers: {
                Authorization: "Bearer " + "b".repeat(64),
                "X-Rivet-Setup-Owner": session.user.id,
              },
            }).then((r) => r.json());
            expect(status.setupEndpoint).toBe(endpoint + "/setup");
            expect(new URL(status.phoneEndpoint).port).not.toBe(new URL(destination).port);
            const response = await fetch(destination, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${uri.hash.slice(1)}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                id: uri.searchParams.get("id"),
                cookies: Object.fromEntries(
                  ["SID", "HSID", "OSID", "SSID", "APISID", "SAPISID"].map((name) => [
                    name,
                    "synthetic",
                  ]),
                ),
              }),
            });
            expect(response.status).toBe(202);
            await page.getByLabel("Pairing confirmation emoji").waitFor();
            expect(await page.getByLabel("Pairing confirmation emoji").textContent()).toBe("🦊");
          },
        );
        await step("Detect phone confirmation and verify Google authentication", async () => {
          writeFileSync(join(directory, "gmessages", "confirm.synthetic"), "", { mode: 0o600 });
          await page.getByText("Authenticated", { exact: true }).waitFor();
          await page.getByText(/Google authentication checked/).waitFor();
          expect(
            await page.getByRole("img", { name: "Interactive isolated Google sign-in" }).count(),
          ).toBe(0);
          await page.getByRole("button", { name: "Check connections", exact: true }).click();
          await page.getByText("Authenticated", { exact: true }).waitFor();
        });
        await step("Retain a rejected saved session at phone width", async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          writeFileSync(join(directory, "gmessages", "reject.synthetic"), "", { mode: 0o600 });
          await page.getByRole("button", { name: "Check connections", exact: true }).click();
          await page.getByText("Sign-in expired", { exact: true }).waitFor();
          await page.getByText(/Ask the service owner to reconnect/).waitFor();
          expect(
            await page
              .getByRole("button", { name: "Connect Google Messages", exact: true })
              .count(),
          ).toBe(0);
          expect(
            await page.getByRole("link", { name: "Open Google sign-in on this computer" }).count(),
          ).toBe(0);
        });
      });
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore);
          for (const file of [
            configFile,
            join(directory, "owner-id"),
            join(directory, "connect-phone.synthetic"),
            join(directory, "gmessages", "confirm.synthetic"),
            join(directory, "gmessages", "reject.synthetic"),
          ])
            rmSync(file, { force: true });
          writeFileSync(join(directory, "setup.token"), "b".repeat(64), { mode: 0o600 });
        }),
      ),
    );
  }),
);
