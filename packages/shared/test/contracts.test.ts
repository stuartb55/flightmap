import { describe, expect, it } from "vitest";
import {
  icaoSchema,
  dismissAlertsInputSchema,
  receiverAircraftSchema,
  sessionQuerySchema,
  trackQuerySchema
} from "../src/index.js";

describe("shared contracts", () => {
  it("canonicalises valid ICAO identifiers", () => {
    expect(icaoSchema.parse(" A0B1C2 ")).toBe("a0b1c2");
    expect(() => icaoSchema.parse("~abc12")).toThrow();
  });

  it("accepts sparse and forward-compatible receiver records", () => {
    const parsed = receiverAircraftSchema.parse({
      hex: "ABC123",
      alt_baro: "ground",
      future_receiver_field: { value: 1 }
    });
    expect(parsed.alt_baro).toBe("ground");
    expect(parsed.future_receiver_field).toEqual({ value: 1 });
  });

  it("caps searches and rejects reversed ranges", () => {
    expect(() => sessionQuerySchema.parse({ limit: "201" })).toThrow();
    expect(() =>
      sessionQuerySchema.parse({
        from: "2026-01-02T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z"
      })
    ).toThrow();
  });

  it("bounds track reads and parses incremental query options", () => {
    expect(
      trackQuerySchema.parse({
        limit: "20000",
        tail: "true",
        from: "2026-07-29T12:00:00.000Z"
      })
    ).toMatchObject({ limit: 20_000, tail: true });
    expect(() => trackQuerySchema.parse({ limit: "20001" })).toThrow();
  });

  it("bounds bulk alert dismissals", () => {
    const id = "9b7dc991-58bf-4c42-b033-40c637d3f09a";
    expect(dismissAlertsInputSchema.parse({ ids: [id] }).ids).toEqual([id]);
    expect(() =>
      dismissAlertsInputSchema.parse({ ids: Array(201).fill(id) })
    ).toThrow();
  });
});
