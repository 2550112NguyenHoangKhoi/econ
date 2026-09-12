// ECON Edge Node — ESP32 firmware
// -----------------------------------------------------------------------------
// Role in the system (see econ/BACKEND_ARCHITECTURE.md):
//   * Publishes zone sensor telemetry  -> econ/telemetry/<zone>
//   * Subscribes to actuation commands  <- econ/commands/<zone>
//   * Drives a lighting relay + an HVAC IR emitter from those commands.
//
// Command format spoken by the Go engine's optimizer (engine.actuate):
//     "LIGHTS_ON;SETPOINT=22.0"   /   "LIGHTS_OFF;SETPOINT=26.0"
// (legacy "HVAC_SET:<c>" is still accepted). This firmware PARSES that combined
// string — earlier sketches only matched the literal "LIGHTS_ON", which never
// fires against the real payload.
//
// Telemetry payload (what mqtt.go / yolo_tracker.py expect):
//     {"zone":"Level 4","occupancy":N,"temperature":t,"humidity":h,"co2":c}
//
// Sensors are simulated by default so the node runs on a bare ESP32, but presence is
// REAL out of the box: USE_TOUCH_PRESENCE reads the ESP32's capacitive touch pin
// (GPIO32) — pinch a jumper wire on it and the zone shows occupied on the dashboard.
// Wire real sensors by enabling them individually (USE_SHT30 / USE_DHT / USE_PIR / USE_CO2),
// so a board with only one of them still reports honestly. Telemetry marks "tempReal" so the
// engine only pins zone physics to measured temperatures, never to placeholders.
// SHT30 (temp/RH) and ACD1200 (CO2) share one I2C bus; see the level-shifter warning below.
// -----------------------------------------------------------------------------

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
void readAndPublish();

// ---------------------------------------------------------------------------------------
// This file is one translation unit. The six headers below are #included at the exact point
// their code used to sit, so file-scope statics, include order and initialisation order are
// all unchanged -- the split is textual, and the compiled .flash.text, .flash.rodata,
// .dram0.data and .iram0.text sections are byte-identical to the 3,117-line original.
//
//	net_provisioning.h   WiFi credentials and broker resolution, both persisted in NVS
//	radar_rd03_state.h   Rd-03 liveness, the OT2 pull test, parsed frame state
//	hvac_ir.h            setpoint -> IR frame, and whether one was really sent
//	power_sense.h        hardware-timed ADC, and the three metered current channels
//	commands.h           the command surface, including the bring-up diagnostics
//	telemetry_publish.h  building the frame -- omission over fabrication
//
// What stays here: configuration, sensor setup, setup() and loop().
// ---------------------------------------------------------------------------------------

// ---------------- CONFIG ----------------
// WiFi + broker address for THIS site live in src/wifi_secrets.h, which is gitignored
// so credentials never reach the repo: copy src/wifi_secrets.example.h over and fill
// it in (defines WIFI_SSID, WIFI_PASS, MQTT_HOST).
#include "wifi_secrets.h"
const int   MQTT_PORT = 1883;

// Per-board identity. These MUST differ between boards: the topic suffix is what the
// engine binds to a zone, so two nodes sharing one would interleave their telemetry into
// the same zone and fight over its commands.
//
// Both are overridable at build time so one source tree flashes a whole floor without
// editing this file per device — which is what platformio.ini and the README have always
// documented. (They documented it before it worked: the override was in the docs and the
// example build_flags, but nothing here read it, so every board flashed by following the
// instructions came up as "zone_1" and collided.)
//
//   build_flags = -DZONE_TOPIC_OVERRIDE=\"zone_2\" -DZONE_LABEL_OVERRIDE=\"Level 5\"
#ifndef ZONE_TOPIC_OVERRIDE
  #define ZONE_TOPIC_OVERRIDE "zone_1"
#endif
#ifndef ZONE_LABEL_OVERRIDE
  #define ZONE_LABEL_OVERRIDE "Level 4"
#endif
const char* ZONE_TOPIC    = ZONE_TOPIC_OVERRIDE;   // topic suffix; engine maps this to a zoneId
// Derived topics
char TELEMETRY_TOPIC[48];                   // econ/telemetry/<ZONE_TOPIC>
char COMMAND_TOPIC[48];                     // econ/commands/<ZONE_TOPIC>
char STATUS_TOPIC[48];                      // econ/status/<ZONE_TOPIC>  (LWT online/offline)
char CONFIG_TOPIC[48];                      // econ/config/<ZONE_TOPIC>        (inbound)
char CONFIG_STATE_TOPIC[56];                // econ/config/<ZONE_TOPIC>/state  (retained)
char CLIENT_ID[32];                         // econ-esp32-<ZONE_TOPIC>

// Runtime configuration (node_config.h). Everything that is a property of the
// INSTALLATION rather than of the wiring — clamp calibration, mains voltage, publish
// cadence, touch sensitivity, the label — is settable over MQTT and persisted to NVS,
// with the compile-time flags above as its defaults. ZONE_TOPIC deliberately stays
// compile-time: it is this node's identity on the bus, the thing its retained LWT and
// its command subscription are keyed on, so changing it at runtime would orphan both.
#include <Preferences.h>
#include <ESPmDNS.h>
#include "node_config.h"

#include "net_provisioning.h"
#include "radar_rd03_state.h"
#include "current_denoiser.h"
// ZONE_LABEL is now gCfg.zoneLabel; this alias keeps the telemetry call site readable.
#define ZONE_LABEL (gCfg.zoneLabel)

// ---------------- HARDWARE PINS ----------------
const int STATUS_LED = 2;   // onboard LED = MQTT link status

// ---------------- SENSORS ----------------
// Wire only what you actually have: each sensor is enabled independently, and NOTHING is
// ever fabricated. A sensor that is absent or fails its read omits its field entirely and
// the engine keeps modelling that quantity itself (mqtt.go uses pointer fields, so
// "not reported" is distinct from a real zero). This matters — a DHT22 drops reads
// routinely, and substituting a plausible-looking constant while still claiming
// tempReal:true would pin the zone's physics, and its AFDD residual, to a number no
// sensor ever measured.
//
// USE_REAL_SENSORS=1 remains supported as shorthand for "DHT + PIR" (older build_flags).
#ifndef USE_REAL_SENSORS
  #define USE_REAL_SENSORS 0
#endif
#ifndef USE_CAMERA
  #define USE_CAMERA 0                // Camera-based ML person detection disabled in main loop
#endif
#ifndef USE_SHT30
  #define USE_SHT30 0                // SHT30 over I2C -> measured temperature + humidity
#endif
#ifndef USE_DHT
  // DHT is the fallback path; SHT30 wins when both are compiled in.
  #define USE_DHT (USE_REAL_SENSORS && !USE_SHT30)
#endif
#ifndef USE_PIR
  #define USE_PIR 1                   // Dual PIR motion sensors -> measured presence
#endif
#ifndef USE_CO2
  #define USE_CO2 1                  // ASAIR ACD1200 NDIR (I2C) -> measured CO2 ppm
#endif
#ifndef USE_MMWAVE
  #define USE_MMWAVE 0               // HLK-LD2410C radar -> presence incl. stationary people
#endif

#ifndef USE_PLUG
  // Plug-load node (APLC): SCT-013 current clamp -> measured plug-circuit watts, plus a
  // second relay that switches the zone's non-critical socket circuit. This is the load a
  // conventional BMS neither meters nor controls — 26.4% of energy in the Hanoi office
  // case study — and the reason this node exists.
  #define USE_PLUG 1
#endif

// ---------------------------------------------------------------------------------
// Sensors that replace a MODELLED value in the twin with a measured one.
//
// Each of the three below exists because the engine currently substitutes an assumption
// where a number should be, and the assumption is load-bearing for something the twin
// claims. They are separate flags so a board fitted with one still reports honestly
// about the other two.
// ---------------------------------------------------------------------------------
#ifndef USE_SUPPLY_TEMP
  // DS18B20 (1-Wire) cable-tied in the indoor unit's discharge louvre.
  //
  // simulation/dynamics.go regresses cooling against flow x (T_room - T_supply) and takes
  // T_supply from a CONSTANT (supplyAirDesignC, 12 C). A split unit's discharge is
  // nowhere near 12 C and it moves with compressor state, so the cooling-authority
  // coefficient — the one the learned setback ceiling depends on — is fit against a
  // number nobody measured. This probe replaces it. Its gap to room temperature is also
  // a far better answer to "is the compressor actually running" than acReal, which only
  // reports that the firmware SENT an IR frame.
  #define USE_SUPPLY_TEMP 0
#endif
#ifndef USE_AC_CLAMP
  // Second SCT-013 on the indoor unit's own supply, GPIO35 (ADC1, input-only).
  //
  // The same regressor takes `flow` from the twin's SIMULATED VAV. A real room on a split
  // AC has no VAV at all. The compressor's power draw IS the cooling drive term, so
  // clamping it turns that regressor from a simulation artifact into a measurement.
  #define USE_AC_CLAMP 0
#endif
#ifndef USE_STRIP
  #define USE_STRIP 1
#endif
#ifndef USE_LUX
  // BH1750 ambient light (I2C 0x23), facing the facade.
  //
  // Solar gain in the engine is `solarGainMultiplier x a constant` — a static per-zone
  // number with no time-of-day or cloud response, so a west facade behaves identically at
  // 08:00 and 16:00. A lux reading is a real irradiance proxy, and it is also what makes
  // daylight-linked dimming possible rather than assumed.
  #define USE_LUX 0
