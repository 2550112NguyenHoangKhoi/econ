import React from 'react';
import { Radio } from 'lucide-react';

// How much of the building the twin can actually act on: nodes reporting, nodes reachable,
// and how many of the current recommendations land on a zone with hardware behind it.
export default function HardwareReachCard({ hardware, realMode, recommendationCount = 0 }) {
  if (!hardware) return null;
  const { zones = 0, nodesBound = 0, nodesOnline = 0, acControlled = 0, acUnknown = 0, acMetered = 0, co2Sensed = 0 } = hardware;

  const rows = [
    ['Zones modelled', zones, null,
      'Every zone in the building fixture. The denominator for everything below.'],
    ['Edge nodes bound', nodesBound, nodesBound > 0 ? 'var(--accent-green)' : 'var(--accent-yellow)',
      'Zones a physical node has reported from at least once.'],
    ['Nodes online now', nodesOnline, nodesOnline === nodesBound && nodesBound > 0 ? 'var(--accent-green)' : nodesOnline > 0 ? 'var(--accent-yellow)' : 'var(--accent-red)',
      "Bound nodes the broker's last-will still considers alive. Commands to the rest go nowhere."],
    ['AC control confirmed', acControlled, acControlled > 0 ? 'var(--accent-green)' : 'var(--text-muted)',
      'Nodes that have positively reported their IR commands reach an air conditioner. Only these zones can be told to switch one off.'],
    ['AC control unreported', acUnknown, acUnknown > 0 ? 'var(--accent-yellow)' : null,
      'Bound nodes that have never said either way. Unknown is not the same as absent, and neither is evidence an AC is running — so no turn-off advice is offered for these.'],
    ['AC power metered', acMetered, acMetered > 0 ? 'var(--accent-green)' : 'var(--text-muted)',
      'Zones with a live clamp on the AC circuit. This is the only measurement that settles whether a compressor is actually drawing.'],
    ['CO₂ sensed', co2Sensed, co2Sensed > 0 ? 'var(--accent-green)' : 'var(--text-muted)',
      'Zones with a fresh NDIR reading. Ventilation findings are raised only for these.'],
  ];

  // The sentence that resolves the ambiguity, in the operator's terms.
  let verdict;
  if (!realMode) {
    verdict = 'Simulation mode: the twin models every actuator it recommends, so nothing here is withheld for want of hardware. These counts are what a real deployment would have to match.';
  } else if (nodesOnline === 0) {
    verdict = 'Real mode with no node online. Nothing below the physics is being measured, so an empty recommendation list means the engine cannot see the building — not that the building is well.';
  } else if (acControlled === 0 && acMetered === 0) {
    verdict = `Real mode. ${nodesOnline} node${nodesOnline === 1 ? '' : 's'} reporting, but no zone has AC control confirmed or a clamp on the AC circuit — so the engine will not offer to switch an air conditioner off anywhere. That is a wiring gap, not an absence of savings.`;
  } else {
    verdict = `Real mode. Recommendations are filtered to what this hardware can carry out: ${acControlled} zone${acControlled === 1 ? '' : 's'} can be commanded off, ${acMetered} ${acMetered === 1 ? 'has' : 'have'} a clamp to prove whether the AC is running.`;
  }

  const quiet = realMode && recommendationCount === 0 && nodesOnline === 0;

  return (
    <div style={{
      marginTop: '4px',
      background: quiet ? 'rgba(234, 179, 8, 0.05)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${quiet ? 'rgba(234, 179, 8, 0.3)' : 'var(--border-glass)'}`,
      borderRadius: '10px', padding: '14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <Radio size={16} color={quiet ? 'var(--accent-yellow)' : 'var(--text-muted)'} />
        <span style={{ fontSize: '12px', fontWeight: 'bold', color: quiet ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}>
          What The AI Can Reach
        </span>
        <span
          title={realMode
            ? 'Recommendations are gated on the hardware that would have to carry them out'
            : 'The capability gate is real-mode only'}
          style={{
            marginLeft: 'auto', fontSize: '8px', fontWeight: 'bold', letterSpacing: '0.05em',
            padding: '1px 5px', borderRadius: '3px', flexShrink: 0,
            color: realMode ? 'var(--accent-blue)' : 'var(--text-muted)',
            border: `1px solid ${realMode ? 'var(--accent-blue)' : 'var(--text-muted)'}`,
          }}
        >
          {realMode ? 'REAL MODE' : 'SIMULATION'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: '4px', columnGap: '10px', marginBottom: '8px' }}>
        {rows.map(([label, value, tone, title]) => (
          <React.Fragment key={label}>
            <span title={title} style={{ fontSize: '10px', color: 'var(--text-muted)', cursor: 'help' }}>{label}</span>
            <span style={{ fontSize: '10px', fontFamily: 'monospace', color: tone || 'var(--text-primary)', textAlign: 'right' }}>
              {value}{label === 'Zones modelled' ? '' : ` / ${zones}`}
            </span>
          </React.Fragment>
        ))}
      </div>

      <p style={{ margin: 0, fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{verdict}</p>
    </div>
  );
}
