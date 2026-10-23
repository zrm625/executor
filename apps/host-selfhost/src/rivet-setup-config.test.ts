import { describe, expect, it } from "@effect/vitest";
import { rivetSetupConfig } from "./rivet-setup";
describe("resolved Rivet browser origin", () => {
  it("uses resolved config when no raw browser-origin environment variable exists", () => {
    const keys = [
      "EXECUTOR_RIVET_SETUP_CONFIG_FILE",
      "EXECUTOR_RIVET_SETUP_ENDPOINT",
      "EXECUTOR_RIVET_SETUP_TOKEN_FILE",
      "EXECUTOR_RIVET_SETUP_OWNER_ID",
      "EXECUTOR_WEB_BASE_URL",
    ] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: restore process environment after the config assertion
    try {
      for (const key of keys) delete process.env[key];
      process.env.EXECUTOR_RIVET_SETUP_ENDPOINT = "https://setup.example.test:8779/setup";
      process.env.EXECUTOR_RIVET_SETUP_TOKEN_FILE = "/tmp/synthetic-rivet.token";
      process.env.EXECUTOR_RIVET_SETUP_OWNER_ID = "synthetic-owner";
      expect(rivetSetupConfig("https://canonical.example.test")).toMatchObject({
        browserOrigin: "https://canonical.example.test",
      });
      expect(rivetSetupConfig("http://localhost:4788")).toMatchObject({
        browserOrigin: "http://localhost:4788",
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