#endif

#if USE_AC_CLAMP
  #ifndef AC_CAL_A_PER_V
    #define AC_CAL_A_PER_V 60.6f   // same burden/front end as the plug clamp
  #endif
  #ifndef AC_MAINS_V
    #define AC_MAINS_V 220.0f
  #endif
#endif

#if USE_SUPPLY_TEMP
  #if USE_IR_AC && defined(IR_RECV_PIN) && IR_RECV_PIN == 26
    #error "gCfg.pinSupplyTemp collides with IR_RECV_PIN (GPIO26) - cannot use both simultaneously"
  #endif
  #include <OneWire.h>
  #include <DallasTemperature.h>
  static OneWire supplyWire(gCfg.pinSupplyTemp);
  static DallasTemperature supplyProbe(&supplyWire);
  static bool supplyProbeReady = false;
#endif

#if USE_CAMERA
  #include "camera/person_detector.h"
#include "esp_camera.h"   // esp_camera_deinit() when the detector has no model
  CameraPersonDetector* cameraDetector = nullptr;
bool cameraReady = false;        // TFLite detector usable; gates processFrame()
bool cameraStreamReady = false;  // esp_camera driver usable; gates frame-buffer access
#endif

#if USE_LUX
  #ifndef BH1750_ADDR
    #define BH1750_ADDR 0x23
  #endif
  static bool luxReady = false;
#endif

#if USE_PLUG
  // SCT-013 on GPIO34: ADC1 channel 6, input-only. Deliberate — ADC2 is unusable while
  // WiFi is up, and an input-only pin can never be misconfigured into driving the clamp.
  // Wiring (SCT-013-000, 100 A : 50 mA current-output variant): burden resistor ~33 Ω
  // across the jack, DC bias the signal to 3.3 V/2 with a 10k/10k divider + 10 µF, tip
  // to GPIO34. The -030 (1 V voltage-output) variant needs only the bias divider.
  // Plug-circuit relay (active HIGH), separate from the lighting relay on GPIO23. Boots
  // ON: a reboot must never leave the room's sockets dead (fail-energized, like a BMS).
  // Calibration lives in node_config.h, which is included above — this file's copy was a
  // shadow that could never take effect, and carried the stale 60.6 while the real value
  // moved to a measured 45.1. Two #ifndef definitions of one constant differ only by
  // include order, which is the kind of thing that is right until it silently is not.
  #ifndef PLUG_MAINS_V
    #define PLUG_MAINS_V 230.0       // Vietnam single-phase nominal
  #endif
#endif

// USE_LUX belongs here too: the BH1750 is an I2C part and shares this bus. Leaving it out
// compiled a LUX-only node against a Wire.begin() that had no <Wire.h> behind it, and also
// skipped the pin-collision guards below for that build.
#if USE_SHT30 || USE_CO2 || USE_LUX
  #include <Wire.h>

  // CRC-8, polynomial 0x31, init 0xFF. Shared: the SHT30 (datasheet 4.12) and the ASAIR
  // ACD1200 (datasheet 2.3.1) specify exactly the same check, so both sensors validate
  // through one routine. Every word is checksummed; we verify all of them, because a corrupt
  // reading published as measured is worse than no reading at all.
  static uint8_t crc8_31(uint8_t msb, uint8_t lsb) {
    uint8_t crc = 0xFF;
    uint8_t bytes[2] = {msb, lsb};
    for (int i = 0; i < 2; i++) {
      crc ^= bytes[i];
      for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
    return crc;
  }
#endif

#if USE_SHT30
  // Sensirion SHT30 on I2C (default address 0x44; ADDR pin high -> 0x45). Preferred over the
  // DHT family for HVAC work: +/-0.2 C beats a DHT11's +/-2 C, which is meaningless against a
  // 2 C control deadband, and I2C avoids the DHT's timing-critical single-wire protocol.
  #ifndef SHT30_ADDR
    #define SHT30_ADDR 0x44
  #endif

  // Single-shot, high repeatability, clock stretching disabled (0x2400). Returns false on a
  // bus error or a failed checksum, so the caller omits the field instead of inventing one.
  bool readSht30(float &t, float &h) {
    Wire.beginTransmission(SHT30_ADDR);
    Wire.write(0x24); Wire.write(0x00);
    if (Wire.endTransmission() != 0) return false;
    delay(20);                                   // >= 15 ms conversion at high repeatability
    if (Wire.requestFrom(SHT30_ADDR, 6) != 6) return false;
    uint8_t d[6];
    for (int i = 0; i < 6; i++) d[i] = Wire.read();
    if (crc8_31(d[0], d[1]) != d[2]) return false;
    if (crc8_31(d[3], d[4]) != d[5]) return false;
    uint16_t rawT = ((uint16_t)d[0] << 8) | d[1];
    uint16_t rawH = ((uint16_t)d[3] << 8) | d[4];
    t = -45.0f + 175.0f * ((float)rawT / 65535.0f);
    h = 100.0f * ((float)rawH / 65535.0f);
    return t > -40.0f && t < 125.0f && h >= 0.0f && h <= 100.0f;
  }
#endif

#if USE_DHT
  #include <DHT.h>
  #ifndef DHT_TYPE
    #define DHT_TYPE DHT22           // hshop.vn stocks DHT11, not DHT22: build -DDHT_TYPE=DHT11
  #endif
  DHT dht(gCfg.pinDht, DHT_TYPE);
#endif



#if USE_MMWAVE
  // 24 GHz FMCW presence radar. A PIR detects *motion* and infers presence, so a person
  // typing quietly at a desk reads as an empty room within minutes — the classic "lights
  // drop on a full meeting" failure. The radar resolves micro-movement down to breathing
  // and holds its output high for a genuinely stationary person, which makes it the
  // honest presence sensor for an office. Verified-compatible modules (same contract,
  // "output high level when sensing", per each maker's spec):
  //   HLK-LD2410C  — OUT pin, 5 V supply, 3.3 V logic out
  //   Ai-Thinker Rd-03 / Rd-03_V2 — OT2 pin (pin 5), 3.3 V supply (3.0-3.6 V)
  // Either wires straight to the GPIO with no level shifter. The modules' UART side is
  // only for tuning gates/thresholds and is not needed here.
#endif

#if USE_CO2
  // ASAIR ACD1200 NDIR CO2 sensor, I2C mode — shares the SHT30's bus. (MH-Z19 is not sold in
  // Vietnam; the ACD1200 is the stocked NDIR part.) The sensor defaults to I2C with Pin5 (SET)
  // left floating; pulling Pin5 low selects UART instead, which runs at 1200 baud and is not
  // worth the wire. Range 400-5000 ppm, +/-(50 ppm + 5% of reading), 120 s preheat.
  //
  // WIRING WARNING (datasheet 2.2): the ACD1200's I2C lines are internally pulled up to *5 V*.
  // The ESP32's GPIOs are 3.3 V and are not 5 V tolerant, so this sensor needs a bidirectional
  // I2C level shifter between it and the board — do not wire it straight to SDA/SCL.
  #ifndef ACD1200_ADDR
    #define ACD1200_ADDR 0x2A          // 7-bit; the datasheet writes it as 0x54 = 0x2A << 1
  #endif

  // Reads gas concentration (command 0x0300). Uplink is 9 bytes:
  //   PPM3 PPM2 CRC | PPM1 PPM0 CRC | TEMP1 TEMP0 CRC   (every two bytes followed by a CRC)
  // Concentration is assembled MSB-first across the two CRC-checked word pairs. Returns false
  // on a bus error or any failed checksum, so the caller omits "co2" rather than inventing an
  // air-quality reading the building never measured.
  bool readCo2(int &ppm) {
    if (millis() < 120000) {
      Serial.printf("[co2] Sensor is in 120s preheat (%.0f s remaining). May NACK or read 0.\n", (120000 - millis()) / 1000.0);
    }
    
    // ASAIR/Aosong sensors aggressively sleep their I2C interface.
    // A dummy write is strictly required to wake the MCU before it will ACK the real command.
    Wire1.beginTransmission(ACD1200_ADDR);
    Wire1.endTransmission();
    delay(5);

    Wire1.beginTransmission(ACD1200_ADDR);
    Wire1.write(0x03); Wire1.write(0x00);
    if (Wire1.endTransmission() != 0) {
      Serial.println("[co2] endTransmission failed on Wire1 (device not found or I2C bus error)");
      return false;
    }
    delay(5);
    int bytesRead = Wire1.requestFrom((uint16_t)ACD1200_ADDR, (uint8_t)9, (bool)true);
    if (bytesRead < 6) {
      Serial.printf("[co2] requestFrom failed on Wire1, only read %d bytes\n", bytesRead);
      return false;
    }
    uint8_t d[9] = {0};
    for (int i = 0; i < bytesRead; i++) d[i] = Wire1.read();
    
    // Validate both word pairs' CRCs
    if (crc8_31(d[0], d[1]) != d[2] || crc8_31(d[3], d[4]) != d[5]) {
      Serial.printf("[co2] CRC failed: d[0]=%02X d[1]=%02X d[2]=%02X | d[3]=%02X d[4]=%02X d[5]=%02X\n", d[0], d[1], d[2], d[3], d[4], d[5]);
      return false;
    }
    
    // The ACD1200 concentration is a 32-bit integer spanning the first two word pairs
    ppm = ((int)d[0] << 24) | ((int)d[1] << 16) | ((int)d[3] << 8) | d[4];
    
    if (ppm < 300 || ppm > 10000) {
      Serial.printf("[co2] Bounds check failed, ppm=%d\n", ppm);
      return false;
    }
    return true;
  }

  // The ACD1200 ships in AUTOMATIC baseline calibration (datasheet 1.1): 24 h after
  // power-on and every 7 days after, it re-zeroes by assuming the lowest concentration it
  // saw recently was outdoor air. In an office that empties overnight that is free and
  // correct. In a continuously occupied space — a server room, a 24/7 floor — the room
  // never gives it that outdoor hour, so the sensor quietly drags its baseline up to an
  // occupied reading and under-reports from then on while looking perfectly healthy.
  // Build with -DCO2_ABC_OFF=1 for such spaces: at boot the node switches the sensor to
  // MANUAL calibration and verifies the write. Manual mode trades silent drift for a
  // maintenance task (single-point calibration, command 0x5204, in known air).
  #ifndef CO2_ABC_OFF
    #define CO2_ABC_OFF 0
  #endif
  #if CO2_ABC_OFF
  bool co2DisableAutoCal() {
    // Set calibration mode = manual: 0x5306 + data 0x0000 + CRC over the data bytes
    // (datasheet table 7; its own example CRC 0x81 = crc8_31(0x00,0x00), validated).
    Wire1.beginTransmission(ACD1200_ADDR);
    Wire1.write(0x53); Wire1.write(0x06);
    Wire1.write(0x00); Wire1.write(0x00);
    Wire1.write(crc8_31(0x00, 0x00));
    if (Wire1.endTransmission() != 0) return false;
    delay(10);                                   // datasheet: >5 ms before the readback
    // Read the mode back (tables 8/9): the set command alone proves nothing, so require
    // a CRC-valid response whose low data byte says manual (0 = manual, 1 = automatic).
    Wire1.beginTransmission(ACD1200_ADDR);
    Wire1.write(0x53); Wire1.write(0x06);
    if (Wire1.endTransmission() != 0) return false;
    delay(5);
    if (Wire1.requestFrom(ACD1200_ADDR, 3) != 3) return false;
    uint8_t d[3];
    for (int i = 0; i < 3; i++) d[i] = Wire1.read();
    if (crc8_31(d[0], d[1]) != d[2]) return false;
    return d[1] == 0x00;
  }
  #endif
#endif

// Zero-wiring presence demo (ignored when a real presence sensor is compiled in): T9 = GPIO32 capacitive
// touch. Touching the bare pin (or a jumper wire in it) drops the reading well below
// the boot-time baseline -> occupied. Publishes immediately on change for a snappy demo.
#define USE_TOUCH_PRESENCE 1
#if !USE_CAMERA && !USE_PIR && !USE_MMWAVE && USE_TOUCH_PRESENCE
  const int TOUCH_PIN = T9;      // GPIO32
  #define TOUCH_OCCUPANTS (gCfg.touchOccupants) // headcount reported while touched
  int touchBaseline = 0;         // calibrated in setup()
  bool touchState = false;       // debounced presence state
  // A single threshold flaps when a bare-finger reading hovers right at the line
  // (observed live: occupancy oscillating 3<->0 while held). Hysteresis — enter well
  // below baseline, leave only after recovering most of the way — plus a requirement
  // of 3 consecutive agreeing samples makes the state boringly stable.
  bool touchOccupied() {
    static int agree = 0;
    int v = touchRead(TOUCH_PIN);
    // Thresholds are runtime-configurable: a bare pin, a jumper wire and a taped-down
    // foil pad all sit at different fractions of baseline, and that is a property of how
    // this particular node was installed rather than of the firmware.
    bool raw = touchState ? (v < touchBaseline * gCfg.touchExitPct / 100)   // stay until clearly released
                          : (v < touchBaseline * gCfg.touchEnterPct / 100); // enter only on a firm touch
    if (raw == touchState) { agree = 0; return touchState; }
    if (++agree >= 3) { agree = 0; touchState = raw; }
    return touchState;
  }
#endif

WiFiClient   espClient;
PubSubClient client(espClient);
WiFiUDP      udpClient;

// Global debounced presence state for periodic telemetry
bool globalDebouncedPresence = false;


// Helper to broadcast presence tracking telemetry (camera disabled)
void broadcastTrackingTelemetry(bool present) {
}

unsigned long lastPublish = 0;
unsigned long lastReconnectAttempt = 0;

// actuated state (echoed back in telemetry for diagnostics)
bool  lightsOn = true;
float hvacSetpointC = 24.0;
// Whether the AC is currently commanded ON. The engine's whole vacancy saving is a
// HVAC_SET:OFF, so "off" has to be a state this node can actually be in, not a setpoint.
bool  hvacPowerOn    = true;

// ---------------- WIFI ----------------
void setupWifi() {
  WiFi.mode(WIFI_STA);
  String savedSsid, savedPass;
  const bool haveSaved = wifiLoadSaved(&savedSsid, &savedPass);
  const char* useSsid = haveSaved ? savedSsid.c_str() : WIFI_SSID;
  const char* usePass = haveSaved ? savedPass.c_str() : WIFI_PASS;
  WiFi.begin(useSsid, usePass);
  Serial.printf("[wifi] connecting to %s (%s)", useSsid,
                haveSaved ? "saved in NVS" : "compiled default");
  // Bounded, and never fatal. The USB console in loop() is the only way to provision
  // a node whose saved network is out of range, so setup() must not block on the old
  // credentials: an unbounded wait here means the board never reaches loop(), never
  // answers "[wifi] scan", and prints dots until someone reflashes it. Continuing
  // offline costs nothing -- loop() already retries MQTT every 5 s.
  const unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_CONNECT_TIMEOUT_MS) {
    delay(400);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
    MDNS.begin(CLIENT_ID);
  } else {
    Serial.printf("\n[wifi] not connected after %lu s -- continuing offline.\n",
                  WIFI_CONNECT_TIMEOUT_MS / 1000);
    Serial.println("[wifi] provision over USB: \"[wifi] scan\", then \"[wifi] connect <n> \\\"PASS\\\"\"");
  }
}

