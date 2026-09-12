
// badgeTone keeps the three kinds of judgement visually distinct on a small screen: a
// forecast must never read like a present-tense measurement.
export function badgeTone(badge) {
  if (!badge) return 'rgba(255,255,255,0.5)';
  if (badge.startsWith('PREDICTED')) return '#E2B04A';
  if (badge === 'CAPABILITY') return '#E2574A';
  if (badge === 'LEARNED') return '#4A90E2';
  return 'rgba(255,255,255,0.5)';
}
