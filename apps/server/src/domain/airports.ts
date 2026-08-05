import {
  airportSchema,
  calculateRangeAndBearing,
  type Airport,
  type AirportRunway
} from "@flightmap/shared";

/**
 * Turning an OurAirports CSV export into the `mapAirports` dataset.
 *
 * Shared by the two things that can build it: the server-side import driven
 * from the Settings page (`services/airports.ts`) and the offline CLI
 * (`airports-cli.ts`), which exists for receivers with no internet access.
 * Both must produce identical bytes from identical input — see `docs/airports.md`.
 */

/** How wide a net to cast, and what a small field has to have to earn a place. */
export interface AirportSelection {
  latitude: number;
  longitude: number;
  radiusNm: number;
  minimumRunwayFt: number;
}

/**
 * RFC 4180 enough for OurAirports, which quotes any field containing a comma
 * and escapes a quote by doubling it. A general CSV library would be a
 * dependency for two files read a few times a year.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A trailing newline keeps the final row from needing a special case.
  const input = text.endsWith("\n") ? text : `${text}\n`;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      field = "";
      // Ignore the blank row a trailing newline would otherwise produce.
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (character !== "\r") {
      field += character;
    }
  }
  return rows;
}

/** Header-keyed records, so a column order change upstream cannot silently shift fields. */
export function csvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = row[index] ?? "";
    });
    return record;
  });
}

function optionalNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Six decimal places is about 10 cm — far finer than a threshold coordinate is
 * surveyed to, and enough that the value is stable across runs rather than
 * carrying float noise into the diff.
 */
function coordinate(value: number): number {
  return Number(value.toFixed(6));
}

const RANK_BY_TYPE: Record<string, number> = {
  large_airport: 3,
  medium_airport: 2,
  small_airport: 1
};

/**
 * Which airports are worth drawing.
 *
 * Radius alone pulls in every grass strip and private helipad in the area,
 * which is noise on the map and most of the payload. Large and medium airports
 * are kept unconditionally — those are the ones traffic is going to — and a
 * small airport only earns its place if it has a runway long enough to be
 * somewhere an aircraft this receiver hears would actually land. Heliports,
 * seaplane bases and closed fields are always excluded.
 */
export function selectAirports(
  airportRows: ReadonlyArray<Record<string, string>>,
  runwayRows: ReadonlyArray<Record<string, string>>,
  options: AirportSelection
): Airport[] {
  const runwaysByAirport = new Map<string, AirportRunway[]>();
  const lengthByAirport = new Map<string, number>();
  for (const row of runwayRows) {
    const reference = row.airport_ident?.trim();
    if (!reference) continue;
    const lengthFt = optionalNumber(row.length_ft);
    if (lengthFt !== null && lengthFt > 0) {
      lengthByAirport.set(
        reference,
        Math.max(lengthByAirport.get(reference) ?? 0, lengthFt)
      );
    }
    // A closed runway is still on the chart but is not somewhere anything
    // lands, so it should not be drawn as if it were.
    if (row.closed?.trim() === "1") continue;
    const lowLatitude = optionalNumber(row.le_latitude_deg);
    const lowLongitude = optionalNumber(row.le_longitude_deg);
    const highLatitude = optionalNumber(row.he_latitude_deg);
    const highLongitude = optionalNumber(row.he_longitude_deg);
    // Without both thresholds there is no centreline to draw. The airport
    // itself still counts; it just gets no runway.
    if (
      lowLatitude === null ||
      lowLongitude === null ||
      highLatitude === null ||
      highLongitude === null
    ) {
      continue;
    }
    const low = row.le_ident?.trim() || "?";
    const high = row.he_ident?.trim() || "?";
    const runways = runwaysByAirport.get(reference) ?? [];
    runways.push({
      ident: `${low}/${high}`.slice(0, 16),
      lengthFt: lengthFt !== null && lengthFt > 0 ? Math.round(lengthFt) : null,
      lowLatitude: coordinate(lowLatitude),
      lowLongitude: coordinate(lowLongitude),
      highLatitude: coordinate(highLatitude),
      highLongitude: coordinate(highLongitude)
    });
    runwaysByAirport.set(reference, runways);
  }

  const selected: Airport[] = [];
  for (const row of airportRows) {
    const rank = RANK_BY_TYPE[row.type?.trim() ?? ""];
    if (rank === undefined) continue;
    const latitude = optionalNumber(row.latitude_deg);
    const longitude = optionalNumber(row.longitude_deg);
    if (latitude === null || longitude === null) continue;
    const { distanceNm } = calculateRangeAndBearing(
      options.latitude,
      options.longitude,
      latitude,
      longitude
    );
    if (distanceNm > options.radiusNm) continue;
    const ident = row.ident?.trim();
    if (!ident) continue;
    if (rank === 1 && (lengthByAirport.get(ident) ?? 0) < options.minimumRunwayFt) {
      continue;
    }
    const icao = (row.icao_code?.trim() || ident).slice(0, 8);
    const iata = row.iata_code?.trim() ?? "";
    const runways = (runwaysByAirport.get(ident) ?? []).sort((left, right) =>
      left.ident.localeCompare(right.ident, "en")
    );
    selected.push(
      airportSchema.parse({
        icao,
        iata: iata.length === 3 ? iata.toUpperCase() : null,
        name: (row.name?.trim() || icao).slice(0, 80),
        latitude: coordinate(latitude),
        longitude: coordinate(longitude),
        elevationFt: (() => {
          const elevation = optionalNumber(row.elevation_ft);
          return elevation === null ? null : Math.round(elevation);
        })(),
        rank,
        runways: runways.slice(0, 16)
      })
    );
  }
  // Sorted by ICAO so the same inputs always produce the same bytes. The map
  // decides drawing order from `rank`, not from position in this array.
  return selected.sort((left, right) => left.icao.localeCompare(right.icao, "en"));
}

/**
 * The database is opened only when it is actually needed — to read the receiver
 * position as the centre, or to write the result. A dry run with an explicit
 * centre is then a pure file-in, summary-out operation, which is what makes it
 * usable for checking a radius or a runway threshold before committing to one.
 */