#include "hvac_ir.h"

#include "power_sense.h"

#include "commands.h"

#include "telemetry_publish.h"

// ---------------- MQTT CONNECT ----------------
bool mqttConnect() {
  if (!resolveBroker()) return false;
  client.setServer(gBrokerIp, MQTT_PORT);
  Serial.printf("[mqtt] connecting to %s (%s)...", gMqttHost, gBrokerIp.toString().c_str());
  // LWT: broker publishes "offline" (retained) on STATUS_TOPIC if this node drops.
  //
  // Credentials come from wifi_secrets.h (MQTT_USER / MQTT_PASS), because the shipped
  // broker refuses anonymous clients — econ/commands/<zone> closes a relay on a mains
  // circuit, and an open broker means anyone on the network can close it. Nodes without
  // the defines still build and connect anonymously, which only works against
  // mosquitto.dev.conf; rc=5 (unauthorized) is what a real broker answers instead.
#if defined(MQTT_USER) && defined(MQTT_PASS)
  bool ok = client.connect(CLIENT_ID, MQTT_USER, MQTT_PASS, STATUS_TOPIC, 0, true, "offline");
#else
  bool ok = client.connect(CLIENT_ID, nullptr, nullptr, STATUS_TOPIC, 0, true, "offline");
#endif
  if (ok) {
    Serial.println(" connected");
    client.publish(STATUS_TOPIC, "online", true);
    client.subscribe(COMMAND_TOPIC);
    // Runtime config. A RETAINED message on this topic is redelivered on every reconnect,
    // so a node that is reflashed or power-cycled picks its site calibration back up from
    // the broker even if its NVS was erased — and cfgApplyJson no-ops when the retained
    // message matches what is already running, so the replay costs nothing.
    client.subscribe(CONFIG_TOPIC);
    publishConfigState();
    digitalWrite(STATUS_LED, HIGH);
  } else {
    // rc=5 is "not authorized" — almost always a missing or wrong MQTT_USER/MQTT_PASS in
    // wifi_secrets.h against an authenticated broker. Naming it saves an hour of
    // suspecting the WiFi.
    Serial.printf(" failed rc=%d%s\n", client.state(),
                  client.state() == 5 ? " (not authorized - check MQTT_USER/MQTT_PASS)" : "");
    digitalWrite(STATUS_LED, LOW);
  }
  return ok;
}


#include <WiFiServer.h>
#include <WiFiClient.h>

#if USE_CAMERA
WiFiServer streamServer(8080);

