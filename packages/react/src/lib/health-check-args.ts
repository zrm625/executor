import type { HealthCheckCandidateParameter } from "@executor-js/sdk/shared";
import { Option, Schema } from "effect";

export const isJsonHealthArgument = (
  name: string,
  parameters?: readonly HealthCheckCandidateParameter[],
): boolean => {
  const parameter = parameters?.find((entry) => entry.name === name);
  return (
    parameter?.valueFormat === "json" ||
    parameter?.location === "body" ||
    (!parameter && name === "body")
  );
};
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const formatHealthCheckArgs = (
  args: Readonly<Record<string, unknown>> | undefined,
  parameters?: readonly HealthCheckCandidateParameter[],
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(args ?? {}).map(([key, value]) => [
      key,
      isJsonHealthArgument(key, parameters)
        ? (JSON.stringify(value) ?? "")
        : value == null
          ? ""
          : String(value),
    ]),
  );

export const parseHealthCheckArgs = (
  draft: Readonly<Record<string, string>>,
  parameters?: readonly HealthCheckCandidateParameter[],
): { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false } => {
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(draft)) {
    if (value.trim().length === 0) continue;
    if (isJsonHealthArgument(name, parameters)) {
      const body = decodeBody(value);
      if (Option.isNone(body)) return { ok: false };
      args[name] = body.value;
    } else {
      args[name] = value.trim();
    }
  }
  return { ok: true, args };
};
