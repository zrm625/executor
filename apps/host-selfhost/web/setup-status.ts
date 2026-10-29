import { Effect, Option, Schema } from "effect";

// Pre-login check of whether the instance still needs first-run setup (its one
// org has zero members). Read by the auth gate to choose the setup vs sign-in
// screen. A plain same-origin fetch — the same boundary the /join + setup
// screens use, which run before the atom registry exists.

const retryDelaysMs = [250, 500, 1_000] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SetupStatusError extends Error {
  constructor() {
    super("Unable to check setup status");
    this.name = "SetupStatusError";
  }
}

const SetupStatusSchema = Schema.Struct({
  needsSetup: Schema.Boolean,
  oidcEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  oidcProviderName: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("SSO"))),
  passwordSignInEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});

export type SetupStatus = typeof SetupStatusSchema.Type;
const decodeSetupStatus = Schema.decodeUnknownOption(SetupStatusSchema);

export const fetchSetupStatus = async (): Promise<SetupStatus> => {
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const response = await fetch("/api/setup-status", { credentials: "same-origin" }).then(
      (r) => r,
      () => null,
    );
    if (response?.ok) {
      const data: unknown = await response.json().then(
        (d: unknown) => d,
        () => null,
      );
      const parsed = decodeSetupStatus(data);
      if (Option.isSome(parsed)) {
        return parsed.value;
      }
    }
    if (attempt < retryDelaysMs.length - 1) await sleep(retryDelaysMs[attempt]);
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: pre-Effect setup-status fetch rejects so the auth gate can surface retry failure
  throw new SetupStatusError();
};