void handleCameraStream() {
  WiFiClient client = streamServer.available();
  if (client) {
    if (client.connected()) {
      // Read request
      while(client.available()) client.read();
      
      if (!cameraStreamReady) return;   // no driver, no frame buffer to hand out
      const uint8_t* frame = cameraDetector->getDriver().getFrameBuffer();
      if (!frame) {
         client.println("HTTP/1.1 503 Service Unavailable");
         client.stop();
         return;
      }
      
      // BMP header, 8-bit grayscale 160x120. STATIC, not on the stack: 1078 bytes of local
      // array on the Arduino loop task's 8 KB stack, on top of what the WiFi client needs
      // for a 19 KB write, overflowed it — the node abort()ed the moment a client connected
      // and the request died after the header. It is a fixed, single-threaded buffer, so
      // .bss is where it belongs.
      static uint8_t bmpHeader[1078];
      memset(bmpHeader, 0, sizeof(bmpHeader));
      bmpHeader[0] = 'B'; bmpHeader[1] = 'M';
      uint32_t fileSize = 1078 + 19200;
      memcpy(bmpHeader + 2, &fileSize, 4);
      uint32_t offset = 1078; memcpy(bmpHeader + 10, &offset, 4);
      bmpHeader[14] = 40; // DIB Header size
      uint32_t width = 160;
      int32_t height = -120; // Top-down
      memcpy(bmpHeader + 18, &width, 4);
      memcpy(bmpHeader + 22, &height, 4);
      bmpHeader[26] = 1; // Planes
      bmpHeader[28] = 8; // Bits per pixel
      uint32_t dataSize = 19200;
      memcpy(bmpHeader + 34, &dataSize, 4);
      
      // Grayscale palette
      for (int i = 0; i < 256; i++) {
        bmpHeader[54 + i*4 + 0] = i; // B
        bmpHeader[54 + i*4 + 1] = i; // G
        bmpHeader[54 + i*4 + 2] = i; // R
        bmpHeader[54 + i*4 + 3] = 0;
      }

      client.println("HTTP/1.1 200 OK");
      client.println("Content-Type: image/bmp");
      client.println("Connection: close");
      client.println();
      
      client.write(bmpHeader, 1078);
      // Chunked, so a slow or stalled reader cannot park the whole frame inside one blocking
      // write. Bail out the moment the peer goes away instead of spinning on a dead socket.
      const size_t CHUNK = 1024;
      for (size_t sent = 0; sent < 19200; sent += CHUNK) {
        if (!client.connected()) break;
        size_t n = (19200 - sent < CHUNK) ? (19200 - sent) : CHUNK;
        if (client.write(frame + sent, n) != n) break;
      }
      client.flush();
    }
    client.stop();
  }
}
#endif

