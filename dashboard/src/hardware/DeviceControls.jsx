import React, { useState } from 'react';
import { API_BASE, getAdminToken } from '../api';
import { S, ago, mono, safeTime } from './shared';


// Both lists are generated from the library on disk, not hand-maintained, because the
// names have to match EXACTLY what the node resolves. The previous list offered PANASONIC,
// MITSUBISHI, SAMSUNG and TOSHIBA -- none of which IRac accepts; the AC variants are
// PANASONIC_AC, MITSUBISHI_AC, SAMSUNG_AC, TOSHIBA_AC -- plus NEC/SONY/RC5/RC6, which are
// TV remote protocols with no AC frame at all. Selecting any of them set a protocol the
// node then refused, and the HVAC buttons silently kept using the previous one.
//
// IR_PROTOCOLS: every protocol IRac::isProtocolSupported() accepts, i.e. everything the
// HVAC buttons and PROTOCOL= can actually drive. 65 of them.
export const IR_PROTOCOLS = [
  'AIRTON', 'AIRWELL', 'AMCOR', 'ARGO',
  'BOSCH144', 'CARRIER_AC64', 'COOLIX', 'CORONA_AC',
  'DAIKIN', 'DAIKIN128', 'DAIKIN152', 'DAIKIN160',
  'DAIKIN176', 'DAIKIN2', 'DAIKIN216', 'DAIKIN64',
  'DELONGHI_AC', 'ECOCLIM', 'ELECTRA_AC', 'EUROM',
  'FUJITSU_AC', 'GOODWEATHER', 'GREE', 'HAIER_AC',
  'HAIER_AC160', 'HAIER_AC176', 'HAIER_AC_YRW02', 'HITACHI_AC',
  'HITACHI_AC1', 'HITACHI_AC264', 'HITACHI_AC296', 'HITACHI_AC344',
  'HITACHI_AC424', 'KELON', 'KELVINATOR', 'LG',
  'LG2', 'MIDEA', 'MIRAGE', 'MITSUBISHI112',
  'MITSUBISHI136', 'MITSUBISHI_AC', 'MITSUBISHI_HEAVY_152', 'MITSUBISHI_HEAVY_88',
  'NEOCLIMA', 'PANASONIC_AC', 'PANASONIC_AC32', 'RHOSS',
  'SAMSUNG_AC', 'SANYO_AC', 'SANYO_AC88', 'SHARP_AC',
  'TCL112AC', 'TECHNIBEL_AC', 'TECO', 'TEKNOPOINT',
  'TOSHIBA_AC', 'TRANSCOLD', 'TROTEC', 'TROTEC_3550',
  'TRUMA', 'VESTEL_AC', 'VOLTAS', 'WHIRLPOOL_AC',
  'YORK',
];


// Of those, the ones whose frame is a 64-bit value rather than a byte array. Only these
// can go out through the raw "Transmit IR Code" path; IRsend refuses the rest without
// transmitting.
export const VALUE_BASED_PROTOCOLS = new Set([
  'AIRTON', 'AIRWELL', 'CARRIER_AC64', 'COOLIX',
  'DAIKIN64', 'DELONGHI_AC', 'ECOCLIM', 'GOODWEATHER',
  'GREE', 'KELON', 'LG', 'LG2',
  'MIDEA', 'PANASONIC_AC32', 'TECHNIBEL_AC', 'TECO',
  'TRANSCOLD', 'TRUMA', 'VESTEL_AC',
]);


