import type { AlertRule, LiveAircraft } from "@flightmap/shared";

export type AlertCandidate = {
  rule: AlertRule;
  state: string | null;
  message: string;
  dedupeKey: string;
};

export type AlertEvaluationContext = {
  watched: boolean;
  /**
   * A session UUID when positioned, otherwise a stable encounter identifier.
   */
  encounterKey: string;
};

const emergencySquawks = new Set(["7500", "7600", "7700"]);

export const activeAircraftAlertRules = [
  "emergency_squawk",
  "emergency_state",
  "watchlist"
] as const satisfies readonly AlertRule[];

export function isActiveAircraftAlert(rule: AlertRule): boolean {
  return activeAircraftAlertRules.some((activeRule) => activeRule === rule);
}

export function evaluateAlerts(
  aircraft: Pick<LiveAircraft, "icao" | "callsign" | "squawk" | "emergency">,
  context: AlertEvaluationContext
): AlertCandidate[] {
  const candidates: AlertCandidate[] = [];
  const identity = aircraft.callsign
    ? `${aircraft.callsign} (${aircraft.icao})`
    : aircraft.icao;

  if (aircraft.squawk && emergencySquawks.has(aircraft.squawk)) {
    candidates.push({
      rule: "emergency_squawk",
      state: aircraft.squawk,
      message: `${identity} is squawking ${aircraft.squawk}`,
      dedupeKey: `${context.encounterKey}:emergency_squawk`
    });
  }

  if (
    aircraft.emergency &&
    !["none", "no emergency", "no_emergency"].includes(aircraft.emergency)
  ) {
    candidates.push({
      rule: "emergency_state",
      state: aircraft.emergency,
      message: `${identity} reports emergency state ${aircraft.emergency}`,
      dedupeKey: `${context.encounterKey}:emergency_state:${aircraft.emergency}`
    });
  }

  if (context.watched) {
    candidates.push({
      rule: "watchlist",
      state: null,
      message: `Watchlisted aircraft ${identity} is active`,
      dedupeKey: `${context.encounterKey}:watchlist`
    });
  }

  return candidates;
}
