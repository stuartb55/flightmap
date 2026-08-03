import { randomUUID } from "node:crypto";
import type {
  SavedView,
  SavedViewInput,
  SavedViewPatch
} from "@flightmap/shared";
import type {
  SavedViewRow
} from "./repository-shared.js";
import {
  RepositoryBase,
  RepositoryInputError,
  json,
  number,
  savedViewFromRow
} from "./repository-shared.js";

/** Installation-wide saved views. */
export class SavedViewsRepository extends RepositoryBase {
  async savedViews(): Promise<SavedView[]> {
    const result = await this.database.query<SavedViewRow>(
      `SELECT id, name, surface, configuration, created_at, updated_at
       FROM saved_views ORDER BY updated_at DESC, name, id`
    );
    return result.rows.map(savedViewFromRow);
  }

  async createSavedView(input: SavedViewInput): Promise<SavedView> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_907_182_028]);
      const count = await client.query<{ count: number | string }>(
        "SELECT count(*) AS count FROM saved_views"
      );
      if (number(count.rows[0]?.count ?? 0) >= 20) {
        throw new RepositoryInputError(
          "SAVED_VIEW_LIMIT",
          "Flightmap supports up to 20 saved views"
        );
      }
      const result = await client.query<SavedViewRow>(
        `INSERT INTO saved_views (id, name, surface, configuration)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, name, surface, configuration, created_at, updated_at`,
        [
          randomUUID(),
          input.name,
          input.configuration.surface,
          json(input.configuration)
        ]
      );
      return savedViewFromRow(result.rows[0]!);
    });
  }

  async updateSavedView(
    id: string,
    patch: SavedViewPatch
  ): Promise<SavedView | null> {
    const configuration = patch.configuration ?? null;
    const result = await this.database.query<SavedViewRow>(
      `UPDATE saved_views
       SET name = COALESCE($2, name),
           surface = COALESCE($3, surface),
           configuration = COALESCE($4::jsonb, configuration),
           updated_at = now()
       WHERE id = $1
       RETURNING id, name, surface, configuration, created_at, updated_at`,
      [
        id,
        patch.name ?? null,
        configuration?.surface ?? null,
        configuration ? json(configuration) : null
      ]
    );
    return result.rows[0] ? savedViewFromRow(result.rows[0]) : null;
  }

  async deleteSavedView(id: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM saved_views WHERE id = $1",
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
