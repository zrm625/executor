import { Option, Predicate, Schema } from "effect";
import {
  extractIdentity,
  extractResponseFields,
  type HealthCheckResult,
} from "@executor-js/sdk/core";

const Envelope = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
});
const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const decode = Schema.decodeUnknownOption(Envelope);
const decodeText = Schema.decodeUnknownOption(Text);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Persist neither arbitrary tool errors nor unstructured response content. */
export const classifyMcpHealthProbe = (
  raw: unknown,
  identityField?: string,
  secrets: readonly string[] = [],
): HealthCheckResult => {
  const checkedAt = Date.now();
  const envelope = Option.getOrUndefined(decode(raw));
  if (!envelope)
    return {
      status: "degraded",
      checkedAt,
      reason: "probe_failed",
      detail: "Malformed MCP probe response.",
    };
  const scrub = (value: string) =>
    secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
  if (envelope.isError === true) {
    // Bounded machine codes are useful; free-form errors can contain account
    // data. Never persist them or response samples from failed probes.
    const texts = envelope.content
      .map((item) => Option.getOrUndefined(decodeText(item))?.text)
      .filter(Predicate.isNotUndefined);
    const code =
      texts.length === 1 && /^[A-Z][A-Z0-9_]{1,79}$/.test(texts[0] ?? "")
        ? scrub(texts[0]!)
        : undefined;
    return {
      status: "degraded",
      checkedAt,
      reason: "probe_failed",
      detail: code ? `Health probe failed: ${code}.` : "MCP health probe returned an error.",
    };
  }
  const text = envelope.content
    .map((item) => Option.getOrUndefined(decodeText(item)))
    .find((item) => item !== undefined)?.text;
  const body =
    envelope.structuredContent ??
    (text === undefined ? undefined : Option.getOrUndefined(decodeJson(text)));
  const identity = extractIdentity(body, identityField);
  return {
    status: "healthy",
    checkedAt,
    detail: "Configured MCP probe succeeded (point-in-time check).",
    ...(identity === undefined ? {} : { identity: scrub(identity) }),
    responseSample: extractResponseFields(body, { scrub }),
  };
};
