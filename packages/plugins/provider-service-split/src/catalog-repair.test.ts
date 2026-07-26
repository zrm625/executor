import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { SqliteDataMigrationClient } from "@executor-js/sdk/core";

import { runSqliteProviderServiceCatalogRepair } from "./catalog-repair";

const makeFakeClient = (
  affectedRows: Record<string, unknown>[],
  options?: { readonly missingTable?: string },
) => {
  const log: (string | { readonly sql: string; readonly args: readonly unknown[] })[] = [];
  const client: SqliteDataMigrationClient = {
    execute: (stmt) => {
      log.push(stmt);
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (sql.includes("sqlite_master")) {
        const table = typeof stmt === "string" ? "" : String(stmt.args[0]);
        return Promise.resolve({
          rows: table === options?.missingTable ? [] : [{ name: table }],
        });
      }
      if (sql.includes("SELECT c.row_id")) return Promise.resolve({ rows: affectedRows });
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, log };
};

describe("runSqliteProviderServiceCatalogRepair", () => {
  it.effect("stale-marks only the empty migrated provider connections selected by the query", () =>
    Effect.gen(function* () {
      const { client, log } = makeFakeClient([
        { row_id: "gmail-main" },
        { row_id: "calendar-work" },
      ]);
      expect(yield* runSqliteProviderServiceCatalogRepair(client)).toBe(2);

      const selection = log.find(
        (stmt) => typeof stmt !== "string" && stmt.sql.includes("SELECT c.row_id"),
      );
      expect(typeof selection === "string" ? selection : selection?.sql).toContain("NOT EXISTS");
      expect(typeof selection === "string" ? selection : selection?.sql).toContain(
        "'google', 'microsoft'",
      );
      const updates = log.filter(
        (stmt) => typeof stmt !== "string" && stmt.sql.includes("tools_synced_at = NULL"),
      );
      expect(updates.map((stmt) => (typeof stmt === "string" ? [] : stmt.args))).toEqual([
        ["gmail-main"],
        ["calendar-work"],
      ]);
    }),
  );

  it.effect("skips fresh databases that do not have the split-era tables", () =>
    Effect.gen(function* () {
      for (const missingTable of ["connection", "integration", "tool"]) {
        const { client } = makeFakeClient([{ row_id: "gmail-main" }], { missingTable });
        expect(yield* runSqliteProviderServiceCatalogRepair(client)).toBe(0);
      }
    }),
  );
});
