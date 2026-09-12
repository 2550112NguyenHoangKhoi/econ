import React, { useState } from 'react';
import { API_BASE, getAdminToken } from '../api';
import { S } from './shared';


export function ConfigTab() {
  const [cmd, setCmd] = useState('');
  const [status, setStatus] = useState(null);

  const sendCmd = async (e) => {
    e.preventDefault();
    if (!cmd.trim()) return;
    setStatus({ msg: 'Sending...', ok: true });
    try {
      const token = typeof getAdminToken === 'function' ? getAdminToken() : '';
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Admin-Token'] = token;
      const res = await fetch(`${API_BASE}/api/command`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `CONFIG:${cmd}`, zone: 'all' })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Say what is actually known. A 200 means the ENGINE accepted it and republished it to
      // econ/config/<node>; the node validates independently and can still reject the payload
      // as malformed JSON or an out-of-range value, which it reports on its config state
      // topic. Nothing here reads that reply yet, so claiming success outright would assert
      // an outcome this component never observed.
      setStatus({ msg: 'Published to the node — check its config state for whether it applied', ok: true });
      setCmd('');
    } catch (err) {
      setStatus({ msg: err.message, ok: false });
    }
  };

  return (
    <div style={S.card}>
      <h2 style={{marginTop: 0, color: '#f59e0b'}}>HARDWARE CONFIGURATION</h2>
      <p style={S.dim}>
        Broadcast configuration to all listening hardware nodes via <code>POST /api/command</code>.
        The engine strips the <code>CONFIG:</code> prefix and republishes to <code>econ/config/&lt;node&gt;</code>,
        where the firmware parses it as JSON keyed by field name and validates each value before applying it.
      </p>
      <form onSubmit={sendCmd} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input style={S.input} value={cmd} onChange={e => setCmd(e.target.value)} placeholder='e.g. {"relayActiveLow": true}' />
        <button type="submit" style={{...S.btn(true), padding: '6px 14px'}}>Send JSON Config</button>
      </form>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button 
          style={{...S.btn(false), padding: '6px 14px', fontSize: 12, background: 'rgba(59, 130, 246, 0.1)'}} 
          onClick={() => { setCmd('{"relayActiveLow": true}'); }}
        >
          Active-Low Relay
        </button>
        <button 
          style={{...S.btn(false), padding: '6px 14px', fontSize: 12, background: 'rgba(59, 130, 246, 0.1)'}} 
          onClick={() => { setCmd('{"relayActiveLow": false}'); }}
        >
          Active-High Relay
        </button>
      </div>
      {status && (
        <div style={{ marginTop: 12, color: status.ok ? '#4ade80' : '#ef4444', fontSize: 12 }}>
          {status.msg}
        </div>
      )}
    </div>
  );
}
