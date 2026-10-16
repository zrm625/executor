import { describe, expect, it } from "@effect/vitest";
import { compatibleHealthCandidates, type McpHealthOperation } from "./health-candidates";
const operation = (
  name: string,
  inputSchema: unknown = { type: "object", properties: {} },
): McpHealthOperation => ({
  name,
  inputSchema,
  outputSchema: undefined,
  readOnly: true,
  destructive: false,
});
describe("integration-wide MCP health candidates", () => {
  it("intersects catalogs and refuses missing, failed, destructive, or incompatible connections", () => {
    const common = operation("health");
    expect(
      compatibleHealthCandidates([
        [common, operation("only_a")],
        [common, operation("only_b")],
      ]).map((c) => c.operation),
    ).toEqual(["health"]);
    for (const peer of [
      { ...common, readOnly: false },
      { ...common, destructive: true },
      { ...common, inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
      { ...common, outputSchema: { type: "string" } },
    ])
      expect(compatibleHealthCandidates([[common], [peer]])).toEqual([]);
    expect(compatibleHealthCandidates([[common], []])).toEqual([]);
    expect(compatibleHealthCandidates([])).toEqual([]);
  });
  it("ignores object key order and exposes typed required and optional arguments", () => {
    const first = operation("health", {
      type: "object",
      properties: {
        limit: { type: "number" },
        body: { type: "string" },
        options: { type: "object" },
      },
      required: ["limit", "body"],
    });
    const peer = {
      ...first,
      inputSchema: {
        required: ["limit", "body"],
        properties: {
          options: { type: "object" },
          body: { type: "string" },
          limit: { type: "number" },
        },
        type: "object",
      },
    };
    const candidates = compatibleHealthCandidates([[first], [peer]]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.requiredArgCount).toBe(2);
    expect(candidates[0]?.parameters).toContainEqual({
      name: "options",
      location: "argument",
      required: false,
      valueFormat: "json",
    });
    expect(candidates[0]?.parameters).toContainEqual({
      name: "body",
      location: "argument",
      required: true,
      valueFormat: "json",
    });
  });
});
