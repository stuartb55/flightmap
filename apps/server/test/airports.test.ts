import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { csvRecords, parseCsv, selectAirports } from "../src/domain/airports.js";
import { parseArguments } from "../src/airports-cli.js";

/*
 * Column names and order taken from the real OurAirports export. Only the
 * columns the CLI reads are populated; the rest stand in so a row is the right
 * shape, which is the point of keying on the header rather than on position.
 */
const AIRPORT_HEADER =
  '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"';

function airportRow(values: {
  ident: string;
  type: string;
  name: string;
  latitude: number;
  longitude: number;
  elevation?: string;
  icao?: string;
  iata?: string;
}): string {
  return [
    "1",
    values.ident,
    values.type,
    `"${values.name}"`,
    String(values.latitude),
    String(values.longitude),
    values.elevation ?? "250",
    "EU",
    "GB",
    "GB-ENG",
    "Somewhere",
    "yes",
    values.icao ?? values.ident,
    values.iata ?? "",
    "",
    "",
    "",
    "",
    ""
  ].join(",");
}

const RUNWAY_HEADER =
  '"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"';

function runwayRow(values: {
  airport: string;
  lengthFt: string;
  closed?: string;
  low?: string;
  high?: string;
  lowLatitude?: string;
  lowLongitude?: string;
  highLatitude?: string;
  highLongitude?: string;
}): string {
  return [
    "1",
    "1",
    values.airport,
    values.lengthFt,
    "150",
    "ASP",
    "1",
    values.closed ?? "0",
    values.low ?? "05",
    values.lowLatitude ?? "53.34",
    values.lowLongitude ?? "-2.29",
    "250",
    "50",
    "0",
    values.high ?? "23",
    values.highLatitude ?? "53.36",
    values.highLongitude ?? "-2.25",
    "250",
    "230",
    "0"
  ].join(",");
}

const CENTRE = { latitude: 53.61, longitude: -2.31 };
const OPTIONS = { ...CENTRE, radiusNm: 250, minimumRunwayFt: 3_281 };