void setup() {
  Serial.begin(115200);
  // Load the persisted configuration FIRST: every announcement printed below (clamp
  // calibration, touch threshold, publish cadence) must report what this node will
  // actually run with, not the compiled default it may already have been told to replace.
  cfgLoad();
  if (gCfg.pinLightingRelay != 255) {
    pinMode(gCfg.pinLightingRelay, OUTPUT);
  }
  if (gCfg.pinIrAc != kIrPin) {
    Serial.printf("[hvac] WARNING: pinIrAc is configured as GPIO%d but the IR objects were "
                  "built on GPIO%d and cannot be moved at runtime. Every frame is going out "
                  "on GPIO%d; reflash with -DIR_PIN=%d to actually change it.\n",
                  gCfg.pinIrAc, kIrPin, kIrPin, gCfg.pinIrAc);
  }
  pinMode(kIrPin, OUTPUT);
#if USE_IR_AC
  customIrSend.begin();
  // IRac has no begin() — the per-protocol sender initialises itself on send. What DOES
  // need doing is seeding the state struct to the library's defaults, so any field this
  // firmware does not set explicitly holds a sane value rather than whatever was on the
  // stack.
  IRac::initState(&ac.next);
  // Ask the library, rather than assuming: a protocol name can compile fine and still be
  // send-unsupported in this build of IRremoteESP8266, and finding that out at the first
  // setpoint command (silently) is exactly the failure this whole change is about.
  irAcReady = IRac::isProtocolSupported(gIrProtocol);
  if (irAcReady) {
    Serial.printf("[hvac] IR AC control ACTIVE: %s on GPIO%d\n",
                  typeToString(gIrProtocol).c_str(), gCfg.pinIrAc);
  } else {
    Serial.printf("[hvac] WARNING: protocol %s is not send-supported by this library build; "
                  "setpoints will NOT reach the AC (acReal:false)\n",
                  typeToString(gIrProtocol).c_str());
  }
#else
  Serial.printf("[hvac] no IR AC compiled in (build -DUSE_IR_AC=1); setpoints are parsed "
                "but not transmitted (acReal:false)\n");
#endif
  pinMode(STATUS_LED, OUTPUT);
  setLights(true);
#if USE_SHT30 || USE_CO2 || USE_LUX
  Wire.begin(gCfg.pinI2cSda, gCfg.pinI2cScl);
  Serial.printf("[i2c] bus up on SDA=GPIO%d SCL=GPIO%d\n", gCfg.pinI2cSda, gCfg.pinI2cScl);
#if USE_CO2
  Wire1.begin(27, 5);
  Serial.printf("[i2c] secondary bus (Wire1) up for CO2 on SDA=GPIO27 SCL=GPIO5\n");
#endif
#endif
#if USE_SHT30
  Serial.printf("[sht30] expecting I2C addr 0x%02X\n", SHT30_ADDR);
#endif
#if USE_DHT
  dht.begin();
  Serial.printf("[dht] sensor on GPIO%d\n", gCfg.pinDht);
#endif
#if USE_PIR
  pinMode(gCfg.pinPir1, INPUT);
  pinMode(gCfg.pinPir2, INPUT);
  Serial.printf("[pir] dual PIR sensors initialized on GPIO%d and GPIO%d\n", gCfg.pinPir1, gCfg.pinPir2);
#endif
#if USE_MMWAVE
  // Two Rd-03_V2 heads. OT2 is push-pull, so it holds its level against the internal
  // pull -- that is how a connected head is told apart from an open pin, which matters
  // because an unconnected input reads HIGH on a pin with a pull-up (GPIO15/MTDO has
  // one) and reads as random toggling on a bare pin, and BOTH look like presence.
  // GPIO34-39 are input-only with no internal pulls, so there the evidence is instead
  // that the reading is steady rather than noisy.
  for (int i = 0; i < 2; i++) {
    const uint8_t pin = (i == 0) ? gCfg.pinMmwave : gCfg.pinMmwave2;
    if (pin == 255) continue;
    if (pin >= 34) {
      pinMode(pin, INPUT);
      int hi = 0;
      for (int k = 0; k < 64; k++) { hi += digitalRead(pin) == HIGH; delayMicroseconds(200); }
      Serial.printf("[mmwave] RD03-%d GPIO%d input-only; %d/64 high (%s)\n", i + 1, pin, hi,
                    (hi == 64 || hi == 0) ? "steady -> driven" : "noisy -> OPEN, nothing on this pin");
    } else {
      pinMode(pin, INPUT_PULLDOWN); delay(5);
      const bool heldHigh = digitalRead(pin) == HIGH;
      pinMode(pin, INPUT_PULLUP);   delay(5);
      const bool heldLow  = digitalRead(pin) == LOW;
      pinMode(pin, INPUT);
      // Conclusive on a clean GPIO: holding HIGH against the internal pull-down, or LOW
      // against the internal pull-up, means something is actively driving the pin.
      //
      // GPIO15 is the exception and must be called out, not quietly folded in: it is a
      // strapping pin and DevKit boards fit an external pull-up far stronger than the
      // internal pull-down, so it reads "driven high" even with the head unplugged. That
      // caveat once led to the opposite of the truth being reported here, so the pin is
      // named explicitly rather than the result being hedged for every pin.
      const bool open_ = !heldHigh && !heldLow;
      const bool untestable = (pin == 15) || (pin >= 34);
      gOt2Driven[i] = untestable ? true : !open_;   // untestable pins get the benefit of the doubt
      const char* verdict;
      if (untestable)        verdict = (pin >= 34)
                               ? "input-only pin, no internal pulls — NOT TESTABLE"
                               : "GPIO15 has an external pull-up — NOT TESTABLE";
      else if (heldHigh)     verdict = "DRIVEN HIGH by the module (OT2 connected, sensing)";
      else if (heldLow)      verdict = "DRIVEN LOW by the module (OT2 connected, clear)";
      else                   verdict = "FLOATS BOTH WAYS -- OPEN, nothing on this pin";
      Serial.printf("[mmwave] RD03-%d GPIO%d pull test: pulldown=%s pullup=%s -> %s\n", i + 1, pin,
                    heldHigh ? "HIGH" : "low", heldLow ? "LOW" : "high", verdict);
    }
  }
  Serial.printf("[mmwave] 24GHz presence radar on GPIO%d%s, OT2 digital output (holds for "
                "stationary occupants)\n", gCfg.pinMmwave,
                gCfg.pinMmwave2 == 255 ? "" : " + a second head");
#endif
#if USE_MMWAVE_UART || USE_MMWAVE2_UART
  // OT2 alone cannot explain a head that never clears; its range gate and disappearance
  // delay can, and both live behind the UART. Read them out at boot so the numbers are
  // on the console instead of being guessed at.
  //
  // Each head is configured independently: they are separate modules with their own flash,
  // so a setting written to one says nothing about the other. Both are reported even when
  // only one answers, because "head 2 did not ACK" is itself the diagnosis.
  // Both heads stream continuously whenever they are not in command mode, and only one is
  // being talked to at a time -- so the other one is filling its RX buffer with nobody
  // reading. The default 256 bytes is about six frames; head 2 overruns it during head 1's
  // sniff. Give each port room and drain it before use.
  #if USE_MMWAVE_UART
    Serial2.setRxBufferSize(2048);
    Serial2.begin(115200, SERIAL_8N1, MMWAVE_UART_RX, MMWAVE_UART_TX);
  #endif
  #if USE_MMWAVE2_UART
    Serial1.setRxBufferSize(2048);
    Serial1.begin(115200, SERIAL_8N1, MMWAVE2_UART_RX, MMWAVE2_UART_TX);
  #endif
  delay(50);
  for (int h = 0; h < 2; h++) {
    Stream* io = nullptr;
    const char* label = nullptr;
    if (h == 0) {
  #if USE_MMWAVE_UART
      io = &Serial2; label = "head1";
  #endif
    } else {
  #if USE_MMWAVE2_UART
      io = &Serial1; label = "head2";
  #endif
    }
    if (!io) continue;
    const int headIndex = h;
    // A UART whose buffer overran while we were busy with the other head can stay wedged.
    // Re-initialising the port costs nothing here and removes that as a variable.
    if (h == 0) {
  #if USE_MMWAVE_UART
      Serial2.end(); Serial2.setRxBufferSize(2048);
      Serial2.begin(115200, SERIAL_8N1, MMWAVE_UART_RX, MMWAVE_UART_TX);
  #endif
    } else {
  #if USE_MMWAVE2_UART
      Serial1.end(); Serial1.setRxBufferSize(2048);
      Serial1.begin(115200, SERIAL_8N1, MMWAVE2_UART_RX, MMWAVE2_UART_TX);
  #endif
    }
    delay(50);
    while (io->available()) (void)io->read();
    gRadarAlive[headIndex] = rd03::dumpConfig(*io, label);
    if (!gRadarAlive[headIndex]) {
      // Only the UART is lost here, not the head. OT2 and the serial link are separate
      // wires and are judged separately: the pull test above drives the pin both ways and
      // can tell a driven pin from a floating one, so a head whose OT2 passed that test
      // still contributes presence and still publishes radarN. What a dead UART costs is
      // the per-gate energy array and the ability to configure the module — nothing else.
      // (This line used to claim the OT2 was ignored and omitted. It was, once, before the
      // two channels were separated; saying so now sends whoever reads the log hunting a
      // presence fault that does not exist.)
      Serial.printf("[mmwave] %s UART is NOT ANSWERING — no gate array, and RD03_SET_* cannot be "
                    "applied to this head. Its OT2 pin is unaffected and still reports presence: "
                    "the pull test proved that pin is driven, which a floating pin cannot fake "
                    "against an internal pulldown.\n", label);
    }
  #if defined(RD03_SET_MAX_GATE) && defined(RD03_SET_DELAY_S)
    rd03::applyConfig(*io, label, (uint32_t)RD03_SET_MIN_GATE, (uint32_t)RD03_SET_MAX_GATE,
                      (uint32_t)RD03_SET_DELAY_S);
    rd03::dumpConfig(*io, label);
  #endif
  #ifdef RD03_SNIFF_S
    rd03::sniff(*io, label, (uint32_t)RD03_SNIFF_S);
  #endif
  #ifdef RD03_FRAME_FILTERS
    if (gRadarAlive[headIndex]) {
      #ifndef RD03_FRAMES_DETECT
        #define RD03_FRAMES_DETECT -1
      #endif
      #ifndef RD03_FRAMES_VANISH
        #define RD03_FRAMES_VANISH -1
      #endif
      rd03::frameFilters(*io, label, RD03_FRAMES_DETECT, RD03_FRAMES_VANISH);
    }
  #endif
  #ifdef RD03_DUMP_THRESHOLDS
    if (gRadarAlive[headIndex]) {
      // Grab one live frame's energy profile first, so thresholds and energy are compared
      // against each other rather than against a remembered number.
      uint32_t e[32] = {0}; int gcount = 0;
      if (rd03::enableReporting(*io, label)) {
        uint8_t det = 0; uint16_t dist = 0;
        for (int tries = 0; tries < 40; tries++) {
          if (rd03::readReportFrame(*io, &det, &dist, e, 32, &gcount, 500)) break;
        }
      }
      rd03::dumpThresholds(*io, label, e, gcount);
    }
  #endif
    // Leave the head streaming. The reporting frame carries the module's own detection flag
    // and the range it measured, which is strictly more than OT2's single bit -- and it is
    // a real measurement, so the dashboard can show a distance instead of implying one.
    if (gRadarAlive[headIndex]) {
      gRadarStream[headIndex] = rd03::enableReporting(*io, label);
    }
  }
#endif
#if USE_CO2
  #if CO2_ABC_OFF
  if (co2DisableAutoCal()) {
    Serial.println("[co2] auto-calibration OFF, manual mode confirmed (24/7-occupied space)");
  } else {
    // Say so loudly: a 24/7 deployment that silently keeps ABC on will drift low.
    Serial.println("[co2] WARNING: could not confirm manual calibration; ABC remains ON");
  }
  #endif
  // Scan the secondary bus before trusting any read. "co2 omitted" covers four distinct
  // faults — nothing on the bus, a device at another address, a protocol mismatch, and a
  // reading out of bounds — and only the first two are visible from a scan. Without it the
  // level shifter's most common wiring error (AVCC unpowered, so the 5 V side has no
  // pull-ups and the sensor can never ACK) looks identical to a dead sensor.
  {
    // Before scanning, look at the lines themselves. An I2C bus at rest must float HIGH on
    // both wires. If either reads LOW with the ESP32's own pull-up engaged, nothing on the
    // bus can ever ACK and no scan result means anything: the line is shorted, or the
    // level shifter's FET is holding it down because its rail is unpowered. That is a
    // different fault from "the sensor is absent", and the scan alone cannot tell them apart.
    // Detect whether an EXTERNAL pull-up is present and powered on each line, which is the
    // question "is the level shifter alive?" reduces to. A BSS138 module carries 10k
    // pull-ups on both sides, but they only pull when that side's rail is powered — so a
    // shifter with BVCC unwired, a dead shifter, and no shifter at all are all the same
    // electrically, and all of them make every scan return nothing.
    //
    // The ESP32's own INPUT_PULLUP cannot answer this: it would hold the line high by
    // itself and every case would look identical. So drive the line low to discharge it,
    // release it as a plain floating input, and look. An external 10k against a few tens
    // of pF snaps back high in well under a microsecond; a line with nothing on it stays
    // down, held only by leakage. This needs no multimeter and no probing.
    auto probeLine = [](uint8_t pin) -> bool {
      pinMode(pin, OUTPUT);
      digitalWrite(pin, LOW);
      delayMicroseconds(50);          // discharge the line and any cable capacitance
      pinMode(pin, INPUT);            // release: NO internal pull-up, so only external pulls
      delayMicroseconds(20);          // 10k x ~20 pF settles in ~0.2 us; 20 us is ample
      return digitalRead(pin) == HIGH;
    };
    bool sdaPulled = probeLine(27), sclPulled = probeLine(5);
    Serial.printf("[co2] Wire1 pull-up probe: SDA(GPIO27)=%s SCL(GPIO5)=%s -> %s\n",
                  sdaPulled ? "pulled HIGH" : "stays LOW",
                  sclPulled ? "pulled HIGH" : "stays LOW",
                  (sdaPulled && sclPulled)
                    ? "external pull-ups ARE present and powered: the shifter's low-voltage"
                      " side is alive, so look past it (5V rail, AVCC, sensor wiring, address)"
                    : "NO powered external pull-up on at least one line. Nothing on this bus"
                      " can ever ACK. Check BVCC=3.3V, AVCC=5V, both grounds tied, and the"
                      " module actually seated — before suspecting the sensor.");
    Wire1.begin(27, 5);   // reclaim the pins after the probe

    int found = 0;
    Serial.print("[co2] scanning Wire1 (SDA=GPIO27 SCL=GPIO5):");
    for (uint8_t addr = 0x08; addr < 0x78; addr++) {
      Wire1.beginTransmission(addr);
      if (Wire1.endTransmission() == 0) {
        Serial.printf(" 0x%02X", addr);
        found++;
      }
    }
    if (found == 0) {
      Serial.println(" nothing responded.\n"
                     "[co2] no device on the bus at all. Check, in this order: the shifter's"
                     " AVCC on 5V and BVCC on 3.3V (both sides need power for their pull-ups),"
                     " AGND/BGND tied to the ESP32 GND, the sensor on the A/high-voltage side"
                     " and GPIO27/GPIO5 on the B/low-voltage side (not swapped), and 5V on the"
                     " sensor's VCC.");
    } else {
      Serial.printf("\n[co2] %d device(s) answered; ACD1200 is expected at 0x%02X\n",
                    found, ACD1200_ADDR);
    }
  }
  Serial.printf("[co2] ACD1200 expected at I2C 0x%02X (120 s preheat; needs a 5V<->3.3V level shifter)\n",
                ACD1200_ADDR);
#endif
#if USE_PLUG
  pinMode(gCfg.pinPlugRelay, OUTPUT);
  setPlug(true);  // fail-energized: sockets live from boot until the engine sheds them
  analogReadResolution(12);
  Serial.printf("[plug] SCT-013 on GPIO%d (cal %.1f A/V), relay on GPIO%d\n",
                gCfg.pinPlugAdc, (double)gCfg.plugCalAPerV, gCfg.pinPlugRelay);
#endif
#if USE_STRIP
  analogReadResolution(12);
  Serial.printf("[strip] ACS712 on GPIO%d (cal %.1f A/V) — power strip metering\n", gCfg.pinStripAdc, (double)gCfg.stripCalAPerV);
#endif
#if USE_SUPPLY_TEMP
  supplyProbe.begin();
  supplyProbeReady = supplyProbe.getDeviceCount() > 0;
  if (supplyProbeReady) {
    supplyProbe.setResolution(12);
    Serial.printf("[supply] DS18B20 on GPIO%d — measured supply air replaces the engine's "
                  "design constant for this zone\n", gCfg.pinSupplyTemp);
  } else {
    Serial.printf("[supply] no DS18B20 found on GPIO%d — supplyC omitted, engine keeps its "
                  "design value\n", gCfg.pinSupplyTemp);
  }
#endif
#if USE_AC_CLAMP
  analogReadResolution(12);
  Serial.printf("[ac] SCT-013 on the AC supply, GPIO%d (cal %.1f A/V) — measured compressor "
                "power replaces the twin's simulated VAV flow for this zone\n",
                gCfg.pinAcClampAdc, (double)gCfg.acCalAPerV);
#endif
#if USE_LUX
  {
    float probe;
    luxReady = readLux(probe);
    Serial.printf("[lux] BH1750 at 0x%02X %s\n", BH1750_ADDR,
                  luxReady ? "responding — measured daylight replaces the static solar constant"
                           : "NOT responding — lux omitted");
  }
#endif
#if !USE_PIR && !USE_MMWAVE && USE_TOUCH_PRESENCE
  // Calibrate the untouched touch level; a touch reads far below this baseline.
  long acc = 0;
  for (int i = 0; i < 16; i++) { acc += touchRead(TOUCH_PIN); delay(10); }
  touchBaseline = acc / 16;
  Serial.printf("[touch] baseline=%d enter<%d exit<%d (GPIO32, cfg %u/%u%%)\n",
                touchBaseline,
                touchBaseline * gCfg.touchEnterPct / 100,
                touchBaseline * gCfg.touchExitPct / 100,
                gCfg.touchEnterPct, gCfg.touchExitPct);
#endif

  snprintf(TELEMETRY_TOPIC,    sizeof(TELEMETRY_TOPIC),    "econ/telemetry/%s",   ZONE_TOPIC);
  snprintf(COMMAND_TOPIC,      sizeof(COMMAND_TOPIC),      "econ/commands/%s",    ZONE_TOPIC);
  snprintf(STATUS_TOPIC,       sizeof(STATUS_TOPIC),       "econ/status/%s",      ZONE_TOPIC);
  snprintf(CONFIG_TOPIC,       sizeof(CONFIG_TOPIC),       "econ/config/%s",      ZONE_TOPIC);
  snprintf(CONFIG_STATE_TOPIC, sizeof(CONFIG_STATE_TOPIC), "econ/config/%s/state", ZONE_TOPIC);
  snprintf(CLIENT_ID,          sizeof(CLIENT_ID),          "econ-esp32-%s",       ZONE_TOPIC);

  // snprintf truncates instead of failing, so a long ZONE_TOPIC would silently produce a
  // topic nobody is subscribed to. Check every one rather than discover it as "the node
  // publishes but the engine never sees it".
  {
    struct { const char* name; const char* val; size_t cap; } topics[] = {
      { "TELEMETRY", TELEMETRY_TOPIC,    sizeof(TELEMETRY_TOPIC) },
      { "COMMAND",   COMMAND_TOPIC,      sizeof(COMMAND_TOPIC) },
      { "STATUS",    STATUS_TOPIC,       sizeof(STATUS_TOPIC) },
      { "CONFIG",    CONFIG_TOPIC,       sizeof(CONFIG_TOPIC) },
      { "CFGSTATE",  CONFIG_STATE_TOPIC, sizeof(CONFIG_STATE_TOPIC) },
      { "CLIENTID",  CLIENT_ID,          sizeof(CLIENT_ID) },
    };
    for (auto& t : topics) {
      if (strlen(t.val) >= t.cap - 1) {
        Serial.printf("[mqtt] FATAL: %s topic TRUNCATED at %u chars (\"%s\") — zone name is "
                      "too long. This node would talk on the wrong topic.\n",
                      t.name, (unsigned)t.cap, t.val);
      }
    }
  }

  setupWifi();
#if USE_CAMERA
  streamServer.begin();
#endif
  mqttLoadHost();
  // The server is set in mqttConnect() once the host resolves: an mDNS name has no
  // address yet at this point in setup().
  Serial.printf("[mqtt] broker configured as \"%s\"\n", gMqttHost);
  client.setBufferSize(2048);   // must be >= the telemetry StaticJsonDocument, see publish()
  client.setCallback(onMessage);

#if USE_CAMERA
  cameraDetector = new CameraPersonDetector();
  bool detectorOk = cameraDetector->init();
  // The camera DRIVER and the ML DETECTOR fail independently, and conflating them cost the
  // node a reboot loop. esp_camera can be up and streaming real frames while TFLite refuses
  // the model — which is exactly the state this board is in. Track the two separately so a
  // dead model does not also kill the video stream, and so neither can be driven blind.
  cameraStreamReady = cameraDetector->getDriver().isHardwarePresent();
  if (detectorOk) {
    cameraReady = true;
      Serial.printf("[camera] initialized. model takes %u bytes SRAM\n", (unsigned int)cameraDetector->getArenaUsedBytes());
      cameraDetector->setZoneAndSensorId(ZONE_TOPIC, CLIENT_ID);
  } else {
      // Latch the failure. loop() previously called processFrame() whenever the pointer was
      // non-null, so a detector that failed init was driven anyway — straight into an
      // abort() and a reboot loop. A camera that cannot start must degrade to no occupancy
      // data, never take the node down with it.
      cameraReady = false;
      // Deliberately KEEP the capture pipeline running. Inference for this node happens on
      // the host, not on the ESP32: frames go out over the BMP stream on :8080 for occupancy
      // and for reading the air conditioner's branding. The on-device TFLite model being a
      // stub therefore does not mean the camera is useless — it means the local detector is
      // the wrong consumer. Only the local inference path is disabled below.
      if (cameraStreamReady) {
        Serial.println("[camera] capture pipeline STAYS UP — frames are served to the host "
                       "for offloaded inference on http://<node-ip>:8080");
      }
      Serial.printf("[camera] detector unavailable — occupancy reports 0 and the detector is "
                    "NOT polled. Camera hardware itself is %s.\n",
                    cameraStreamReady ? "UP (frames still available to the stream)"
                                      : "down as well");
  }
#endif

}

