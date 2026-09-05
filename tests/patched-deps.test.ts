import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@effect/vitest";

test("rejects a Cloudflare patch applied outside the request forwarding block", ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "executor-patch-check-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, "index.mjs");
  writeFileSync(entry, 'const unrelated = { credentials: "omit" };\n');
  const result = spawnSync("bun", ["run", "scripts/check-patched-deps.ts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, CHECK_PATCHED_DEPS_CLOUDFLARE_VITE: entry },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("missing post-patch sentinel");
  expect(result.stderr).toContain("@cloudflare/vite-plugin");
});
