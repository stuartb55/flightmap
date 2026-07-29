import {
  createReadStream,
  createWriteStream
} from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { parse as createParser } from "csv-parse";
import { parse } from "csv-parse/sync";
import type { Config } from "../config.js";
import type { Database } from "../db/database.js";

type Logger = {
  info: (object: unknown, message?: string) => void;
  warn: (object: unknown, message?: string) => void;
};

type MetadataRecord = {
  icao: string;
  registration: string | null;
  typeCode: string | null;
  description: string | null;
  operator: string | null;
  owner: string | null;
  country: string | null;
};

type MetadataImportState = {
  etag: string | null;
  lastModified: string | null;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result : null;
}

function canonicalColumn(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function field(
  row: string[],
  columns: Map<string, number>,
  aliases: string[]
): string | null {
  for (const alias of aliases) {
    const index = columns.get(canonicalColumn(alias));
    if (index !== undefined) return clean(row[index]);
  }
  return null;
}

/**
 * Supports tar1090's headered extended CSV and the compact readsb five-column
 * form. A strict ICAO check prevents a bad download from replacing good data.
 */
export function parseMetadataCsv(input: string): MetadataRecord[] {
  const firstLine =
    input
      .split(/\r?\n/, 1)[0]
      ?.replace(/^\uFEFF/, "") ?? "";
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) >
    (firstLine.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  const rows = parse(input, {
    bom: true,
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true
  }) as string[][];
  if (rows.length === 0) throw new Error("Metadata CSV is empty");

  const first = rows[0]!.map(canonicalColumn);
  const hasHeader = first.some((value) =>
    ["icao", "icao24", "hex"].includes(value)
  );
  const columns = new Map<string, number>();
  if (hasHeader) {
    first.forEach((name, index) => columns.set(name, index));
  } else {
    columns.set("icao", 0);
    columns.set("registration", 1);
    columns.set("typecode", 2);
    columns.set("description", 4);
    // Compact tar1090-db: hex;reg;type;flags;description;year;owner/operator;
    // Country is not present and must remain unavailable rather than being
    // inferred from an unrelated trailing field.
    columns.set("operator", 6);
    columns.set("owner", 6);
  }

  const records = new Map<string, MetadataRecord>();
  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    const rawIcao = field(row, columns, ["icao", "icao24", "hex"]);
    const icao = rawIcao?.toLowerCase();
    if (!icao || !/^[0-9a-f]{6}$/.test(icao)) continue;
    records.set(icao, {
      icao,
      registration: field(row, columns, [
        "registration",
        "reg",
        "tailnumber"
      ]),
      typeCode: field(row, columns, [
        "typecode",
        "icaotype",
        "icaoaircrafttype"
      ]),
      description: field(row, columns, [
        "description",
        "model",
        "aircrafttype"
      ]),
      operator: field(row, columns, [
        "operator",
        "operatorname",
        "airline"
      ]),
      owner: field(row, columns, ["owner", "registeredowners"]),
      country: field(row, columns, [
        "country",
        "registrationcountry",
        "countrycode"
      ])
    });
  }
  return [...records.values()];
}

function byteLimit(maximum: number, label: string): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > maximum
          ? new Error(`${label} exceeds the ${maximum.toLocaleString()} byte limit`)
          : null,
        chunk
      );
    }
  });
}

function columnsFor(firstRow: string[]): {
  columns: Map<string, number>;
  hasHeader: boolean;
} {
  const first = firstRow.map(canonicalColumn);
  const hasHeader = first.some((value) =>
    ["icao", "icao24", "hex"].includes(value)
  );
  const columns = new Map<string, number>();
  if (hasHeader) {
    first.forEach((name, index) => columns.set(name, index));
  } else {
    columns.set("icao", 0);
    columns.set("registration", 1);
    columns.set("typecode", 2);
    columns.set("description", 4);
    columns.set("operator", 6);
    columns.set("owner", 6);
  }
  return { columns, hasHeader };
}

function recordFromRow(
  row: string[],
  columns: Map<string, number>
): MetadataRecord | null {
  const rawIcao = field(row, columns, ["icao", "icao24", "hex"]);
  const icao = rawIcao?.toLowerCase();
  if (!icao || !/^[0-9a-f]{6}$/.test(icao)) return null;
  return {
    icao,
    registration: field(row, columns, [
      "registration",
      "reg",
      "tailnumber"
    ]),
    typeCode: field(row, columns, [
      "typecode",
      "icaotype",
      "icaoaircrafttype"
    ]),
    description: field(row, columns, [
      "description",
      "model",
      "aircrafttype"
    ]),
    operator: field(row, columns, [
      "operator",
      "operatorname",
      "airline"
    ]),
    owner: field(row, columns, ["owner", "registeredowners"]),
    country: field(row, columns, [
      "country",
      "registrationcountry",
      "countrycode"
    ])
  };
}