void loop() {
#if USE_CAMERA
  handleCameraStream();
  if (cameraDetector && cameraReady) {
    static unsigned long lastCameraPoll = 0;
    if (millis() - lastCameraPoll >= 150) {
      lastCameraPoll = millis();
      cameraDetector->processFrame();
    }
  }
#endif
  while (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line == "[wifi] scan") {
      Serial.println("[wifi] starting scan...");
      WiFi.mode(WIFI_STA);
      WiFi.disconnect(true, true);
      delay(100);
      int n = WiFi.scanNetworks(false, true); // sync, show hidden
      Serial.println("[wifi] scan done");
      if (n == 0) {
        Serial.println("[wifi] scanned: no networks found");
      
} else if (n < 0) {
        Serial.printf("[wifi] scanned: failed with code %d\n", n);
      } else {
        gScanCount = (n < (int)(sizeof(gScanSsids) / sizeof(gScanSsids[0])))
                     ? n : (int)(sizeof(gScanSsids) / sizeof(gScanSsids[0]));
        Serial.println("[wifi]  #   signal  security  SSID");
        for (int i = 0; i < gScanCount; ++i) {
          gScanSsids[i] = WiFi.SSID(i);
          const int rssi = WiFi.RSSI(i);
          const bool open_ = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
          // Four bars is roughly -55 dBm or better; one bar is below -80.
          const int bars = rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
          char sig[5] = "....";
          for (int b = 0; b < bars; b++) sig[b] = '#';
          Serial.printf("[wifi] %2d   %s %4d  %-8s  %s\n", i, sig, rssi,
                        open_ ? "open" : "locked", gScanSsids[i].c_str());
        }
        Serial.println("[wifi] connect with:  [wifi] connect <#> <password>");
        Serial.println("[wifi]   (an open network needs no password; "
                       "\"[wifi] forget\" clears the saved one)");
      }
    } else if (line.startsWith("[wifi] connect ")) {
      String payload = line.substring(15);
      payload.trim();
      String current_ssid = "";
      String current_pass = "";

      int pos = 0;
      auto parseNextToken = [&]() -> String {
        while (pos < payload.length() && (payload.charAt(pos) == ' ' || payload.charAt(pos) == '\t')) pos++;
        if (pos >= payload.length()) return "";
        
        String token = "";
        bool inQuotes = (payload.charAt(pos) == '"');
        if (inQuotes) pos++;
        
        while (pos < payload.length()) {
          char c = payload.charAt(pos);
          if (inQuotes) {
            if (c == '\\' && pos + 1 < payload.length()) {
              pos++;
              token += payload.charAt(pos);
            } else if (c == '"') {
              pos++;
              break;
            } else {
              token += c;
            }
          } else {
            if (c == ' ' || c == '\t') {
              break;
            } else {
              token += c;
            }
          }
          pos++;
        }
        return token;
      };

      current_ssid = parseNextToken();
      current_pass = parseNextToken();

      // A bare number selects from the last scan, so only the password has to be typed.
      // Anything else is still accepted as a literal SSID.
      bool numeric = current_ssid.length() > 0;
      for (unsigned k = 0; k < current_ssid.length(); k++) {
        if (!isDigit(current_ssid.charAt(k))) { numeric = false; break; }
      }
      if (numeric) {
        const int idx = current_ssid.toInt();
        if (idx < 0 || idx >= gScanCount) {
          Serial.printf("[wifi] no network #%d in the last scan (run \"[wifi] scan\" first; "
                        "%d found)\n", idx, gScanCount);
          current_ssid = "";
        } else {
          current_ssid = gScanSsids[idx];
          Serial.printf("[wifi] #%d selected: \"%s\"\n", idx, current_ssid.c_str());
        }
      }

      if (current_ssid.length() > 0) {
        Serial.printf("[wifi] connecting to \"%s\"...\n", current_ssid.c_str());
        WiFi.disconnect();
        WiFi.begin(current_ssid.c_str(), current_pass.c_str());

        // Only persist credentials that actually work -- saving on request would happily
        // store a typo and brick the node's connectivity on the next boot.
        const uint32_t until = millis() + 15000;
        while (WiFi.status() != WL_CONNECTED && (int32_t)(millis() - until) < 0) delay(250);
        if (WiFi.status() == WL_CONNECTED) {
          Serial.printf("[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
          wifiSaveCredentials(current_ssid, current_pass);
          MDNS.begin(CLIENT_ID);
          gBrokerResolved = false; // different network: the broker name resolves elsewhere
          Serial.printf("[wifi] broker is \"%s\" -- \"[mqtt] host <ip-or-name.local>\" to repoint\n",
                        gMqttHost);
        } else {
          Serial.println("[wifi] FAILED to connect within 15s — nothing saved, "
                         "the previous network is still what boots");
        }
      }
    } else if (line == "[wifi] forget") {
      wifiForget();
    } else if (line == "[wifi] status") {
      String ss, pp;
      const bool saved = wifiLoadSaved(&ss, &pp);
      Serial.printf("[wifi] status: %s, ssid=\"%s\", ip=%s, rssi=%d, saved-in-nvs=%s\n",
                    WiFi.status() == WL_CONNECTED ? "connected" : "NOT connected",
                    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(),
                    saved ? ss.c_str() : "(none)");
    } else if (line.startsWith("[mqtt] host ")) {
      String host = line.substring(12);
      host.trim();
      if (host.length() > 0 && host.length() < sizeof(gMqttHost)) {
        client.disconnect();
        mqttSaveHost(host.c_str());
        Serial.printf("[mqtt] broker set to %s:%d (saved to NVS)\n", gMqttHost, MQTT_PORT);
      } else {
        Serial.println("[mqtt] host rejected: empty or too long");
      }
    } else if (line == "[i2c] scan") {
      // Every I2C sensor announces "expected at 0x.." during setup whether or not it
      // is present, so the boot log cannot tell a missing sensor from a wiring fault.
      // Ask the bus who actually answers.
#if USE_SHT30 || USE_CO2 || USE_LUX
      // Both buses: the CO2 sensor sits on its own Wire1 (GPIO27/5) behind the level
      // shifter, so scanning only the primary bus reports it missing when it is fine.
      int found = 0;
      Serial.printf("[i2c] scanning Wire  SDA=GPIO%d SCL=GPIO%d...\n", gCfg.pinI2cSda, gCfg.pinI2cScl);
      for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
          const char* who = "unknown";
          if (addr == SHT30_ADDR) who = "SHT30 temp/humidity";
          if (addr == 0x21)       who = "OV7670 camera";
          Serial.printf("[i2c] Wire  0x%02X responding -- %s\n", addr, who);
          found++;
        }
      }
#if USE_CO2
      Serial.println("[i2c] scanning Wire1 SDA=GPIO27 SCL=GPIO5...");
      for (uint8_t addr = 1; addr < 127; addr++) {
        Wire1.beginTransmission(addr);
        if (Wire1.endTransmission() == 0) {
          Serial.printf("[i2c] Wire1 0x%02X responding -- %s\n", addr,
                        addr == ACD1200_ADDR ? "ACD1200 CO2" : "unknown");
          found++;
        }
      }
#endif
      Serial.printf("[i2c] scan done, %d device(s) across both buses\n", found);
#else
      Serial.println("[i2c] bus not compiled in (no USE_SHT30/USE_CO2/USE_LUX)");
#endif
    } else if (line.startsWith("[mqtt] sub ")) {
      int arrowIdx = line.indexOf(" -> ");
      if (arrowIdx > 0) {
        String topicStr = line.substring(11, arrowIdx);
        String payloadStr = line.substring(arrowIdx + 4);
        onMessage((char*)topicStr.c_str(), (byte*)payloadStr.c_str(), payloadStr.length());
      }
    }
  }

