import React, { useState } from 'react';
import { DeviceControls } from './DeviceControls';
import { S } from './shared';


export function ControlsTab({ devices = [] }) {
  const [selectedTarget, setSelectedTarget] = useState('zone-office-a');
  const [customTarget, setCustomTarget] = useState('');

  const target = customTarget.trim() || selectedTarget;

  const defaultOptions = [
    'zone-office-a',
    'zone-office-b',
    'zone-conf-b',
    'zone-north-west-office-lvl4',
    'esp32-zone-01',
    'vav-office-a',
  ];
  const dynamicOptions = devices.map((d) => d.zone || d.id).filter(Boolean);
  const targetOptions = Array.from(new Set([...defaultOptions, ...dynamicOptions]));

  return (
    <div style={S.card}>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 4px 0', color: '#f3f4f6', fontWeight: 700 }}>
          Edge Hardware Manual Actuation & Controls
        </h2>
        <p style={{ ...S.dim, margin: 0, fontSize: 12, lineHeight: 1.5 }}>
          Comprehensive manual controls for all edge devices: transmit arbitrary IR codes to mini-split ACs, toggle smart plugs and relays, modulate VAV dampers, and test edge compute offloading via CPU strain simulation.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', background: '#0b0f14', padding: 10, borderRadius: 4, border: '1px solid #1f2937' }}>
        <label style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600 }}>Target Zone / Device:</label>
        <select
          data-testid="target-zone-select"
          style={{ ...S.input, maxWidth: 260 }}
          value={selectedTarget}
          onChange={(e) => { setSelectedTarget(e.target.value); setCustomTarget(''); }}
        >
          {targetOptions.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: '#6b7280' }}>or custom zone/device ID:</span>
        <input
          data-testid="custom-target-input"
          style={{ ...S.input, maxWidth: 180 }}
          placeholder="e.g. zone-12"
          value={customTarget}
          onChange={(e) => setCustomTarget(e.target.value)}
        />
      </div>

      <DeviceControls targetZone={target} targetDevice={target} />
    </div>
  );
}
