import React from 'react';
import { S, safeDateTime } from './shared';


export function EventsTab({ events }) {
  return (
    <div style={S.card}>
      {events == null && <div style={S.empty}>loading…</div>}
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>time</th>
            <th style={S.th}>device</th>
            <th style={S.th}>event</th>
            <th style={S.th}>detail</th>
          </tr>
        </thead>
        <tbody>
          {events != null && events.length === 0 && (
            <tr>
              <td colSpan={4} style={S.td}>no events recorded</td>
            </tr>
          )}
          {(events || []).map((e, i) => (
            <tr key={i}>
              <td style={S.td}>{safeDateTime(e?.t)}</td>
              <td style={S.td}>{e?.device ?? '—'}</td>
              <td style={{ ...S.td, color: e?.event === 'offline' ? '#ef4444' : '#4ade80' }}>
                {e?.event ?? '—'}
              </td>
              <td style={S.td}>{e?.detail ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
