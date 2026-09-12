import React, { useState, useEffect } from 'react';
import { API_BASE } from '../api';
import { S, safeTime } from './shared';


export function SustainabilityTab() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    const fetchSus = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/sustainability`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (alive) {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e.message);
      }
    };
    fetchSus();
    const interval = setInterval(fetchSus, 5000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  if (err) return <div style={S.error}>Error fetching sustainability data: {err}</div>;
  if (!data) return <div style={S.dim}>Loading sustainability data...</div>;

  const accounting = data?.carbonAccounting || {};
  // A measurement that has not arrived is not zero.
  //
  // These four read from an object that defaults to {} until /api/sustainability answers,
  // and every one of them was `(Number(x) || 0).toFixed(n)` -- so an empty payload rendered
  // as 0.0 W, 0.000 kgCO2e/h, 0.00 kg/kWh, 0.000 kgCO2e, in 24px bold, indistinguishable
  // from a building genuinely drawing nothing. `|| 0` cannot tell absent from zero, so this
  // tests for absence explicitly and leaves a dash where there is no number yet.
  const fx = (v, d) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));
  const recs = data?.carbonCreditRecommendations || {};
  const quote = recs?.marketQuote || {};
  const altQuotes = recs?.alternativeQuotes || [];
  const maint = data?.predictiveMaintenance || {};
  const warnings = maint?.warnings || [];
  const util = data?.spaceUtilization || {};
  const zones = util?.zones || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={S.card}>
        <h2 style={{marginTop: 0, color: '#4ade80'}}>Scope 2 Carbon Accounting</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
          <div>
            <div style={S.dim}>Instantaneous Power</div>
            <div style={{fontSize: 24, fontWeight: 'bold'}}>{fx(accounting.instantaneousPowerW, 1)} W</div>
          </div>
          <div>
            <div style={S.dim}>Emission Rate</div>
            <div style={{fontSize: 24, fontWeight: 'bold'}}>{fx(accounting.instantaneousEmissionRateKgPerHour, 3)} kgCO2e/h</div>
          </div>
          <div>
            <div style={S.dim}>Grid Factor</div>
            <div style={{fontSize: 24, fontWeight: 'bold'}}>{fx(accounting.gridEmissionFactorKgPerKwh, 2)} kg/kWh</div>
          </div>
          <div>
            <div style={S.dim}>Cumulative Emissions</div>
            <div style={{fontSize: 24, fontWeight: 'bold'}}>{fx(accounting.cumulativeEmissionsKgCO2e, 3)} kgCO2e</div>
          </div>
        </div>
      </div>

      <div style={S.card}>
        <h2 style={{marginTop: 0, color: '#60a5fa'}}>Carbon Credit Recommendations (Live Market)</h2>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
          <div style={{ flex: 1, minWidth: '300px' }}>
            <div style={{marginBottom: 8}}><strong>Status:</strong> {recs.recommendation || 'Balanced'}</div>
            {recs.overBudget && (
              <>
                <div style={{color: '#f87171', marginBottom: 4}}>Deficit: {(Number(recs.deficitKgCO2e) || 0).toFixed(2)} kgCO2e</div>
                <div style={{marginBottom: 4}}>Credits Needed: {recs.wholeCertificatesNeeded ?? 0} (approx {(Number(recs.creditsNeededMetricTons) || 0).toFixed(3)} MT)</div>
                <div style={{color: '#fbbf24', fontSize: 18, fontWeight: 'bold', marginTop: 8}}>Estimated Cost: ${(Number(recs.estimatedCostUSD) || 0).toFixed(2)}</div>
              </>
            )}
          </div>
          <div style={{ flex: 1, minWidth: '300px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{textAlign: 'right', background: '#111827', padding: '12px', borderRadius: '4px', border: '1px solid #374151'}}>
              <div style={{fontSize: 10, color: '#9ca3af', textTransform: 'uppercase'}}>Live Quote Source</div>
              <div style={{fontWeight: 'bold'}}>
                <a href="https://www.coingecko.com/en/coins/toucan-protocol-base-carbon-tonne" target="_blank" rel="noreferrer" style={{color: '#60a5fa', textDecoration: 'none'}}>
                  {quote.source || 'Toucan Protocol Base Carbon Tonne'}
                </a>
              </div>
              <div style={{color: '#4ade80', fontSize: 18}}>${(Number(quote.spotPricePerMetricTonUSD) || 0).toFixed(6)} / MT</div>
              <div style={{fontSize: 10, color: '#9ca3af', marginTop: 4}}>Updated: {safeTime(quote.fetchedAt)}</div>
            </div>
            
            {altQuotes.length > 0 && (
              <div style={{background: '#111827', padding: '12px', borderRadius: '4px', border: '1px solid #374151'}}>
                <div style={{fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', marginBottom: '8px'}}>Alternative Market Quotes</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {altQuotes.map((alt, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', background: 'rgba(255,255,255,0.03)', padding: '6px 10px', borderRadius: '4px' }}>
                      <span style={{ color: '#60a5fa', fontWeight: '600' }}>{alt.source}</span>
                      <div style={{ fontWeight: 'bold', color: '#34d399', fontFamily: 'monospace', fontSize: '12px' }}>
                        ${(Number(alt.spotPricePerMetricTonUSD) || 0).toFixed(2)} <span style={{ fontSize: '9px', color: '#9ca3af', fontWeight: 'normal' }}>{alt.currency || 'USD'} / tCO2e</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <div style={S.card}>
          <h2 style={{marginTop: 0, color: '#fbbf24'}}>Predictive Maintenance</h2>
          {(maint.activeAlertsCount ?? 0) === 0 ? (
            <div style={{color: '#4ade80'}}>All systems operating within normal parameters.</div>
          ) : (
            <div style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
              {warnings.map((w, i) => (
                <div key={i} style={{background: '#7f1d1d30', border: '1px solid #ef444450', padding: '8px', borderRadius: '4px'}}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start'}}>
                    <div style={{color: '#f87171', fontWeight: 'bold', fontSize: 11, marginBottom: 4}}>[{(w.type || '').toUpperCase()}] {w.equipmentId}</div>
                    <div style={{fontSize: 10, color: '#9ca3af'}}>Health: <b style={{color: '#e5e7eb'}}>{w.healthScore !== undefined ? `${w.healthScore}%` : 'N/A'}</b></div>
                  </div>
                  <div style={{fontSize: 12}}>{w.message}</div>
                  {w.troubleshooting && w.troubleshooting.length > 0 && (
                    <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(239, 68, 68, 0.2)' }}>
                      <div style={{ fontSize: '10px', color: '#fca5a5', fontWeight: 'bold', marginBottom: '4px' }}>Recommended Troubleshooting:</div>
                      <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '10px', color: '#fecaca' }}>
                        {w.troubleshooting.map((step, j) => (
                          <li key={j}>{step}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={S.card}>
          <h2 style={{marginTop: 0, color: '#a78bfa'}}>Space Utilization</h2>
          <div style={{marginBottom: 12}}>
            <span style={{fontSize: 24, fontWeight: 'bold'}}>{(Number(util.overallEfficiencyPercent) || 0).toFixed(1)}%</span>
            <span style={S.dim}> Overall Efficiency</span>
          </div>
          <table style={{width: '100%', borderCollapse: 'collapse'}}>
            <thead>
              <tr>
                <th style={S.th}>Zone</th>
                <th style={S.th}>Occupants</th>
                <th style={S.th}>Capacity</th>
                <th style={S.th}>Efficiency</th>
              </tr>
            </thead>
            <tbody>
              {zones.map((z, i) => {
                const eff = Number(z.efficiencyPercent) || 0;
                return (
                  <tr key={i}>
                    <td style={S.td}>{z.zoneId}</td>
                    <td style={S.td}>{z.liveOccupants ?? 0}</td>
                    <td style={S.td}>{z.designCapacity ?? 0}</td>
                    <td style={S.td}>
                      <span style={{color: eff > 100 ? '#f87171' : eff > 50 ? '#4ade80' : '#fbbf24'}}>
                        {eff.toFixed(0)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
