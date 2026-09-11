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
#include "node_config.h"

// ---------------------------------------------------------------------------------------
// WiFi provisioning.
//
// Credentials used to live only in wifi_secrets.h, so moving the node to another network
// meant editing a header and reflashing. These are stored in NVS instead: pick a network
// from a scan by number, type the password once, and it survives reboots and reflashes.
// The compile-time values in wifi_secrets.h remain the fallback for a node that has never
// been provisioned.
static Preferences gWifiPrefs;
static String  gScanSsids[24];        // index -> SSID from the last scan
static int     gScanCount = 0;

static bool wifiLoadSaved(String* ssid, String* pass) {
  if (!gWifiPrefs.begin("econwifi", true)) return false;
  *ssid = gWifiPrefs.getString("ssid", "");
  *pass = gWifiPrefs.getString("pass", "");
  gWifiPrefs.end();
  return ssid->length() > 0;
}

static void wifiSaveCredentials(const String& ssid, const String& pass) {
  if (!gWifiPrefs.begin("econwifi", false)) {
    Serial.println("[wifi] could not open NVS — credentials NOT saved");
    return;
  }
  gWifiPrefs.putString("ssid", ssid);
  gWifiPrefs.putString("pass", pass);
  gWifiPrefs.end();
  // Never echo the password, not even its length.
  Serial.printf("[wifi] saved \"%s\" to NVS — will be used on every boot from now on\n",
                ssid.c_str());
}

static void wifiForget() {
  if (gWifiPrefs.begin("econwifi", false)) {
    gWifiPrefs.clear();
    gWifiPrefs.end();
  }
  Serial.println("[wifi] saved credentials cleared — reverting to wifi_secrets.h on next boot");
}
#ifndef USE_MMWAVE_UART
  #define USE_MMWAVE_UART 0
#endif
#ifndef USE_MMWAVE2_UART
  #define USE_MMWAVE2_UART 0
#endif
// Per-head liveness. Defaults to true: with no UART wired we cannot know, and refusing to
// report a head we simply cannot interrogate would be worse than trusting OT2. Where the
// UART *is* wired, a head that does not answer is known-dead and its OT2 must be ignored.
#ifndef RD03_SET_MIN_GATE
  #define RD03_SET_MIN_GATE 1         // exclude gate 0: the module's own near field
#endif
#ifndef RD03_SET_MAX_GATE
  #define RD03_SET_MAX_GATE 15
#endif
static bool gRadarAlive[2] = { true, true };
// Result of the boot-time OT2 pull test. On a clean GPIO (13/14) this is conclusive: a pin
// that follows BOTH internal pulls has nothing driving it. That is the correct gate for
// presence -- not UART liveness, which is a separate channel, and not blind trust, which
// publishes a floating pin's pull-up as occupancy.
static bool gOt2Driven[2] = { true, true };
// Set when the OT2 pull test sees a pin come back to life. The UART probe is expensive and
// backed off, but OT2 turning driven is free proof the head has power again -- so it is used
// to cut the backoff short rather than making a visibly-recovered head wait out the ceiling.
static bool gRadarMaybeBack[2] = { false, false };

// Re-test whether an OT2 pin is driven. The Rd-03 needs ~30 s after power-up before its
// output stage is live, and the boot probe runs long before that -- so a cold start reads an
// un-driven pin, marks it OPEN, and the radar stays excluded until the next reboot even
// though the head comes up fine seconds later. A one-shot verdict on a device with a warm-up
// time is a latch, not a test. Returns true if something is driving the pin.
static bool ot2PullTest(uint8_t pin) {
  if (pin == 255) return false;
  if (pin == 15 || pin >= 34) return true;      // untestable: external pull-up / no pulls
  pinMode(pin, INPUT_PULLDOWN); delay(4);
  const bool heldHigh = digitalRead(pin) == HIGH;
  pinMode(pin, INPUT_PULLUP);   delay(4);
  const bool heldLow  = digitalRead(pin) == LOW;
  pinMode(pin, INPUT);
  return heldHigh || heldLow;
}
// Live view from each head's reporting stream. OT2 is a boolean with a configurable hold;
// this is the module's own verdict plus the range it measured, refreshed every frame.
static bool     gRadarStream[2]   = { false, false };  // head is parked in reporting mode
static uint8_t  gRadarDetect[2]   = { 0, 0 };
static uint16_t gRadarDistCm[2]   = { 0, 0 };
static uint32_t gRadarEnergy[2][16];                   // per-range-gate energy, 0.7 m per gate
static int      gRadarGates[2]    = { 0, 0 };
static uint32_t gRadarSeen[2]     = { 0, 0 };          // millis of last parsed frame
// ---------------------------------------------------------------------------------------
// Physical pin-contention guard.
//
// USE_CAMERA=0 stops the firmware driving the OV7670's pins, but it does NOT unplug the
// sensor. If those jumpers are still on the board, the OV7670's data pins are OUTPUTS
// sitting on the same nets we now use for the radars -- two drivers on one wire. The
// symptoms are exactly what a "faulty" sensor looks like: corrupted UART frames, OT2 stuck
// at a level nothing set, energy values that make no physical sense.
//
// Software cannot detect this, so it is asserted at compile time. If a collision below is
// intentional because the camera wiring is genuinely gone, build with
// -DCAMERA_WIRING_REMOVED=1 to acknowledge it.
#if !defined(CAMERA_WIRING_REMOVED)
  #include "camera/camera_config.h"
  #define RD03_PIN_CLASH(a, b) ((a) >= 0 && (a) == (b))
  #if USE_MMWAVE && (RD03_PIN_CLASH(PIN_CAM_D7, MMWAVE_PIN) || RD03_PIN_CLASH(PIN_CAM_RESET, MMWAVE_PIN))
    #warning "RADAR HEAD 1 OT2 SHARES A PIN WITH AN OV7670 DATA LINE. Unplug the camera from that pin, or build with -DCAMERA_WIRING_REMOVED=1 once its jumpers are physically off."
  #endif
  #if USE_MMWAVE_UART
    #warning "RADAR HEAD 1 UART (GPIO16/17) sits on OV7670 D3/D4. Those jumpers must be physically removed."
  #endif
  #if USE_MMWAVE2_UART
    #warning "RADAR HEAD 2 UART (GPIO4/18) sits on OV7670 D0/D5. Those jumpers must be physically removed."
  #endif
#endif

#if USE_MMWAVE_UART || USE_MMWAVE2_UART
  #include "rd03_uart.h"
  // Two heads, two hardware UARTs. UART0 is the USB console, so head 1 takes UART2 and
  // head 2 takes UART1 -- both remapped onto pins the retired camera gave back. No
  // software serial, so neither head's timing depends on the other.
  #ifndef MMWAVE_UART_RX          // ESP32 pin that listens to head 1's TX
    #define MMWAVE_UART_RX 16
  #endif
  #ifndef MMWAVE_UART_TX          // ESP32 pin that drives head 1's RX
    #define MMWAVE_UART_TX 17
  #endif
  #ifndef MMWAVE2_UART_RX         // ESP32 pin that listens to head 2's TX
    #define MMWAVE2_UART_RX 18
  #endif
  #ifndef MMWAVE2_UART_TX         // ESP32 pin that drives head 2's RX
    #define MMWAVE2_UART_TX 19
  #endif
#endif
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
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\n[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
}

// ---------------- HVAC IR ----------------
// This is where the whole control loop terminates: the engine's optimizer decides a
// setpoint, publishes it, and the node has to make a real air conditioner obey.
//
// For a long time it did not. applyHvacSetpoint() pulsed the pin three times and logged
// the setpoint, which looks convincing on a scope and in the serial monitor while the AC
// does absolutely nothing — every setback the twin reported saving energy on was, at this
// node, a no-op. USE_IR_AC=1 now sends a genuine per-brand IR frame via IRremoteESP8266,
// and telemetry reports which of the two is actually happening (`acReal`), so a bare demo
// board can never be mistaken for a node that is really driving a machine.
#ifndef USE_IR_AC
  #define USE_IR_AC 0
#endif

