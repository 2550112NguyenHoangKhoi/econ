import { Wind, Zap, Activity, Lightbulb, Users } from 'lucide-react';
import { API_BASE } from './api';
import { money, rateNow, touPeriodLabel, touPeriod } from './tariff';
// fx() prints a number or the em dash. Used here rather than .toFixed() because a zone can
// legitimately arrive with a field missing -- a frame that lands mid building-switch carries
// telemetry for zones the new fixture has not been adopted for yet -- and .toFixed() on
// undefined throws, taking the whole HUD down through the error boundary. An em dash for one
// frame is the correct failure; a blank panel is not.
import { fx } from './measured';

// The drill-down HUD: everything the operator sees after clicking a zone -- live hardware
// provenance, CO2 with its measured/modelled marker, cost at the live TOU band, the manual
// veto, and the ESP32 diagnostics accordion. Lifted out of App.jsx as-is; it was ~260 lines
// of the 990-line return block and the single largest reason that JSX could not be read.
//
// Rendered only when a zone is selected AND that zone is present in the frame -- App keeps
// that guard, so this component can assume `simData.zones[selectedZone]` exists.
//
// It does NOT assume that zone has a label. Labels come from the building fixture at init;
// a zone that first appears on the websocket -- which happens during a building switch,
// before the new fixture has been adopted -- has telemetry but no label yet, and
// `label.toUpperCase()` on undefined would take the whole HUD down through the error
// boundary for a frame or two. Falling back to the id is ugly for that frame and correct.
export default function ZoneDrilldownHUD({
  selectedZone,
  setSelectedZone,
  simData,
  hardwareNodes,
  modelledCo2,
  sendManualOverride,
}) {
  return (
      <div style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 40
      }}>
        {/* Cinematic Overlay gradient */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'radial-gradient(circle, transparent 30%, rgba(0,0,0,0.85) 100%)' }} />
        
        <div style={{
          position: 'absolute', top: '25%', right: '25%',
          background: 'rgba(10,10,10,0.95)', border: '1px solid var(--accent-blue)',
          padding: '1.5rem', borderRadius: '12px', width: '320px', pointerEvents: 'auto',
          boxShadow: '0 0 40px rgba(0, 163, 224, 0.15)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '12px', color: 'var(--text-primary)', letterSpacing: '1px' }}>MICRO-TELEMETRY: {(simData.zones[selectedZone].label || selectedZone.replace(/^zone-/, '')).toUpperCase()}</h3>
            <button onClick={() => setSelectedZone(null)} style={{ background: 'transparent', border: '1px solid var(--accent-red)', borderRadius: '4px', padding: '4px 8px', color: 'var(--accent-red)', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold' }}>EXIT [X]</button>
          </div>
          
          {hardwareNodes[selectedZone] && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
              <span style={{
                fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.06em', padding: '3px 8px', borderRadius: '4px',
                color: hardwareNodes[selectedZone].online ? 'var(--accent-green)' : 'var(--text-secondary)',
                border: `1px solid ${hardwareNodes[selectedZone].online ? 'var(--accent-green)' : 'var(--border-glass)'}`,
                background: hardwareNodes[selectedZone].online ? 'rgba(46, 204, 113, 0.08)' : 'transparent',
              }}>
                ⚡ LIVE HARDWARE — {(hardwareNodes[selectedZone].source || 'edge').toUpperCase()}{hardwareNodes[selectedZone].online ? '' : ' (OFFLINE)'}
              </span>
		          {hardwareNodes[selectedZone].tempPinned && (
		            <span style={{ fontSize: '9px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
		              sensor {fx(hardwareNodes[selectedZone].hwTemp)}°C
		            </span>
		          )}
		          {/* [GEMINI IMPLEMENTATION START] */}
		          {hardwareNodes[selectedZone].detectedProtocol && (
		            <span style={{ 
		              fontSize: '9px', fontWeight: 'bold', color: 'var(--accent-blue)', 
		              border: '1px solid var(--accent-blue)', padding: '2px 6px', 
		              borderRadius: '4px', backgroundColor: 'rgba(52, 152, 219, 0.1)',
		              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100px'
		            }}>
		              👁 VISION: {hardwareNodes[selectedZone].detectedProtocol}
		            </span>
		          )}
                {hardwareNodes[selectedZone].pirState !== undefined && hardwareNodes[selectedZone].pirState !== null && (
                  <span style={{ 
                    fontSize: '9px', fontWeight: 'bold', color: hardwareNodes[selectedZone].pirState ? 'var(--accent-red)' : 'var(--accent-green)', 
                    border: `1px solid ${hardwareNodes[selectedZone].pirState ? 'var(--accent-red)' : 'var(--accent-green)'}`, padding: '2px 6px', 
                    borderRadius: '4px', backgroundColor: hardwareNodes[selectedZone].pirState ? 'rgba(239, 68, 68, 0.1)' : 'rgba(74, 222, 128, 0.1)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>
                    🏃‍♂️ PIR RD-04: {hardwareNodes[selectedZone].pirState ? 'MOTION DETECTED' : 'CLEAR'}
                  </span>
                )}
                {hardwareNodes[selectedZone].cameraEvent && (
                  <span style={{ 
                    fontSize: '9px', fontWeight: 'bold', color: 'var(--accent-yellow)', 
                    border: '1px solid var(--accent-yellow)', padding: '2px 6px', 
                    borderRadius: '4px', backgroundColor: 'rgba(234, 179, 8, 0.1)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>
                    📷 OV7670: {hardwareNodes[selectedZone].cameraEvent}
                  </span>
                )}
                {hardwareNodes[selectedZone].irState && (
                  <span style={{ 
                    fontSize: '9px', fontWeight: 'bold', color: 'var(--accent-blue)', 
                    border: '1px solid var(--accent-blue)', padding: '2px 6px', 
                    borderRadius: '4px', backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>
                    📡 IR Blaster: {hardwareNodes[selectedZone].irState}
                  </span>
                )}
		          {/* [GEMINI IMPLEMENTATION END] */}
		        </div>
		      )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* CO₂ and humidity come straight off the telemetry stream: non-zero means a
                real sensor on this zone is reporting, so the measured value wins. Zero means
                nothing is measuring it and we say so rather than passing a model off as data. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              {/* Measured takes precedence; the modelled figure uses the library's own
                  ventilation coefficients rather than a 400+15n literal repeated here,
                  on mobile and in the engine with three different values. When the
                  library has not been read there is no modelled figure to show, and the
                  row says so instead of inventing a plausible ppm. */}
              {(() => {
                const zc = simData.zones[selectedZone].co2;
                const measured = zc > 0;
                const modelled = measured ? null : modelledCo2(simData.zones[selectedZone].occupancy);
                return (
                  <>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Users size={14}/> CO₂ {measured ? 'Level (measured)' : modelled != null ? 'Level (modeled)' : 'Level'}
                    </span>
                    <span style={{ color: 'var(--accent-green)', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '14px' }}>
                      {measured ? `${Math.round(zc)} ppm`
                        : modelled != null ? `${Math.round(modelled)} ppm`
                        : '— no sensor'}
                    </span>
                  </>
                );
              })()}
            </div>

            {/* Demand-controlled ventilation. Shown only when a live NDIR reading is driving
                it: with no sensor the damper sits at the fixed ASHRAE minimum, and printing
                "15%" under a "Ventilation" heading would present a constant as a control
                decision. The row also names WHY the damper is where it is, because an
                operator looking at a wide-open box needs to know whether the room is hot or
                stuffy — the damper serves both and runs at whichever asks for more. */}
            {(() => {
              const zd = simData.zones[selectedZone];
              if (!zd.ventMeasured) return null;
              const pct = Math.round((zd.ventFloor || 0) * 100);
              // Thresholds mirror ventilation.go's Reason field. Kept in sync by eye rather
              // than shared over the wire: the string is 6 bytes per zone per frame at 30 Hz
              // and the number it is derived from is already here.
              const atCapacity = pct >= 100;
              const label = atCapacity ? 'PURGE' : pct > 50 ? 'BOOST' : pct > 16 ? 'TRIM' : 'FLOOR';
              const tone = atCapacity ? 'var(--accent-red)' : pct > 50 ? 'var(--accent-yellow)' : 'var(--accent-green)';
              return (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Wind size={14}/> Fresh air (demand-controlled)
                  </span>
                  <span style={{ fontFamily: 'monospace', fontWeight: 'bold', fontSize: '14px', color: tone }}>
                    {pct}% <span style={{ fontSize: '9px', letterSpacing: '0.06em', opacity: 0.85 }}>{label}</span>
                  </span>
                </div>
              );
            })()}

            {simData.zones[selectedZone].humidity > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}><Wind size={14}/> Humidity (measured)</span>
                <span style={{ color: 'var(--accent-blue)', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '14px' }}>
                  {fx(simData.zones[selectedZone].humidity)} %RH
                </span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}><Activity size={14}/> Thermostat</span>
              <span style={{ color: 'var(--accent-blue)', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '14px' }}>
                {fx(simData.zones[selectedZone].temp)}°C / {fx(simData.zones[selectedZone].setpoint)}°C
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}><Lightbulb size={14}/> Lights</span>
              <span style={{ color: simData.zones[selectedZone].lightsOn === false ? 'var(--text-secondary)' : 'var(--accent-green)', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '14px' }}>
                {simData.zones[selectedZone].lightsOn === false ? 'OFF · SETBACK' : 'ON'}
              </span>
            </div>
            {/* Cost rate at the live EVN TOU band: the zone's thermal load becomes electrical
                draw at the plant's COP, priced in đồng at whatever band the clock is in. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Zap size={14}/> Cost Rate ({touPeriodLabel(touPeriod())})
              </span>
              <span style={{ color: 'var(--accent-yellow)', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '14px' }}>
                {money((simData.zones[selectedZone].load / (simData.plantCop || 3.0)) * rateNow())} / hr
              </span>
            </div>
            {/* [GEMINI IMPLEMENTATION START] */}
            {/* Added by Gemini (Antigravity) on June 2026. */}
            {/* Added a Manual Veto section to the Micro-Telemetry panel */}
            {/* to allow operators to override the autonomous system. */}
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '12px' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-secondary)', alignSelf: 'center' }}>MANUAL VETO:</span>
              <button onClick={() => sendManualOverride('LIGHTS_OFF;SETPOINT=26.0', selectedZone)} style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid var(--accent-blue)', color: 'var(--accent-blue)', fontSize: '10px', padding: '6px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold' }}>FORCE OFF</button>
              <button onClick={() => sendManualOverride('LIGHTS_ON;SETPOINT=20.0', selectedZone)} style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid var(--accent-red)', color: 'var(--accent-red)', fontSize: '10px', padding: '6px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold' }}>MAX COOL</button>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-secondary)', alignSelf: 'center' }}>IR BLASTER:</span>
              <button onClick={() => sendManualOverride('IR_SEND:NEC:0xFF00FF:32', selectedZone)} title="Universal IR Blaster Test" style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid var(--accent-green)', color: 'var(--accent-green)', fontSize: '10px', padding: '6px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold' }}>IR FAN</button>
              <button onClick={() => sendManualOverride('IR_SEND:AC:ON', selectedZone)} title="Turn AC ON" style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid var(--accent-blue)', color: 'var(--accent-blue)', fontSize: '10px', padding: '6px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold' }}>AC ON</button>
              <button onClick={() => sendManualOverride('IR_SEND:AC:OFF', selectedZone)} title="Turn AC OFF" style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid var(--accent-red)', color: 'var(--accent-red)', fontSize: '10px', padding: '6px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold' }}>AC OFF</button>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-secondary)', alignSelf: 'center' }}>IR PROTOCOL:</span>
              <select 
                style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid #3498db', color: '#3498db', fontSize: '10px', padding: '6px', borderRadius: '4px', outline: 'none', cursor: 'pointer' }}
                value={hardwareNodes[selectedZone]?.detectedProtocol || ""}
                onChange={(e) => {
                  fetch(`${API_BASE}/api/vision/detection`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ zone: selectedZone, protocol: e.target.value })
                  });
                }}
              >
                <option value="">(Auto-Detect / None)</option>
                <option value="ELECTRA_AC">Casper AC (ELECTRA_AC)</option>
                <option value="PANASONIC_AC">Panasonic AC</option>
                <option value="MITSUBISHI_AC">Mitsubishi AC</option>
                <option value="NEC:0x20DF10EF:32">Dyson Fan (Raw Hex)</option>
              </select>
            </div>

            {/* ESP32 & SENSOR ADVANCED DIAGNOSTICS */}
            <details style={{ marginTop: '12px', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px', background: 'rgba(239, 68, 68, 0.05)' }}>
              <summary style={{ padding: '8px', fontSize: '10px', fontWeight: 'bold', color: '#fca5a5', cursor: 'pointer', outline: 'none' }}>
                🔧 ESP32 & SENSOR ADVANCED DIAGNOSTICS
              </summary>
              <div style={{ padding: '8px', fontSize: '10px', color: '#fecaca', borderTop: '1px solid rgba(239, 68, 68, 0.2)' }}>
                {/* ADC & Power Measurement */}
                <details open style={{ marginBottom: '8px' }}>
                  <summary style={{ fontWeight: 'bold', color: '#f59e0b', cursor: 'pointer', fontSize: '10px' }}>⚡ ADC & Power Measurement</summary>
                  <ul style={{ margin: '4px 0', paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <li><strong>ADC2 / WiFi Conflict:</strong> ESP32 cannot use ADC2 pins (GPIO 0, 2, 4, 12-15, 25-27) while WiFi is active. Use ADC1 pins (GPIO 32-39) for analogRead. If readings are 0 or erratic, check your pin assignment.</li>
                    <li><strong>ACS712 Noise Floor:</strong> Loads below ~35W (0.15A cutoff) will read as 0W due to DSP denoising. This is intentional to prevent ghost readings from EMI. Verify with a known 100W+ load.</li>
                    <li><strong>SCT-013 CT Clamp Reads 0:</strong> Ensure the clamp jaw is fully closed around the wire. Verify the 33Ω burden resistor is installed. Check <code>plugCalAPerV</code> calibration constant in firmware.</li>
                    <li><strong>ADC Nonlinearity:</strong> ESP32 ADC is non-linear above 3.1V and below 0.1V. Apply polynomial correction or use attenuation setting <code>ADC_ATTEN_DB_11</code> for full 0-3.3V range.</li>
                  </ul>
                </details>

                {/* I2C Bus */}
                <details style={{ marginBottom: '8px' }}>
                  <summary style={{ fontWeight: 'bold', color: '#60a5fa', cursor: 'pointer', fontSize: '10px' }}>🔌 I2C Bus (SHT30, CO2, BH1750)</summary>
                  <ul style={{ margin: '4px 0', paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <li><strong>Bus Lockup:</strong> If sensors return NaN or freeze, the I2C bus may be locked. Add 4.7kΩ pull-ups on SDA (GPIO 21) and SCL (GPIO 22). Power-cycle the sensor or call <code>Wire.begin()</code> to reset.</li>
                    <li><strong>Address Conflicts:</strong> SHT30 defaults to 0x44, BH1750 to 0x23, SCD30/ACD1200 to 0x61. Run an I2C scan if sensors are not detected. Conflicting addresses will cause both devices to fail.</li>
                    <li><strong>Cable Length:</strong> I2C is reliable up to ~1m at 400kHz. For longer runs, reduce to 100kHz or use an I2C bus extender (P82B715).</li>
                    <li><strong>CO2 Sensor Warm-Up:</strong> SCD30/ACD1200 requires 30-60 seconds of warm-up before readings stabilize. First readings may show 0 or 400 ppm baseline.</li>
                  </ul>
                </details>

                {/* Temperature Sensors */}
                <details style={{ marginBottom: '8px' }}>
                  <summary style={{ fontWeight: 'bold', color: '#34d399', cursor: 'pointer', fontSize: '10px' }}>🌡 Temperature Sensors (DS18B20, SHT30)</summary>
                  <ul style={{ margin: '4px 0', paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <li><strong>DS18B20 reads -127°C:</strong> Sensor is disconnected or the 4.7kΩ pull-up resistor to 3.3V on the data pin (GPIO 26) is missing.</li>
                    <li><strong>DS18B20 reads 85°C:</strong> Sensor has power but failed to complete a temperature conversion. Check wiring or increase conversion delay to 750ms.</li>
                    <li><strong>SHT30 reads 0°C / 0%RH:</strong> I2C communication failure. Check pull-ups and verify the sensor address (0x44 or 0x45). Try a soft reset command (0x30A2).</li>
                    <li><strong>Self-Heating:</strong> SHT30 in continuous measurement mode can self-heat +0.5°C. Use single-shot mode with <code>repeatability=HIGH</code> for accurate readings.</li>
                  </ul>
                </details>

                {/* PIR & Occupancy */}
                <details style={{ marginBottom: '8px' }}>
                  <summary style={{ fontWeight: 'bold', color: '#a78bfa', cursor: 'pointer', fontSize: '10px' }}>🏃 PIR & Occupancy Detection</summary>
                  <ul style={{ margin: '4px 0', paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <li><strong>PIR RD-04 Not Registering:</strong> Adjust sensitivity potentiometer. Ensure the Fresnel lens is unobstructed. PIR requires line-of-sight and detects motion (not static presence).</li>
                    <li><strong>False Triggers:</strong> PIR can false-trigger from HVAC air drafts, sunlight, or nearby heat sources. Add a 2-second debounce timer. Shield the sensor from direct AC discharge.</li>
                    <li><strong>mmWave Radar Interference:</strong> 24GHz FMCW radar can detect through thin walls, causing ghost occupancy. Reduce detection range via UART configuration. Keep away from fluorescent ballasts.</li>
                    <li><strong>Capacitive Touch Flapping:</strong> GPIO32 touch sensing near high-voltage lines may false-trigger the SSR relay. Adjust <code>touchEnterPct</code> and <code>touchExitPct</code> thresholds.</li>
                  </ul>
                </details>

                {/* IR Blaster */}
                <details style={{ marginBottom: '8px' }}>
                  <summary style={{ fontWeight: 'bold', color: '#f472b6', cursor: 'pointer', fontSize: '10px' }}>📡 IR Blaster & AC Control</summary>
                  <ul style={{ margin: '4px 0', paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <li><strong>IR Command Not Received:</strong> Ensure the 940nm IR LED is pointed at the AC receiver. Maximum reliable range is ~5m with direct line-of-sight. Check GPIO 19 PWM output with a phone camera (IR shows as purple glow).</li>
                    <li><strong>Wrong Protocol:</strong> Try COOLIX first (most Casper/generic ACs). If no response, cycle through GREE → DAIKIN → ELECTRA → PANASONIC_AC. Use the raw hex capture mode to learn unknown protocols.</li>
                    <li><strong>IR LED Wiring:</strong> Drive the LED through a 2N2222 transistor (not directly from GPIO). Use a 22Ω series resistor. Maximum forward current is 100mA.</li>
                  </ul>
                </details>

                {/* WiFi & MQTT */}
                <details style={{ marginBottom: '8px' }}>
                  <summary style={{ fontWeight: 'bold', color: '#38bdf8', cursor: 'pointer', fontSize: '10px' }}>📶 WiFi & MQTT Connectivity</summary>
                  <ul style={{ margin: '4px 0', paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <li><strong>Frequent Disconnects:</strong> ESP32 WiFi is 2.4GHz only. Ensure your router's 2.4GHz band is active and not overloaded. Set a static IP in the firmware to avoid DHCP renewal drops.</li>
                    <li><strong>MQTT Publish Fails:</strong> Check broker address and port (default 1883). Verify the MQTT client ID is unique per device. If using TLS (port 8883), ensure the CA certificate is loaded.</li>
                    <li><strong>Telemetry Gaps:</strong> If the Hardware Inspector shows stale data, check the MQTT QoS level (use QoS 1 for guaranteed delivery). Increase the keepalive interval to 60s.</li>
                    <li><strong>Watchdog Reboot:</strong> If ESP32 reboots every ~5 minutes, the task watchdog is triggering. Ensure <code>yield()</code> or <code>vTaskDelay(1)</code> is called in tight loops.</li>
                  </ul>
                </details>

                {/* Power & Boot */}
                <details>
                  <summary style={{ fontWeight: 'bold', color: '#fb923c', cursor: 'pointer', fontSize: '10px' }}>🔋 Power & Boot Issues</summary>
                  <ul style={{ margin: '4px 0', paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <li><strong>Brown-Out Reset:</strong> If ESP32 reboots when WiFi connects, the USB power supply is insufficient. Use a dedicated 5V/2A supply. Add a 470µF capacitor across VIN/GND.</li>
                    <li><strong>Boot Loop (GPIO 0, 2, 12, 15):</strong> These are strapping pins. Avoid connecting peripherals that pull them HIGH or LOW during boot. GPIO 12 pulled HIGH forces 1.8V flash voltage (crash).</li>
                    <li><strong>Compute Offload Mode:</strong> If the ESP32 is too strained (CPU &gt;85%), it will automatically switch to pass-through mode and stream raw ADC values to the backend for server-side DSP processing.</li>
                  </ul>
                </details>
              </div>
            </details>
            {/* [GEMINI IMPLEMENTATION END] */}
          </div>
        </div>
      </div>
  );
}
