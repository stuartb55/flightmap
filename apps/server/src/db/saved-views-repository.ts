import { randomUUID } from "node:crypto";
import type {
  SavedView,
  SavedViewInput,
  SavedViewPatch
} from "@flightmap/shared";
import { savedViewPinLimit } from "@flightmap/shared";
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

const SAVED_VIEW_LOCK = 1_907_182_028;
const SAVED_VIEW_COLUMNS =
  "id, name, surface, configuration, is_default, pinned_at, created_at, updated_at";

/** Installation-wide saved views. */
export class SavedViewsRepository extends RepositoryBase {
  async savedViews(): Promise<SavedView[]> {
    const result = await this.database.query<SavedViewRow>(
      `SELECT ${SAVED_VIEW_COLUMNS}
       FROM saved_views ORDER BY updated_at DESC, name, id`
    );
    return result.rows.map(savedViewFromRow);
  }

  async createSavedView(input: SavedViewInput): Promise<SavedView> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SAVED_VIEW_LOCK]);
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
         RETURNING ${SAVED_VIEW_COLUMNS}`,
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
    /*
     * Name and configuration are independent of every other row, so they stay a
     * single statement. Default and pin state are not: one is unique per
     * surface and the other is capped per surface, so both go through the same
     * advisory lock the create path uses, and the partial unique index behind
     * `is_default` is the backstop if a writer ever skips it.
     */
    if (patch.isDefault === undefined && patch.pinned === undefined) {
      const configuration = patch.configuration ?? null;
      const result = await this.database.query<SavedViewRow>(
        `UPDATE saved_views
         SET name = COALESCE($2, name),
             surface = COALESCE($3, surface),
             configuration = COALESCE($4::jsonb, configuration),
             updated_at = now()
         WHERE id = $1
         RETURNING ${SAVED_VIEW_COLUMNS}`,
        [
          id,
          patch.name ?? null,
          configuration?.surface ?? null,
          configuration ? json(configuration) : null
        ]
      );
      return result.rows[0] ? savedViewFromRow(result.rows[0]) : null;
    }

    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SAVED_VIEW_LOCK]);
      const existing = await client.query<{
        surface: SavedView["surface"];
        pinned_at: Date | string | null;
      }>("SELECT surface, pinned_at FROM saved_views WHERE id = $1", [id]);
      const current = existing.rows[0];
      if (!current) return null;
      const surface = patch.configuration?.surface ?? current.surface;

      if (patch.isDefault === true) {
        await client.query(
          `UPDATE saved_views SET is_default = false, updated_at = now()
           WHERE surface = $1 AND is_default AND id <> $2`,
          [surface, id]
        );
      }
      if (patch.pinned === true && !current.pinned_at) {
        const pinned = await client.query<{ count: number | string }>(
          `SELECT count(*) AS count FROM saved_views
           WHERE surface = $1 AND pinned_at IS NOT NULL`,
          [surface]
        );
        if (number(pinned.rows[0]?.count ?? 0) >= savedViewPinLimit) {
          throw new RepositoryInputError(
            "SAVED_VIEW_PIN_LIMIT",
            `Each surface supports up to ${savedViewPinLimit} pinned views; unpin one first`
          );
        }
      }

      const configuration = patch.configuration ?? null;
      const result = await client.query<SavedViewRow>(
        `UPDATE saved_views
         SET name = COALESCE($2, name),
             surface = COALESCE($3, surface),
             configuration = COALESCE($4::jsonb, configuration),
             is_default = COALESCE($5::boolean, is_default),
             pinned_at = CASE
               WHEN $6::boolean IS NULL THEN pinned_at
               WHEN $6::boolean THEN COALESCE(pinned_at, now())
               ELSE NULL
             END,
             updated_at = now()
         WHERE id = $1
         RETURNING ${SAVED_VIEW_COLUMNS}`,
        [
          id,
          patch.name ?? null,
          configuration?.surface ?? null,
          configuration ? json(configuration) : null,
          patch.isDefault ?? null,
          patch.pinned ?? null
        ]
      );
      return result.rows[0] ? savedViewFromRow(result.rows[0]) : null;
    });
  }

  async deleteSavedView(id: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM saved_views WHERE id = $1",
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