#if USE_IR_AC
  #include <IRremoteESP8266.h>
  #include <IRsend.h>
  #include <IRac.h>
  #include <IRutils.h>

  // Which brand's protocol to speak. IRremoteESP8266's IRac wraps ~50 vendor protocols
  // behind one state struct, so switching brands is a build flag, not a rewrite:
  //   -DIR_AC_PROTOCOL=COOLIX     generic; many budget/OEM splits (a good first try)
  //   -DIR_AC_PROTOCOL=DAIKIN     -DIR_AC_PROTOCOL=PANASONIC_AC
  //   -DIR_AC_PROTOCOL=MITSUBISHI_AC   -DIR_AC_PROTOCOL=LG2   -DIR_AC_PROTOCOL=SAMSUNG_AC
  //   -DIR_AC_PROTOCOL=TOSHIBA_AC -DIR_AC_PROTOCOL=GREE       (Casper/Nagakawa are often GREE)
  // If the unit does not respond, capture its remote with IRremoteESP8266's IRrecvDumpV3
  // example and use whatever protocol it decodes to.
  #ifndef IR_AC_PROTOCOL
    #define IR_AC_PROTOCOL COOLIX
  #endif
  #ifndef IR_AC_MODEL
    #define IR_AC_MODEL 1            // vendor sub-model; 1 is the default for most
  #endif
  #ifndef IR_AC_FAN
    #define IR_AC_FAN kAuto          // stdAc::fanspeed_t member name
  #endif

  // The protocol the blaster currently speaks. Compile-time IR_AC_PROTOCOL is only the
  // starting guess: engine.go carries a DetectedProtocol per zone (set by
  // UpdateDetectedProtocol when a camera reads the unit's branding) and prefixes its
  // commands with PROTOCOL=<name>. Until now the firmware ignored that token and stayed on
  // whatever was compiled in, so recognising a brand could never actually retarget the
  // blaster — the last link in that chain was missing.
  decode_type_t gIrProtocol = decode_type_t::IR_AC_PROTOCOL;

  IRac ac(gCfg.pinIrAc);
  IRsend customIrSend(gCfg.pinIrAc);       // Generic IR sender for fans, TVs, etc.
  bool irAcReady = false;            // protocol compiled AND supported by the library
#endif

// applyHvacSetpoint drives the room's air conditioner to `celsius`.
//
// Bounds are enforced here rather than trusted from the wire: a corrupt or malicious
// SETPOINT= would otherwise be handed straight to the AC. 16-30 °C is the range essentially
// every split unit accepts, and clamping is safer than refusing (a refused command leaves
// the room uncontrolled, a clamped one is merely conservative).
void applyHvacSetpoint(float celsius) {
  // The safe band is configurable per installation: a server room and an open-plan floor
  // do not share a sensible floor, and this is the last check before a command reaches a
  // real compressor. Clamped rather than refused, deliberately — unlike a calibration, a
  // setpoint the engine wanted is better served at the nearest safe value than ignored.
  const float lo = gCfg.setpointMinC, hi = gCfg.setpointMaxC;
  if (isnan(celsius) || celsius < lo || celsius > hi) {
    Serial.printf("[hvac] setpoint %.1f C outside %.1f..%.1f -> clamped\n",
                  celsius, (double)lo, (double)hi);
    celsius = isnan(celsius) ? (lo + hi) / 2.0f : (celsius < lo ? lo : hi);
  }
  // Same reasoning as applyHvacOff(): only transmit when something actually changes.
  // A repeated identical setpoint is a no-op to the air conditioner and costs a blocking
  // IR frame each time it arrives.
  if (hvacPowerOn && fabsf(hvacSetpointC - celsius) < 0.05f) {
    hvacSetpointC = celsius;
    return;
  }
  hvacSetpointC = celsius;
  hvacPowerOn   = true;

#if USE_IR_AC
  if (irAcReady) {
    // The AC's full desired state, not just a temperature: these units are stateless
    // receivers — each frame carries mode, fan and power as well, so omitting them would
    // let the machine fall back to whatever it last heard from the handset.
    ac.next.protocol = gIrProtocol;
    ac.next.model    = IR_AC_MODEL;
    ac.next.mode     = stdAc::opmode_t::kCool;
    ac.next.celsius  = true;
    ac.next.degrees  = celsius;
    ac.next.fanspeed = stdAc::fanspeed_t::IR_AC_FAN;
    ac.next.swingv   = stdAc::swingv_t::kOff;
    ac.next.swingh   = stdAc::swingh_t::kOff;
    ac.next.light    = false;
    ac.next.beep     = false;
    ac.next.econo    = false;
    ac.next.filter   = false;
    ac.next.turbo    = false;
    ac.next.quiet    = false;
    ac.next.clean    = false;
    ac.next.sleep    = -1;
    ac.next.clock    = -1;
    ac.next.power    = true;
    ac.sendAc();
    Serial.printf("[hvac] IR frame sent: %s -> %.1f C\n",
                  typeToString(gIrProtocol).c_str(), celsius);
    return;
  }
  Serial.println("[hvac] WARNING: IR AC compiled in but protocol unsupported -> not sent");
#else
  // No AC control fitted. The pulse is a diagnostic only — it lets a scope or an LED on
  // gCfg.pinIrAc confirm the command arrived and was parsed — and telemetry says acReal:false
  // so nothing downstream reads this as a machine having been commanded.
  Serial.printf("[hvac] setpoint %.1f C parsed (no IR AC compiled in; acReal:false)\n", celsius);
  for (int i = 0; i < 3; i++) { digitalWrite(gCfg.pinIrAc, HIGH); delay(8); digitalWrite(gCfg.pinIrAc, LOW); delay(8); }
#endif
}

// applyHvacOff powers the air conditioner down.
//
// This exists because "OFF" was being fed through applyHvacSetpoint(): String::toFloat()
// returns 0.0 for any non-numeric text, 0.0 fails the 16-30 C band, and the clamp turned
// it into the FLOOR of that band. A vacancy shutdown therefore reached the compressor as
// "power on, cool, 16 C" — maximum cooling for an empty room, which is the exact inverse
// of the command and of the saving engine.go:1197 believes it just made. The engine then
// latches z.IrState="OFF" on send and never repeats it, so the room stays there.
void applyHvacOff() {
  // Idempotent. engine.go re-issues LIGHTS_OFF;HVAC_SET:OFF on every tick it considers the
  // zone vacant — 130 commands in 50 s on this node — and each one was driving a fresh IR
  // frame. An IRremoteESP8266 send blocks for tens of milliseconds with interrupts largely
  // masked, so ~2.6 transmissions a second is both pointless (the unit is already off) and
  // enough blocking to destabilise the node. Send the state change; ignore the repeats.
  if (!hvacPowerOn) return;
  hvacPowerOn = false;
#if USE_IR_AC
  if (irAcReady) {
    ac.next.protocol = gIrProtocol;
    ac.next.model    = IR_AC_MODEL;
    ac.next.mode     = stdAc::opmode_t::kCool;   // carried for units that need a valid mode
    ac.next.celsius  = true;
    ac.next.degrees  = hvacSetpointC;            // stateless receivers: send a sane payload
    ac.next.fanspeed = stdAc::fanspeed_t::IR_AC_FAN;
    ac.next.swingv   = stdAc::swingv_t::kOff;
    ac.next.swingh   = stdAc::swingh_t::kOff;
    ac.next.light    = false;
    ac.next.beep     = false;
    ac.next.econo    = false;
    ac.next.filter   = false;
    ac.next.turbo    = false;
    ac.next.quiet    = false;
    ac.next.clean    = false;
    ac.next.sleep    = -1;
    ac.next.clock    = -1;
    ac.next.power    = false;                    // the one bit that matters here
    ac.sendAc();
    Serial.printf("[hvac] IR frame sent: %s -> POWER OFF\n",
                  typeToString(gIrProtocol).c_str());
    return;
  }
  Serial.println("[hvac] WARNING: IR AC compiled in but protocol unsupported -> OFF not sent");
#else
  Serial.println("[hvac] OFF parsed (no IR AC compiled in; acReal:false)");
#endif
}

