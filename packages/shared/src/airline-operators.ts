/**
 * Common ICAO three-letter operator designators observed by UK receivers.
 *
 * The list is deliberately bundled so callsign enrichment remains available
 * on offline installations. Names are user-facing airline brands rather than
 * registered-company names.
 */
export const airlineOperators = {
  AAL: "American Airlines",
  ACA: "Air Canada",
  AEE: "Aegean Airlines",
  AEA: "Air Europa",
  AFR: "Air France",
  AIC: "Air India",
  AMX: "Aeromexico",
  ANZ: "Air New Zealand",
  ASA: "Alaska Airlines",
  AUA: "Austrian Airlines",
  AUR: "Aurigny",
  AVA: "Avianca",
  AWC: "Titan Airways",
  BAW: "British Airways",
  BCS: "DHL",
  BEL: "Brussels Airlines",
  BTI: "airBaltic",
  BZE: "Eastern Airways",
  CCA: "Air China",
  CFE: "BA CityFlyer",
  CES: "China Eastern Airlines",
  CFG: "Condor",
  CLX: "Cargolux",
  CPA: "Cathay Pacific",
  CSN: "China Southern Airlines",
  DAL: "Delta Air Lines",
  DHK: "DHL Air",
  DLA: "Air Dolomiti",
  DLH: "Lufthansa",
  EAI: "Emerald Airlines",
  EIN: "Aer Lingus",
  EJU: "easyJet Europe",
  ELY: "El Al",
  ETD: "Etihad Airways",
  ETH: "Ethiopian Airlines",
  EUK: "Aer Lingus UK",
  EWG: "Eurowings",
  EXS: "Jet2.com",
  EZS: "easyJet Switzerland",
  EZY: "easyJet",
  FDB: "flydubai",
  FDX: "FedEx Express",
  FIN: "Finnair",
  FLJ: "Flexjet",
  GEC: "Lufthansa Cargo",
  GFA: "Gulf Air",
  GMA: "Gama Aviation",
  GTI: "Atlas Air",
  HGO: "One Air",
  IBE: "Iberia",
  IBS: "Iberia Express",
  ICE: "Icelandair",
  IGO: "IndiGo",
  ITY: "ITA Airways",
  JAL: "Japan Airlines",
  JBU: "JetBlue",
  KAC: "Kuwait Airways",
  KAL: "Korean Air",
  KLM: "KLM",
  KQA: "Kenya Airways",
  LAN: "LATAM Airlines Chile",
  LOG: "Loganair",
  LOT: "LOT Polish Airlines",
  MAS: "Malaysia Airlines",
  MSR: "EgyptAir",
  NBT: "Norse Atlantic Airways",
  NOZ: "Norwegian",
  NPT: "West Atlantic UK",
  NSZ: "Norwegian Air Sweden",
  OMA: "Oman Air",
  PGT: "Pegasus Airlines",
  PIA: "Pakistan International Airlines",
  QFA: "Qantas",
  QTR: "Qatar Airways",
  RAM: "Royal Air Maroc",
  RJA: "Royal Jordanian",
  ROT: "TAROM",
  RUK: "Ryanair UK",
  RYR: "Ryanair",
  SAS: "SAS",
  SHT: "British Airways",
  SIA: "Singapore Airlines",
  SVA: "Saudia",
  SWR: "Swiss International Air Lines",
  SXS: "SunExpress",
  TAP: "TAP Air Portugal",
  TFL: "TUI fly Netherlands",
  THA: "Thai Airways",
  THY: "Turkish Airlines",
  TOM: "TUI Airways",
  TRA: "Transavia",
  TUI: "TUI fly",
  TVF: "Transavia France",
  UAE: "Emirates",
  UAL: "United Airlines",
  UBT: "Norse Atlantic UK",
  UPS: "UPS Airlines",
  VIR: "Virgin Atlantic",
  VLG: "Vueling",
  VOE: "Volotea",
  WAZ: "Wizz Air Abu Dhabi",
  WIF: "Wideroe",
  WMT: "Wizz Air Malta",
  WUK: "Wizz Air UK",
  WZZ: "Wizz Air",
  XMS: "British Airways"
} as const satisfies Readonly<Record<string, string>>;

export type AirlineOperatorMatch = {
  designator: string;
  operator: string;
};

export const airlineOperatorRows: readonly AirlineOperatorMatch[] =
  Object.entries(airlineOperators).map(([designator, operator]) => ({
    designator,
    operator
  }));

export function airlineOperatorFromCallsign(
  value: string | null | undefined
): AirlineOperatorMatch | null {
  const callsign = value?.trim().toUpperCase();
  const designator = callsign?.match(/^([A-Z]{3})[0-9][A-Z0-9]{0,4}$/)?.[1];
  if (!designator) return null;
  const operator = airlineOperators[designator as keyof typeof airlineOperators];
  return operator ? { designator, operator } : null;
}
