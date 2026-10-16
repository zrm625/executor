import { describe, expect, it } from "@effect/vitest";
import { classifyMcpHealthProbe } from "./health-probe";

describe("configured MCP health probe", () => {
  it("does not confuse successful transport with an execution error", () => {
    const result = classifyMcpHealthProbe({
      isError: true,
      content: [{ type: "text", text: "GM_PAIRING_REQUIRED_OR_INVALID_SESSION" }],
    });
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("PAIRING_REQUIRED");
    expect(result.responseSample).toBeUndefined();
  });
  it("refuses malformed responses and never persists free-form error data", () => {
    expect(classifyMcpHealthProbe({}).status).toBe("degraded");
    const result = classifyMcpHealthProbe({
      isError: true,
      content: [{ type: "text", text: "synthetic private account and message" }],
    });
    expect(JSON.stringify(result)).not.toContain("private account");
  });
  it("uses structured output for identity and redacts sample credentials", () => {
    const result = classifyMcpHealthProbe(
      {
        content: [],
        structuredContent: { name: "synthetic", token: "secret", innocent: "secret" },
      },
      "name",
      ["secret"],
    );
    expect(result.status).toBe("healthy");
    expect(result.identity).toBe("synthetic");
    expect(JSON.stringify(result)).not.toContain('"value":"secret"');
  });
  it("extracts identity from a later JSON text block and preserves structured-output precedence", () => {
    const content = [
      { type: "text", text: "synthetic explanation" },
      { type: "text", text: '{"email":"synthetic@example.test"}' },
    ];
    expect(classifyMcpHealthProbe({ content }, "email")).toMatchObject({
      identity: "synthetic@example.test",
      responseSample: [{ path: "email", value: "synthetic@example.test" }],
    });
    expect(
      classifyMcpHealthProbe(
        { content, structuredContent: { email: "structured@example.test" } },
        "email",
      ).identity,
    ).toBe("structured@example.test");
  });
  it("accepts Rivet's bounded JSON output without persisting unrelated content", () => {
    const result = classifyMcpHealthProbe({
      content: [{ type: "text", text: '{"authenticated":true,"scope":"point_in_time"}' }],
    });
    expect(result.status).toBe("healthy");
    expect(result.responseSample).toContainEqual({ path: "authenticated", value: "true" });
  });
});
