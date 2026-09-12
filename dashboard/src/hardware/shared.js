
export const POLL_MS = 2000;

export const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';


// Field metadata: units, and which build flag puts the field on the wire. The flag is here
// because the single most common bring-up question is "why is this field missing" and the
// answer is usually that the firmware was not built with it, not that the sensor failed.
export const FIELDS = {
  temperature: { unit: '°C', flag: 'USE_SHT30 (or USE_DHT)' },
  humidity:    { unit: '%',  flag: 'USE_SHT30 (or USE_DHT)' },
  co2:         { unit: 'ppm', flag: 'USE_CO2' },
  occupancy:   { unit: '',   flag: 'USE_MMWAVE / USE_PIR' },
  occupancy_2: { unit: '',   flag: 'USE_MMWAVE / USE_PIR' },
  radar1:      { unit: '',   flag: 'USE_MMWAVE' },
  radar2:      { unit: '',   flag: 'MMWAVE2_PIN' },
  radar1_m:    { unit: 'm',  flag: 'USE_MMWAVE_UART' },
  radar2_m:    { unit: 'm',  flag: 'USE_MMWAVE2_UART' },
  plugW:       { unit: 'W',  flag: 'USE_PLUG' },
  circuitBreakerW: { unit: 'W', flag: 'USE_CB' },
  cbW:         { unit: 'W',  flag: 'USE_CB' },
  stripW:      { unit: 'W',  flag: 'USE_STRIP' },
  supplyC:     { unit: '°C', flag: 'USE_SUPPLY_TEMP' },
  acW:         { unit: 'W',  flag: 'USE_AC_CLAMP' },
  lux:         { unit: 'lx', flag: 'USE_LUX' },
};


export const fmt = (v, unit) =>
  v === null || v === undefined || Number.isNaN(+v) ? '—' : `${(+v).toFixed(2)}${unit ? ' ' + unit : ''}`;

export const ago = (s) => {
  if (s == null || Number.isNaN(+s) || s < 0) return '—';
  const num = +s;
  return num < 1 ? 'now' : num < 60 ? `${num.toFixed(0)}s` : `${(num / 60).toFixed(1)}m`;
};

export const safeTime = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
};

export const safeDateTime = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};


export const S = {
  page: { minHeight: '100vh', background: '#0b0f14', color: '#e5e7eb', fontFamily: mono, fontSize: 13, padding: 20 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: 16 },
  h1: { margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' },
  sub: { color: '#9ca3af', marginTop: 4, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  tempTag: { background: '#f59e0b22', color: '#f59e0b', border: '1px solid #f59e0b55', padding: '2px 8px', borderRadius: 3, fontSize: 11, letterSpacing: '0.04em' },
  counts: { display: 'flex', gap: 24, color: '#9ca3af' },
  tabs: { display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', borderBottom: '1px solid #1f2937', paddingBottom: 8, flexWrap: 'wrap' },
  tab: (on) => ({ background: on ? '#1f2937' : 'transparent', color: on ? '#e5e7eb' : '#9ca3af', border: '1px solid #1f2937', padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontFamily: mono, fontSize: 12 }),
  back: { marginLeft: 'auto', color: '#60a5fa', textDecoration: 'none', fontSize: 12 },
  card: { background: '#111827', border: '1px solid #1f2937', borderRadius: 4, padding: 14, marginBottom: 12, overflowX: 'auto' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  devId: { fontSize: 15, fontWeight: 700, marginRight: 10 },
  badge: (c) => ({ background: `${c}22`, color: c, border: `1px solid ${c}55`, padding: '1px 7px', borderRadius: 3, fontSize: 10, marginRight: 6, letterSpacing: '0.04em' }),
  dim: { color: '#9ca3af', fontSize: 12 },
  warn: { background: '#f59e0b11', border: '1px solid #f59e0b44', color: '#fbbf24', padding: '7px 10px', borderRadius: 3, marginBottom: 10, fontSize: 12, lineHeight: 1.5 },
  error: { background: '#ef444411', border: '1px solid #ef444444', color: '#fca5a5', padding: 12, borderRadius: 4, marginBottom: 12, lineHeight: 1.6 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', color: '#6b7280', fontWeight: 500, padding: '5px 8px', borderBottom: '1px solid #1f2937', whiteSpace: 'nowrap' },
  td: { padding: '5px 8px', borderBottom: '1px solid #161d29', whiteSpace: 'nowrap' },
  btn: (on) => ({ background: on ? '#374151' : 'transparent', color: on ? '#e5e7eb' : '#9ca3af', border: '1px solid #374151', padding: '2px 9px', borderRadius: 3, cursor: 'pointer', fontFamily: mono, fontSize: 11, marginLeft: 4 }),
  linkBtn: { background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontFamily: mono, fontSize: 11, padding: '8px 0 0', textDecoration: 'underline' },
  pre: { background: '#0b0f14', border: '1px solid #1f2937', borderRadius: 3, padding: 10, fontSize: 11, color: '#9ca3af', overflowX: 'auto', marginTop: 6 },
  chartBox: { marginTop: 12, padding: 10, background: '#0b0f14', border: '1px solid #1f2937', borderRadius: 3 },
  chartHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 },
  sparkMeta: { display: 'flex', gap: 16, color: '#6b7280', fontSize: 11, marginTop: 4, flexWrap: 'wrap' },
  empty: { color: '#6b7280', padding: 16, textAlign: 'center', lineHeight: 1.6 },
  totals: { display: 'flex', gap: 28, margin: '12px 0 16px', flexWrap: 'wrap' },
  total: { minWidth: 100 },
  input: { background: '#1f2937', color: '#e5e7eb', border: '1px solid #374151', padding: '6px 10px', borderRadius: 3, fontFamily: mono, fontSize: 12, flex: 1, outline: 'none' },
};
