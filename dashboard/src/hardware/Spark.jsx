import React from 'react';
import { S } from './shared';


/** Inline sparkline. No chart library: one <path>, and this module is meant to be deleted. */
export function Spark({ points, width = 520, height = 90 }) {
  if (!points || !Array.isArray(points) || points.length < 2) {
    return <div style={S.empty}>no history yet — needs a few samples</div>;
  }
  const vs = points.map((p) => (p && Number.isFinite(p.v) ? Number(p.v) : 0));
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const span = hi - lo || 1;
  const t0 = points[0]?.t ? new Date(points[0].t).getTime() : 0;
  const t1 = points[points.length - 1]?.t ? new Date(points[points.length - 1].t).getTime() : 1;
  const tspan = t1 - t0 || 1;
  const d = points
    .map((p, i) => {
      const pt = p?.t ? new Date(p.t).getTime() : t0;
      const pv = p && Number.isFinite(p.v) ? Number(p.v) : lo;
      const x = ((pt - t0) / tspan) * width;
      const y = height - ((pv - lo) / span) * (height - 8) - 4;
      return `${i ? 'L' : 'M'}${Number.isFinite(x) ? x.toFixed(1) : '0'},${Number.isFinite(y) ? y.toFixed(1) : '0'}`;
    })
    .join(' ');
  // Colour by provenance: measured rows are evidence, modelled rows are the simulation.
  const measured = points.filter((p) => p?.q === 'measured').length;
  const stroke = measured === points.length ? '#4ade80' : measured === 0 ? '#f59e0b' : '#60a5fa';
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block' }}
      >
        <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={S.sparkMeta}>
        <span>min {lo.toFixed(2)}</span>
        <span>max {hi.toFixed(2)}</span>
        <span>{points.length} pts</span>
        <span style={{ color: stroke }}>
          {measured === points.length ? 'all measured' : measured === 0 ? 'all modelled' : `${measured}/${points.length} measured`}
        </span>
      </div>
    </div>
  );
}
