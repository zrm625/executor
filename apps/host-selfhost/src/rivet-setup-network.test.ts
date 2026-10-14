import { describe, expect, it } from "@effect/vitest";
import { isPrivateSetupAddress } from "./rivet-setup";

describe("private Rivet setup transport", () => {
  it("accepts loopback, LAN and tailnet destinations, including mapped IPv6", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "10.0.1.2",
      "192.168.1.2",
      "172.16.0.1",
      "100.64.0.1",
      "fd00::1",
      "::ffff:10.0.1.2",
    ])
      expect(isPrivateSetupAddress(address)).toBe(true);
  });
  it("refuses public, wildcard, link-local and unresolved destinations", () => {
    for (const address of [
      "8.8.8.8",
      "0.0.0.0",
      "::",
      "169.254.169.254",
      "fe80::1",
      "2001:4860::1",
      "example.test",
      "172.32.0.1",
      "100.128.0.1",
    ])
      expect(isPrivateSetupAddress(address)).toBe(false);
  });
});
