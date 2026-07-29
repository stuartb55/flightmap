import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  MetadataService,
  parseMetadataCsv
} from "../src/services/metadata.js";

describe("metadata CSV validation", () => {
  it("maps extended header aliases and rejects invalid ICAO rows", () => {
    const records = parseMetadataCsv(
      [
        "icao24,registration,icao_type,model,operator,owner,country",
        "ABC123,G-TEST,A320,Airbus A320,Example Air,Example Ltd,United Kingdom",
        "not-hex,N12345,B738,Boeing 737,Other,,,"
      ].join("\n")
    );
    expect(records).toEqual([
      {
        icao: "abc123",
        registration: "G-TEST",
        typeCode: "A320",
        description: "Airbus A320",
        operator: "Example Air",
        owner: "Example Ltd",
        country: "United Kingdom"
      }
    ]);
  });

  it("supports compact five-column readsb CSV without a header", () => {
    expect(parseMetadataCsv("abc123,G-TEST,A320,00,Airbus A320")).toEqual([
      {
        icao: "abc123",
        registration: "G-TEST",
        typeCode: "A320",
        description: "Airbus A320",
        operator: null,
        owner: null,
        country: null
      }
    ]);
  });

  it("auto-detects the semicolon-delimited tar1090-db format", () => {
    expect(
      parseMetadataCsv(
        [
          "007CC1;N26BD;ASTR;00;;1992;ARKANSAS BOLT CO;",
          "004003;Z-WPB;B733;00;BOEING 737-300;;;;"
        ].join("\n")
      )
    ).toEqual([
      {
        icao: "007cc1",
        registration: "N26BD",
        typeCode: "ASTR",
        description: null,
        operator: "ARKANSAS BOLT CO",
        owner: "ARKANSAS BOLT CO",
        country: null
      },
      {
        icao: "004003",
        registration: "Z-WPB",
        typeCode: "B733",
        description: "BOEING 737-300",
        operator: null,
        owner: null,
        country: null
      }
    ]);
  });

  it.each(["plain", "gzip"] as const)(
    "streams a bounded %s download into atomic staging",
    async (format) => {
      const csv = [
        "icao24,registration,icao_type,model,operator,owner,country",
        "ABC123,G-TEST,A320,Airbus A320,Example Air,Example Ltd,United Kingdom"
      ].join("\n");
      const client = {
        query: vi.fn(async (sql: string) =>
          sql.includes("count(*) AS count")
            ? { rows: [{ count: "1" }] }
            : { rows: [] }
        )
      };
      const database = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        transaction: vi.fn(
          async (callback: (value: typeof client) => Promise<unknown>) =>
            callback(client)
        )
      };
      const body = format === "gzip" ? gzipSync(csv) : csv;
      const service = new MetadataService(
        database as never,
        {
          metadataUrl: "https://metadata.example/aircraft.csv",
          metadataTimeoutMs: 5_000,
          metadataMinRows: 1,
          metadataCheckIntervalMs: 60_000,
          metadataMaxDownloadBytes: 1_000_000,
          metadataMaxUncompressedBytes: 1_000_000
        },
        { info: vi.fn(), warn: vi.fn() },
        vi.fn().mockResolvedValue(new Response(body))
      );
      await expect(service.refresh()).resolves.toEqual({
        changed: true,
        rowCount: 1
      });
      expect(
        client.query.mock.calls.some(([sql]) =>
          String(sql).includes("ON CONFLICT (icao) DO UPDATE")
        )
      ).toBe(true);
    }
  );
});