#ifdef RD03_PIN_PROBE
  // One-shot detailed comparison of the two OT2 pins. The pass/fail pull test says GPIO14 is
  // open while the wire is known good, so print the raw behaviour of both pins side by side
  // rather than trusting a verdict that has already been wrong.
  {
    static uint32_t lastProbe = 0;
    if (millis() - lastProbe > 5000) {
      lastProbe = millis();
      const uint8_t pins[2] = { gCfg.pinMmwave, gCfg.pinMmwave2 };
      for (int i = 0; i < 2; i++) {
        const uint8_t pin = pins[i];
        if (pin == 255) continue;
        int floatHi = 0, upHi = 0, downHi = 0;
        pinMode(pin, INPUT);          delay(5);
        for (int k = 0; k < 32; k++) { floatHi += digitalRead(pin); delayMicroseconds(300); }
        pinMode(pin, INPUT_PULLUP);   delay(5);
        for (int k = 0; k < 32; k++) { upHi   += digitalRead(pin); delayMicroseconds(300); }
        pinMode(pin, INPUT_PULLDOWN); delay(5);
        for (int k = 0; k < 32; k++) { downHi += digitalRead(pin); delayMicroseconds(300); }
        pinMode(pin, INPUT);
        Serial.printf("[pinprobe] RD03-%d GPIO%-2u  float=%2d/32  pullup=%2d/32  pulldown=%2d/32  -> %s\n",
                      i + 1, (unsigned)pin, floatHi, upHi, downHi,
                      (downHi >= 30) ? "driven HIGH"
                    : (upHi <= 2)    ? "driven LOW"
                    : (upHi >= 30 && downHi <= 2) ? "OPEN (follows both pulls)"
                                                  : "AMBIGUOUS — weak drive or noise");
      }
    }
  }
#endif