// Setpoint tokens carry either a number or the literal OFF. Parse strictly: toFloat()
// silently maps every unparseable string to 0.0, and 0.0 is inside no sane band, so a
// corrupt token would otherwise be clamped into a real command to a real compressor.
// An unreadable setpoint is dropped, which leaves the AC where it is.
static void applyHvacToken(const String& value) {
  String v = value;
  v.trim();
  if (v.equalsIgnoreCase("OFF")) { applyHvacOff(); return; }

  char* end = nullptr;
  const char* cstr = v.c_str();
  float parsed = strtof(cstr, &end);
  if (end == cstr || *end != '\0' || isnan(parsed)) {
    Serial.printf("[hvac] setpoint token \"%s\" is not a number and not OFF -> ignored\n", cstr);
    return;
  }
  applyHvacSetpoint(parsed);
}

void setLights(bool on) {
  lightsOn = on;
  if (gCfg.pinLightingRelay != 255) {
    digitalWrite(gCfg.pinLightingRelay, on ? HIGH : LOW);
  }
  Serial.printf("[relay] lights %s\n", on ? "ON" : "OFF");
}


// ---------------------------------------------------------------------------------------
// Hardware-timed ADC acquisition
//
// The previous loop was `analogRead()` followed by `delayMicroseconds(70)`, which sets the
// sample interval by how long the loop happens to take. That is fine for an RMS over a
// window and wrong for anything that reasons about frequency: analogRead's duration varies,
// WiFi interrupts land in the middle of it, and the window came out with 619-631 samples
// from one tick to the next. Every frequency-domain step downstream — drift rejection at
// bin 1, the periodicity gate, the harmonic content of a switch-mode load — assumes samples
// are evenly spaced in time. They were not.
//
// This paces on the microsecond clock instead of on accumulated delays, so a slow read or a
// preempted loop steals from the following gap rather than shifting every sample after it.
// The result is a fixed sample count at a known rate, which makes bin k exactly k*10 Hz for
// a 100 ms window instead of approximately so.
//
// esp_timer/I2S DMA would be tighter still, but both take the ADC away from analogRead()
// (which the plug, strip and AC-clamp channels all share) and neither survives the ADC2/WiFi
// arbitration on this chip. Deadline-paced polling gets the uniformity the DSP needs without
// that fight.
// 4 kHz, not 6. analogRead() on this core costs ~100 us (it walks the calibration path on
// every call), so a 166 us slot at 6 kHz left ~60 us of headroom and every single window
// reported a slot overrun once WiFi interrupts landed in it. A 250 us slot absorbs that.
// 80 samples per 50 Hz cycle is still far above what the harmonics here need, and 400
// samples over 100 ms keeps bin k at exactly k*10 Hz.
#ifndef ADC_SAMPLE_RATE_HZ
  #define ADC_SAMPLE_RATE_HZ 4000        // 80 samples per 50 Hz cycle, 66 per 60 Hz cycle
#endif
#ifndef ADC_WINDOW_MS
  #define ADC_WINDOW_MS 100              // exactly 5 cycles at 50 Hz, 6 at 60 Hz
#endif
#define ADC_WINDOW_SAMPLES ((ADC_SAMPLE_RATE_HZ * ADC_WINDOW_MS) / 1000)   // 600

// Fills `buf` with exactly ADC_WINDOW_SAMPLES readings paced to ADC_SAMPLE_RATE_HZ.
// Returns the number of samples taken, and reports how far the pacing actually slipped so a
// window whose timing was disturbed can be recognised rather than silently trusted.
// The rate the last window ACTUALLY achieved, in Hz. Every frequency-domain step downstream
// assumes samples are evenly spaced at a known rate — if analogRead overruns its slot the
// window stretches, 400 samples no longer span 100 ms, and a 50 Hz signal stops landing where
// the analysis looks for it. Measured, not assumed.
static float gLastSampleRateHz = (float)ADC_SAMPLE_RATE_HZ;

static int sampleAdcWindow(uint8_t pin, int* buf, uint32_t* worstSlipUs) {
  const uint32_t periodUs = 1000000UL / ADC_SAMPLE_RATE_HZ;   // 250 us at 4 kHz

  // Throwaway reads first, to settle the ADC on this channel.
  //
  // The plug, strip and AC-clamp channels share one ADC and are sampled in turn, and the
  // ESP32's sample-and-hold carries charge across a channel switch: the first conversions
  // after a change are pulled toward whatever the previous channel was sitting at. It shows
  // up plainly here — the strip's rest level alternated between 1662 and 1763 counts window
  // to window while the plug channel sat at 1790, i.e. every other strip window was dragged
  // up by its neighbour. A DC offset that alternates is not noise the DSP can average out;
  // it lands in the low-frequency bins and inflates drift.
  for (int i = 0; i < 8; i++) (void)analogRead(pin);

  const uint32_t windowStart = micros();
  uint32_t next = windowStart;
  uint32_t worst = 0;
  for (int i = 0; i < ADC_WINDOW_SAMPLES; i++) {
    next += periodUs;
    buf[i] = analogRead(pin);
    // Absolute deadline, not a relative delay: errors do not accumulate across the window.
    int32_t remaining = (int32_t)(next - micros());
    if (remaining > 0) {
      delayMicroseconds((uint32_t)remaining);
    } else if ((uint32_t)(-remaining) > worst) {
      worst = (uint32_t)(-remaining);   // this read overran its slot
    }
  }
  const uint32_t elapsedUs = micros() - windowStart;
  if (elapsedUs > 0) {
    gLastSampleRateHz = (float)ADC_WINDOW_SAMPLES * 1000000.0f / (float)elapsedUs;
  }
  if (worstSlipUs) *worstSlipUs = worst;
  return ADC_WINDOW_SAMPLES;
}
// ---------------------------------------------------------------------------------------

#if USE_PLUG
bool plugOn = true;  // fail-energized: sockets are live until the engine says otherwise

// Relay modules come in both polarities and the difference is invisible in telemetry: the
// logical state flips either way, only the contacts move the wrong direction. Opto-isolated
// boards (the common SRD-05VDC-SL-C carrier among them) are usually ACTIVE LOW -- the coil
// energizes when the input is pulled low. Build with -DPLUG_RELAY_ACTIVE_LOW=1 for those.
#ifndef PLUG_RELAY_ACTIVE_LOW
  #define PLUG_RELAY_ACTIVE_LOW 0
#endif
#if PLUG_RELAY_ACTIVE_LOW
  #define PLUG_LEVEL(on) ((on) ? LOW : HIGH)
#else
  #define PLUG_LEVEL(on) ((on) ? HIGH : LOW)
#endif

void setPlug(bool on) {
  plugOn = on;
  digitalWrite(gCfg.pinPlugRelay, PLUG_LEVEL(on));
  Serial.printf("[relay] plug circuit %s (GPIO%d driven %s, active-%s module)\n",
                on ? "ON" : "OFF", gCfg.pinPlugRelay,
                PLUG_LEVEL(on) == HIGH ? "HIGH" : "LOW",
                PLUG_RELAY_ACTIVE_LOW ? "LOW" : "HIGH");
}

// Noise floor for THIS channel, measured on the node rather than assumed.
//
// The shared 300.0 (sigma 17.3 counts) was a guess, and on this hardware it is ~5x too
// large: eight consecutive idle windows on GPIO33 measured var = 44.9 .. 77.9 counts^2
// (sigma 6.7 .. 8.8), mean 1788 counts, so the 1.65 V bias divider is healthy and the
// front end is quiet. Subtracting 300 from ~62 clamps signalVariance to zero every time,
// which is why plugW published exactly 0.00 W for 2684 messages. The threshold that
// matters is sqrt(noiseVariance - realVariance): at 300 nothing under ~0.75 A (173 W)
// could ever appear.
//
// 100.0 sits above the observed spread plus the estimator's own jitter (with n~540,
// SE(var) = var*sqrt(2/n) ~ 3.8 counts^2, so ~5 SE of headroom above the 77.9 maximum)
// and puts the floor at sqrt(100-62) = 6.2 counts = 0.30 A = ~70 W. Re-derive per node
// from the [plugW floor] line below; the 33 ohm burden, at 11.2 W per count, is what
// stops this going lower.
#ifndef PLUG_NOISE_VARIANCE
  #define PLUG_NOISE_VARIANCE 100.0
