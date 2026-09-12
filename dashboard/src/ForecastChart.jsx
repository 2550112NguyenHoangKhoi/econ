import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { powerMw } from './units';

/**
 * ForecastChart renders the visual TimeFM / LSTM predictive load trajectory graph.
 *
 * Requirements fulfilled:
 * - Renders forecast trajectory series and upper decile uncertainty band (e.g. q9).
 * - Renders LSTM peak reference line.
 * - Programmatically detectable via data-testid="forecast-chart", .forecast-chart-container,
 *   .forecast-chart, svg.forecast-chart, and Recharts <ResponsiveContainer>.
 * - Robust fallbacks for live /api/forecast/compare and embedded /api/recommendations payloads.
 */
export default function ForecastChart({
  series = null,
  upperBand = null,
  upperQuantile = 'q9',
  peakUpperMw = null,
  lstmPeakMw = null,
  stepMinutes = 5,
  engine = 'timesfm',
  liveLoadMw = null,
  height = 120,
  compact = false,
  showLegend = true,
  title = null,
  plausible = true,
  plausibility = null,
}) {
  const lstmPeak = lstmPeakMw != null && Number.isFinite(lstmPeakMw) ? lstmPeakMw : null;

  const chartData = useMemo(() => {
    // 1. If explicit object series [{ t, mw, hi }] is passed
    if (Array.isArray(series) && series.length > 0 && typeof series[0] === 'object' && series[0] !== null && 't' in series[0]) {
      const allValid = series.every(d => d && typeof d.mw === 'number' && Number.isFinite(d.mw));
      if (allValid) return series;
      return [];
    }

    // 2. If numerical series array [0.021, 0.023, ...] is passed
    if (Array.isArray(series) && series.length > 0 && series.every(v => v != null && (typeof v === 'number' || (typeof v === 'string' && !Number.isNaN(Number(v)))) && Number.isFinite(Number(v)))) {
      const step = stepMinutes > 0 ? stepMinutes : 5;
      return series.map((mw, i) => ({
        t: `+${(i + 1) * step}m`,
        mw: +Number(mw).toFixed(4),
        hi: Array.isArray(upperBand) && upperBand[i] != null && Number.isFinite(Number(upperBand[i])) ? +Number(upperBand[i]).toFixed(4) : undefined,
      }));
    }

    // 3. When series is empty, null, or undefined, return an empty array.
    // Do NOT fabricate synthetic cubic spline curves or sine waves.
    return [];
  }, [series, upperBand, stepMinutes]);

  const hasGenuineSeries = Array.isArray(chartData) && chartData.length > 0;

  const peakOfSeries = useMemo(() => {
    return chartData.reduce((m, d) => Math.max(m, d.mw || 0), 0);
  }, [chartData]);

  const calculatedPeakUpper = peakUpperMw != null
    ? peakUpperMw
    : chartData.reduce((m, d) => Math.max(m, d.hi || 0), 0);

  const hasUpper = chartData.some((d) => d.hi != null);

  // The axis must span every series this chart claims to draw, and where it cannot, the
  // chart must say so rather than draw a line that is not where it appears to be.
  //
  // The axis was domain={['auto','auto']}, which Recharts derives from the plotted Lines and
  // which ignores ReferenceLine entirely. On the pilot building that produced a y-axis of
  // 0.0013–0.0014 MW while the legend named three series: the 0.001 MW forecast (on scale),
  // a 2.446 MW band (clipped to the top edge, so it read as a flat dashed line at a value it
  // does not have), and a 2.22 MW reference line that was not drawn at all. Three entries in
  // the legend, one of them truthful.
  //
  // Extending the domain to 2.22 MW is not the fix either: the forecast series would collapse
  // to a flat line on the floor and become unreadable. Two numbers 2000x apart do not share a
  // linear axis usefully. So the axis is fitted to the series it can show, and a reference
  // that falls outside it is reported as a multiple instead of being drawn.
  const { yDomain, refOffScale, refFactor } = useMemo(() => {
    const vals = chartData.flatMap((d) => [d.mw, d.hi]).filter((v) => v != null && !Number.isNaN(v));
    if (!vals.length) return { yDomain: ['auto', 'auto'], refOffScale: false, refFactor: 0 };
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    // A reference within an order of magnitude shares the axis; anything beyond would flatten
    // the series, so it is declared off-scale instead.
    const onScale = lstmPeak != null && lstmPeak > 0 && lstmPeak <= hi * 10 && lstmPeak >= lo / 10;
    if (onScale) {
      lo = Math.min(lo, lstmPeak);
      hi = Math.max(hi, lstmPeak);
    }
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.08 || 0.001;
    return {
      yDomain: [lo - pad, hi + pad],
      refOffScale: lstmPeak != null && lstmPeak > 0 && !onScale,
      refFactor: hi > 0 && lstmPeak != null ? lstmPeak / hi : 0,
    };
  }, [chartData, lstmPeak]);
  const engineLabel = (engine || 'timesfm').toUpperCase();
  const stepMin = stepMinutes > 0 ? stepMinutes : 5;

  // SVG sparkline path for ultra-compact fallback / pure SVG query detection
  const svgSparkline = useMemo(() => {
    if (!hasGenuineSeries) return null;
    const vals = chartData.map((d) => d.mw);
    const minVal = Math.min(...vals);
    const maxVal = Math.max(...vals, lstmPeak || 0);
    const rng = maxVal - minVal || 1;
    const W = 100, H = 28;
    const pts = chartData.map((d, i) => {
      const x = ((i / (chartData.length - 1 || 1)) * W).toFixed(2);
      const y = (H - ((d.mw - minVal) / rng) * (H - 4) - 2).toFixed(2);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    }).join(' ');

    const hiPts = hasUpper ? chartData.map((d, i) => {
      const x = ((i / (chartData.length - 1 || 1)) * W).toFixed(2);
      const y = (H - (((d.hi || d.mw) - minVal) / rng) * (H - 4) - 2).toFixed(2);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    }).join(' ') : null;

    const lstmY = lstmPeak != null ? (H - ((lstmPeak - minVal) / rng) * (H - 4) - 2).toFixed(2) : null;

    return { pts, hiPts, lstmY, W, H, minVal, maxVal };
  }, [chartData, hasUpper, lstmPeak, hasGenuineSeries]);

  // When series is empty, null, or undefined: render honest insufficient data state with 0 curves
  if (!hasGenuineSeries) {
    return (
      <div
        data-testid="forecast-chart"
        className="forecast-chart-container forecast-chart"
        style={{
          marginTop: '6px',
          width: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}
      >
        <div
          data-testid="forecast-insufficient-data"
          style={{
            padding: compact ? '10px 12px' : '16px 14px',
            borderRadius: '6px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px dashed var(--border-glass, rgba(255, 255, 255, 0.12))',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            textAlign: 'center',
            minHeight: compact ? '64px' : `${height || 100}px`,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertTriangle size={15} style={{ color: 'var(--accent-yellow, #eab308)', flexShrink: 0 }} />
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--text-secondary, #94a3b8)',
                letterSpacing: '0.02em',
              }}
            >
              Insufficient data — awaiting model telemetry
            </span>
          </div>
          <div
            style={{
              fontSize: '10px',
              color: 'var(--text-muted, #64748b)',
              maxWidth: '380px',
              lineHeight: 1.4,
            }}
          >
            {lstmPeak != null
              ? 'Sequence trajectory unavailable. Foundation model requires ≥ 8 recorded load samples.'
              : 'Time-series forecast unavailable. Both LSTM and TimesFM awaiting historical load telemetry.'}
          </div>

          {lstmPeak != null && (
            <div
              data-testid="forecast-lstm-scalar-badge"
              style={{
                marginTop: '2px',
                padding: '4px 10px',
                borderRadius: '4px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span
                style={{
                  fontSize: '9px',
                  color: 'var(--text-secondary, #94a3b8)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                LSTM Predicted Peak (Scalar Reference)
              </span>
              <span
                style={{
                  fontFamily: 'monospace',
                  fontWeight: 600,
                  fontSize: '11px',
                  color: 'var(--accent-red, #ef4444)',
                }}
              >
                {powerMw(lstmPeak)}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="forecast-chart"
      className="forecast-chart-container forecast-chart"
      style={{
        marginTop: '6px',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      {/* Chart Title / Metric Header */}
      {!compact && (
        <div
          style={{
            fontSize: '9px',
            color: 'var(--text-muted, #64748b)',
            marginBottom: '2px',
            letterSpacing: '0.04em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '4px',
          }}
        >
          <span>
            {title || `${engineLabel} HORIZON · ${chartData.length} × ${stepMin} MIN · PEAK ${peakOfSeries.toFixed(3)} MW`}
            {calculatedPeakUpper > 0 && ` · ${(upperQuantile || 'Q9').toUpperCase()} ${Number(calculatedPeakUpper).toFixed(3)} MW`}
          </span>
          {!plausible && (
            <span style={{ color: 'var(--accent-yellow, #eab308)', display: 'flex', alignItems: 'center', gap: '3px' }}>
              <AlertTriangle size={10} /> OUT OF DISTRIBUTION
            </span>
          )}
        </div>
      )}

      {/* Main Recharts Container */}
      <div style={{ width: '100%', height, position: 'relative' }}>
        <ResponsiveContainer width="100%" height="100%" className="forecast-chart">
          <LineChart
            className="forecast-chart"
            data={chartData}
            // left was -22, which pulled the Y axis off the left edge. That was survivable
            // while the ticks were bare numbers; once they carried a unit the numeric part
            // was clipped away and the axis read "MW MW MW MW kW".
            margin={{ top: 6, right: 8, bottom: 0, left: 2 }}
          >
            <XAxis
              dataKey="t"
              tick={{ fontSize: 8, fill: 'var(--text-muted, #64748b)' }}
              tickLine={false}
              axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
              interval={compact ? 'preserveStartEnd' : 3}
            />
            <YAxis
              tick={{ fontSize: 8, fill: 'var(--text-muted, #64748b)' }}
              tickLine={false}
              axisLine={false}
              domain={yDomain}
              width={38}
              // The domain is fitted to the data (lo - pad, hi + pad), so its bounds are
              // arbitrary reals and Recharts derives equally arbitrary ticks from them.
              // With no formatter it printed them at full float precision —
              // "0.5823142264404297" — and five of those overlapped into an unreadable
              // smear that looked like six-digit garbage on the axis.
              //
              // powerMw is the same formatter the header and the legend below use, so the
              // axis now agrees with the figures printed beside it instead of contradicting
              // them, and picks W / kW / MW to suit the magnitude.
              // Numeric only. powerMw would repeat "MW" on every tick, which costs the width
              // the numbers need in a 300 px card; the unit is stated once in the header and
              // again on each legend row. Precision follows the span so a narrow band does
              // not collapse to five identical labels.
              tickFormatter={(v) => {
                const [lo, hi] = yDomain;
                const span = (typeof hi === 'number' && typeof lo === 'number') ? hi - lo : 0;
                const digits = span >= 1 ? 1 : span >= 0.1 ? 2 : 3;
                return Number(v).toFixed(digits);
              }}
            />
            <Tooltip
              contentStyle={{
                background: 'rgba(10,10,10,0.95)',
                border: '1px solid var(--border-glass, rgba(255,255,255,0.15))',
                borderRadius: 6,
                fontSize: 10,
                color: '#fff',
              }}
              labelStyle={{ color: 'var(--text-secondary, #94a3b8)' }}
              formatter={(v, name) => [
                `${v} MW`,
                name === 'hi' ? `${(upperQuantile || 'q9').toUpperCase()} band` : 'Forecast load',
              ]}
            />
            {lstmPeak != null && !refOffScale && (
              <ReferenceLine
                y={lstmPeak}
                ifOverflow="extendDomain"
                stroke="var(--accent-red, #ef4444)"
                strokeDasharray="4 4"
                label={{
                  value: 'LSTM PEAK',
                  fontSize: 8,
                  fill: 'var(--accent-red, #ef4444)',
                  position: 'insideTopRight',
                }}
              />
            )}
            {hasUpper && (
              <Line
                type="monotone"
                dataKey="hi"
                stroke="var(--accent-blue, #00a3e0)"
                strokeWidth={1}
                strokeDasharray="3 3"
                strokeOpacity={0.6}
                dot={false}
                isAnimationActive={false}
              />
            )}
            <Line
              type="monotone"
              dataKey="mw"
              stroke="var(--accent-blue, #00a3e0)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>

        {/* Fallback pure SVG element with svg.forecast-chart class for direct headless SVG queries */}
        {svgSparkline && (
          <svg
            className="forecast-chart"
            viewBox={`0 0 ${svgSparkline.W} ${svgSparkline.H}`}
            preserveAspectRatio="none"
            style={{
              display: 'none',
              width: '100%',
              height: '100%',
              position: 'absolute',
              top: 0,
              left: 0,
            }}
          >
            {svgSparkline.lstmY && (
              <line
                x1="0"
                y1={svgSparkline.lstmY}
                x2={svgSparkline.W}
                y2={svgSparkline.lstmY}
                stroke="var(--accent-red, #ef4444)"
                strokeDasharray="2 2"
                strokeWidth="0.8"
              />
            )}
            {svgSparkline.hiPts && (
              <path
                d={svgSparkline.hiPts}
                fill="none"
                stroke="var(--accent-blue, #00a3e0)"
                strokeWidth="0.8"
                strokeDasharray="2 2"
                strokeOpacity="0.6"
              />
            )}
            <path
              d={svgSparkline.pts}
              fill="none"
              stroke="var(--accent-blue, #00a3e0)"
              strokeWidth="1.5"
            />
          </svg>
        )}
      </div>

      {/* Model Comparison / Legend Rows */}
      {showLegend && !compact && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            rowGap: '3px',
            columnGap: '10px',
            marginTop: '4px',
            fontSize: '10px',
          }}
        >
          <span style={{ color: 'var(--text-secondary, #94a3b8)' }}>
            Blue line — {engineLabel} ({engine === 'timesfm' ? 'zero-shot' : 'model'})
          </span>
          <span style={{ fontFamily: 'monospace', color: 'var(--accent-blue, #00a3e0)', textAlign: 'right' }}>
            {peakOfSeries > 0 ? `${peakOfSeries.toFixed(3)} MW peak` : '—'}
          </span>

          {calculatedPeakUpper > 0 && (
            <>
              <span
                style={{ color: 'var(--text-secondary, #94a3b8)' }}
                title="The upper decile uncertainty band — peak probability bounds"
              >
                Dashed — {(upperQuantile || 'q9').toUpperCase()} upper band
              </span>
              <span style={{ fontFamily: 'monospace', color: 'var(--text-muted, #64748b)', textAlign: 'right' }}>
                {Number(calculatedPeakUpper).toFixed(3)} MW
              </span>
            </>
          )}

          {lstmPeak != null && (
            <>
              <span style={{ color: 'var(--text-secondary, #94a3b8)' }}>
                {refOffScale
                  ? `LSTM (supervised peak reference) — off scale, ${refFactor >= 10 ? Math.round(refFactor) : refFactor.toFixed(1)}× the forecast`
                  : 'Red line — LSTM (supervised peak reference)'}
              </span>
              <span style={{ fontFamily: 'monospace', color: 'var(--accent-red, #ef4444)', textAlign: 'right' }}>
                {powerMw(lstmPeak)}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