#if USE_MMWAVE_UART || USE_MMWAVE2_UART
  // Drain whatever the heads have sent since the last pass. Non-blocking: if a whole frame
  // is not already buffered we simply try again next loop, so this never stalls control.
  for (int h = 0; h < 2; h++) {
    // OT2 first, and deliberately BEFORE the UART-liveness gate below. The presence pin and
    // the serial port are independent channels; a head that missed its UART probe at boot can
    // still be driving OT2 correctly, and testing the pin only for "alive" heads turned one
    // cold-start miss into permanently absent presence.
    {
      const uint8_t otPin = (h == 0) ? gCfg.pinMmwave : gCfg.pinMmwave2;
      static uint32_t lastPull[2] = { 0, 0 };
      if (!gOt2Driven[h] && otPin != 255 && millis() - lastPull[h] > 10000) {
        lastPull[h] = millis();
        if (ot2PullTest(otPin)) {
          gOt2Driven[h] = true;
          gRadarMaybeBack[h] = true;   // cut the UART backoff short: this head has power
          Serial.printf("[mmwave] RD03-%d OT2 on GPIO%u is now DRIVEN — head warmed up, "
                        "presence restored\n", h + 1, (unsigned)otPin);
        }
      }
    }

    // Not gated on gRadarStream any more: a head that fell out of reporting mode has that
    // flag false, and skipping it here is exactly what made the drop-out permanent.
    Stream* io = nullptr;
  #if USE_MMWAVE_UART
    if (h == 0) io = &Serial2;
  #endif
  #if USE_MMWAVE2_UART
    if (h == 1) io = &Serial1;
  #endif
    if (!gRadarAlive[h]) {
      // Retry the UART probe rather than treating one cold-start miss as permanent absence.
      //
      // With EXPONENTIAL BACKOFF, because these calls block: openCommandMode alone can spend
      // ~650 ms waiting for an ACK, and enableReporting ~2.4 s. That runs inside loop(), so a
      // head that is genuinely unplugged used to stall MQTT keepalive, relay commands and
      // presence polling for over two seconds every 30 s, indefinitely. Backing off to a
      // 10-minute ceiling keeps recovery working while making a permanently dead head cost
      // almost nothing.
      static uint32_t lastProbe[2] = { 0, 0 };
      static uint32_t probeBackoff[2] = { 30000, 30000 };
      if (gRadarMaybeBack[h]) {
        // Independent evidence the head is powered. Retry now instead of waiting out a
        // backoff that exists only to stop us hammering a head that is genuinely absent.
        gRadarMaybeBack[h] = false;
        probeBackoff[h] = 30000;
        lastProbe[h] = 0;
      }
      if (io && millis() - lastProbe[h] > probeBackoff[h]) {
        lastProbe[h] = millis();
        probeBackoff[h] = (probeBackoff[h] < 600000) ? probeBackoff[h] * 2 : 600000;
        if (rd03::openCommandMode(*io)) {
          rd03::closeCommandMode(*io);
          gRadarAlive[h] = true;
          probeBackoff[h] = 30000;   // recovered: reset so the next loss retries promptly
          const char* lbl = (h == 0) ? "head1" : "head2";

          // Restore the configuration, not just the stream. These V1 modules have no save
          // command, so every parameter lives in volatile RAM and a head that dropped out
          // because it lost power comes back on factory defaults. Re-arming reporting mode
          // without re-applying the gates and delay left it running a configuration nobody
          // chose, silently different from the other head.
          #if defined(RD03_SET_MAX_GATE) && defined(RD03_SET_DELAY_S)
            rd03::applyConfig(*io, lbl, (uint32_t)RD03_SET_MIN_GATE,
                              (uint32_t)RD03_SET_MAX_GATE, (uint32_t)RD03_SET_DELAY_S);
          #endif
          #if defined(RD03_FRAME_FILTERS) && defined(RD03_FRAMES_DETECT)
            rd03::frameFilters(*io, lbl, RD03_FRAMES_DETECT, -1);
          #endif

          gRadarStream[h] = rd03::enableReporting(*io, lbl);
          Serial.printf("[mmwave] head%d is answering again — rejoined, config re-applied\n", h + 1);
        }
      }
      continue;
    }
    if (!io) continue;
    // Re-arm a head that has gone quiet. Reporting mode is entered once at boot, so any
    // event that knocks a module out of it -- a command-mode round trip, a glitch on the
    // rail, the module's own watchdog -- silently ended the energy stream until the next
    // reflash. The live view then showed data frozen minutes in the past.
    if (millis() - gRadarSeen[h] > 15000) {
      // Same blocking cost as the probe above, same backoff for the same reason: a head that
      // accepts commands but never streams (one of the two here behaves that way) would
      // otherwise pay ~2.4 s of stalled loop every 20 s for the life of the node.
      static uint32_t lastRearm[2] = { 0, 0 };
      static uint32_t rearmBackoff[2] = { 20000, 20000 };
      if (millis() - lastRearm[h] > rearmBackoff[h]) {
        lastRearm[h] = millis();
        rearmBackoff[h] = (rearmBackoff[h] < 600000) ? rearmBackoff[h] * 2 : 600000;
        Serial.printf("[rd03] head%d silent for >15s — re-arming reporting mode\n", h + 1);
        gRadarStream[h] = rd03::enableReporting(*io, h == 0 ? "head1" : "head2");
        if (gRadarStream[h]) { gRadarSeen[h] = millis(); rearmBackoff[h] = 20000; }
      }
    }

    uint8_t det = 0; uint16_t dist = 0; uint32_t energy[32] = {0}; int gates = 0;
    while (io->available() >= 45) {
      // A short, non-zero timeout: the bytes are already buffered (checked above), but the
      // parser still needs a deadline in the future or its read loops exit immediately.
      if (!rd03::readReportFrame(*io, &det, &dist, energy, 32, &gates, 25)) break;
      gRadarDetect[h] = det;
      gRadarDistCm[h] = dist;
      gRadarSeen[h]   = millis();
      gRadarGates[h]  = (gates < 16) ? gates : 16;
      for (int g = 0; g < gRadarGates[h]; g++) gRadarEnergy[h][g] = energy[g];
    }
  }
#endif

  // Non-blocking dual PIR motion sensor polling & immediate transition dispatch
  static unsigned long lastPirPollTime = 0;
  static bool lastPirDetectedState = false;
  unsigned long nowPir = millis();
  if (nowPir - lastPirPollTime >= 50) {
    lastPirPollTime = nowPir;
#if USE_PIR
    bool pir1 = (digitalRead(gCfg.pinPir1) == HIGH);
    bool pir2 = (digitalRead(gCfg.pinPir2) == HIGH);
    bool currentDetected = (pir1 || pir2);
#else
    bool currentDetected = false;
#endif
#if USE_MMWAVE
    bool mw1 = gOt2Driven[0] && (gCfg.pinMmwave  != 255) && (digitalRead(gCfg.pinMmwave)  == HIGH);
    bool mw2 = gOt2Driven[1] && (gCfg.pinMmwave2 != 255) && (digitalRead(gCfg.pinMmwave2) == HIGH);
    if (mw1 || mw2) currentDetected = true;
#endif

    // Edge-triggered per-pin logging. The 3-second summary below can miss a transition
    // entirely, and a transition is the ONLY evidence that separates "pin faithfully
    // following a module that is latched ON" from "pin stuck because nothing drives it".
    // Both read as a constant level; only a change proves the wire carries a signal.
    {
      // The UART-vs-pin cross-check that used to live here has been REMOVED.
      //
      // It excluded a head whose OT2 pin disagreed with the module's own reporting-mode
      // `detected` flag, on the assumption that the flag was the reliable reference. It is
      // not: on this firmware that flag is latched at 1 permanently, exactly like the
      // distance field, and neither tracks the room. So the check condemned the pin --
      // which was reporting the empty room CORRECTLY as 0 -- and suppressed a healthy
      // channel for nine minutes while the dashboard showed a stale "presence".
      //
      // A test is only as good as its reference signal. There is no trustworthy second
      // opinion available on this hardware, so OT2 is taken at face value; the boot-time
      // pull test already proves the pin is driven, which is the part that can be checked.

      static int lastMw1 = -1, lastMw2 = -1;
      const int now1 = (gCfg.pinMmwave  != 255) ? digitalRead(gCfg.pinMmwave)  : -1;
      const int now2 = (gCfg.pinMmwave2 != 255) ? digitalRead(gCfg.pinMmwave2) : -1;
      if (now1 != lastMw1) {
        Serial.printf("[edge] GPIO%d (RD03-1 OT2) %d -> %d  @%lums  *** PIN IS ALIVE ***\n",
                      gCfg.pinMmwave, lastMw1, now1, (unsigned long)millis());
        lastMw1 = now1;
      }
      if (now2 != lastMw2) {
        Serial.printf("[edge] GPIO%d (RD03-2 OT2) %d -> %d  @%lums  *** PIN IS ALIVE ***\n",
                      gCfg.pinMmwave2, lastMw2, now2, (unsigned long)millis());
        lastMw2 = now2;
      }
    }

    // Report each source separately, not just the OR of them.
    //
    // Three sensors feed one boolean here, so a single one stuck high makes the other two
    // invisible: occupancy reads 1 forever and nothing in the telemetry says why. That is
    // exactly the state this node reached — occupancy pinned at 1 while CO2 fell from 1575
    // to 1386 ppm, which is a room emptying. Printing the raw pins turns "something is
    // stuck" into "this one is stuck".
    {
      static unsigned long lastPresenceDump = 0;
      if (millis() - lastPresenceDump > 3000) {
        lastPresenceDump = millis();
#if USE_PIR
        Serial.printf("[presence] PIR1(GPIO%d)=%d PIR2(GPIO%d)=%d ", gCfg.pinPir1, pir1 ? 1 : 0,
                      gCfg.pinPir2, pir2 ? 1 : 0);
#endif
#if USE_MMWAVE
        Serial.printf("[presence] RD03-1(GPIO%d)=%d RD03-2(GPIO%d)=%d -> occupancy %d\n",
                      gCfg.pinMmwave, mw1 ? 1 : 0, gCfg.pinMmwave2, mw2 ? 1 : 0,
                      currentDetected ? 1 : 0);
#else
        Serial.printf("[presence] -> occupancy %d\n", currentDetected ? 1 : 0);
#endif
      }
    }

    // Immediate telemetry burst on occupancy transition (<200ms latency)
    globalDebouncedPresence = currentDetected;
    if (currentDetected != lastPirDetectedState) {
      lastPirDetectedState = currentDetected;
      broadcastTrackingTelemetry(currentDetected);
    }
  }

  // Non-blocking reconnect (every 5s) keeps sensing/actuation responsive.
  if (!client.connected()) {
    digitalWrite(STATUS_LED, LOW);
    unsigned long now = millis();
    if (now - lastReconnectAttempt > 5000) {
      lastReconnectAttempt = now;
      mqttConnect();
    }
  } else {
    client.loop();
    unsigned long now = millis();
#if !USE_CAMERA && !USE_PIR && !USE_MMWAVE && USE_TOUCH_PRESENCE
    // Publish instantly when presence flips so the dashboard reacts in <0.2 s
    // instead of waiting out the periodic interval.
    static unsigned long lastTouchPoll = 0;
    static bool lastTouched = false;
    if (now - lastTouchPoll > 150) {
      lastTouchPoll = now;
      bool touched = touchOccupied();
      if (touched != lastTouched) {
        lastTouched = touched;
        lastPublish = now;
        readAndPublish();
      }
    }
#endif
    if (now - lastPublish > gCfg.publishIntervalMs) {
      lastPublish = now;
      readAndPublish();
    }
  }
}
