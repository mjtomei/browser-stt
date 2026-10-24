// Longer windows are experimental: validate at both ends of the worker bridge.
export function speechWindowSeconds(value = 15) {
  if (!Number.isFinite(value) || value < 2 || value > 60) throw new RangeError('Speech window must be between 2 and 60 seconds.');
  return value;
}
