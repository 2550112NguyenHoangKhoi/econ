// Hardware Inspector — the raw MQTT view, one level below /api/hardware.
//
// This was a single 2,200-line file. The split is by tab, because that is how the panel is
// actually navigated and how a change request arrives ("the forecast tab shows the wrong
// band"), so the file you open matches the thing you were asked about. Nothing moved
// across a seam it did not already have: every component here was already a separate
// top-level declaration, and the shared constants, formatters and style table they all
// reach for now live in hardware/shared.js instead of being scattered top and bottom of
// one scroll.
//
// Pure reorganisation — no behaviour was changed.

import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE } from './api';
import { POLL_MS, S } from './hardware/shared';
import { ConfigTab } from './hardware/ConfigTab';
import { ControlsTab } from './hardware/ControlsTab';
import { DeviceCard } from './hardware/DeviceCard';
import { EventsTab } from './hardware/EventsTab';
import { ForecastTab } from './hardware/ForecastTab';
import { QualityTab } from './hardware/QualityTab';
import { StaleAgeControl } from './hardware/StaleAgeControl';
import { SustainabilityTab } from './hardware/SustainabilityTab';
import { UsbTab } from './hardware/UsbTab';


export default function HardwareInspector() {
  const [data, setData] = useState(null);
  const [events, setEvents] = useState(null);
  const [quality, setQuality] = useState(null);
  const [qMinutes, setQMinutes] = useState(60);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('devices');

  // index.css sets `body { overflow: hidden }` because the 3D console is a full-screen app.
  // This inspector is the opposite: a long document (the events table runs to thousands of
  // rows) that must scroll. Restore scrolling for as long as this view is mounted and put it
  // back on the way out, so the console keeps the behaviour it needs.
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'auto';
    document.documentElement.style.overflow = 'auto';
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);
  const [staleAge, setStaleAgeRaw] = useState(() => {
    // localStorage can throw outright in some contexts, so never let it break the view.
    try {
      const v = window.localStorage.getItem('econ.inspector.staleAfter');
      const n = v == null ? null : Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  });
  const setStaleAge = useCallback((n) => {
    setStaleAgeRaw(n);
    try {
      if (n == null) window.localStorage.removeItem('econ.inspector.staleAfter');
      else window.localStorage.setItem('econ.inspector.staleAfter', String(n));
    } catch { /* private window or blocked storage: keep the in-memory value */ }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/devices`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (alive) { setData(j); setErr(null); }
      } catch (e) {
        // Distinguish "the engine is down" from "the engine is up but predates this
        // module". Both arrive here as an opaque TypeError: Go's default mux answers an
        // unknown route with a bare 404 that carries no Access-Control-Allow-Origin, so
        // the browser refuses to let us read it and fetch rejects exactly as it would for
        // a refused connection. Reporting both as "cannot reach the engine — start it"
        // sends you to restart a process that is already running and answering.
        //
        // /api/hardware has existed far longer than the inspector, so it is the probe:
        // if it answers, the engine is alive and simply lacks registerDeviceRoutes.
        let kind = 'down';
        try {
          const probe = await fetch(`${API_BASE}/api/hardware`);
          if (probe.ok) kind = 'stale';
        } catch { /* genuinely unreachable */ }
        if (alive) setErr({ kind, detail: e.message });
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (tab !== 'events') return;
    setEvents(null);
    fetch(`${API_BASE}/api/devices/events`).then((r) => r.json()).then((j) => setEvents(j.events || [])).catch(() => setEvents([]));
  }, [tab]);

  // The quality roll-up groups over the raw sample table, which is large — a full
  // building persists ~1500 rows/s. Without an explicit loading state a slow window
  // renders as an empty table, which reads as "no data" rather than "still counting".
  useEffect(() => {
    if (tab !== 'quality') return;
    setQuality(null);
    fetch(`${API_BASE}/api/devices/quality?minutes=${qMinutes}`)
      .then((r) => r.json()).then(setQuality).catch(() => setQuality({ error: true }));
  }, [tab, qMinutes]);

  const devices = data?.devices || [];
  const online = devices.filter((d) => d.online).length;

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div>
          <h1 style={S.h1}>Hardware Inspector</h1>
          <div style={S.sub}>
            Raw MQTT view, one level below <code>/api/hardware</code>. Read-only.
            <span style={S.tempTag}>TEMPORARY BRING-UP MODULE</span>
          </div>
        </div>
        <div style={S.counts}>
          <div><span style={{ color: '#4ade80', fontSize: 24, fontWeight: 700 }}>{online}</span> online</div>
          <div><span style={{ color: '#9ca3af', fontSize: 24, fontWeight: 700 }}>{devices.length}</span> seen</div>
        </div>
      </div>

      <div style={S.tabs}>
        {['devices', 'controls', 'events', 'quality', 'forecast', 'sustainability', 'usb', 'config'].map((t) => (
          <button key={t} style={S.tab(tab === t)} onClick={() => setTab(t)}>{t}</button>
        ))}
        <a href={window.location.pathname} style={S.back}>← back to console</a>
      </div>

      {err && (
        <div style={S.error}>
          {err.kind === 'stale' ? (
            <>
              The engine at <code>{API_BASE}</code> is running, but it does not serve
              <code> /api/devices</code> — it was built before the hardware inspector existed.
              <br />Restart it onto a current build: <code>cd econ/server &amp;&amp; go run .</code>
              {' '}(learned models persist to <code>data/</code>, so a restart keeps them),
              or point the dashboard at one that has the routes with
              {' '}<code>VITE_BACKEND_PORT=&lt;port&gt;</code>.
            </>
          ) : (
            <>
              Cannot reach the engine at <code>{API_BASE}</code> — {err.detail}.
              <br />Start it with <code>cd econ/server &amp;&amp; go run .</code> (and the broker with <code>docker compose up -d mqtt</code>).
            </>
          )}
        </div>
      )}

      {tab === 'devices' && (
        devices.length === 0 && !err ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={S.empty}>
              No physical node has published yet on <code>econ/telemetry/+</code>. The engine is running in simulation/ready state.
              You can test manual actuation commands directly below or switch to the <strong>controls</strong> tab.
            </div>
            <ControlsTab devices={[]} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {devices.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                              margin: '0 0 10px 0' }}>
                  <h3 style={{ color: '#9ca3af', fontSize: '13px', margin: 0, textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>ESP32 Edge Nodes</h3>
                  <StaleAgeControl serverDefault={data?.staleAfter || 20}
                                   value={staleAge} onChange={setStaleAge} />
                </div>
                {devices.map((d) => <DeviceCard key={d.id} dev={d} staleAfter={staleAge ?? (data?.staleAfter || 20)} />)}
              </div>
            )}
          </div>
        )
      )}

      {tab === 'controls' && <ControlsTab devices={devices} />}
      {tab === 'events' && <EventsTab events={events} />}
      {tab === 'quality' && <QualityTab quality={quality} setQMinutes={setQMinutes} qMinutes={qMinutes} />}
      {tab === 'config' && <ConfigTab />}
      {tab === 'forecast' && <ForecastTab />}
      {tab === 'sustainability' && <SustainabilityTab />}
      
      <div style={{ display: tab === 'usb' ? 'block' : 'none' }}>
        <UsbTab />
      </div>
    </div>
  );
}