describe("CSV parsing", () => {
  it("reads quoted fields, embedded commas and doubled quotes", () => {
    const rows = parseCsv(
      'a,b,c\n1,"Manchester, Ringway","He said ""hello"""\n2,plain,x\n'
    );
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "Manchester, Ringway", 'He said "hello"'],
      ["2", "plain", "x"]
    ]);
  });

  it("survives CRLF endings and a missing final newline", () => {
    expect(parseCsv("a,b\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  /*
   * Keyed on the header rather than on column position, so an upstream export
   * that inserts a column shifts nothing. A positional reader would silently
   * start reading longitude as elevation.
   */
  it("keys records by header name", () => {
    const records = csvRecords('ident,name\nEGCC,"Manchester Airport"\n');
    expect(records).toEqual([{ ident: "EGCC", name: "Manchester Airport" }]);
  });

  it("returns nothing for an empty file", () => {
    expect(csvRecords("")).toEqual([]);
  });
});

describe("airport selection", () => {
  it("keeps large and medium airports regardless of runway length", () => {
    const airports = [
      AIRPORT_HEADER,
      airportRow({
        ident: "EGCC",
        type: "large_airport",
        name: "Manchester Airport",
        latitude: 53.35,
        longitude: -2.28,
        iata: "MAN"
      }),
      airportRow({
        ident: "EGNM",
        type: "medium_airport",
        name: "Leeds Bradford",
        latitude: 53.87,
        longitude: -1.66
      })
    ].join("\n");
    const items = selectAirports(csvRecords(airports), [], OPTIONS);
    expect(items.map((airport) => airport.icao)).toEqual(["EGCC", "EGNM"]);
    expect(items[0]).toMatchObject({ iata: "MAN", rank: 3, name: "Manchester Airport" });
    expect(items[1]).toMatchObject({ iata: null, rank: 2 });
  });

  /*
   * Radius alone pulls in every grass strip in the area, which is noise on the
   * map and most of the payload. A small field earns its place by having a
   * runway something might actually land on.
   */
  it("keeps a small airport only when a runway is long enough", () => {
    const airports = [
      AIRPORT_HEADER,
      airportRow({
        ident: "EGBK",
        type: "small_airport",
        name: "Sywell",
        latitude: 53.4,
        longitude: -2.3
      }),
      airportRow({
        ident: "XSTRIP",
        type: "small_airport",
        name: "Farm strip",
        latitude: 53.41,
        longitude: -2.31
      })
    ].join("\n");
    const runways = [
      RUNWAY_HEADER,
      runwayRow({ airport: "EGBK", lengthFt: "4000" }),
      runwayRow({ airport: "XSTRIP", lengthFt: "1400" })
    ].join("\n");
    const items = selectAirports(csvRecords(airports), csvRecords(runways), OPTIONS);
    expect(items.map((airport) => airport.icao)).toEqual(["EGBK"]);
  });

  it("excludes heliports, seaplane bases and closed fields entirely", () => {
    const airports = [
      AIRPORT_HEADER,
      airportRow({ ident: "H1", type: "heliport", name: "Hospital pad", latitude: 53.4, longitude: -2.3 }),
      airportRow({ ident: "S1", type: "seaplane_base", name: "Lake", latitude: 53.4, longitude: -2.3 }),
      airportRow({ ident: "C1", type: "closed", name: "Old field", latitude: 53.4, longitude: -2.3 })
    ].join("\n");
    expect(selectAirports(csvRecords(airports), [], OPTIONS)).toEqual([]);
  });

  it("drops anything beyond the radius", () => {
    const airports = [
      AIRPORT_HEADER,
      airportRow({ ident: "NEAR", type: "large_airport", name: "Near", latitude: 53.4, longitude: -2.3 }),
      // Rome: well outside 250 nm of the reference receiver.
      airportRow({ ident: "LIRF", type: "large_airport", name: "Fiumicino", latitude: 41.8, longitude: 12.25 })
    ].join("\n");
    expect(
      selectAirports(csvRecords(airports), [], OPTIONS).map((airport) => airport.icao)
    ).toEqual(["NEAR"]);
  });

  it("pairs runway thresholds into a centreline and skips closed ones", () => {
    const airports = [
      AIRPORT_HEADER,
      airportRow({ ident: "EGCC", type: "large_airport", name: "Manchester", latitude: 53.35, longitude: -2.28 })
    ].join("\n");
    const runways = [
      RUNWAY_HEADER,
      runwayRow({ airport: "EGCC", lengthFt: "10000", low: "05L", high: "23R" }),
      runwayRow({ airport: "EGCC", lengthFt: "9000", low: "05R", high: "23L", closed: "1" })
    ].join("\n");
    const items = selectAirports(csvRecords(airports), csvRecords(runways), OPTIONS);
    expect(items[0]?.runways).toEqual([
      {
        ident: "05L/23R",
        lengthFt: 10_000,
        lowLatitude: 53.34,
        lowLongitude: -2.29,
        highLatitude: 53.36,
        highLongitude: -2.25
      }
    ]);
  });

  it("keeps an airport whose runway has no published thresholds, without a centreline", () => {
    const airports = [
      AIRPORT_HEADER,
      airportRow({ ident: "EGCC", type: "large_airport", name: "Manchester", latitude: 53.35, longitude: -2.28 })
    ].join("\n");
    const runways = [
      RUNWAY_HEADER,
      runwayRow({
        airport: "EGCC",
        lengthFt: "10000",
        lowLatitude: "",
        highLatitude: ""
      })
    ].join("\n");
    const items = selectAirports(csvRecords(airports), csvRecords(runways), OPTIONS);
    expect(items).toHaveLength(1);
    expect(items[0]?.runways).toEqual([]);
  });

  /*
   * The whole point of the CLI being deterministic: a regenerated dataset has to
   * be a reviewable diff rather than a reshuffle, and an unchanged rebuild must
   * not invalidate the ETag every client has cached.
   */
  it("produces byte-identical output from the same input", () => {
    const airports = [
      AIRPORT_HEADER,
      airportRow({ ident: "EGNM", type: "medium_airport", name: "Leeds", latitude: 53.87, longitude: -1.66 }),
      airportRow({ ident: "EGCC", type: "large_airport", name: "Manchester", latitude: 53.35, longitude: -2.28 }),
      airportRow({ ident: "EGGP", type: "medium_airport", name: "Liverpool", latitude: 53.33, longitude: -2.85 })
    ].join("\n");
    const runways = [
      RUNWAY_HEADER,
      runwayRow({ airport: "EGCC", lengthFt: "10000", low: "23R", high: "05L" }),
      runwayRow({ airport: "EGCC", lengthFt: "10007", low: "05R", high: "23L" })
    ].join("\n");
    const first = JSON.stringify(selectAirports(csvRecords(airports), csvRecords(runways), OPTIONS));
    const second = JSON.stringify(selectAirports(csvRecords(airports), csvRecords(runways), OPTIONS));
    expect(first).toBe(second);
    // Airports sorted by ICAO and runways by ident, which is what makes it so.
    const items = selectAirports(csvRecords(airports), csvRecords(runways), OPTIONS);
    expect(items.map((airport) => airport.icao)).toEqual(["EGCC", "EGGP", "EGNM"]);
    expect(items[0]?.runways.map((runway) => runway.ident)).toEqual(["05R/23L", "23R/05L"]);
  });

  it("rounds coordinates so float noise cannot reach the diff", () => {
    const airports = [
      AIRPORT_HEADER,
      airportRow({
        ident: "EGCC",
        type: "large_airport",
        name: "Manchester",
        latitude: 53.3493751234567,
        longitude: -2.2795214567891,
        elevation: "257.4"
      })
    ].join("\n");
    expect(selectAirports(csvRecords(airports), [], OPTIONS)[0]).toMatchObject({
      latitude: 53.349375,
      longitude: -2.279521,
      elevationFt: 257
    });
  });

  /*
   * The plan's working budget was 250 kB gzipped for a 250 nm radius. The
   * reference deployment measures at about 9 kB; this is a ceiling that would
   * catch a filter change that let the grass strips back in, not a target.
   */
  it("stays far inside the payload budget for a realistic set", () => {
    const rows = [AIRPORT_HEADER];
    const runwayRows = [RUNWAY_HEADER];
    for (let index = 0; index < 400; index += 1) {
      const ident = `EG${index.toString().padStart(2, "0")}`;
      rows.push(
        airportRow({
          ident,
          type: "medium_airport",
          name: `Aerodrome number ${index} with a fairly long name`,
          latitude: 53.4 + index / 1_000,
          longitude: -2.3 + index / 1_000
        })
      );
      runwayRows.push(runwayRow({ airport: ident, lengthFt: "6000" }));
    }
    const items = selectAirports(csvRecords(rows.join("\n")), csvRecords(runwayRows.join("\n")), OPTIONS);
    expect(items).toHaveLength(400);
    const gzipped = gzipSync(Buffer.from(JSON.stringify({ items }))).byteLength;
    expect(gzipped).toBeLessThan(250_000);
  });
});

describe("command line parsing", () => {
  it("defaults the radius and the runway threshold", () => {
    const options = parseArguments(["--airports", "./airports.csv"]);
    expect(options).toMatchObject({
      airportsPath: "./airports.csv",
      runwaysPath: null,
      radiusNm: 250,
      minimumRunwayFt: 3_281,
      dryRun: false
    });
  });

  it("reads every option", () => {
    expect(
      parseArguments([
        "--airports",
        "a.csv",
        "--runways",
        "r.csv",
        "--latitude",
        "53.61",
        "--longitude",
        "-2.31",
        "--radius-nm",
        "120",
        "--min-runway-ft",
        "5000",
        "--dry-run"
      ])
    ).toEqual({
      airportsPath: "a.csv",
      runwaysPath: "r.csv",
      latitude: 53.61,
      longitude: -2.31,
      radiusNm: 120,
      minimumRunwayFt: 5_000,
      dryRun: true
    });
  });

  it("rejects input that would produce a dataset nobody meant to ask for", () => {
    expect(() => parseArguments([])).toThrow(/--airports is required/);
    expect(() => parseArguments(["--airports"])).toThrow(/needs a value/);
    expect(() => parseArguments(["--airports", "a.csv", "--radius-nm", "wide"])).toThrow(
      /needs a number/
    );
    expect(() => parseArguments(["--airports", "a.csv", "--radius-nm", "0"])).toThrow(
      /between 0 and 3000/
    );
    expect(() => parseArguments(["--airports", "a.csv", "--latitude", "53"])).toThrow(
      /go together/
    );
    expect(() => parseArguments(["--airports", "a.csv", "--wat"])).toThrow(/Unrecognised/);
  });
});
