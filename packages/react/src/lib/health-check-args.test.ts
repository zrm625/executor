import { describe, expect, it } from "@effect/vitest";

import { formatHealthCheckArgs, parseHealthCheckArgs } from "./health-check-args";

describe("health-check request bodies", () => {
  it("preserves nested values through editing and saving", () => {
    const args = {
      "Connect-Protocol-Version": "1",
      body: {
        pageSize: 1,
        status: ["queued", "running", "finished", "failed", "cancelled"],
        filter: { enabled: false },
      },
    };
    expect(parseHealthCheckArgs(formatHealthCheckArgs(args))).toEqual({ ok: true, args });
    for (const body of [null, false, 0, "plain text", [1, 2]]) {
      expect(parseHealthCheckArgs(formatHealthCheckArgs({ body }))).toEqual({
        ok: true,
        args: { body },
      });
    }
  });

  it("round trips MCP numbers, booleans, arrays, objects, null, and literal body arguments", () => {
    const args = {
      limit: 1,
      enabled: false,
      values: [1, "two"],
      options: { nested: true },
      nullable: null,
      body: "literal body",
      label: " spaced ",
    };
    const parameters = Object.keys(args).map((name) => ({
      name,
      location: "argument",
      required: true,
      valueFormat: "json" as const,
    }));
    expect(parseHealthCheckArgs(formatHealthCheckArgs(args, parameters), parameters)).toEqual({
      ok: true,
      args,
    });
    expect(parseHealthCheckArgs({ limit: "not JSON" }, parameters)).toEqual({ ok: false });
  });
  it("rejects invalid JSON and drops a cleared optional body", () => {
    expect(parseHealthCheckArgs({ body: '{"pageSize":' })).toEqual({ ok: false });
    expect(parseHealthCheckArgs({ body: "   ", id: " me " })).toEqual({
      ok: true,
      args: { id: "me" },
    });
  });
});
