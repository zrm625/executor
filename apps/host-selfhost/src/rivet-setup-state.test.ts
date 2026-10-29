import { describe, expect, it } from "@effect/vitest";
import {
  decodeSetupStatus,
  setupActive,
  setupInstruction,
  localSignInUrl,
  googleSignInRejected,
} from "../web/rivet-setup-state";

const state = () =>
  decodeSetupStatus({
    phoneConnected: true,
    phoneEndpoint: "wss://phone.example.test:8778/phone",
    setupEndpoint: "https://setup.example.test:8779/setup",
    googleConfigured: true,
    googleSessionPresent: false,
    googleAuthenticated: false,
    checkedAt: null,
    error: null,
    google: null,
  });
describe("Rivet setup state", () => {
  it("retains a rejected saved session and directs recovery to its owner", () => {
    const rejected = { ...state(), googleSessionPresent: true, error: "GM_REPAIR_REQUIRED" };
    expect(googleSignInRejected(rejected)).toBe(true);
    expect(setupInstruction(rejected)).toContain("Ask the service owner to reconnect");
    expect(googleSignInRejected({ ...rejected, error: "GM_CONNECT_FAILED" })).toBe(false);
    expect(googleSignInRejected({ ...rejected, googleAuthenticated: true })).toBe(false);
  });
  it("local Google sign-in stays bound to the separate setup listener and current one-time attempt", () => {
    const uri = new URL("rivet-pair://google");
    const id = "00000000-0000-4000-8000-000000000001";
    uri.searchParams.set("endpoint", "https://setup.example.test:8779/setup/google/credentials");
    uri.searchParams.set("id", id);
    uri.hash = "b".repeat(64);
    const local = {
      ...state(),
      google: {
        id,
        state: "sign_in" as const,
        method: "local-browser" as const,
        expiresAt: Date.now() + 600000,
        handoff: uri.href,
      },
    };
    expect(localSignInUrl(local)).toBe(uri.href);
    expect(localSignInUrl({ ...local, google: { ...local.google, expiresAt: 0 } })).toBeNull();
    expect(setupInstruction(local)).toContain("phone's passkey");
    uri.searchParams.set("endpoint", "https://another.example.test/setup/google/credentials");
    expect(localSignInUrl({ ...local, google: { ...local.google, handoff: uri.href } })).toBeNull();
    expect(localSignInUrl({ ...local, google: { ...local.google, state: "canceled" } })).toBeNull();
  });
  it("a connected phone does not imply Google authentication", () => {
    expect(setupInstruction(state())).toContain("Connect Google Messages");
    expect(setupActive(state())).toBe(false);
  });
  it("a saved session still requires upstream verification", () => {
    expect(setupInstruction({ ...state(), googleSessionPresent: true })).toContain(
      "Verify the saved",
    );
    expect(
      setupInstruction({
        ...state(),
        googleSessionPresent: true,
        googleAuthenticated: true,
        checkedAt: 123,
      }),
    ).toContain("ready");
  });
  it("phone confirmation remains an explicit user action", () => {
    const pending = {
      ...state(),
      google: {
        id: "synthetic",
        state: "phone_confirmation" as const,
        expiresAt: 123,
        emoji: "🦊",
      },
    };
    expect(setupActive(pending)).toBe(true);
    expect(setupInstruction(pending)).toContain("confirm the matching emoji");
  });
  it("a saved session survives failed initial verification and a later successful check", () => {
    const failed = {
      ...state(),
      google: {
        id: "synthetic",
        state: "failed" as const,
        expiresAt: 123,
        error: "GOOGLE_PAIRING_FAILED",
      },
    };
    expect(setupInstruction(failed)).toContain("Retry");
    expect(setupInstruction({ ...failed, googleSessionPresent: true })).toContain(
      "Verify the saved",
    );
    expect(
      setupInstruction({
        ...failed,
        googleSessionPresent: true,
        googleAuthenticated: true,
        checkedAt: 123,
      }),
    ).toContain("ready");
    expect(setupActive(failed)).toBe(false);
  });
  it("refuses malformed states instead of marking a connection ready", () => {
    expect(() => decodeSetupStatus({ ...state(), phoneConnected: "true" })).toThrow();
    expect(() =>
      decodeSetupStatus({
        ...state(),
        google: { id: "synthetic", state: "anything", expiresAt: 123 },
      }),
    ).toThrow();
  });
});
