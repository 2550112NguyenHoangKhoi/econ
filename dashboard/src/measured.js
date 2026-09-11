// Formatting for values that may not exist yet.
//
// The recurring defect this exists to prevent: `(x || 0).toFixed(1)` renders a missing
// reading as a plausible figure -- 0.0 °C, 0.0 W, 0.000 kgCO2e -- on a channel whose label
// says it was measured. `||` and a numeric fallback cannot distinguish "absent" from
// "genuinely zero", and a dashboard that shows a fabricated zero is worse than one that
// shows nothing, because nothing is visibly missing and zero is not.
//
// This is CLAUDE.md rule 1 at the render layer: a modelled or absent value must never be
// presented the way a measured one is.

export const NO_VALUE = '—';

/** Fixed-decimal string, or NO_VALUE when there is no number to show. */
export function fx(value, digits = 1) {
  if (value == null) return NO_VALUE;
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : NO_VALUE;
}

/** True when a value is a real number worth presenting as a reading. */
export function hasReading(value) {
  return value != null && Number.isFinite(Number(value));
}
