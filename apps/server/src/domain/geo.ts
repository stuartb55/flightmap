const EARTH_RADIUS_NM = 3440.065;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function normaliseBearing(degrees: number): number {
  return (degrees + 360) % 360;
}

export type RangeAndBearing = {
  distanceNm: number;
  bearingDeg: number;
};

export function calculateRangeAndBearing(
  receiverLatitude: number,
  receiverLongitude: number,
  aircraftLatitude: number,
  aircraftLongitude: number
): RangeAndBearing {
  const receiverLatRad = toRadians(receiverLatitude);
  const aircraftLatRad = toRadians(aircraftLatitude);
  const latitudeDelta = toRadians(aircraftLatitude - receiverLatitude);
  const longitudeDelta = toRadians(aircraftLongitude - receiverLongitude);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(receiverLatRad) *
      Math.cos(aircraftLatRad) *
      Math.sin(longitudeDelta / 2) ** 2;
  const angularDistance =
    2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

  const y = Math.sin(longitudeDelta) * Math.cos(aircraftLatRad);
  const x =
    Math.cos(receiverLatRad) * Math.sin(aircraftLatRad) -
    Math.sin(receiverLatRad) *
      Math.cos(aircraftLatRad) *
      Math.cos(longitudeDelta);

  return {
    distanceNm: angularDistance * EARTH_RADIUS_NM,
    bearingDeg: normaliseBearing((Math.atan2(y, x) * 180) / Math.PI)
  };
}