export const DEFAULT_HARDWARE_LIBRARY = [
  { id: 'ir_blaster', device: 'HVAC IR Blaster', pin: 'GPIO 25', bus: 'PWM / IRremoteESP8266', flag: 'USE_IR_AC', desc: 'Commands split-unit ACs (Coolix, Electra, Daikin, etc.) via 940nm IR emitter' },
  { id: 'smart_plug', device: 'Smart Plug Relay', pin: 'GPIO 26', bus: 'Digital Output', flag: 'USE_PLUG', desc: 'Sheds non-critical socket circuits after-hours (APLC automated plug load control)' },
  { id: 'lighting', device: 'Lighting Relay', pin: 'Unused (255)', bus: 'Digital Output', flag: 'RELAY_PIN', desc: 'Legacy/unpopulated lighting relay (virtual, pinLightingRelay = 255)' },
  { id: 'strip_meter', device: 'ACS712 Power Strip Meter', pin: 'GPIO 32 (ADC1_CH4)', bus: 'Analog ADC (True-RMS)', flag: 'USE_STRIP', desc: 'True-RMS strip current sensing with compute offload fallback streaming' },
  { id: 'plug_clamp', device: 'SCT-013 Plug CT Clamp', pin: 'GPIO 33 (ADC1_CH5)', bus: 'Analog ADC (33Ω burden)', flag: 'USE_PLUG', desc: 'Monitors wall plug circuit current draw (plugW)' },
  { id: 'ac_clamp', device: 'SCT-013 AC CT Clamp', pin: 'GPIO 35 (ADC1_CH7)', bus: 'Analog ADC (33Ω burden)', flag: 'USE_AC_CLAMP', desc: 'Measures compressor active power (acW) for thermodynamic model tracking' },
  { id: 'supply_temp', device: 'DS18B20 Supply Air Temp', pin: 'Unused (255)', bus: '1-Wire Digital', flag: 'USE_SUPPLY_TEMP', desc: 'High-precision temperature sensor in AC discharge louvre' },
  { id: 'env_sensors', device: 'SHT30 / ACD1200 / BH1750', pin: 'GPIO 21 (SDA), GPIO 22 (SCL)', bus: 'I2C Bus (400 kHz)', flag: 'USE_SHT30, USE_CO2, USE_LUX', desc: 'Environmental telemetry: air temperature, relative humidity, CO2 ppm, lux' },
  { id: 'pir_radar', device: 'Rd-03 V1 Radar x2', pin: 'GPIO 13 & GPIO 14', bus: 'Digital (OT2 high = sensing)', flag: 'USE_MMWAVE', desc: 'Two 24GHz FMCW presence heads, ORed into occupancy. Unlike a PIR these hold their output high for a stationary person, so a still occupant is not read as an empty room' },
];



