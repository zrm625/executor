import { describe, expect, it } from "@effect/vitest";
import { Validator, type Schema } from "@cfworker/json-schema";
import { CallToolResultSchema } from "@modelcontextprotocol/core";

import { callToolResultJsonSchema } from "./call-tool-result-schema.gen";

// The generated copy exists so the RUNTIME never imports
// @modelcontextprotocol/core (module eval costs ~8.6MB of heap per Cloudflare
// isolate; see client-module.ts). Tests may import it freely — this one pins
// the baked schema to the installed package so a core version bump that
// changes CallToolResultSchema fails here until the file is regenerated:
//   bun scripts/gen-call-tool-result-schema.ts
describe("call-tool-result-schema.gen", () => {
  it("matches the installed @modelcontextprotocol/core schema", () => {
    expect(callToolResultJsonSchema).toStrictEqual(CallToolResultSchema.toJSONSchema());
  });
});

// lastModified remains an RFC 3339 date-time, including seconds. Check the
// advertised schema's accepted values independently of its generated text.
it.each([
  ["2026-09-05T10:00Z", false],
  ["2026-09-05T10:00:00Z", true],
  ["2026-09-05T10:00:00.123Z", true],
  ["2026-09-05T10:00:00-04:00", true],
  ["not-a-date", false],
])("validates lastModified %s as %s", (lastModified, valid) => {
  // The drift assertion above guarantees this mutable schema matches the bake.
  const validator = new Validator(CallToolResultSchema.toJSONSchema() as Schema, "2020-12", true);
  expect(
    validator.validate({
      content: [{ type: "text", text: "result", annotations: { lastModified } }],
    }).valid,
  ).toBe(valid);
});