#endif

static CurrentDenoiser plugDenoiser([]() {
  CurrentDenoiseConfig c;
  c.calAPerV     = PLUG_CAL_A_PER_V;
  c.dividerRatio = 1.0f; // Direct CT clamp burden without voltage divider
  c.noiseVariance = PLUG_NOISE_VARIANCE;
  c.cutoffAmps   = 0.02f;
  c.emaAlpha     = 0.35f;
  c.deadbandAmps = 0.03f;
  return c;
}());

// True-RMS current over ~100 ms (≈5 mains cycles at 50 Hz): sample fast into buffer,
// denoise via CurrentDenoiser (Stage 1 variance subtraction + Stage 2 EMA/deadband).
// Returns amps, or -1 when the window was starved of samples (< 100 samples).
float readPlugAmps() {
  static int sampleBuf[ADC_WINDOW_SAMPLES];
  uint32_t slipUs = 0;
  int n = sampleAdcWindow(gCfg.pinPlugAdc, sampleBuf, &slipUs);
  if (slipUs > 200) {
    Serial.printf("[plug] sampling slipped up to %lu us past its slot (target %d Hz) — "
                  "frequency-domain results from this window are unreliable\n",
                  (unsigned long)slipUs, ADC_SAMPLE_RATE_HZ);
  }
  
  plugDenoiser.setCal(gCfg.plugCalAPerV);
  plugDenoiser.setSampleRateHz(gLastSampleRateHz);
  float amps = plugDenoiser.processWindow(sampleBuf, n);

  // Raw samples plus the statistics Stage 1 actually decides on. Reading 0.00 W has two
  // completely different causes that the published value cannot tell apart, and this line
  // separates them:
  //   mean near 0 or near 4095      -> the ADC pin is sitting on a rail: the 1.65 V bias
  //                                    divider is not doing its job, so nothing is wired
  //                                    through to GPIO33 and no load will ever show.
  //   mean near 2048, var << noise  -> bias is good and the front end is quiet: either
  //                                    there is genuinely no load, or the burden resistor
  //                                    is too small for the current being measured.
  //   var just under noiseVariance  -> a real load is being subtracted away by the noise
  //                                    floor. sqrt(noiseVariance) counts is the cliff.
  // Running minimum of observed window variance. The quietest window this node has seen
  // is an upper bound on its true noise floor, so this is the number PLUG_NOISE_VARIANCE
  // should be set from — measured on the installed hardware, not carried over from
  // another board. If minVar ever approaches noiseVariance, the constant is too low and
  // idle noise is being published as power; if it sits far below, real load is being
  // subtracted away.
  static double plugMinVar = 1e18;
  if (plugDenoiser.lastVariance() > 0.0 && plugDenoiser.lastVariance() < plugMinVar) {
    plugMinVar = plugDenoiser.lastVariance();
  }

  static unsigned long lastDump = 0;
  if (millis() - lastDump > 2000) {
    lastDump = millis();
    double inForce = plugDenoiser.lastNoiseVariance();
    Serial.printf("[plugW floor] measured=%.1f cts^2 (sigma=%.2f) configured=%.1f "
                  "in-force=%.1f -> detection floor %.1f W\n",
                  plugDenoiser.observedFloor(), sqrt(plugDenoiser.observedFloor()),
                  plugDenoiser.getConfig().noiseVariance, inForce,
                  (double)(sqrt(inForce) * 0.5 * (3.3 / 4095.0)
                           * gCfg.plugCalAPerV * gCfg.plugMainsV));
    Serial.print("[plugW raw ADC] ");
    for (int i = 0; i < 10 && i < n; i++) Serial.printf("%d ", sampleBuf[i]);
    Serial.printf("| n=%d mean=%.1f var=%.1f sigma=%.2f cts | floor in-force=%.1f | "
                  "fs=%.0fHz | drift=%.0f | periodicCov=%+.3f | raw=%.3f A -> published %.3f A = %.1f W\n",
                  n, plugDenoiser.lastMean(), plugDenoiser.lastVariance(),
                  sqrt(plugDenoiser.lastVariance()), plugDenoiser.lastNoiseVariance(),
                  (double)gLastSampleRateHz, plugDenoiser.lastDriftEnergy(), plugDenoiser.lastFullPeriodCov(),
                  (double)plugDenoiser.lastRawAmps(), (double)amps,
                  (double)(amps >= 0 ? amps * gCfg.plugMainsV : 0.0f));
  }

  return amps;
}
#endif

#if USE_AC_CLAMP
static CurrentDenoiser acDenoiser([]() {
  CurrentDenoiseConfig c;
  c.calAPerV     = AC_CAL_A_PER_V;
  c.dividerRatio = 1.0f; // Direct CT clamp burden without voltage divider
  c.noiseVariance = 300.0;
  c.cutoffAmps   = 0.02f;
  c.emaAlpha     = 0.35f;
  c.deadbandAmps = 0.03f;
  return c;
}());

// True-RMS on the air conditioner's own supply via CurrentDenoiser.
float readAcAmps() {
  static int sampleBuf[ADC_WINDOW_SAMPLES];
  int n = sampleAdcWindow(gCfg.pinAcClampAdc, sampleBuf, nullptr);
  acDenoiser.setCal(gCfg.acCalAPerV);
  return acDenoiser.processWindow(sampleBuf, n);
}
#endif

#if USE_STRIP
// Ratio of the ACS712 output divider feeding the ADC. 0.5 is the 10k/10k pair the wiring
// guide specifies; 1.0 means the sensor drives the pin directly. The firmware cannot infer
// this, so it checks the measured rest level against it at runtime and complains on a
// mismatch rather than scaling every reading wrongly in silence.
#ifndef STRIP_DIVIDER_RATIO
  #define STRIP_DIVIDER_RATIO 0.5f
#endif

// Whether the strip front end is wired such that its readings mean anything. Set by the
// rest-level check below. Publishing a reading the firmware has already diagnosed as wrong
// is the same fabrication the radar and CO2 channels go out of their way to avoid: with the
// ACS712 disconnected this channel was reporting ~3.9 kW of load that does not exist.
static bool gStripFrontEndOk = true;

static CurrentDenoiser stripDenoiser([]() {
  CurrentDenoiseConfig c;
  c.calAPerV     = STRIP_CAL_A_PER_V;
  c.dividerRatio = STRIP_DIVIDER_RATIO; // ACS712 divider; see the rest-level check below
  c.noiseVariance = 300.0;
  c.cutoffAmps   = 0.02f;
  c.emaAlpha     = 0.35f;
  c.deadbandAmps = 0.03f;
  return c;
}());

// CPU strain detection and raw pass-through fallback state
static bool gCpuStrainDetected = false;
static unsigned long gLastDspDurationUs = 0;
const unsigned long DSP_TIME_BUDGET_US = 50000; // 50 ms DSP execution budget (increased from 15ms)

const int MAX_RAW_STRIP_SAMPLES = 60;
static int gRawStripSamples[MAX_RAW_STRIP_SAMPLES];
static int gRawStripSampleCount = 0;

inline bool isCpuStrained() {
  return gCfg.simulateCpuStrain || gCpuStrainDetected;
}