export function DeviceControls({ targetZone = 'zone-office-a', targetDevice = '' }) {
  // No pin overrides. They were read from localStorage and layered over the real table, so a
  // remap someone typed months ago -- one that never reached a node, because nothing consumed
  // those messages -- kept displaying as this node's pinout on that browser alone. A stale
  // illusion in one person's local storage is worse than no control at all.
  const hwLibrary = DEFAULT_HARDWARE_LIBRARY;

  // GPIO assignments are build-time. This table reports them; it cannot change them.
  //
  // It used to be click-to-edit, and the edit could never land. It POSTed
  // `CONFIG:PIN_REMAP:<dashboard-id>=<pin>`. The CONFIG: route itself is real -- engine.go
  // strips the prefix and republishes the remainder to econ/config/<topic>, which the node
  // subscribes to -- but handleConfig() deserialises that payload as JSON keyed by firmware
  // field name (pinIrAc, pinPlugRelay). `PIN_REMAP:ir_blaster=25` is neither JSON nor a
  // firmware field name, so the node rejected it as malformed and said so on its config
  // state topic. Nothing in this component read that reply: the POST returned 200 because
  // the engine accepted the command, `.catch(() => {})` discarded transport errors, and
  // localStorage was updated regardless -- so the cell redrew with a pin the node had
  // explicitly refused.
  //
  // Making it work is not simply a matter of the right topic either. IRac and IRsend capture
  // their pin in the constructor and expose no way to move it, so the IR row in particular
  // cannot be remapped at runtime by any message -- main.cpp warns about exactly that when a
  // configured pinIrAc disagrees with the compiled one. Changing a pin means editing
  // platformio.ini and reflashing. The honest control is no control.
  const [protocol, setProtocol] = useState('COOLIX');
  const [hexCode, setHexCode] = useState('0xB27BE0');
  const [bits, setBits] = useState('32');
  const [tempSetpoint, setTempSetpoint] = useState(22.0);
  const [damperVal, setDamperVal] = useState(75);
  const [sending, setSending] = useState(false);
  const [radarMin, setRadarMin] = useState(1);
  const [radarMax, setRadarMax] = useState(5);
  const [radarDelay, setRadarDelay] = useState(2);
  const [radarFrames, setRadarFrames] = useState(15);
  const [status, setStatus] = useState(null);
  const [showLib, setShowLib] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [cameraKey, setCameraKey] = useState(0);

  const effectiveZone = targetZone || targetDevice || 'zone-office-a';

  const sendCommand = async (cmd) => {
    setSending(true);
    setStatus(null);
    try {
      const token = typeof getAdminToken === 'function' ? getAdminToken() : '';
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Admin-Token'] = token;
      const res = await fetch(`${API_BASE}/api/command`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          zone: effectiveZone,
          device_id: targetDevice || effectiveZone,
          command: cmd,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setStatus({
        ok: true,
        cmd,
        msg: `Dispatched: "${cmd}" to ${effectiveZone}`,
        time: safeTime(new Date()),
      });
    } catch (err) {
      setStatus({
        ok: false,
        cmd,
        msg: `Failed: ${err.message}`,
        time: safeTime(new Date()),
      });
    } finally {
      setSending(false);
    }
  };

  const btnStyle = (variant) => {
    let bg = '#1f2937';
    let border = '#374151';
    let color = '#e5e7eb';
    if (variant === 'primary') { bg = '#1d4ed8'; border = '#2563eb'; color = '#ffffff'; }
    if (variant === 'success') { bg = '#065f46'; border = '#059669'; color = '#34d399'; }
    if (variant === 'warning') { bg = '#78350f'; border = '#d97706'; color = '#fbbf24'; }
    if (variant === 'danger') { bg = '#7f1d1d'; border = '#dc2626'; color = '#f87171'; }
    return {
      background: bg,
      border: `1px solid ${border}`,
      color,
      padding: '5px 12px',
      borderRadius: 4,
      cursor: sending ? 'wait' : 'pointer',
      fontFamily: mono,
      fontSize: 11,
      fontWeight: 600,
      opacity: sending ? 0.6 : 1,
      transition: 'all 0.15s ease',
    };
  };

  return (
    <div style={{ background: '#0d131c', border: '1px solid #1e293b', borderRadius: 6, padding: 14, marginTop: 12 }}>
      {/* Target indicator */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, borderBottom: '1px solid #1e293b', paddingBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa' }}>Manual Controls & Actuation</span>
          <span style={S.badge('#3b82f6')}>TARGET: {effectiveZone}</span>
        </div>
        <button
          style={btnStyle('default')}
          onClick={() => setShowLib(!showLib)}
        >
          {showLib ? 'Hide Device Specs' : 'Show Device Library & Pins'}
        </button>
      </div>

      {/* Collapsible Device Library */}
      {showLib && (
        <div style={{ background: '#080d14', border: '1px solid #1f2937', borderRadius: 4, padding: 10, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f3f4f6' }}>
              ESP32 Edge Node Hardware Library (edge/esp32/src/main.cpp)
            </div>
            <span style={{ fontSize: 10, color: '#6b7280' }}>
              build-time — set in <code style={{ color: '#9ca3af' }}>platformio.ini</code>
            </span>
          </div>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Device</th>
                <th style={S.th}>GPIO Pin</th>
                <th style={S.th}>Protocol / Bus</th>
                <th style={S.th}>Build Flag</th>
                <th style={S.th}>Function</th>
              </tr>
            </thead>
            <tbody>
              {hwLibrary.map((item) => (
                <tr key={item.id}>
                  <td style={{ ...S.td, fontWeight: 600, color: '#e5e7eb' }}>{item.device}</td>
                  <td style={{ ...S.td, color: '#60a5fa' }}>
                    <code>{item.pin}</code>
                  </td>
                  <td style={S.td}>{item.bus}</td>
                  <td style={S.td}><code style={{ color: '#f59e0b' }}>{item.flag}</code></td>
                  <td style={{ ...S.td, color: '#9ca3af' }}>{item.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        {/* Section 1: IR Blaster Controls */}
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 4, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 12, color: '#f3f4f6' }}>HVAC IR Blaster (GPIO 25)</span>
            <span style={S.badge('#f59e0b')}>USE_IR_AC</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Protocol:</label>
              <select
                data-testid="ir-protocol-select"
                style={{ ...S.input, width: '100%' }}
                value={protocol}
                onChange={(e) => {
                  // Retarget the node too. Without this the select only rewrote the string
                  // the raw-transmit button builds, so every HVAC button underneath kept
                  // firing whatever protocol was compiled in -- picking HITACHI_AC344 here
                  // and pressing "Set Temp" still transmitted ELECTRA_AC.
                  setProtocol(e.target.value);
                  sendCommand(`PROTOCOL=${e.target.value}`);
                }}
              >
                {IR_PROTOCOLS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Hex Code:</label>
                <input
                  data-testid="ir-hex-input"
                  style={{ ...S.input, width: '100%' }}
                  value={hexCode}
                  onChange={(e) => setHexCode(e.target.value)}
                  placeholder="0xB27BE0"
                />
              </div>
              <div style={{ width: 70 }}>
                <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Bits:</label>
                <input
                  data-testid="ir-bits-input"
                  type="number"
                  style={{ ...S.input, width: '100%' }}
                  value={bits}
                  onChange={(e) => setBits(e.target.value)}
                />
              </div>
            </div>

            <button
              data-testid="ir-send-btn"
              style={{ ...btnStyle('primary'), marginTop: 4, width: '100%' }}
              onClick={() => sendCommand(`IR_SEND:${protocol}:${hexCode.trim()}:${bits}`)}
              disabled={sending || !VALUE_BASED_PROTOCOLS.has(protocol)}
            >
              Transmit IR Code ({protocol})
            </button>
            {!VALUE_BASED_PROTOCOLS.has(protocol) && (
              <div style={{ fontSize: 10, color: '#9ca3af', lineHeight: 1.45 }}>
                {protocol} carries its frame as a byte array, not a hex value, so raw transmit
                cannot express it — the node would refuse it. Use the HVAC buttons below, which
                build the full frame. The protocol is already applied to the node.
              </div>
            )}

            {/* Quick HVAC controls via IR */}
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #374151' }}>
              <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
                HVAC Setpoint Override: <strong>{Number(tempSetpoint).toFixed(1)}°C</strong>
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  data-testid="hvac-setpoint-input"
                  type="number"
                  step="0.5"
                  min="16"
                  max="30"
                  style={{ ...S.input, width: 70 }}
                  value={tempSetpoint}
                  onChange={(e) => setTempSetpoint(e.target.value)}
                />
                <button
                  data-testid="hvac-set-btn"
                  style={btnStyle('default')}
                  onClick={() => sendCommand(`SETPOINT=${Number(tempSetpoint).toFixed(1)}`)}
                >
                  Set Temp
                </button>
                <button
                  data-testid="hvac-off-btn"
                  style={btnStyle('danger')}
                  onClick={() => sendCommand('HVAC_SET:OFF')}
                >
                  Turn Off AC
                </button>
              </div>

              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button style={{ ...btnStyle('default'), flex: 1 }} onClick={() => sendCommand('SETPOINT=20.0')}>
                  Cool Mode (20°C)
                </button>
                <button style={{ ...btnStyle('warning'), flex: 1 }} onClick={() => sendCommand('SETPOINT=18.0')}>
                  Purge Air (18°C)
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Relays & Plugs */}
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 4, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 12, color: '#f3f4f6' }}>Relays & Sockets</span>
            <span style={S.badge('#10b981')}>ACTUATORS</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Smart Plug Relay */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Smart Plug Circuit (GPIO 26 / APLC Sockets)</span>
                <span style={S.badge('#10b981')}>PHYSICAL RELAY (pinPlugRelay = 26)</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  data-testid="plug-on-btn"
                  style={{ ...btnStyle('success'), flex: 1 }}
                  onClick={() => sendCommand('PLUG_ON')}
                  disabled={sending}
                >
                  Sockets ON (PLUG_ON)
                </button>
                <button
                  data-testid="plug-off-btn"
                  style={{ ...btnStyle('danger'), flex: 1 }}
                  onClick={() => sendCommand('PLUG_OFF')}
                  disabled={sending}
                >
                  Sockets OFF (PLUG_OFF)
                </button>
              </div>
            </div>

            {/* Lighting Relay */}
            <div style={{ paddingTop: 8, borderTop: '1px dashed #374151' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Lighting Relay (GPIO 23 / Solid State)</span>
                <span style={S.badge('#6b7280')}>VIRTUAL / UNPOPULATED (pinLightingRelay = 255)</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  data-testid="lights-on-btn"
                  style={{ ...btnStyle('secondary'), flex: 1, opacity: 0.7 }}
                  onClick={() => sendCommand('LIGHTS_ON')}
                  disabled={sending}
                  title="Virtual / Unpopulated relay (GPIO 23 / pinLightingRelay = 255)"
                >
                  Lights ON (LIGHTS_ON)
                </button>
                <button
                  data-testid="lights-off-btn"
                  style={{ ...btnStyle('secondary'), flex: 1, opacity: 0.7 }}
                  onClick={() => sendCommand('LIGHTS_OFF')}
                  disabled={sending}
                  title="Virtual / Unpopulated relay (GPIO 23 / pinLightingRelay = 255)"
                >
                  Lights OFF (LIGHTS_OFF)
                </button>
              </div>
            </div>


            {/* CPU Strain Fallback Testing */}
            <div style={{ paddingTop: 8, borderTop: '1px dashed #374151' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', marginBottom: 2 }}>
                Compute Offload / CPU Strain Test
              </div>
              <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 6 }}>
                Simulates high MCU load to test pass-through raw streaming fallback.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  data-testid="cpu-strain-high-btn"
                  style={{ ...btnStyle('warning'), flex: 1 }}
                  onClick={() => sendCommand('CPU_STRAIN:HIGH')}
                  disabled={sending}
                >
                  Strain HIGH (Offload)
                </button>
                <button
                  data-testid="cpu-strain-normal-btn"
                  style={{ ...btnStyle('default'), flex: 1 }}
                  onClick={() => sendCommand('CPU_STRAIN:NORMAL')}
                  disabled={sending}
                >
                  Normal CPU (Clear)
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Presence radar — the only tuning that previously required a reflash. */}
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 4, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 12, color: '#f3f4f6' }}>Presence Radar (Rd-03 &times;2)</span>
            <span style={S.badge('#4ade80')}>USE_MMWAVE</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>
              Detection range gates &mdash; 0.7&nbsp;m each. Applied to <strong>both heads</strong> over
              UART and read back.
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#6b7280', width: 30 }}>min</span>
              <input type="number" min="0" max="15" value={radarMin} style={S.input}
                     onChange={(e) => setRadarMin(e.target.value)} />
              <span style={{ fontSize: 11, color: '#6b7280', width: 30 }}>max</span>
              <input type="number" min="0" max="15" value={radarMax} style={S.input}
                     onChange={(e) => setRadarMax(e.target.value)} />
              <button style={S.btn('#2563eb')} disabled={sending}
                      onClick={() => sendCommand(`RADAR_GATES=${radarMin},${radarMax}`)}>
                Apply
              </button>
            </div>
            <div style={{ fontSize: 10, color: '#4b5563', marginTop: -4 }}>
              = {(Number(radarMin) * 0.7).toFixed(1)}&ndash;{((Number(radarMax) + 1) * 0.7).toFixed(1)} m.
              Round the far gate <em>down</em> to the wall, or the radar sees through it.
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', borderTop: '1px solid #1f2937', paddingTop: 9 }}>
              <span style={{ fontSize: 11, color: '#9ca3af', flex: 1 }}>Disappearance delay</span>
              <input type="number" min="0" max="65535" value={radarDelay} style={S.input}
                     onChange={(e) => setRadarDelay(e.target.value)} />
              <span style={{ fontSize: 11, color: '#6b7280' }}>s</span>
              <button style={S.btn('#2563eb')} disabled={sending}
                      onClick={() => sendCommand(`RADAR_DELAY=${radarDelay}`)}>Apply</button>
            </div>
            <div style={{ fontSize: 10, color: '#4b5563', marginTop: -4 }}>
              Seconds of continuous vacancy before a head reports clear. Any detection restarts it.
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', borderTop: '1px solid #1f2937', paddingTop: 9 }}>
              <span style={{ fontSize: 11, color: '#9ca3af', flex: 1 }}>Frame filter (detect, clear)</span>
              <input type="number" min="1" max="255" value={radarFrames} style={S.input}
                     onChange={(e) => setRadarFrames(e.target.value)} />
              <button style={S.btn('#2563eb')} disabled={sending}
                      onClick={() => sendCommand(`RADAR_FRAMES=${radarFrames},10`)}>Apply</button>
            </div>
            <div style={{ fontSize: 10, color: '#4b5563', marginTop: -4 }}>
              Consecutive agreeing frames before asserting presence. Ships at 1 &mdash; a single noisy
              frame trips it. The Rd-03 V1 has no threshold registers, so this is its only
              sensitivity control.
            </div>

            <div style={{ fontSize: 10, color: '#4b5563', marginTop: 6, lineHeight: 1.5,
                          borderTop: '1px solid #1f2937', paddingTop: 8 }}>
              Node reboot is not exposed here on purpose: this endpoint&rsquo;s admin token is
              optional, so anything reachable from it is reachable by anyone who can reach the
              engine. Reboot over the serial console, or power-cycle.
            </div>
          </div>
        </div>

        {/* Section 3: VAV Damper Modulation */}
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 4, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 12, color: '#f3f4f6' }}>VAV Damper Modulation</span>
            <span style={S.badge('#60a5fa')}>AIRFLOW</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>
                <span>Damper Position:</span>
                <strong style={{ color: '#60a5fa' }}>{damperVal}% ({(damperVal / 100).toFixed(2)})</strong>
              </div>
              <input
                data-testid="damper-slider"
                type="range"
                min="0"
                max="100"
                step="5"
                style={{ width: '100%', accentColor: '#3b82f6', cursor: 'pointer' }}
                value={damperVal}
                onChange={(e) => setDamperVal(Number(e.target.value))}
              />
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                data-testid="damper-input"
                type="number"
                min="0"
                max="100"
                style={{ ...S.input, width: 70 }}
                value={damperVal}
                onChange={(e) => setDamperVal(Math.max(0, Math.min(100, Number(e.target.value))))}
              />
              <span style={{ fontSize: 11, color: '#9ca3af' }}>%</span>
              <button
                data-testid="damper-send-btn"
                style={{ ...btnStyle('primary'), marginLeft: 'auto' }}
                onClick={() => sendCommand(`DAMPER=${damperVal}`)}
                disabled={sending}
              >
                Apply Damper ({damperVal}%)
              </button>
            </div>

            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button
                style={{ ...btnStyle('default'), flex: 1, fontSize: 10 }}
                onClick={() => { setDamperVal(15); sendCommand('DAMPER=15'); }}
              >
                15% (Min Vent)
              </button>
              <button
                style={{ ...btnStyle('default'), flex: 1, fontSize: 10 }}
                onClick={() => { setDamperVal(50); sendCommand('DAMPER=50'); }}
              >
                50% (Nominal)
              </button>
              <button
                style={{ ...btnStyle('default'), flex: 1, fontSize: 10 }}
                onClick={() => { setDamperVal(100); sendCommand('DAMPER=100'); }}
              >
                100% (Full Open)
              </button>
            </div>

            <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4, lineHeight: 1.4 }}>
              Modulates physical actuator position [0.0, 1.0] across Hardy Cross pressure network and dispatches <code>;DAMPER=...</code> to edge nodes.
            </div>
          </div>
        </div>

        {/* Section 4: Camera & ML */}
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 4, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 12, color: '#f3f4f6' }}>Camera & ML Person Detection</span>
            <span style={S.badge('#a855f7')}>VISION</span>
          </div>

          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ border: '1px solid #374151', borderRadius: 4, padding: 8, background: '#000', textAlign: 'center', minHeight: '120px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              {!cameraError ? (
                <img 
                  key={cameraKey}
                  src={`http://192.168.50.28:8080/?t=${Date.now()}`} 
                  alt="Live Camera Feed" 
                  style={{ width: '100%', maxWidth: '320px', height: 'auto', imageRendering: 'pixelated' }} 
                  onError={() => setCameraError(true)}
                />
              ) : (
                <div style={{ color: '#9ca3af', fontSize: 12, padding: 20 }}>
                  <div style={{ color: '#f87171', fontWeight: 600, marginBottom: 4 }}>Camera feed offline or unreachable</div>
                  <div>esp32-41c3f0.local:8080 (fallback to simulation/edge inference)</div>
                  <button
                    onClick={() => { setCameraError(false); setCameraKey(k => k + 1); }}
                    style={{ ...btnStyle('default'), marginTop: 8, padding: '3px 8px', fontSize: 10 }}
                  >
                    Retry Connection
                  </button>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                data-testid="camera-trigger-btn"
                style={{ ...btnStyle('primary'), flex: 1 }}
                onClick={() => sendCommand('CAMERA_TRIGGER')}
                disabled={sending}
              >
                Trigger Inference
              </button>
            </div>
            <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4, lineHeight: 1.4 }}>
              Forces the edge node to capture a frame and run the TensorFlow Lite person detection model immediately.
            </div>
          </div>
        </div>
      </div>

      {/* Action feedback status banner */}
      {status && (
        <div
          data-testid="command-feedback-banner"
          style={{
            marginTop: 12,
            padding: '8px 12px',
            borderRadius: 4,
            background: status.ok ? '#065f4622' : '#7f1d1d22',
            border: `1px solid ${status.ok ? '#05966966' : '#dc262666'}`,
            color: status.ok ? '#34d399' : '#f87171',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 12,
          }}
        >
          <span>
            <strong>{status.ok ? '✔ SUCCESS' : '✖ ERROR'}:</strong> {status.msg}
          </span>
          <span style={{ fontSize: 10, color: '#9ca3af' }}>{status.time}</span>
        </div>
      )}
    </div>
  );
}
