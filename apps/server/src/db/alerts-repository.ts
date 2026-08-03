import { randomUUID } from "node:crypto";
import type {
  AlertEvent,
  AlertQuery,
  AlertsResponse,
  CustomAlertRule,
  CustomAlertRuleInput,
  CustomAlertRulePatch,
  WatchlistEntry,
  WatchlistInput
} from "@flightmap/shared";
import {
  customAlertRuleInputSchema
} from "@flightmap/shared";
import {
  analyticalAltitudeFt
} from "../domain/altitude.js";
import type { Database } from "./database.js";
import type { LiveRepository } from "./live-repository.js";
import type {
  AlertRow,
  CustomAlertRuleRow,
  RepositoryConfig
} from "./repository-shared.js";
import {
  RepositoryBase,
  alertCursorSchema,
  alertFromRow,
  customAlertRuleFromRow,
  customRuleMatches,
  decodeCursor,
  encodeCursor,
  iso,
  normaliseIcao
} from "./repository-shared.js";

/** Alert events, custom alert rules, and the watchlist. */
export class AlertsRepository extends RepositoryBase {
  /** Rule previews are evaluated against the live fleet. */
  constructor(
    database: Database,
    config: RepositoryConfig,
    private readonly live: LiveRepository
  ) {
    super(database, config);
  }

