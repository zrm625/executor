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

export interface SetupStatus {
  readonly needsSetup: boolean;
  readonly oidcEnabled: boolean;
  readonly oidcProviderName: string;
  readonly passwordSignInEnabled: boolean;
}

export const fetchNeedsSetup = async (): Promise<SetupStatus> => {
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const response = await fetch("/api/setup-status", { credentials: "same-origin" }).then(
      (r) => r,
      () => null,
    );
    if (response?.ok) {
      const data = (await response.json().then(
        (d) => d,
        () => ({}),
      )) as Partial<SetupStatus>;
      return {
        needsSetup: data.needsSetup === true,
        oidcEnabled: data.oidcEnabled === true,
        oidcProviderName: typeof data.oidcProviderName === "string" ? data.oidcProviderName : "",
        passwordSignInEnabled: data.passwordSignInEnabled !== false,
      };
    }
    if (attempt < retryDelaysMs.length - 1) await sleep(retryDelaysMs[attempt]);
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: pre-Effect setup-status fetch rejects so the auth gate can surface retry failure
  throw new SetupStatusError();
};
