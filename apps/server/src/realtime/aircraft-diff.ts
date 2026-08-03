import type { LiveAircraft } from "@flightmap/shared";

/**
 * Suppresses aircraft whose payload is byte-identical to the previous
 * snapshot so a live delta only carries rows a client would actually apply.
 *
 * The comparison state is rebuilt from each snapshot, so aircraft that drop
 * out of the receiver feed are forgotten without a separate eviction pass.
 */
export class LiveAircraftDiff {
  private previous = new Map<string, string>();

  changed(aircraft: LiveAircraft[]): LiveAircraft[] {
    const next = new Map<string, string>();
    const changed: LiveAircraft[] = [];
    for (const item of aircraft) {
      const encoded = JSON.stringify(item);
      if (this.previous.get(item.icao) !== encoded) changed.push(item);
      next.set(item.icao, encoded);
    }
    this.previous = next;
    return changed;
  }

  reset(): void {
    this.previous = new Map();
  }
}