  async alerts(query: AlertQuery): Promise<AlertsResponse> {
    const cursor = decodeCursor(query.cursor, alertCursorSchema);
    const result = await this.database.query<AlertRow>(
      `SELECT id, icao, session_id, rule, state, message, severity,
              occurred_at, dismissed_at, callsign
       FROM alert_events
       WHERE ($1::text IS NULL OR icao = $1)
         AND ($2::boolean IS NULL OR (dismissed_at IS NOT NULL) = $2)
         AND (
           $3::timestamptz IS NULL OR
           (occurred_at, id) < ($3::timestamptz, $4::uuid)
         )
       ORDER BY occurred_at DESC, id DESC
       LIMIT $5`,
      [
        query.icao ?? null,
        query.dismissed ?? null,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        query.limit + 1
      ]
    );
    const hasMore = result.rows.length > query.limit;
    const page = result.rows.slice(0, query.limit);
    const items = page.map(alertFromRow);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
          : null
    };
  }

  async customAlertRules(): Promise<CustomAlertRule[]> {
    const result = await this.database.query<CustomAlertRuleRow>(
      "SELECT * FROM custom_alert_rules ORDER BY updated_at DESC, name"
    );
    return result.rows.map(customAlertRuleFromRow);
  }

  async createCustomAlertRule(input: CustomAlertRuleInput): Promise<CustomAlertRule> {
    const result = await this.database.query<CustomAlertRuleRow>(
      `INSERT INTO custom_alert_rules (
         id, name, enabled, severity, callsign_prefix, icao, operator, type_code,
         minimum_altitude_ft, maximum_altitude_ft, minimum_distance_nm, maximum_distance_nm,
         cooldown_minutes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [randomUUID(), input.name, input.enabled, input.severity, input.callsignPrefix,
        input.icao, input.operator, input.typeCode, input.minimumAltitudeFt,
        input.maximumAltitudeFt, input.minimumDistanceNm, input.maximumDistanceNm,
        input.cooldownMinutes]
    );
    return customAlertRuleFromRow(result.rows[0]!);
  }

  async updateCustomAlertRule(id: string, patch: CustomAlertRulePatch): Promise<CustomAlertRule | null> {
    const current = (await this.database.query<CustomAlertRuleRow>(
      "SELECT * FROM custom_alert_rules WHERE id = $1", [id]
    )).rows[0];
    if (!current) return null;
    const existing = customAlertRuleFromRow(current);
    const input = customAlertRuleInputSchema.parse({
      name: patch.name ?? existing.name,
      enabled: patch.enabled ?? existing.enabled,
      severity: patch.severity ?? existing.severity,
      callsignPrefix: patch.callsignPrefix === undefined ? existing.callsignPrefix : patch.callsignPrefix,
      icao: patch.icao === undefined ? existing.icao : patch.icao,
      operator: patch.operator === undefined ? existing.operator : patch.operator,
      typeCode: patch.typeCode === undefined ? existing.typeCode : patch.typeCode,
      minimumAltitudeFt: patch.minimumAltitudeFt === undefined ? existing.minimumAltitudeFt : patch.minimumAltitudeFt,
      maximumAltitudeFt: patch.maximumAltitudeFt === undefined ? existing.maximumAltitudeFt : patch.maximumAltitudeFt,
      minimumDistanceNm: patch.minimumDistanceNm === undefined ? existing.minimumDistanceNm : patch.minimumDistanceNm,
      maximumDistanceNm: patch.maximumDistanceNm === undefined ? existing.maximumDistanceNm : patch.maximumDistanceNm,
      cooldownMinutes: patch.cooldownMinutes ?? existing.cooldownMinutes
    });
    const result = await this.database.query<CustomAlertRuleRow>(
      `UPDATE custom_alert_rules SET name=$2, enabled=$3, severity=$4, callsign_prefix=$5,
         icao=$6, operator=$7, type_code=$8, minimum_altitude_ft=$9, maximum_altitude_ft=$10,
         minimum_distance_nm=$11, maximum_distance_nm=$12, cooldown_minutes=$13, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, input.name, input.enabled, input.severity, input.callsignPrefix, input.icao,
        input.operator, input.typeCode, input.minimumAltitudeFt, input.maximumAltitudeFt,
        input.minimumDistanceNm, input.maximumDistanceNm, input.cooldownMinutes]
    );
    return result.rows[0] ? customAlertRuleFromRow(result.rows[0]) : null;
  }

  async deleteCustomAlertRule(id: string): Promise<boolean> {
    const result = await this.database.query("DELETE FROM custom_alert_rules WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async previewCustomAlertRule(input: CustomAlertRuleInput) {
    const now = new Date().toISOString();
    const rule: CustomAlertRule = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    // The same altitude ingestion evaluates rules against. No previous report
    // is available here, so the current one is judged on its own — which is
    // what ingestion does for the first sample of a session.
    const matches = (await this.live.liveAircraft()).filter((aircraft) =>
      customRuleMatches(rule, aircraft, analyticalAltitudeFt(aircraft, null))
    );
    return { matches: matches.slice(0, 100).map((aircraft) => ({
      icao: aircraft.icao,
      callsign: aircraft.callsign,
      registration: aircraft.metadata?.registration ?? null
    })) };
  }

  async dismissAlert(id: string, at = new Date()): Promise<AlertEvent | null> {
    const result = await this.database.query<AlertRow>(
      `UPDATE alert_events SET dismissed_at = COALESCE(dismissed_at, $2)
       WHERE id = $1
       RETURNING id, icao, session_id, rule, state, message, severity,
                 occurred_at, dismissed_at, callsign`,
      [id, at]
    );
    return result.rows[0] ? alertFromRow(result.rows[0]) : null;
  }

  async dismissAlerts(ids: string[], at = new Date()): Promise<AlertEvent[]> {
    const result = await this.database.query<AlertRow>(
      `UPDATE alert_events
       SET dismissed_at = COALESCE(dismissed_at, $2)
       WHERE id = ANY($1::uuid[])
       RETURNING id, icao, session_id, rule, state, message, severity,
                 occurred_at, dismissed_at, callsign`,
      [ids, at]
    );
    return result.rows.map(alertFromRow);
  }

  async watchlist(): Promise<WatchlistEntry[]> {
    const result = await this.database.query<{
      icao: string;
      label: string | null;
      notes: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>("SELECT * FROM watchlist ORDER BY updated_at DESC, icao");
    return result.rows.map((row) => ({
      icao: normaliseIcao(row.icao),
      label: row.label,
      notes: row.notes,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    }));
  }

  async putWatchlist(
    icao: string,
    input: WatchlistInput
  ): Promise<WatchlistEntry> {
    const result = await this.database.query<{
      icao: string;
      label: string | null;
      notes: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `INSERT INTO watchlist (icao, label, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (icao) DO UPDATE SET
         label = EXCLUDED.label, notes = EXCLUDED.notes, updated_at = now()
       RETURNING *`,
      [icao, input.label ?? null, input.notes ?? null]
    );
    const row = result.rows[0]!;
    return {
      icao: normaliseIcao(row.icao),
      label: row.label,
      notes: row.notes,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async deleteWatchlist(icao: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM watchlist WHERE icao = $1",
      [icao]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
