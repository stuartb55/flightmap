import type {
  AircraftDetailResponse,
  AircraftSummary,
  LiveAircraft
} from "@flightmap/shared";
import {
  activeAircraftAlertRules
} from "../domain/alerts.js";
import type {
  AlertRow,
  MetadataRow,
  SessionRow
} from "./repository-shared.js";
import {
  RepositoryBase,
  alertFromRow,
  iso,
  metadataFromRow,
  normaliseIcao,
  number,
  sessionFromRow
} from "./repository-shared.js";

/** The current-aircraft view and single-aircraft detail. */
export class LiveRepository extends RepositoryBase {
  async liveAircraft(
    now = new Date(),
    icaos?: readonly string[]
  ): Promise<LiveAircraft[]> {
    if (icaos !== undefined && icaos.length === 0) return [];
    const cutoff = new Date(
      now.getTime() - this.config.currentAircraftTtlSeconds * 1000
    );
    const result = await this.database.query<{
      state: LiveAircraft;
      watched: boolean;
      has_active_alert: boolean;
      metadata_icao: string | null;
      registration: string | null;
      type_code: string | null;
      description: string | null;
      operator: string | null;
      owner: string | null;
      country: string | null;
      first_seen_at: Date | string | null;
    }>(
      `SELECT c.state,
              (w.icao IS NOT NULL) AS watched,
              EXISTS (
                SELECT 1 FROM alert_events a
                WHERE a.icao = c.icao
                  AND a.rule = ANY($2::text[])
                  AND a.dismissed_at IS NULL
              ) AS has_active_alert,
              m.icao AS metadata_icao, m.registration, m.type_code,
              m.description, m.operator, m.owner, m.country,
              s.first_seen_at
       FROM current_aircraft c
       LEFT JOIN watchlist w ON w.icao = c.icao
       LEFT JOIN aircraft_metadata m ON m.icao = c.icao
       LEFT JOIN aircraft_summary s ON s.icao = c.icao
       WHERE c.updated_at >= $1
         AND ($3::text[] IS NULL OR c.icao = ANY($3::text[]))
       ORDER BY c.icao`,
      [
        cutoff,
        [...activeAircraftAlertRules],
        icaos ? icaos.map(normaliseIcao) : null
      ]
    );
    return result.rows.map((row) => ({
      ...row.state,
      icao: normaliseIcao(row.state.icao),
      stale:
        now.getTime() - Date.parse(row.state.recordedAt) > 15_000 ||
        row.state.stale,
      watched: row.watched,
      hasActiveAlert: row.has_active_alert,
      // Null until the summary row exists, which the client shows as unknown
      // rather than as a first sighting.
      firstSeenAt: row.first_seen_at == null ? null : iso(row.first_seen_at),
      metadata: row.metadata_icao
        ? metadataFromRow({
            icao: row.metadata_icao,
            registration: row.registration,
            type_code: row.type_code,
            description: row.description,
            operator: row.operator,
            owner: row.owner,
            country: row.country
          })
        : null
    }));
  }

  async aircraftDetail(icao: string): Promise<AircraftDetailResponse> {
    const [live, metadataResult, summaryResult, sessions, alerts] =
      await Promise.all([
        this.liveAircraft(new Date(), [icao]).then(
          (aircraft) => aircraft[0] ?? null
        ),
        this.database.query<MetadataRow>(
          "SELECT * FROM aircraft_metadata WHERE icao = $1",
          [icao]
        ),
        this.database.query<{
          icao: string;
          first_seen_at: Date | string;
          last_seen_at: Date | string;
          total_observations: number | string;
          session_count: number | string;
          closest_range_nm: number | null;
          latest_callsign: string | null;
          latest_registration: string | null;
          latest_type_code: string | null;
          latest_operator: string | null;
        }>("SELECT * FROM aircraft_summary WHERE icao = $1", [icao]),
        this.database.query<SessionRow>(
          `SELECT s.*, true AS detailed_track_available,
                  ARRAY(
                    SELECT DISTINCT a.rule
                    FROM alert_events a
                    WHERE a.session_id = s.id
                  ) AS alert_rules
           FROM track_sessions s WHERE s.icao = $1
           ORDER BY s.started_at DESC LIMIT 20`,
          [icao]
        ),
        this.database.query<AlertRow>(
          `SELECT id, icao, session_id, rule, state, message, severity,
                  occurred_at, dismissed_at, callsign
           FROM alert_events WHERE icao = $1
           ORDER BY occurred_at DESC LIMIT 50`,
          [icao]
        )
      ]);
    const summaryRow = summaryResult.rows[0];
    const summary: AircraftSummary | null = summaryRow
      ? {
          icao: normaliseIcao(summaryRow.icao),
          firstSeenAt: iso(summaryRow.first_seen_at),
          lastSeenAt: iso(summaryRow.last_seen_at),
          totalObservations: number(summaryRow.total_observations),
          sessionCount: number(summaryRow.session_count),
          closestRangeNm: summaryRow.closest_range_nm,
          latestCallsign: summaryRow.latest_callsign,
          latestRegistration: summaryRow.latest_registration,
          latestTypeCode: summaryRow.latest_type_code,
          latestOperator: summaryRow.latest_operator
        }
      : null;
    return {
      aircraft: live,
      metadata: metadataResult.rows[0]
        ? metadataFromRow(metadataResult.rows[0])
        : null,
      summary,
      recentSessions: sessions.rows.map(sessionFromRow),
      alerts: alerts.rows.map(alertFromRow)
    };
  }
}