// True-RMS current over ~100 ms (≈5 mains cycles at 50 Hz) for ACS712 power strip sensor.
// Denoised via CurrentDenoiser: Stage 1 dynamic DC offset & variance subtraction (0.5 divider),
// Stage 2 inter-window EMA with deadband and zero-snapping.
// When CPU strain is detected or simulated, bypasses local DSP and captures raw decimated samples.
float readStripAmps() {
  static int sampleBuf[ADC_WINDOW_SAMPLES];
  uint32_t slipUs = 0;
  int n = sampleAdcWindow(gCfg.pinStripAdc, sampleBuf, &slipUs);

  if (n < 100) {
    Serial.printf("[strip] ADC starved! n=%d\n", n);
    return -1.0f;
  }
  // A slot overrun means samples were not evenly spaced, which is precisely the assumption
  // the frequency-domain stages rest on. Say so rather than publishing a number derived
  // from a window whose time base moved.
  if (slipUs > 200) {
    Serial.printf("[strip] sampling slipped up to %lu us past its slot (target %d Hz) — "
                  "frequency-domain results from this window are unreliable\n",
                  (unsigned long)slipUs, ADC_SAMPLE_RATE_HZ);
  }

  // Compute offload pass-through mode: if CPU is strained (simulated or measured),
  // skip local DSP execution and capture decimated raw ADC samples for backend offload.
  if (isCpuStrained()) {
    gCpuStrainDetected = false; // clear latch so it retries local DSP next tick
    const int TARGET_RAW = 30;
    gRawStripSampleCount = 0;
    int count = (n < TARGET_RAW) ? n : TARGET_RAW;
    for (int i = 0; i < count; ++i) {
      int idx = (count > 1) ? (i * (n - 1) / (count - 1)) : 0;
      gRawStripSamples[gRawStripSampleCount++] = sampleBuf[idx];
    }
    return -2.0f; // Pass-through mode active
  }

  // Normal mode: run local DSP and measure execution timing
  unsigned long dspStart = micros();
  stripDenoiser.setCal(gCfg.stripCalAPerV);
  stripDenoiser.setSampleRateHz(gLastSampleRateHz);
  float amps = stripDenoiser.processWindow(sampleBuf, n);

  // Same window statistics the plug channel reports. Without these, a channel reading 0.0 W
  // is indistinguishable between "no load", "front end dead" and "signal subtracted away by
  // the noise floor" — three faults with nothing in common but their output.
  // Does the measured DC rest level agree with the divider the firmware was told about?
  // An ACS712 idles at Vcc/2. Through the specified 10k/10k divider that lands near 1600
  // counts; wired straight to the pin it lands near 3200. Getting this wrong scales every
  // reading by 2x silently — and if the divider really is absent, the sensor's output swings
  // toward 5 V on a 3.3 V-only pin as load rises, which is a hardware risk, not just a
  // calibration one. Check it once, out loud.
  {
    // Re-run every 60 s rather than once. A boot-time verdict is a latch: plug the ACS712
    // in after start-up and the channel would stay suppressed until the next reflash, which
    // is the same failure mode already fixed on both radar paths today.
    static uint32_t lastDividerCheck = 0;
    const bool dividerDue = (lastDividerCheck == 0) || (millis() - lastDividerCheck > 60000);
    if (dividerDue && n >= 100) {
      lastDividerCheck = millis();
      double mean = stripDenoiser.lastMean();
      double expected = (2.6 * (float)STRIP_DIVIDER_RATIO / 3.3) * 4095.0;
      double ratioSeen = mean / ((2.6 / 3.3) * 4095.0);   // implied divider from the rest level

      // A rest level near ZERO is its own fault, and the check above missed it entirely:
      // it only ever warned when the level was too HIGH, so a pin reading a flat 0 sailed
      // through as "agrees with divider ratio 0.50" — which is nonsense, because an ACS712
      // outputs Vcc/2 whether or not any current flows. Zero means no sensor output is
      // reaching the pin at all.
      //
      // Two causes look identical on the ADC, so separate them electrically: engage the
      // ESP32's own pull-up and see whether the pin can be pulled up. If it can, the pin is
      // healthy and something upstream is simply sitting at 0 V (an unpowered ACS712, or a
      // divider whose top leg is open). If it cannot, the pin itself is tied to ground.
      if (mean < 100.0) {
        pinMode(gCfg.pinStripAdc, INPUT_PULLUP);
        delayMicroseconds(500);
        bool canPullUp = digitalRead(gCfg.pinStripAdc) == HIGH;
        pinMode(gCfg.pinStripAdc, INPUT);
        gStripFrontEndOk = false;
        Serial.printf("[strip] FAULT: rest level %.0f counts — an ACS712 always outputs Vcc/2, "
                      "so nothing is reaching GPIO%d. stripW will be OMITTED, not guessed.\n",
                      mean, gCfg.pinStripAdc);
        if (canPullUp) {
          Serial.println("[strip] the pin pulls HIGH, so GPIO32 itself is fine — the source is "
                         "at 0 V. Check the ACS712's VCC is on 5V (measure at the module's own "
                         "pin), then that OUT reaches the top of the divider.");
        } else {
          Serial.println("[strip] the pin STAYS LOW even with the internal pull-up on — GPIO32 "
                         "is shorted to ground. Look for the divider's midpoint wire landing in "
                         "a ground row, or a jumper bridging to the GND rail.");
        }
      } else if (mean > expected * 1.5) {
        gStripFrontEndOk = false;
        Serial.printf("[strip] WARNING: rest level %.0f counts implies NO voltage divider "
                      "(implied ratio %.2f, configured %.2f, expected ~%.0f counts).\n",
                      mean, ratioSeen, (double)(float)STRIP_DIVIDER_RATIO, expected);
        Serial.println("[strip] Two consequences: every reading is scaled 2x wrong, and the "
                       "ACS712's output swings toward 5 V on a 3.3 V-only pin as load rises. "
                       "Fit the 10k/10k divider, or rebuild with -DSTRIP_DIVIDER_RATIO=1.0 "
                       "if the sensor is genuinely driving the pin directly.");
      } else {
        if (!gStripFrontEndOk) {
          Serial.println("[strip] front end now agrees with the configured divider — stripW "
                         "is being published again.");
        }
        gStripFrontEndOk = true;
        Serial.printf("[strip] rest level %.0f counts agrees with divider ratio %.2f\n",
                      mean, (double)(float)STRIP_DIVIDER_RATIO);
      }
    }
  }

  {
    static unsigned long lastStripDump = 0;
    if (millis() - lastStripDump > 2000) {
      lastStripDump = millis();
      // A full mains cycle, not a 10-sample peek. Ten consecutive samples span 1.6 ms and
      // cannot show whether a 20 ms waveform exists; the periodicity gate is rejecting both
      // channels, and deciding whether that verdict is right needs the actual shape.
      // A FULL window (~5 mains cycles). The periodicity gate says there is no 50 Hz
      // content; that verdict rests on assumptions about lag and uniform sampling, and the
      // only way to check it independently is to look at the samples themselves off-board.
      // (full-window dump removed: it identified the 10 Hz drift and would now just flood)
      Serial.printf("[stripW raw ADC] ");
      for (int i = 0; i < 10 && i < n; i++) Serial.printf("%d ", sampleBuf[i]);
      Serial.printf("| n=%d mean=%.1f var=%.1f | floor: measured=%.1f configured=%.1f "
                    "in-force=%.1f | fs=%.0fHz | drift=%.0f | periodicCov=%+.3f | raw=%.3f A -> published %.3f A = %.1f W\n",
                    n, stripDenoiser.lastMean(), stripDenoiser.lastVariance(),
                    stripDenoiser.observedFloor(), stripDenoiser.getConfig().noiseVariance,
                    stripDenoiser.lastNoiseVariance(), (double)gLastSampleRateHz, stripDenoiser.lastDriftEnergy(),
                    stripDenoiser.lastFullPeriodCov(),
                    (double)stripDenoiser.lastRawAmps(), (double)amps,
                    (double)(amps >= 0 ? amps * gCfg.plugMainsV : 0.0f));
    }
  }
  unsigned long dspDuration = micros() - dspStart;
  gLastDspDurationUs = dspDuration;
  if (dspDuration > DSP_TIME_BUDGET_US) {
    gCpuStrainDetected = true;
    Serial.printf("[dsp] CPU strain detected: %lu us > %lu us budget (switching to offload next cycle)\n",
                  dspDuration, DSP_TIME_BUDGET_US);
  }
  return amps;
}
#endif

#if USE_LUX
// BH1750 in one-time high-resolution mode: 1 lx resolution, ~120 ms conversion. One-shot
// rather than continuous so the part returns to low power between the node's 5 s cycles.
bool readLux(float& out) {
  Wire.beginTransmission(BH1750_ADDR);
  Wire.write(0x20);                       // one-time H-resolution mode
  if (Wire.endTransmission() != 0) return false;
  delay(180);                             // datasheet max conversion 180 ms
  if (Wire.requestFrom(BH1750_ADDR, 2) != 2) return false;
  uint16_t raw = (Wire.read() << 8) | Wire.read();
  out = raw / 1.2f;                       // datasheet counts -> lux
  return true;
}
#endif