async function previewText(
  path: string,
  compressed: boolean
): Promise<string> {
  const file = createReadStream(path);
  const source = compressed ? file.pipe(createGunzip()) : file;
  let text = "";
  try {
    for await (const chunk of source) {
      text += Buffer.from(chunk).toString("utf8");
      if (text.includes("\n") || text.length >= 16_384) break;
    }
    return text.slice(0, 16_384);
  } finally {
    source.destroy();
    file.destroy();
  }
}

export class MetadataService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private activeRefresh: Promise<unknown> | null = null;
  private abortController = new AbortController();

  constructor(
    private readonly database: Database,
    private readonly config: Pick<
      Config,
      | "metadataUrl"
      | "metadataTimeoutMs"
      | "metadataMinRows"
      | "metadataCheckIntervalMs"
      | "metadataMaxDownloadBytes"
      | "metadataMaxUncompressedBytes"
    >,
    private readonly logger: Logger,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch
  ) {}

  private async state(): Promise<MetadataImportState> {
    const result = await this.database.query<{
      etag: string | null;
      last_modified: string | null;
    }>(
      `SELECT etag, last_modified
       FROM aircraft_metadata_import WHERE id = true`
    );
    return {
      etag: result.rows[0]?.etag ?? null,
      lastModified: result.rows[0]?.last_modified ?? null
    };
  }

  async refresh(force = false): Promise<{
    changed: boolean;
    rowCount: number;
  }> {
    if (this.running) throw new Error("Metadata refresh is already running");
    this.running = true;
    const stopSignal = this.abortController.signal;
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(this.config.metadataTimeoutMs),
      stopSignal
    ]);
    try {
      const previous = await this.state();
      const headers = new Headers({ accept: "text/csv, application/gzip" });
      if (!force && previous.etag) headers.set("if-none-match", previous.etag);
      if (!force && previous.lastModified) {
        headers.set("if-modified-since", previous.lastModified);
      }
      const response = await this.fetchImplementation(this.config.metadataUrl, {
        headers,
        signal: requestSignal
      });
      if (response.status === 304) {
        await this.database.query(
          `INSERT INTO aircraft_metadata_import (
             id, source_url, last_checked_at, row_count
           ) VALUES (
             true, $1, now(), (SELECT count(*) FROM aircraft_metadata)
           )
           ON CONFLICT (id) DO UPDATE SET
             last_checked_at = now(), last_error = NULL`,
          [this.config.metadataUrl]
        );
        return {
          changed: false,
          rowCount: await this.count()
        };
      }
      if (!response.ok) {
        throw new Error(`Metadata server returned HTTP ${response.status}`);
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > this.config.metadataMaxDownloadBytes
      ) {
        throw new Error("Metadata download is larger than the configured limit");
      }
      if (!response.body) throw new Error("Metadata response has no body");
      const directory = await mkdtemp(join(tmpdir(), "flightmap-metadata-"));
      const downloadPath = join(directory, "metadata.download");
      let rowCount = 0;
      try {
        await pipeline(
          Readable.fromWeb(
            response.body as unknown as NodeReadableStream<Uint8Array>
          ),
          byteLimit(
            this.config.metadataMaxDownloadBytes,
            "Metadata download"
          ),
          createWriteStream(downloadPath, { flags: "wx", mode: 0o600 }),
          { signal: requestSignal }
        );
        rowCount = await this.replaceFromFile(downloadPath, {
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified")
        }, stopSignal);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      this.logger.info(
        { rowCount },
        "Aircraft metadata atomically replaced"
      );
      return { changed: true, rowCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!stopSignal.aborted) {
        await this.recordFailure(message).catch(() => undefined);
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async count(): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      "SELECT count(*) AS count FROM aircraft_metadata"
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async replaceFromFile(
    downloadPath: string,
    headers: MetadataImportState,
    stopSignal: AbortSignal = this.abortController.signal
  ): Promise<number> {
    const file = await open(downloadPath, "r");
    const signature = Buffer.alloc(2);
    await file.read(signature, 0, 2, 0);
    await file.close();
    const compressed = signature[0] === 0x1f && signature[1] === 0x8b;
    const sampleText = await previewText(downloadPath, compressed);
    const firstLine = sampleText.split(/\r?\n/, 1)[0] ?? "";
    const delimiter =
      (firstLine.match(/;/g)?.length ?? 0) >
      (firstLine.match(/,/g)?.length ?? 0)
        ? ";"
        : ",";

    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_907_182_027]);
      await client.query(`
        CREATE TEMP TABLE metadata_staging (
          LIKE aircraft_metadata
            INCLUDING DEFAULTS
            INCLUDING CONSTRAINTS
            INCLUDING INDEXES
        ) ON COMMIT DROP
      `);
      const parser = createParser({
        bom: true,
        delimiter,
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true
      });
      const source = createReadStream(downloadPath);
      const limiter = byteLimit(
        this.config.metadataMaxUncompressedBytes,
        "Uncompressed metadata"
      );
      const parsing = compressed
        ? pipeline(source, createGunzip(), limiter, parser, {
            signal: stopSignal
          })
        : pipeline(source, limiter, parser, { signal: stopSignal });
      void parsing.catch(() => undefined);

      let columns: Map<string, number> | null = null;
      let parsedRows = 0;
      let batch: MetadataRecord[] = [];
      const insertBatch = async (): Promise<void> => {
        if (batch.length === 0) return;
        stopSignal.throwIfAborted();
        const values = batch.map((row) => ({
          icao: row.icao,
          registration: row.registration,
          type_code: row.typeCode,
          description: row.description,
          operator: row.operator,
          owner: row.owner,
          country: row.country
        }));
        await client.query(
          `INSERT INTO metadata_staging (
             icao, registration, type_code, description, operator, owner, country
           )
           SELECT x.icao, x.registration, x.type_code, x.description,
                  x.operator, x.owner, x.country
           FROM jsonb_to_recordset($1::jsonb) AS x(
             icao text, registration text, type_code text, description text,
             operator text, owner text, country text
           )
           ON CONFLICT (icao) DO UPDATE SET
             registration = EXCLUDED.registration,
             type_code = EXCLUDED.type_code,
             description = EXCLUDED.description,
             operator = EXCLUDED.operator,
             owner = EXCLUDED.owner,
             country = EXCLUDED.country`,
          [JSON.stringify(values)]
        );
        batch = [];
      };
      try {
        for await (const value of parser) {
          stopSignal.throwIfAborted();
          const row = value as string[];
          if (!columns) {
            const detected = columnsFor(row);
            columns = detected.columns;
            if (detected.hasHeader) continue;
          }
          const record = recordFromRow(row, columns);
          if (!record) continue;
          parsedRows += 1;
          batch.push(record);
          if (batch.length >= 5_000) await insertBatch();
        }
        await parsing;
      } catch (error) {
        parser.destroy(error instanceof Error ? error : new Error(String(error)));
        await parsing.catch(() => undefined);
        throw error;
      }
      await insertBatch();
      const validated = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM metadata_staging"
      );
      const rowCount = Number(validated.rows[0]?.count ?? 0);
      if (
        parsedRows < this.config.metadataMinRows ||
        rowCount < this.config.metadataMinRows
      ) {
        throw new Error(
          `Metadata validation found ${rowCount} unique rows; expected at least ${this.config.metadataMinRows}`
        );
      }
      await client.query("TRUNCATE aircraft_metadata");
      await client.query(
        `INSERT INTO aircraft_metadata
         SELECT * FROM metadata_staging`
      );
      const sourceModified = headers.lastModified
        ? new Date(headers.lastModified)
        : null;
      await client.query(
        `INSERT INTO aircraft_metadata_import (
           id, source_url, etag, last_modified, source_modified_at,
           imported_at, last_checked_at, version, row_count, last_error
         ) VALUES (true, $1, $2, $3, $4, now(), now(), $5, $6, NULL)
         ON CONFLICT (id) DO UPDATE SET
           source_url = EXCLUDED.source_url,
           etag = EXCLUDED.etag,
           last_modified = EXCLUDED.last_modified,
           source_modified_at = EXCLUDED.source_modified_at,
           imported_at = EXCLUDED.imported_at,
           last_checked_at = EXCLUDED.last_checked_at,
           version = EXCLUDED.version,
           row_count = EXCLUDED.row_count,
           last_error = NULL`,
        [
          this.config.metadataUrl,
          headers.etag,
          headers.lastModified,
          sourceModified && !Number.isNaN(sourceModified.getTime())
            ? sourceModified
            : null,
          headers.etag ?? headers.lastModified ?? null,
          rowCount
        ]
      );
      return rowCount;
    });
  }

  private async recordFailure(message: string): Promise<void> {
    await this.database.query(
      `INSERT INTO aircraft_metadata_import (
         id, source_url, last_checked_at, last_error
       ) VALUES (true, $1, now(), $2)
       ON CONFLICT (id) DO UPDATE SET
         source_url = EXCLUDED.source_url,
         last_checked_at = now(),
         last_error = EXCLUDED.last_error`,
      [this.config.metadataUrl, message.slice(0, 2000)]
    );
    this.logger.warn({ error: message }, "Aircraft metadata refresh failed");
  }

  start(): void {
    if (this.started) return;
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
    this.started = true;
    const schedule = async (): Promise<void> => {
      this.activeRefresh = this.refresh();
      await this.activeRefresh.catch(() => undefined);
      this.activeRefresh = null;
      if (!this.started) return;
      this.timer = setTimeout(
        () => void schedule(),
        this.config.metadataCheckIntervalMs
      );
      this.timer.unref();
    };
    void schedule();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abortController.abort();
    if (this.activeRefresh) {
      await this.activeRefresh.catch(() => undefined);
    }
  }
}
