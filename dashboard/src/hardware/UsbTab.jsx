import React, { useState } from 'react';
import { S } from './shared';


export function UsbTab() {
  const [port, setPort] = useState(null);
  const [log, setLog] = useState('');
  const [input, setInput] = useState('');
  
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [networks, setNetworks] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [presets, setPresets] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('wifi_presets')) || [];
    } catch {
      return [];
    }
  });
  const readerRef = React.useRef(null);

  const appendLog = (chunk) => {
    setLog((l) => {
      const next = l + chunk;
      return next.length > 50000 ? next.slice(-40000) : next;
    });
  };

  const connect = async () => {
    if (!('serial' in navigator)) {
      appendLog('WebSerial API not supported in this browser.\n');
      return;
    }
    try {
      const p = await navigator.serial.requestPort();
      await p.open({ baudRate: 115200 });
      setPort(p);
      readLoop(p);
    } catch (e) {
      appendLog(`Error: ${e.message}\n`);
    }
  };

  const disconnect = async () => {
    try {
      if (readerRef.current) {
        await readerRef.current.cancel();
      }
      if (port) {
        await port.close();
      }
    } catch (e) {
      appendLog(`Disconnect Error: ${e.message}\n`);
    } finally {
      setPort(null);
    }
  };

  const readLoop = async (p) => {
    const textDecoder = new TextDecoderStream();
    p.readable.pipeTo(textDecoder.writable).catch(e => appendLog(`Pipe Error: ${e.message}\n`));
    const reader = textDecoder.readable.getReader();
    readerRef.current = reader;
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        setLog(l => { const next = l + value; return next.length > 50000 ? next.slice(-40000) : next; });
        
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.includes('[wifi] scan done') || line.includes('connect with:')) setScanning(false);

          // Two scan formats. The firmware now prints a table with index, signal, security
          // and SSID; older builds printed [wifi] scanned: "name". Both are accepted so this
          // panel keeps working against a node that has not been reflashed.
          //   [wifi]  0   ####  -48  locked    star
          const row = line.match(/^\[wifi\]\s+(\d+)\s+([#.]{4})\s+(-?\d+)\s+(locked|open)\s*(.*)$/);
          const legacy = line.match(/\[wifi\] scanned:\s*"([^"]+)"/);
          let found = null;
          if (row) {
            const ssidText = (row[5] || '').trim();
            // A blank SSID is a hidden network: it cannot be joined by name, so offering it
            // in the dropdown would hand the user an entry that always fails.
            if (ssidText) {
              found = { ssid: ssidText, rssi: Number(row[3]), secure: row[4] === 'locked' };
            }
          } else if (legacy) {
            found = { ssid: legacy[1], rssi: null, secure: null };
          }
          if (found) {
            setNetworks(prev => prev.some(n => n.ssid === found.ssid) ? prev : [...prev, found]);
          }
        }
      }
    } catch (e) {
      appendLog(`Read Error: ${e.message}\n`);
    } finally {
      reader.releaseLock();
      readerRef.current = null;
      setPort(null);
    }
  };

  const send = async (text) => {
    if (!port) return;
    try {
      const encoder = new TextEncoder();
      const writer = port.writable.getWriter();
      await writer.write(encoder.encode(text + '\r\n'));
      writer.releaseLock();
      appendLog(`> ${text}\n`);
    } catch (e) {
      appendLog(`Write Error: ${e.message}\n`);
    }
  };


  const handleSendWifi = () => {
    if (!ssid.trim()) return;
    const newPresets = presets.filter(p => p.ssid !== ssid);
    newPresets.unshift({ ssid, password });
    if (newPresets.length > 5) newPresets.pop();
    setPresets(newPresets);
    try {
      localStorage.setItem('wifi_presets', JSON.stringify(newPresets));
    } catch { /* private window or blocked storage: the preset just is not remembered */ }

    // C++ firmware now supports parsing quotes around SSID and password,
    // including escaped quotes. JSON.stringify safely adds quotes and escapes internal characters.
    send(`[wifi] connect ${JSON.stringify(ssid)} ${JSON.stringify(password)}`);
  };

  const removePreset = (s) => {
    const newPresets = presets.filter(p => p.ssid !== s);
    setPresets(newPresets);
    localStorage.setItem('wifi_presets', JSON.stringify(newPresets));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={S.card}>
        <h2 style={{marginTop: 0, color: '#3b82f6'}}>USB Serial Console</h2>
        <div style={{ marginBottom: 12 }}>
          {!port ? (
            <button style={{...S.btn(true), padding: '6px 14px'}} onClick={connect}>Connect to ESP32 via USB</button>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={S.badge('#4ade80')}>CONNECTED</span>
              <button style={{...S.btn(false), padding: '4px 10px'}} onClick={disconnect}>Disconnect</button>
            </div>
          )}
        </div>
        <div style={{...S.pre, height: 300, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all'}}>
          {log || 'No data'}
        </div>
        
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <input style={S.input} value={input} onChange={e => setInput(e.target.value)} placeholder="Send command..." onKeyDown={e => e.key === 'Enter' && (send(input), setInput(''))} />
          <button style={{...S.btn(true), padding: '6px 14px'}} onClick={() => { send(input); setInput(''); }}>Send</button>
        </div>
      </div>

      <div style={S.card}>
        <h2 style={{marginTop: 0, color: '#a855f7'}}>WiFi Provisioning (USB)</h2>
        <p style={{ ...S.dim, marginTop: 0, marginBottom: 12 }}>
          Send credentials to the connected edge node. Ensure a USB connection is open first.
        </p>
        
        {presets.length > 0 && (
          <div style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {presets.map(p => (
              <div key={p.ssid} style={{ display: 'flex', alignItems: 'center', background: '#374151', borderRadius: 4, overflow: 'hidden' }}>
                <button 
                  style={{...S.btn(false), background: 'transparent', border: 'none', padding: '4px 8px', fontSize: 13}} 
                  onClick={() => { setSsid(p.ssid); setPassword(p.password); }}
                  title="Load preset"
                >
                  {p.ssid}
                </button>
                <button 
                  style={{ background: 'transparent', border: 'none', borderLeft: '1px solid #4b5563', color: '#9ca3af', padding: '4px 6px', cursor: 'pointer' }}
                  onClick={() => removePreset(p.ssid)}
                  title="Remove preset"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{...S.input, flex: 1}} placeholder="SSID" value={ssid} onChange={e => setSsid(e.target.value)} />
            <button 
              style={{...S.btn(true), padding: '6px 14px', opacity: port ? 1 : 0.5}} 
              disabled={!port}
              onClick={() => { setNetworks([]); setScanning(true); send('[wifi] scan'); }}
            >
              {scanning ? 'Scanning...' : 'Scan Networks'}
            </button>
            <input style={{...S.input, flex: 1}} type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
          </div>

          {networks.length > 0 && (
            <div style={{ display: 'flex', gap: 8 }}>
              <select 
                style={{...S.input, flex: 1, backgroundColor: '#374151', color: 'white', cursor: 'pointer'}}
                value={networks.some(n => n.ssid === ssid) ? ssid : ""}
                onChange={e => setSsid(e.target.value)}
              >
                <option value="" disabled>Select a scanned network... ({networks.length} found)</option>
                {[...networks].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)).map(n => (
                  <option key={n.ssid} value={n.ssid}>
                    {n.rssi != null
                      ? `${n.ssid}  —  ${n.rssi} dBm${n.secure ? '' : '  (open)'}`
                      : n.ssid}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'flex-end' }}>
            <button 
              style={{...S.btn(true), padding: '6px 14px', opacity: port ? 1 : 0.5}} 
              disabled={!port}
              onClick={handleSendWifi}
            >
              Send WiFi Config
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