#if USE_SUPPLY_TEMP
// DS18B20 in the supply-air stream. Returns false on the disconnect sentinel (-127 C)
// and on the power-on default (85 C) so a probe that has fallen out of the louvre is
// omitted rather than published as a plausible supply temperature.
bool readSupplyC(float& out) {
  if (!supplyProbeReady) return false;
  supplyProbe.requestTemperatures();
  float c = supplyProbe.getTempCByIndex(0);
  if (c <= -100.0f || c >= 84.9f) return false;
  out = c;
  return true;
}
#endif

// ---------------- COMMAND PARSING ----------------
// Accepts "LIGHTS_ON;SETPOINT=22.0", "LIGHTS_OFF;SETPOINT=26.0", or "HVAC_SET:23".
// Ignores any extra ;KEY=VAL tokens (e.g. the gateway's ;SRC=FAILSAFE).
void handleCommand(const String& msg) {
  int start = 0;
  while (start < (int)msg.length()) {
    int sep = msg.indexOf(';', start);
    String tok = (sep == -1) ? msg.substring(start) : msg.substring(start, sep);
    tok.trim();

    if (tok.startsWith("PROTOCOL=")) {
#if USE_IR_AC
      // Retarget the blaster to the brand the camera recognised. Validate before adopting:
      // an unknown name, or one this library build cannot transmit, must leave the working
      // protocol in place rather than silently disabling AC control.
      String want = tok.substring(9);
      want.trim();
      decode_type_t p = strToDecodeType(want.c_str());
      if (p == decode_type_t::UNKNOWN) {
        Serial.printf("[hvac] PROTOCOL=%s not recognised — keeping %s\n",
                      want.c_str(), typeToString(gIrProtocol).c_str());
      } else if (!IRac::isProtocolSupported(p)) {
        Serial.printf("[hvac] PROTOCOL=%s is not send-supported by this library build — "
                      "keeping %s\n", want.c_str(), typeToString(gIrProtocol).c_str());
      } else if (p != gIrProtocol) {
        Serial.printf("[hvac] IR protocol switched %s -> %s (recognised by camera)\n",
                      typeToString(gIrProtocol).c_str(), typeToString(p).c_str());
        gIrProtocol = p;
        irAcReady = true;
        hvacPowerOn = !hvacPowerOn;   // force the next command to actually transmit
      }
#else
      Serial.println("[hvac] PROTOCOL= ignored (built without USE_IR_AC=1)");
#endif
    }
    else if (tok == "LIGHTS_ON")       setLights(true);
    else if (tok == "LIGHTS_OFF") setLights(false);
    else if (tok.startsWith("SETPOINT=")) applyHvacToken(tok.substring(9));
    else if (tok.startsWith("HVAC_SET:")) applyHvacToken(tok.substring(9));
    else if (tok.startsWith("IR_SEND:")) {
#if USE_IR_AC
      int p1 = tok.indexOf(':', 8);
      if (p1 != -1) {
        int p2 = tok.indexOf(':', p1 + 1);
        if (p2 != -1) {
          String protoStr = tok.substring(8, p1);
          String dataStr = tok.substring(p1 + 1, p2);
          String bitsStr = tok.substring(p2 + 1);
          
          decode_type_t protocol = strToDecodeType(protoStr.c_str());
          uint64_t data = strtoull(dataStr.c_str(), NULL, 16);
          const long nbitsRaw = bitsStr.toInt();
          const uint16_t nbits = (uint16_t)nbitsRaw;

          // toInt() returns 0 for non-numeric input, so garbage would otherwise be sent as a
          // zero-bit frame and reported as success. Bound it to what the IR library can
          // actually emit rather than passing an arbitrary count straight through.
          if (nbitsRaw <= 0 || nbitsRaw > 512) {
            Serial.printf("[ir] rejected bit count \"%s\" (parsed %ld; expected 1..512)\n",
                          bitsStr.c_str(), nbitsRaw);
          } else if (protocol != decode_type_t::UNKNOWN) {
            customIrSend.send(protocol, data, nbits);
            Serial.printf("[ir] sent %s: 0x%llx (%d bits)\n", protoStr.c_str(), (unsigned long long)data, nbits);
          } else {
            Serial.printf("[ir] unknown protocol: %s\n", protoStr.c_str());
          }
        }
      }
#else
      Serial.println("[ir] WARNING: IR_SEND requested but USE_IR_AC=0");
#endif
    }
#if USE_PLUG
    // After-hours sweep (APLC, plugs.go): the engine sheds the zone's non-critical
    // sockets on verified vacancy and restores them the instant presence returns.
#if USE_MMWAVE_UART || USE_MMWAVE2_UART
    // Runtime radar tuning. Every gate/delay/frame-filter change this session needed a
    // reflash and a 90-second round trip; these make it a command. Applied to both heads,
    // and re-read so the reply is the module's state rather than what we hoped it took.
    else if (tok.startsWith("RADAR_GATES=") || tok.startsWith("RADAR_DELAY=") ||
             tok.startsWith("RADAR_FRAMES=")) {
      const int eq = tok.indexOf('=');
      String val = tok.substring(eq + 1);
      long a = -1, b = -1;
      const int comma = val.indexOf(',');
      if (comma >= 0) { a = val.substring(0, comma).toInt(); b = val.substring(comma + 1).toInt(); }
      else            { a = val.toInt(); }

      for (int h = 0; h < 2; h++) {
        Stream* io = nullptr; const char* label = nullptr;
  #if USE_MMWAVE_UART
        if (h == 0) { io = &Serial2; label = "head1"; }
  #endif
  #if USE_MMWAVE2_UART
        if (h == 1) { io = &Serial1; label = "head2"; }
  #endif
        if (!io || !gRadarAlive[h]) continue;
        const bool wasStreaming = gRadarStream[h];
        if (tok.startsWith("RADAR_GATES=") && a >= 0 && b >= 0) {
          rd03::applyConfig(*io, label, (uint32_t)a, (uint32_t)b, (uint32_t)RD03_SET_DELAY_S);
        } else if (tok.startsWith("RADAR_DELAY=") && a >= 0) {
          rd03::applyConfig(*io, label, (uint32_t)RD03_SET_MIN_GATE,
                            (uint32_t)RD03_SET_MAX_GATE, (uint32_t)a);
        } else if (tok.startsWith("RADAR_FRAMES=")) {
          rd03::frameFilters(*io, label, a, b);
        }
        rd03::dumpConfig(*io, label);
        // applyConfig leaves the head in command mode's aftermath; restore the stream.
        if (wasStreaming) gRadarStream[h] = rd03::enableReporting(*io, label);
      }
    }
#endif
    else if (tok == "REBOOT") {
      Serial.println("[cmd] REBOOT requested — restarting node");
      delay(200);
      ESP.restart();
    }
    else if (tok == "PLUG_ON")  setPlug(true);
    else if (tok == "PLUG_OFF") setPlug(false);
#endif
#if USE_STRIP
    else if (tok == "CPU_STRAIN:HIGH") {
      gCpuStrainDetected = true;
      Serial.println("[strain] CPU strain forced HIGH via command (fallback active)");
    }
    else if (tok == "CPU_STRAIN:NORMAL") {
      gCpuStrainDetected = false;
      Serial.println("[strain] CPU strain returned to NORMAL via command");
    }
#endif
#if USE_CAMERA
    else if (tok == "CAMERA_TRIGGER") {
      Serial.println("[camera] ML inference triggered via command");
      cameraDetector->processFrame();
      readAndPublish();
    }
#endif

    if (sep == -1) break;
    start = sep + 1;
  }
}


// publishConfigState publishes the effective configuration, RETAINED, so the current
// calibration of every node on the bus is readable with one subscribe rather than by
// interrogating boards one at a time.
void publishConfigState() {
  StaticJsonDocument<1536> doc;
  cfgSerializeState(doc);
  char buf[1536];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  client.publish(CONFIG_STATE_TOPIC, (const uint8_t*)buf, n, true);
}

