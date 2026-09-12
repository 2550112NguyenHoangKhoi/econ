import React from 'react';

// RecommendationsEmptyState explains a blank list rather than leaving it blank.
//
// Nothing here is computed: every number is a count the engine sent, and if it sent none
// the component says only what it can stand behind. A reassuring "all clear" over an engine
// that is wired to nothing would be the most damaging sentence on this screen.
export default function RecommendationsEmptyState({ count, hardware, realMode }) {
  if (count > 0) return null;

  let headline = 'Nothing flagged right now';
  let detail = 'No signal is far enough from this building’s own learned normal to raise.';
  let tone = 'rgba(255,255,255,0.4)';

  if (realMode && hardware) {
    if (hardware.nodesOnline === 0) {
      headline = 'Nothing connected';
      detail = hardware.nodesBound > 0
        ? `${hardware.nodesBound} node${hardware.nodesBound === 1 ? ' is' : 's are'} bound but none is online. The engine is not measuring this building, so an empty list here says nothing about how it is running.`
        : 'No edge node has ever reported. The engine is running physics alone — an empty list here says nothing about how the building is running.';
      tone = 'var(--accent-yellow, #eab308)';
    } else if (hardware.acControlled === 0 && hardware.acMetered === 0 && hardware.co2Sensed === 0) {
      headline = 'Nothing this hardware can speak to';
      detail = `${hardware.nodesOnline} node${hardware.nodesOnline === 1 ? '' : 's'} online, but no zone has AC control, an AC clamp or a CO₂ sensor — so there is nothing the engine could raise a grounded recommendation about.`;
      tone = 'var(--accent-yellow, #eab308)';
    } else {
      detail = `Checked against the ${hardware.nodesOnline} node${hardware.nodesOnline === 1 ? '' : 's'} currently reporting. Recommendations are limited to what this hardware can actually carry out.`;
    }
  } else if (realMode) {
    detail = 'No signal is far enough from normal to raise. The engine has not reported what hardware it can reach.';
  }

  return (
    <div style={{
      border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px',
      padding: '14px', marginBottom: '12px', background: 'rgba(255,255,255,0.02)',
    }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: tone, marginBottom: '4px' }}>{headline}</div>
      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>{detail}</div>
    </div>
  );
}
