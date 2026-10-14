import { Schema } from "effect";

export const SetupStatusSchema = Schema.Struct({
  phoneConnected: Schema.Boolean,
  phoneEndpoint: Schema.String,
  googleConfigured: Schema.Boolean,
  googleSessionPresent: Schema.Boolean,
  googleAuthenticated: Schema.Boolean,
  checkedAt: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  google: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      state: Schema.Literals([
        "starting",
        "sign_in",
        "phone_confirmation",
        "verifying",
        "complete",
        "failed",
        "canceled",
      ]),
      expiresAt: Schema.Number,
      method: Schema.optional(Schema.Literal("local-browser")),
      handoff: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
      emoji: Schema.optional(Schema.String),
    }),
  ),
});
export type SetupStatus = typeof SetupStatusSchema.Type;
export const decodeSetupStatus = Schema.decodeUnknownSync(SetupStatusSchema);

export const setupActive = (status: SetupStatus) =>
  status.google !== null &&
  ["starting", "sign_in", "phone_confirmation", "verifying"].includes(status.google.state);

export function localSignInUrl(status: SetupStatus): string | null {
  if (
    status.google?.method !== "local-browser" ||
    status.google.state !== "sign_in" ||
    !status.google.handoff ||
    Date.now() >= status.google.expiresAt
  )
    return null;
  if (!URL.canParse(status.google.handoff) || !URL.canParse(status.phoneEndpoint)) return null;
  const uri = new URL(status.google.handoff);
  const rawEndpoint = uri.searchParams.get("endpoint") ?? "";
  if (!URL.canParse(rawEndpoint)) return null;
  const endpoint = new URL(rawEndpoint);
  const phone = new URL(status.phoneEndpoint);
  return uri.protocol === "rivet-pair:" &&
    uri.hostname === "google" &&
    !uri.pathname &&
    !uri.username &&
    !uri.password &&
    !uri.port &&
    uri.searchParams.size === 2 &&
    uri.searchParams.get("id") === status.google.id &&
    /^[a-f0-9]{64}$/.test(uri.hash.slice(1)) &&
    endpoint.protocol === "https:" &&
    endpoint.host === phone.host &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.port &&
    !endpoint.search &&
    !endpoint.hash &&
    endpoint.pathname === "/setup/google/credentials"
    ? uri.href
    : null;
}

export function setupInstruction(status: SetupStatus): string {
  if (
    (status.google?.state === "sign_in" || status.google?.state === "starting") &&
    status.google.method === "local-browser"
  )
    return "Open Google sign-in on a nearby computer. Use your phone's passkey in Chrome, then confirm the Messages emoji here.";
  if (status.google?.state === "phone_confirmation")
    return "Open Google Messages on your phone and confirm the matching emoji.";
  if (status.google?.state === "sign_in" || status.google?.state === "starting")
    return "Google sign-in requires the installed Rivet helper on a nearby computer.";
  if (status.google?.state === "verifying")
    return "Verifying Google Messages authentication without fetching history.";
  if (status.google?.state === "failed" && !status.googleSessionPresent)
    return "Google Messages pairing did not finish. Retry when you are ready.";
  if (!status.phoneConnected)
    return "Connect your phone: scan the pairing QR in Rivet, review the address, then Save and connect.";
  if (status.googleConfigured && !status.googleAuthenticated)
    return status.googleSessionPresent
      ? "Your phone is connected. Verify the saved Google Messages session."
      : "Your phone is connected. Connect Google Messages to enable its protocol tools.";
  return "Your configured connections are ready.";
}
