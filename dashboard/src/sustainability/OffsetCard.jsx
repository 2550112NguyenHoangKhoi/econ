import React from 'react';
import { Coins, ExternalLink } from 'lucide-react';
import { S } from './styles';

// The carbon budget against cumulative emissions, and what closing the gap would cost at
// the live voluntary-market price. Every quote carries whether it is live: a fallback
// reference price must never be presented as a market observation.
export default function OffsetCard({
  carbonBudgetKgCO2e,
  overBudget,
  deficitKgCO2e,
  creditsNeededMetricTons,
  wholeCertificatesNeeded,
  estimatedCostUSD,
  marketQuote,
  alternativeQuotes,
  recommendation,
}) {
  return (
    <>
  {/* CARD 2: Carbon Budget & Live Market Offset Quote */}
  <div data-testid="card-carbon-offset" style={S.card}>
    <div style={S.cardHeader}>
      <h3 style={{ ...S.cardTitle, color: '#60a5fa' }}>
        <Coins size={15} />
        Carbon Budget & Live Market Quote
      </h3>
      <span
        data-testid="badge-budget-status"
        style={{
          ...S.badge,
          background: overBudget ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
          color: overBudget ? '#ef4444' : '#10b981',
          border: `1px solid ${overBudget ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)'}`,
        }}
      >
        {overBudget ? 'OVER BUDGET' : 'ON TRACK'}
      </span>
    </div>

    {/* Budget comparison */}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '12px' }}>
      <div>
        <div style={S.dimLabel}>Target Carbon Budget</div>
        <div data-testid="metric-carbon-budget" style={S.metricValue}>
          {carbonBudgetKgCO2e.toFixed(1)}{' '}
          <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kgCO2e</span>
        </div>
      </div>
      <div>
        <div style={S.dimLabel}>Carbon Deficit</div>
        <div
          data-testid="metric-carbon-deficit"
          style={{
            ...S.metricValue,
            color: overBudget ? '#ef4444' : '#10b981',
          }}
        >
          {deficitKgCO2e.toFixed(2)}{' '}
          <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kgCO2e</span>
        </div>
      </div>
    </div>

    {/* Live Market Quote Box */}
    <div
      style={{
        background: 'rgba(17, 24, 39, 0.8)',
        border: '1px solid rgba(55, 65, 81, 0.8)',
        borderRadius: '8px',
        padding: '12px',
        marginBottom: '12px',
      }}
    >
      <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
        Available Carbon Credit Sources
      </div>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {[marketQuote, ...alternativeQuotes].filter(Boolean).map((quote, idx) => (
          <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '6px', border: idx === 0 ? '1px solid rgba(52, 211, 153, 0.3)' : '1px solid transparent' }}>
            <div>
              <div style={{ color: '#60a5fa', fontWeight: '600', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {idx === 0 ? (
                  <a href="https://www.coingecko.com/en/coins/toucan-protocol-base-carbon-tonne" target="_blank" rel="noreferrer" style={{color: '#60a5fa', textDecoration: 'none'}}>{quote.source || 'Toucan Protocol BCT'} <ExternalLink size={10} /></a>
                ) : quote.url ? (
                  <a href={quote.url} target="_blank" rel="noreferrer" style={{color: '#60a5fa', textDecoration: 'none'}}>{quote.source || 'Market Quote'} <ExternalLink size={10} /></a>
                ) : (
                  (quote.source || 'Market Quote')
                )}
              </div>
              <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px', display: 'flex', gap: '6px' }}>
                <span
                  style={{
                    fontSize: '9px',
                    fontWeight: 'bold',
                    color: quote.isLive ? '#10b981' : '#f59e0b',
                    background: quote.isLive ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                  }}
                >
                  {quote.isLive ? '● LIVE' : '○ STATIC'}
                </span>
                <span>Updated: {quote.fetchedAt ? new Date(quote.fetchedAt).toLocaleTimeString() : 'N/A'}</span>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div
                data-testid="metric-market-spot-price"
                style={{ fontSize: '14px', fontWeight: 'bold', color: '#34d399', fontFamily: 'monospace' }}
              >
                ${(Number(quote.spotPricePerMetricTonUSD) || 0).toFixed(2)}
              </div>
              <div style={{ fontSize: '9px', color: '#94a3b8' }}>{quote.currency || 'USD'} / tCO2e</div>
            </div>
          </div>
        ))}
      </div>

      {/* Certificate purchase requirement */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: '12px',
          marginTop: '12px',
          borderTop: '1px dashed rgba(255,255,255,0.15)',
        }}
      >
        <div>
          <div style={S.dimLabel}>Required Certificates</div>
          <div data-testid="metric-certificates-needed" style={{ fontSize: '14px', fontWeight: 'bold' }}>
            {wholeCertificatesNeeded}{' '}
            <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'normal' }}>
              (~{creditsNeededMetricTons.toFixed(4)} MT)
            </span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={S.dimLabel}>Estimated Offset Cost (Best Price)</div>
          <div
            data-testid="metric-total-offset-cost"
            style={{ fontSize: '16px', fontWeight: 'bold', color: '#fbbf24', fontFamily: 'monospace' }}
          >
            ${estimatedCostUSD.toFixed(2)}{' '}
            <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'normal' }}>USD</span>
          </div>
        </div>
      </div>
    </div>

    {/* Recommendation Text */}
    <div
      data-testid="text-offset-recommendation"
      style={{
        background: 'rgba(30, 41, 59, 0.4)',
        borderLeft: `3px solid ${overBudget ? '#ef4444' : '#10b981'}`,
        padding: '8px 12px',
        borderRadius: '0 6px 6px 0',
        fontSize: '11px',
        color: '#e2e8f0',
        lineHeight: 1.4,
      }}
    >
      {recommendation}
    </div>

    {overBudget && (
      <div style={{ marginTop: '12px' }}>
        <a
          href="https://carboncredits.com/"
          target="_blank"
          rel="noreferrer"
          style={{
            ...S.btnAction,
            textDecoration: 'none',
            background: 'rgba(52, 211, 153, 0.1)',
            borderColor: 'rgba(52, 211, 153, 0.3)',
            color: '#34d399',
            display: 'flex',
            justifyContent: 'center',
            width: '100%',
          }}
        >
          <Coins size={13} style={{ marginRight: '4px' }} />
          View Carbon Credit Quotes & Alternatives <ExternalLink size={11} style={{ marginLeft: '2px' }} />
        </a>
      </div>
    )}
  </div>
    </>
  );
}
