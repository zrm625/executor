import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";

const generatedRouteTree = readFileSync(
  new URL("../../web/routeTree.gen.ts", import.meta.url),
  "utf8",
);

describe("login route", () => {
  it("recognizes the browser and OAuth deep-link instead of rendering the root 404", () => {
    expect(generatedRouteTree).toContain("LoginRouteImport");
    expect(generatedRouteTree).toContain("id: '/login'");
    expect(generatedRouteTree).toContain("fullPath: '/login'");
  });
});
