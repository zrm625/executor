// ---------------------------------------------------------------------------
// Follow-up repair for provider-service splits whose connection rows were
// cloned as "synced" even though no per-service tool rows were persisted.
//
// The OpenAPI resolver now repairs a missing migrated Google/Microsoft catalog
// from its stored spec URL. Stale-mark only affected connections so their next
// normal tools read enters that resolver. Connections that already have tools,
// non-provider OpenAPI integrations, and integrations owned by other plugins
// are left untouched.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { DataMigrationError, type SqliteDataMigrationClient } from "@executor-js/sdk/core";

const MIGRATION_NAME = "2026-07-10-provider-service-empty-catalog-repair";

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

const tableExists = (client: SqliteDataMigrationClient, table: string) =>
  Effect.map(
    execute(client, {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    }),
    (result) => result.rows.length > 0,
  );

export const runSqliteProviderServiceCatalogRepair = (
  client: SqliteDataMigrationClient,
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    for (const table of ["connection", "integration", "tool"]) {
      if (!(yield* tableExists(client, table))) return 0;
    }

    const affected = yield* execute(client, {
      sql: `SELECT c.row_id AS row_id
            FROM connection c
            INNER JOIN integration i
              ON i.tenant = c.tenant AND i.slug = c.integration
            WHERE i.plugin_id = 'openapi'
              AND i.config IS NOT NULL
              AND json_valid(i.config)
              AND json_extract(i.config, '$.family') IN ('google', 'microsoft')
              AND json_extract(i.config, '$.specUrl') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM tool t
                WHERE t.tenant = c.tenant
                  AND t.owner = c.owner
                  AND t.subject = c.subject
                  AND t.integration = c.integration
                  AND t.connection = c.name
              )`,
      args: [],
    });

    const rowIds = affected.rows.flatMap((row) =>
      typeof row.row_id === "string" ? [row.row_id] : [],
    );
    for (const rowId of rowIds) {
      yield* execute(client, {
        sql: "UPDATE connection SET tools_synced_at = NULL WHERE row_id = ?",
        args: [rowId],
      });
    }
    return rowIds.length;
  });

export const providerServiceCatalogRepairDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteProviderServiceCatalogRepair(client).pipe(Effect.asVoid),
};
