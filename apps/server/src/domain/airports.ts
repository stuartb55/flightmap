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
 * Handing the event loop back while a dataset is being built.
 *
 * The CLI has a process to itself and does not care. The Settings-page import
 * does not: it runs inside the process serving the map, and an OurAirports
 * export is around 8 MB and 83,000 rows, which is a few hundred milliseconds of
 * uninterrupted parsing here and closer to a second on the receiver-class
 * hardware this usually runs on. For that whole window the 1 Hz collector poll
 * does not run, no WebSocket client gets a delta, and `/health/ready` does not
 * answer.
 *
 * The budget is a deadline rather than a row count because the point is the
 * length of the stall, not the amount of work — slower hardware should yield
 * more often, and only it knows that it is slower.
 */
const YIELD_INTERVAL_MS = 8;

/** Small enough that one is well inside the budget even on slow hardware. */
const SCAN_CHUNK_CHARACTERS = 64 * 1024;
const ROW_CHUNK = 2_000;

function createDeadline(): { due: () => Promise<void> } {
  let until = performance.now() + YIELD_INTERVAL_MS;
  return {
    async due(): Promise<void> {
      if (performance.now() < until) return;
      await new Promise((resolve) => setImmediate(resolve));
      until = performance.now() + YIELD_INTERVAL_MS;
    }
  };
}

interface CsvScan {
  rows: string[][];
  row: string[];
  field: string;
  quoted: boolean;
}

/**
 * Scans `input` from `from` up to `to`, appending whole rows to `scan.rows` and
 * leaving any partial row in `scan` for the next call. Returns where it stopped,
 * which is not always `to`: an escaped quote consumes two characters and the
 * second of them can sit past the boundary.
 *
 * Carrying the state like this is what lets one parser serve both the
 * straight-through sync read and the chunked one that yields, so the two paths
 * cannot drift — `docs/airports.md` promises they produce identical bytes.
 */
function scanCsv(input: string, from: number, to: number, scan: CsvScan): number {
  let index = from;
  for (; index < to; index += 1) {
    const character = input[index];
    if (scan.quoted) {
      if (character !== '"') {
        scan.field += character;
      } else if (input[index + 1] === '"') {
        scan.field += '"';
        index += 1;
      } else {
        scan.quoted = false;
      }
      continue;
    }
    if (character === '"') scan.quoted = true;
    else if (character === ",") {
      scan.row.push(scan.field);
      scan.field = "";
    } else if (character === "\n") {
      scan.row.push(scan.field);
      scan.field = "";
      // Ignore the blank row a trailing newline would otherwise produce.
      if (scan.row.length > 1 || scan.row[0] !== "") scan.rows.push(scan.row);
      scan.row = [];
    } else if (character !== "\r") {
      scan.field += character;
    }
  }
  return index;
}

function beginScan(text: string): { input: string; scan: CsvScan } {
  return {
    // A trailing newline keeps the final row from needing a special case.
    input: text.endsWith("\n") ? text : `${text}\n`,
    scan: { rows: [], row: [], field: "", quoted: false }
  };
}

/**
 * RFC 4180 enough for OurAirports, which quotes any field containing a comma
 * and escapes a quote by doubling it. A general CSV library would be a
 * dependency for two files read a few times a year.
 */
export function parseCsv(text: string): string[][] {
  const { input, scan } = beginScan(text);
  scanCsv(input, 0, input.length, scan);
  return scan.rows;
}

/** Header-keyed records, so a column order change upstream cannot silently shift fields. */
export function csvRecords(text: string): Array<Record<string, string>> {
  return recordsFrom(parseCsv(text));
}

function recordsFrom(rows: readonly string[][]): Array<Record<string, string>> {
  const header = rows[0];
  if (!header) return [];
  return rows.slice(1).map((row) => keyRow(header, row));
}

function keyRow(header: readonly string[], row: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  header.forEach((name, index) => {
    record[name] = row[index] ?? "";
  });
  return record;
}

/**
 * `csvRecords`, handing the event loop back as it goes. Same parser, same
 * output; the only difference is that the process stays answerable while it
 * runs. Use this anywhere the import shares a process with the live path.
 */
