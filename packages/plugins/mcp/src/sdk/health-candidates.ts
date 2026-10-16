import { isDeepStrictEqual } from "node:util";
import { Option, Schema } from "effect";
import { projectResponseFields, type HealthCheckCandidate } from "@executor-js/sdk/core";

export interface McpHealthOperation {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly readOnly: boolean;
  readonly destructive: boolean;
}
const Input = Schema.Struct({
  properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optional(Schema.Array(Schema.String)),
});
const decodeInput = Schema.decodeUnknownOption(Input);

/** A single integration spec runs against every connection, so a union is unsafe. */
export function compatibleHealthCandidates(
  catalogs: readonly (readonly McpHealthOperation[])[],
): readonly HealthCheckCandidate[] {
  const first = catalogs[0];
  if (!first) return [];
  return first.flatMap((operation) => {
    if (!operation.readOnly || operation.destructive) return [];
    if (
      catalogs.some((catalog) => {
        const peer = catalog.find((entry) => entry.name === operation.name);
        return (
          !peer ||
          !peer.readOnly ||
          peer.destructive ||
          !isDeepStrictEqual(peer.inputSchema, operation.inputSchema) ||
          !isDeepStrictEqual(peer.outputSchema, operation.outputSchema)
        );
      })
    )
      return [];
    const schema = Option.getOrUndefined(decodeInput(operation.inputSchema));
    if (!schema) return [];
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    if (required.some((name) => !(name in properties))) return [];
    return [
      {
        operation: operation.name,
        method: "mcp",
        destructive: false,
        requiredArgCount: required.length,
        summary: operation.description,
        parameters: Object.keys(properties).map((name) => ({
          name,
          location: "argument",
          required: required.includes(name),
          valueFormat: "json" as const,
        })),
        responseFields: projectResponseFields(operation.outputSchema),
      },
    ];
  });
}
