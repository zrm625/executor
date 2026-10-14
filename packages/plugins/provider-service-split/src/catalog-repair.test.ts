import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { collectTables, runSqliteDataMigrations } from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import {
  providerServiceCatalogRepairDataMigration,
  runSqliteProviderServiceCatalogRepair,
} from "./catalog-repair";

describe("provider service catalog repair", () => {
  it.effect("stale-marks only empty provider catalogs in the matching identity partition", () =>
    Effect.gen(function* () {
      const { client } = yield* Effect.promise(() =>
        createSqliteTestFumaDb({ tables: collectTables() }),
      );
      const rows = [
        {
          id: "empty-google",
          family: "google",
          tenant: "one",
          owner: "org",
          subject: "",
          tools: false,
        },
        {
          id: "empty-microsoft",
          family: "microsoft",
          tenant: "one",
          owner: "org",
          subject: "",
          tools: false,
        },
        {
          id: "populated",
          family: "google",
          tenant: "one",
          owner: "user",
          subject: "alice",
          tools: true,
        },
        {
          id: "other-subject",
          family: "google",
          tenant: "one",
          owner: "user",
          subject: "bob",
          tools: false,
        },
        {
          id: "other-tenant",
          family: "google",
          tenant: "two",
          owner: "user",
          subject: "alice",
          tools: false,
        },
        {
          id: "ordinary",
          family: "custom",
          tenant: "one",
          owner: "org",
          subject: "",
          tools: false,
        },
      ];
      for (const tenant of ["one", "two"]) {
        for (const family of ["google", "microsoft", "custom"]) {
          yield* Effect.promise(() =>
            client.execute({
              sql: `INSERT INTO integration
              (row_id, tenant, slug, plugin_id, name, config, can_remove, can_refresh, created_at, updated_at)
              VALUES (?, ?, ?, 'openapi', ?, ?, 1, 1, 1, 1)`,
              args: [
                `${tenant}-${family}`,
                tenant,
                family,
                family,
                JSON.stringify({ family, specUrl: "https://example.test/spec" }),
              ],
            }),
          );
        }
      }
      for (const row of rows) {
        yield* Effect.promise(() =>
          client.execute({
            sql: `INSERT INTO connection
            (row_id, tenant, owner, subject, integration, name, template, provider, item_ids,
             tools_synced_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'main', 'apiKey', 'vault', '{}', 42, 1, 1)`,
            args: [row.id, row.tenant, row.owner, row.subject, row.family],
          }),
        );
        if (row.tools) {
          yield* Effect.promise(() =>
            client.execute({
              sql: `INSERT INTO tool
              (row_id, tenant, owner, subject, integration, connection, plugin_id, name, description,
               input_schema, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'main', 'openapi', 'list', 'List records', '{}', 1, 1)`,
              args: [`tool-${row.id}`, row.tenant, row.owner, row.subject, row.family],
            }),
          );
        }
      }
      expect(yield* runSqliteProviderServiceCatalogRepair(client)).toBe(4);
      const result = yield* Effect.promise(() =>
        client.execute("SELECT row_id, tools_synced_at FROM connection ORDER BY row_id"),
      );
      expect(result.rows).toEqual([
        { row_id: "empty-google", tools_synced_at: null },
        { row_id: "empty-microsoft", tools_synced_at: null },
        { row_id: "ordinary", tools_synced_at: 42 },
        { row_id: "other-subject", tools_synced_at: null },
        { row_id: "other-tenant", tools_synced_at: null },
        { row_id: "populated", tools_synced_at: 42 },
      ]);
      expect(
        yield* runSqliteDataMigrations(client, [providerServiceCatalogRepairDataMigration]),
      ).toEqual([providerServiceCatalogRepairDataMigration.name]);
      expect(
        yield* runSqliteDataMigrations(client, [providerServiceCatalogRepairDataMigration]),
      ).toEqual([]);
    }),
  );
});