export async function csvRecordsYielding(
  text: string
): Promise<Array<Record<string, string>>> {
  const deadline = createDeadline();
  const { input, scan } = beginScan(text);
  let at = 0;
  while (at < input.length) {
    at = scanCsv(input, at, Math.min(input.length, at + SCAN_CHUNK_CHARACTERS), scan);
    await deadline.due();
  }
  const header = scan.rows[0];
  if (!header) return [];
  const records: Array<Record<string, string>> = [];
  for (let index = 1; index < scan.rows.length; index += 1) {
    records.push(keyRow(header, scan.rows[index]!));
    if (index % ROW_CHUNK === 0) await deadline.due();
  }
  return records;
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
type RunwayIndex = {
  runwaysByAirport: Map<string, AirportRunway[]>;
  lengthByAirport: Map<string, number>;
};

function emptyRunwayIndex(): RunwayIndex {
  return { runwaysByAirport: new Map(), lengthByAirport: new Map() };
}

/**
 * The per-row halves of the selection, kept separate from the loops that drive
 * them so the straight-through read and the chunked one that yields share every
 * decision between them. All the behaviour lives here; the exported functions
 * below differ only in how often they hand the event loop back.
 */
function indexRunway(row: Record<string, string>, index: RunwayIndex): void {
  const reference = row.airport_ident?.trim();
  if (!reference) return;
  const lengthFt = optionalNumber(row.length_ft);
  if (lengthFt !== null && lengthFt > 0) {
    index.lengthByAirport.set(
      reference,
      Math.max(index.lengthByAirport.get(reference) ?? 0, lengthFt)
    );
  }
  // A closed runway is still on the chart but is not somewhere anything
  // lands, so it should not be drawn as if it were.
  if (row.closed?.trim() === "1") return;
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
    return;
  }
  const low = row.le_ident?.trim() || "?";
  const high = row.he_ident?.trim() || "?";
  const runways = index.runwaysByAirport.get(reference) ?? [];
  runways.push({
    ident: `${low}/${high}`.slice(0, 16),
    lengthFt: lengthFt !== null && lengthFt > 0 ? Math.round(lengthFt) : null,
    lowLatitude: coordinate(lowLatitude),
    lowLongitude: coordinate(lowLongitude),
    highLatitude: coordinate(highLatitude),
    highLongitude: coordinate(highLongitude)
  });
  index.runwaysByAirport.set(reference, runways);
}

function selectAirport(
  row: Record<string, string>,
  index: RunwayIndex,
  options: AirportSelection
): Airport | null {
  const rank = RANK_BY_TYPE[row.type?.trim() ?? ""];
  if (rank === undefined) return null;
  const latitude = optionalNumber(row.latitude_deg);
  const longitude = optionalNumber(row.longitude_deg);
  if (latitude === null || longitude === null) return null;
  const { distanceNm } = calculateRangeAndBearing(
    options.latitude,
    options.longitude,
    latitude,
    longitude
  );
  if (distanceNm > options.radiusNm) return null;
  const ident = row.ident?.trim();
  if (!ident) return null;
  if (rank === 1 && (index.lengthByAirport.get(ident) ?? 0) < options.minimumRunwayFt) {
    return null;
  }
  const icao = (row.icao_code?.trim() || ident).slice(0, 8);
  const iata = row.iata_code?.trim() ?? "";
  const runways = (index.runwaysByAirport.get(ident) ?? []).sort((left, right) =>
    left.ident.localeCompare(right.ident, "en")
  );
  const elevation = optionalNumber(row.elevation_ft);
  return airportSchema.parse({
    icao,
    iata: iata.length === 3 ? iata.toUpperCase() : null,
    name: (row.name?.trim() || icao).slice(0, 80),
    latitude: coordinate(latitude),
    longitude: coordinate(longitude),
    elevationFt: elevation === null ? null : Math.round(elevation),
    rank,
    runways: runways.slice(0, 16)
  });
}

/** Sorted by ICAO so the same inputs always produce the same bytes. The map
 *  decides drawing order from `rank`, not from position in this array. */
function byIcao(selected: Airport[]): Airport[] {
  return selected.sort((left, right) => left.icao.localeCompare(right.icao, "en"));
}

export function selectAirports(
  airportRows: ReadonlyArray<Record<string, string>>,
  runwayRows: ReadonlyArray<Record<string, string>>,
  options: AirportSelection
): Airport[] {
  const index = emptyRunwayIndex();
  for (const row of runwayRows) indexRunway(row, index);
  const selected: Airport[] = [];
  for (const row of airportRows) {
    const airport = selectAirport(row, index, options);
    if (airport) selected.push(airport);
  }
  return byIcao(selected);
}

/**
 * `selectAirports`, handing the event loop back as it goes. Same decisions,
 * same output, same order.
 */
export async function selectAirportsYielding(
  airportRows: ReadonlyArray<Record<string, string>>,
  runwayRows: ReadonlyArray<Record<string, string>>,
  options: AirportSelection
): Promise<Airport[]> {
  const deadline = createDeadline();
  const index = emptyRunwayIndex();
  for (let at = 0; at < runwayRows.length; at += 1) {
    indexRunway(runwayRows[at]!, index);
    if (at % ROW_CHUNK === 0) await deadline.due();
  }
  const selected: Airport[] = [];
  for (let at = 0; at < airportRows.length; at += 1) {
    const airport = selectAirport(airportRows[at]!, index, options);
    if (airport) selected.push(airport);
    if (at % ROW_CHUNK === 0) await deadline.due();
  }
  return byIcao(selected);
}

/**
 * The database is opened only when it is actually needed — to read the receiver
 * position as the centre, or to write the result. A dry run with an explicit
 * centre is then a pure file-in, summary-out operation, which is what makes it
 * usable for checking a radius or a runway threshold before committing to one.
 */