// handleConfig applies an inbound configuration message and always answers on /state —
// including when it rejected the message. A config push that vanishes silently is
// indistinguishable, from the operator's side, from one that was applied.
void handleConfig(const String& msg) {
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    snprintf(gCfgLastError, sizeof(gCfgLastError), "malformed JSON: %s", err.c_str());
    Serial.printf("[config] REJECTED: %s\n", gCfgLastError);
    publishConfigState();
    return;
  }
  bool wasReset = false;
  bool hardwareChanged = false;
  bool changed  = cfgApplyJson(doc, wasReset, hardwareChanged);
  publishConfigState();
  if (changed) {
    if (hardwareChanged || wasReset) {
      Serial.println("[config] Hardware pins changed or reset requested. Rebooting ESP32 in 1s...");
      delay(1000);
      ESP.restart();
    }
    // Republish immediately rather than waiting out the interval: the operator who just
    // changed a calibration wants to see the corrected watts now, and the new cfgRev is
    // what marks where the old series stopped being comparable.
    lastPublish = millis();
    readAndPublish();
  }
}

void onMessage(char* topic, byte* payload, unsigned int len) {
  String msg;
  msg.reserve(len);
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  Serial.printf("[mqtt] %s -> %s\n", topic, msg.c_str());
  String t(topic);
  if (t == COMMAND_TOPIC)     handleCommand(msg);
  else if (t == CONFIG_TOPIC) handleConfig(msg);
}

// ---------------- TELEMETRY ----------------
// Publishes only what was genuinely measured this cycle: any field whose sensor is absent
// or failed its read is omitted, so the engine keeps modelling it rather than trusting an
// invented number.
void readAndPublish() {
#if defined(__SIZEOF_POINTER__) && __SIZEOF_POINTER__ == 8
  StaticJsonDocument<1536> doc; // Scaled for 64-bit host test shims (32-byte slots)
#else
  // 2048, not 768. The per-gate radar arrays add two 16-element integer arrays; at 768 the
  // document silently overflowed and ArduinoJson dropped them with no error anywhere -- the
  // serial print showed the array because that happens before serialization, while the MQTT
  // payload that actually left the node did not contain it. The overflow check below exists
  // so that failure mode can never be silent again.
  StaticJsonDocument<2048> doc; // physical 32-bit ESP32 hardware (16-byte slots)
#endif
  doc["zone"]   = ZONE_LABEL;
  doc["source"] = "esp32";
  // Configuration revision. A calibration change alters the MEANING of plugW/acW, so a
  // step in those series caused by recalibrating is otherwise indistinguishable from a
  // step caused by the load itself. Publishing the revision lets the engine mark exactly
  // where the series stopped being comparable to itself (devices.go records the change).
  doc["cfgRev"] = gCfg.cfgRev;

  // --- temperature + humidity ---
  bool tempReal = false;
#if USE_SHT30
  float t = NAN, h = NAN;
  if (readSht30(t, h)) {
    doc["temperature"] = round(t * 10) / 10.0;
    doc["humidity"]    = round(h * 10) / 10.0;
    tempReal = true;
  } else {
    Serial.println("[sht30] read/CRC failed -> omitted (engine keeps modelling)");
  }
#elif USE_DHT
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t)) { doc["temperature"] = round(t * 10) / 10.0; tempReal = true; }
  if (!isnan(h)) { doc["humidity"]    = round(h * 10) / 10.0; }
  if (isnan(t)) Serial.println("[dht] temperature read failed -> omitted (engine keeps modelling)");
#else
  // Demo build with no temp/humidity sensor. The placeholder temperature is published
  // ONLY because tempReal:false travels with it — the engine sees the flag and models the
  // zone itself rather than pinning physics to the number.
  //
  // Humidity gets no such flag, and there is no humidityReal in the protocol, so a
  // simulated value here would arrive indistinguishable from a real one: the engine would
  // store it, stream it, and the dashboard would label it "Humidity (measured)". Omit it.
  // Absent is not zero — mqtt.go uses pointer fields precisely so this reads as
  // "no sensor is measuring humidity" rather than "the air is 0% RH".
  doc["temperature"] = round((22.0 + random(0, 40) / 10.0) * 10) / 10.0;  // simulated
#endif
  doc["tempReal"] = tempReal;  // only a genuine measurement may pin zone physics

  // --- occupancy ---
  int occupancy = 0;
  bool present = false;
#if USE_CAMERA
  present = cameraDetector->isPersonDetected();
  #if USE_MMWAVE
    if (gOt2Driven[0] && gCfg.pinMmwave  != 255 && digitalRead(gCfg.pinMmwave)  == HIGH) present = true;
    if (gOt2Driven[1] && gCfg.pinMmwave2 != 255 && digitalRead(gCfg.pinMmwave2) == HIGH) present = true;
  #endif
  occupancy = present ? (cameraDetector->getPersonCount() > 0 ? cameraDetector->getPersonCount() : 1) : 0;
  doc["confidence"] = round(cameraDetector->getConfidence() * 100) / 100.0;
  doc["person_count"] = occupancy;
#elif USE_PIR || USE_MMWAVE
  present = globalDebouncedPresence;
  occupancy = present ? 1 : 0;  // presence, not a headcount
  doc["confidence"] = present ? 1.0 : 0.0;
  doc["person_count"] = occupancy;
  broadcastTrackingTelemetry(present);
#elif USE_TOUCH_PRESENCE
  occupancy = touchOccupied() ? TOUCH_OCCUPANTS : 0;  // real physical input
  present = occupancy > 0;
  doc["confidence"] = present ? 1.0 : 0.0;
  doc["person_count"] = occupancy;
  broadcastTrackingTelemetry(present);
#else
  occupancy = random(0, 6);
  present = occupancy > 0;
  doc["confidence"] = present ? 1.0 : 0.0;
  doc["person_count"] = occupancy;
#endif
  // Occupancy is published only when at least one presence source is trustworthy.
  //
  // With both OT2 pins failing the wiring check there is nothing measuring the room, and a
  // "0" here would state that the room is empty on the authority of two floating pins --
  // a fabricated measurement on a channel the engine acts on. Omitting the field instead
  // makes the gap visible: the engine sees no occupancy rather than a confident wrong one,
  // and the inspector shows it as never-reported with the omitted count climbing.
// NOTE: deliberately not gated on USE_TOUCH_PRESENCE. That macro is defined to 1
// unconditionally further up this file, so including it here compiled the whole guard away
// and occupancy kept being published from failed pins. The occupancy chain above selects
// the mmwave/PIR branch ahead of touch anyway, so USE_MMWAVE || USE_PIR is the right test.
#if (USE_MMWAVE || USE_PIR) && !USE_CAMERA
  bool occupancyTrustworthy = false;
  #if USE_MMWAVE
    // Only a pin proven to be driven can make occupancy trustworthy. With both OT2 lines
    // open, "occupancy: 1" would be the pins' own bias reported as a measurement.
    if (gOt2Driven[0] && gCfg.pinMmwave  != 255) occupancyTrustworthy = true;
    if (gOt2Driven[1] && gCfg.pinMmwave2 != 255) occupancyTrustworthy = true;
  #endif
  #if USE_PIR
    occupancyTrustworthy = true;            // PIRs have no self-test; trust the wiring
  #endif
  if (occupancyTrustworthy) {
    doc["occupancy"] = occupancy;
  } else {
    static uint32_t lastOccWarn = 0;
    if (millis() - lastOccWarn > 30000) {
      lastOccWarn = millis();
      Serial.printf("[presence] occupancy OMITTED — no trustworthy presence source. "
                    "Both radar OT2 pins failed the wiring check, so any value here would "
                    "be the pins' pull-ups, not the room.\n");
    }
  }
#else
  doc["occupancy"] = occupancy;
#endif

  // Per-head radar state alongside the fused occupancy. The engine consumes `occupancy`,
  // which is the OR of the heads; these two say which head is asserting. Without them a
  // head stuck high is indistinguishable from a genuinely occupied room downstream --
  // the OR hides it, which is the failure this node already walked into once.
