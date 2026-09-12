import React, { useState, useEffect } from 'react';
import { S } from './shared';



// How long a node may go quiet before this view calls it silent.
//
// The server has its own threshold and uses it for the `online` flag; this one only changes
// what THIS view highlights, which is why it is a local override rather than a command. The
// default is worth surfacing: a value typed during a bench session is easy to forget, and a
// 5-minute threshold quietly hides exactly the drop-outs you are trying to catch.
export function StaleAgeControl({ serverDefault, value, onChange }) {
  const inForce = value ?? serverDefault;
  const overridden = value != null && value !== serverDefault;
  const [draft, setDraft] = useState(String(inForce));

  useEffect(() => { setDraft(String(value ?? serverDefault)); }, [value, serverDefault]);

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n <= 0) { setDraft(String(inForce)); return; }
    onChange(Math.min(3600, Math.round(n)));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11,
                  color: '#6b7280', border: '1px solid #1f2937', borderRadius: 4,
                  padding: '3px 8px', background: '#111827' }}>
      <span style={{ textTransform: 'uppercase', letterSpacing: '.07em' }}>stale after</span>
      <strong style={{ color: overridden ? '#f59e0b' : '#4ade80', fontSize: 12 }}>
        {inForce}s
      </strong>
      <span style={{ color: '#4b5563' }}>now</span>
      <input
        type="number" min="1" max="3600" value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur(); } }}
        style={{ ...S.input, width: 62 }}
        title="Seconds of silence before a node is shown as silent in this view"
      />
      <button
        onClick={() => onChange(null)}
        disabled={!overridden}
        style={{ ...S.btn(overridden ? '#374151' : '#1f2937'),
                 padding: '2px 7px', fontSize: 10,
                 cursor: overridden ? 'pointer' : 'default',
                 opacity: overridden ? 1 : 0.5 }}
        title={`Reset to the engine's own threshold (${serverDefault}s)`}
      >
        default {serverDefault}s
      </button>
      {overridden && (
        <span style={{ color: '#f59e0b' }} title="This view only — the engine still uses its own value">
          local override
        </span>
      )}
    </div>
  );
}