#if USE_MMWAVE
  // A head that is not answering is omitted rather than reported. Publishing its floating
  // pin would put a fabricated presence on a measured channel; publishing a 0 would claim
  // we measured "empty" when we measured nothing at all.
  // OT2 is a direct pin read and does NOT depend on the UART. These were previously gated on
  // gRadarAlive (set by the UART probe), so when head1's serial port went quiet its perfectly
  // good presence pin was suppressed too and radar1 went stale for nine minutes. Two
  // independent channels; only the UART-derived data below depends on the UART.
  if (gOt2Driven[0] && gCfg.pinMmwave  != 255) doc["radar1"] = digitalRead(gCfg.pinMmwave)  == HIGH ? 1 : 0;
  if (gOt2Driven[1] && gCfg.pinMmwave2 != 255) doc["radar2"] = digitalRead(gCfg.pinMmwave2) == HIGH ? 1 : 0;
  // Per-range-gate energy. THIS is the real measurement in the reporting frame -- gates 2..15
  // vary frame to frame with a physically sensible decay, and they move when the room moves.
  // (Gates 0..1 read a constant 0xFFFF near-field blanking sentinel and are sent as -1 so the
  // dashboard can mark them blanked instead of plotting a bar 65535 high.)
  for (int h = 0; h < 2; h++) {
    if (!gRadarStream[h] || millis() - gRadarSeen[h] > 3000 || gRadarGates[h] == 0) continue;
    JsonArray arr = doc.createNestedArray(h == 0 ? "radar1_gates" : "radar2_gates");
    for (int g = 0; g < gRadarGates[h]; g++) {
      arr.add(gRadarEnergy[h][g] == 0xFFFF ? -1 : (int32_t)gRadarEnergy[h][g]);
    }
  }

  // NO DISTANCE IS PUBLISHED. The reporting frame has a target-distance field, and on this
  // module's firmware it does not measure anything: it tracks the configured minimum gate.
  // Holding the room constant and changing only the config moved it deterministically --
  //
  //     min gate 0 -> 11 cm      min gate 1 -> 35 cm      min gate 3 -> 175 cm
  //
  // i.e. the centre of gate (minGate-1) every time. The `detected` byte is likewise stuck
  // at 1 in every configuration. Publishing either would put a fabricated measurement on a
  // channel that implies a real one, so both are dropped and OT2 -- which does track the
  // room -- remains the presence source.
  //
  // What IS real in that frame is the per-gate energy array (gates 2..15 vary frame to
  // frame with a sensible physical decay; gates 0..1 read a constant 0xFFFF near-field
  // blanking sentinel). Deriving a range from it would need background subtraction against
  // a learned per-gate baseline -- a real estimator, not a field read. Not built.
#endif

  // --- CO2 ---
#if USE_CO2
  int ppm;
  if (readCo2(ppm)) doc["co2"] = ppm;
  else Serial.println("[co2] ACD1200 read/CRC failed -> omitted");
#else
  // No NDIR fitted: omit, for the same reason as humidity above. A number derived from
  // occupancy is a model output, and publishing it over the sensor channel would launder
  // it into "CO2 (measured)" on both dashboards. The engine already estimates CO2 from
  // occupancy itself — that estimate belongs there, where it is labelled as one.
#endif

  // --- plug circuit (APLC) ---
#if USE_PLUG
  float amps = readPlugAmps();
  if (amps >= 0) {
    doc["plugW"] = round(amps * gCfg.plugMainsV * 10) / 10.0;  // measured, engine-side model yields
  } else {
    Serial.println("[plug] ADC window starved -> omitted (engine keeps modelling)");
  }
  doc["plug"] = plugOn ? "ON" : "OFF";
#endif
#if USE_STRIP
  float stripAmps = readStripAmps();
  if (isCpuStrained() || stripAmps == -2.0f) {
    doc["rawFallback"] = true;
    JsonArray rawArr = doc.createNestedArray("rawStripSamples");
    for (int i = 0; i < gRawStripSampleCount; ++i) {
      rawArr.add(gRawStripSamples[i]);
    }
    Serial.printf("[strip] offload pass-through: rawFallback=true (%d raw samples streamed)\n",
                  gRawStripSampleCount);
  } else if (stripAmps >= 0) {
    // Omitted, never estimated, when the front end has failed its own self-check. A value
    // here is a claim about real watts on a real circuit; with the ACS712 unplugged the
    // maths still produces a number, and that number was ~3.9 kW of nothing.
    if (gStripFrontEndOk) {
      doc["stripW"] = round(stripAmps * gCfg.plugMainsV * 10) / 10.0;
    }
  } else {
    Serial.println("[strip] ADC window starved -> omitted");
  }
#endif

  // --- measurements that replace a modelled value in the twin ---
  // Each is omitted when its sensor is absent or failed, never defaulted: the engine
  // keeps its own assumption and says so, which is the whole point of publishing these.
#if USE_SUPPLY_TEMP
  float supplyC;
  if (readSupplyC(supplyC)) doc["supplyC"] = round(supplyC * 10) / 10.0;
  else Serial.println("[supply] DS18B20 absent/out of range -> omitted (engine keeps its design value)");
#endif
#if USE_AC_CLAMP
  float acAmps = readAcAmps();
  if (acAmps >= 0) doc["acW"] = round(acAmps * gCfg.acMainsV * 10) / 10.0;
  else Serial.println("[ac] ADC window starved -> omitted");
#endif
#if USE_LUX
  float lux;
  if (readLux(lux)) doc["lux"] = round(lux);
  else Serial.println("[lux] BH1750 read failed -> omitted");
#endif

  if (gCfg.pinLightingRelay != 255) {
    doc["lights"] = lightsOn ? "ON" : "OFF";
  }
  doc["setpoint"]    = hvacSetpointC;
  // engine.go:3277 latches z.IrState="OFF" the moment it SENDS a shutdown and never
  // repeats it, so without this the twin's belief about the compressor is never checked
  // against the node. Published only when this node genuinely drives an AC — otherwise
  // omitted, so an unequipped node cannot be read as confirming a state it cannot set.
#if USE_IR_AC
  if (irAcReady) doc["irState"] = hvacPowerOn ? "ON" : "OFF";
#endif
  // Whether that setpoint was actually transmitted to an air conditioner, or merely
  // parsed. Same discipline as tempReal: the twin must never count energy saved by a
  // setback that terminated in a serial log line.
#if USE_IR_AC
  doc["acReal"] = irAcReady;
#else
  doc["acReal"] = false;
#endif

  // Three separate limits have to agree or fields vanish without a word: the document's
  // capacity, this serialisation buffer, and the MQTT client's buffer. They disagreed once
  // (768/768/768 vs a payload that grew past it) and the radar gate arrays were dropped
  // silently -- printed on serial, absent from the wire. Check and shout instead.
  char buf[2048];
  if (doc.overflowed()) {
    Serial.printf("[mqtt] TELEMETRY DOC OVERFLOWED — fields were dropped from this payload. "
                  "Raise StaticJsonDocument capacity.\n");
  }
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (n == 0 || n >= sizeof(buf) - 1) {
    Serial.printf("[mqtt] serialize produced %u bytes for a %u-byte buffer — payload truncated\n",
                  (unsigned)n, (unsigned)sizeof(buf));
  }
  if (!client.publish(TELEMETRY_TOPIC, buf, n)) {
    Serial.printf("[mqtt] publish REJECTED (%u bytes) — client buffer too small?\n", (unsigned)n);
  }
  Serial.printf("[mqtt] pub %s -> %s\n", TELEMETRY_TOPIC, buf);
}

// ---------------- MQTT CONNECT ----------------
bool mqttConnect() {
  Serial.print("[mqtt] connecting...");
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
  pinMode(gCfg.pinIrAc, OUTPUT);
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
      Serial.printf("[mmwave] %s is NOT ANSWERING — treating it as absent. Its OT2 pin will be "
                    "IGNORED for occupancy and omitted from telemetry, because an unpowered "
                    "head leaves that pin floating and a floating pin reads as PRESENT.\n", label);
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
  client.setServer(MQTT_HOST, MQTT_PORT);
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
          gRadarStream[h] = rd03::enableReporting(*io, h == 0 ? "head1" : "head2");
          Serial.printf("[mmwave] head%d is answering again — rejoined\n", h + 1);
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
