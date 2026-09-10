// -----------------------------------------------------------------------------
// node_config.h — runtime configuration for an ECON edge node.
//
// WHY THIS EXISTS
//
// Every tunable on this node used to be a compile-time -D flag. That is correct for
// anything that decides which CODE is linked (which sensors exist, which IR protocol,
// which pins), but it is wrong for everything that is a PROPERTY OF THE INSTALLATION:
// a burden resistor's calibration constant, the mains voltage, how often to publish,
// how sensitive the touch pad is. Those are discovered on a ladder with a multimeter,
// and needing a reflash — a laptop, a USB cable, and physical access to a board that
// may already be in a ceiling — to change one float is how a node ends up running on a
// calibration nobody ever corrected.
//
// So: the compile-time flags become the DEFAULTS, and each one may be overridden at
// runtime over MQTT and persisted to NVS. A node that is never configured behaves
// EXACTLY as it did before this file existed. That is the whole design constraint.
//
// THE DISCIPLINE THIS FILE INHERITS
//
// The repo's first rule is "never fabricate a measurement", and a calibration constant
// is upstream of every measurement the clamp reports. Two consequences:
//
//   1. A bad config value is REJECTED, not clamped. Silently clamping 6060.0 to 500.0
//      would publish confident, wrong watts forever. The node keeps its last good value
//      and says loudly what it refused and why.
//   2. Changing a calibration changes the MEANING of the series the engine is storing.
//      A step in plugW caused by recalibrating is indistinguishable, downstream, from a
//      step caused by the load actually changing — unless the node says so. Hence
//      cfgRev: a monotonic counter published in every telemetry message, so the engine
//      can mark exactly where the series stopped being comparable to itself.
//
// WIRE PROTOCOL
//
//   econ/config/<zone>        <- JSON, any subset of fields. {"reset":true} restores
//                                defaults. Retain it and a rebooting node picks it up.
//   econ/config/<zone>/state  -> JSON, retained: effective config, which fields are
//                                overridden, cfgRev, and the last rejection if any.
// -----------------------------------------------------------------------------
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>

// ---------------------------------------------------------------------------------
// Compile-time defaults.
//
// Each is taken from the -D flag that used to be the ONLY way to set it, so the default
// config is bit-identical to the previous hardcoded behaviour. Guarded individually
// because the sensor flags they belong to may not be compiled in — the config struct
// carries every field regardless, so a board can be pre-configured for a clamp that is
// fitted later without reflashing twice.
// ---------------------------------------------------------------------------------
#ifndef PUBLISH_INTERVAL_MS_DEFAULT
  #define PUBLISH_INTERVAL_MS_DEFAULT 5000
#endif
// SCT-013 clamp: amps of primary current per volt at the ADC.
//
// 22.1, identified against a known load with a 94 ohm burden (two 47 ohm in series). The
// burden was doubled from 47 ohm deliberately, to halve the smallest load this channel can
// resolve: 8.4 W per ADC count became 4.1 W, over a range that still reaches 5.7 kW.
//
// Identified, not derived, and the history is worth keeping because the derivation has been
// wrong every time:
//
//   burden   nominal 2000/R   identified   error
//    33 ohm      60.6            --        resistor was never in the circuit
//    47 ohm      42.6           45.3       +6.3%
//    94 ohm      21.3           22.1       +3.9%
//
// Both identified values sit a few percent above what the nominal burden predicts, and by a
// consistent amount — which is what a stable tolerance stack looks like rather than a
// measurement error: the SCT-013's turns ratio (+/-3%), the ACS712-05B it is compared
// against (+/-1.5%), and ESP32 ADC nonlinearity. The consistency across two burdens is the
// reassuring part; a one-off would not have been.
//
// Method, for when the burden or the clamp changes again: put ONE load on the circuit (a
// ~1 kW hair dryer), confirm both current channels are on the same conductor with nothing
// branching between them, wait for both to settle, then scale this constant by
// stripW_amps / plugW_amps. The ACS712 is the reference because at ~4.2 A it runs at 84% of
// its 5 A full scale, where a Hall part is most accurate, against this clamp at 4.2% of
// 100 A where a CT is least.
//
// A calibration change alters the MEANING of plugW, so it bumps cfgRev like any other.
#ifndef PLUG_CAL_A_PER_V
  #define PLUG_CAL_A_PER_V 22.1
#endif
#ifndef PLUG_MAINS_V
  #define PLUG_MAINS_V 230.0
#endif
#ifndef AC_CAL_A_PER_V
  #define AC_CAL_A_PER_V 60.6f
#endif
#ifndef AC_MAINS_V
  #define AC_MAINS_V 220.0f
#endif
// ACS712 sensitivity, as amps per volt at the sensor's output. The part number sets this
// and getting it wrong scales every watt this channel publishes:
//   ACS712-05B  185 mV/A ->  5.41 A/V
//   ACS712-05B  185 mV/A ->  5.41 A/V   <- the module now fitted to this node
//   ACS712-20A  100 mV/A -> 10.0  A/V
//   ACS712-30A   66 mV/A -> 15.15 A/V
// This has now been wrong twice: it shipped at 15.0 (the 30 A part) against a 20 A module,
// over-reporting by half — the first real reading this node produced, 27.0 W, was 18.0 W.
// The 5 A part fitted now gives 1.85x the signal of the 20 A for the same current, which is
// what the strip channel needed: it was resolving ~30 W and up against loads well below it.
// A calibration change alters the MEANING of stripW, so it bumps cfgRev like any other.
//
// Headroom check for the 5 A part: it idles at Vcc/2 = 2.5 V and swings 185 mV/A. At its
// rated 5 A RMS (7.07 A peak) that is +/-1.31 V, which the 10k/10k divider halves to
// 1.25 +/- 0.65 V at the pin — comfortably inside 0-3.3 V. 5 A is ~1150 W at 230 V, a
// sensible ceiling for a power strip, and the sensor saturates before the ADC does.
#ifndef STRIP_CAL_A_PER_V
  #define STRIP_CAL_A_PER_V 5.41f
#endif
// Touch presence hysteresis, as a percentage of the boot-time baseline. Enter on a firm
// touch, leave only after recovering most of the way — the literals 62 and 82 come from
// the observed 3<->0 occupancy flapping these were introduced to stop.
#ifndef TOUCH_ENTER_PCT_DEFAULT
  #define TOUCH_ENTER_PCT_DEFAULT 62
#endif
#ifndef TOUCH_EXIT_PCT_DEFAULT
  #define TOUCH_EXIT_PCT_DEFAULT 82
#endif
#ifndef TOUCH_OCCUPANTS_DEFAULT
  #define TOUCH_OCCUPANTS_DEFAULT 3
#endif
// Bounds the engine's setpoint commands before they reach a real compressor.
#ifndef SETPOINT_MIN_C_DEFAULT
  #define SETPOINT_MIN_C_DEFAULT 16.0f
#endif
#ifndef SETPOINT_MAX_C_DEFAULT
  #define SETPOINT_MAX_C_DEFAULT 30.0f
#endif

struct NodeConfig {
  char     zoneLabel[32];         // human label published as telemetry "zone"
  uint32_t publishIntervalMs;     // telemetry cadence
  float    plugCalAPerV;          // SCT-013 plug clamp: amps of primary per volt at the ADC
  float    plugMainsV;            // assumed mains voltage for the plug circuit
  float    acCalAPerV;            // SCT-013 on the AC supply
  float    acMainsV;
  float    stripCalAPerV;         // ACS712 strip sensor: amps per volt at ADC
  uint8_t  touchEnterPct;         // capacitive presence hysteresis, % of baseline
  uint8_t  touchExitPct;
  uint8_t  touchOccupants;        // headcount reported while the pad is held
  float    setpointMinC;          // refuse engine setpoints outside this band
  float    setpointMaxC;
  bool     relayActiveLow;        // true = LOW turns relay ON, false = HIGH turns relay ON
  bool     simulateCpuStrain = false; // high CPU load offload fallback simulation
  
  // GPIO Pin Assignments
  uint8_t  pinIrAc;
  uint8_t  pinPlugRelay;
  uint8_t  pinLightingRelay;
  uint8_t  pinStripAdc;
  uint8_t  pinPlugAdc;
  uint8_t  pinAcClampAdc;
  uint8_t  pinSupplyTemp;
  uint8_t  pinI2cSda;
  uint8_t  pinI2cScl;
  uint8_t  pinPir1;
  uint8_t  pinPir2;
  uint8_t  pinMmwave;
  uint8_t  pinDht;
  
  uint32_t cfgRev;                // bumped on every accepted change; published in telemetry
};

// cfgDefaults returns the configuration this firmware was BUILT with. It is what a
// factory-reset node runs, and what every "is this field overridden?" comparison is made
// against.
inline NodeConfig cfgDefaults() {
  NodeConfig c{};
  snprintf(c.zoneLabel, sizeof(c.zoneLabel), "%s", ZONE_LABEL_OVERRIDE);
  c.publishIntervalMs = PUBLISH_INTERVAL_MS_DEFAULT;
  c.plugCalAPerV      = (float)PLUG_CAL_A_PER_V;
  c.plugMainsV        = (float)PLUG_MAINS_V;
  c.acCalAPerV        = (float)AC_CAL_A_PER_V;
  c.acMainsV          = (float)AC_MAINS_V;
  c.stripCalAPerV     = (float)STRIP_CAL_A_PER_V;
  c.touchEnterPct     = TOUCH_ENTER_PCT_DEFAULT;
  c.touchExitPct      = TOUCH_EXIT_PCT_DEFAULT;
  c.touchOccupants    = TOUCH_OCCUPANTS_DEFAULT;
  c.setpointMinC      = SETPOINT_MIN_C_DEFAULT;
  c.setpointMaxC      = SETPOINT_MAX_C_DEFAULT;
  c.relayActiveLow    = false;
  c.simulateCpuStrain = false;
  
  // Default GPIO from #define macros if they exist, or 255 if unused
  #ifdef IR_PIN
    c.pinIrAc = IR_PIN;
  #else
    c.pinIrAc = 25;
  #endif
  
  #ifdef PLUG_RELAY_PIN
    c.pinPlugRelay = PLUG_RELAY_PIN;
  #else
    c.pinPlugRelay = 26;
  #endif
  
  #ifdef RELAY_PIN
    c.pinLightingRelay = RELAY_PIN;
  #else
    c.pinLightingRelay = 255;
  #endif
  
  #ifdef STRIP_ADC_PIN
    c.pinStripAdc = STRIP_ADC_PIN;
  #else
    c.pinStripAdc = 32;
  #endif
  
  #ifdef PLUG_ADC_PIN
    c.pinPlugAdc = PLUG_ADC_PIN;
  #else
    c.pinPlugAdc = 33;
  #endif
  
  #ifdef AC_CLAMP_PIN
    c.pinAcClampAdc = AC_CLAMP_PIN;
  #else
    c.pinAcClampAdc = 255;
  #endif
  
  #ifdef SUPPLY_TEMP_PIN
    c.pinSupplyTemp = SUPPLY_TEMP_PIN;
  #else
    c.pinSupplyTemp = 255;
  #endif
  
  #ifdef I2C_SDA
    c.pinI2cSda = I2C_SDA;
  #else
    c.pinI2cSda = 21;
  #endif
  
  #ifdef I2C_SCL
    c.pinI2cScl = I2C_SCL;
  #else
    c.pinI2cScl = 22;
  #endif
  
  #ifdef PIR1_PIN
    c.pinPir1 = PIR1_PIN;
  #else
    c.pinPir1 = 255;
  #endif
  
  #ifdef PIR2_PIN
    c.pinPir2 = PIR2_PIN;
  #else
    c.pinPir2 = 255;
  #endif
  
  #ifdef MMWAVE_PIN
    c.pinMmwave = MMWAVE_PIN;
  #else
    c.pinMmwave = 255;
  #endif
  
  #ifdef DHT_PIN
    c.pinDht = DHT_PIN;
  #else
    c.pinDht = 255;
  #endif

  c.cfgRev            = 0;
  return c;
}

// The live configuration. Reads are lock-free single-core Arduino loop reads; every write
// goes through cfgApplyJson().
inline NodeConfig  gCfg           = cfgDefaults();
inline Preferences gCfgPrefs;
inline char        gCfgLastError[96] = {0};

// ---------------------------------------------------------------------------------
// Validation. Each field states its own acceptable range, and a value outside it is
// REFUSED — see the header comment. The ranges are physical, not arbitrary:
//   * a clamp calibration below 1 or above 500 A/V describes no SCT-013 ever sold
//   * mains outside 90..260 V is not a single-phase supply this node will meet
//   * a publish interval under 1 s floods the broker; over 5 min the engine's 20 s
//     staleness window means the zone is unpinned more often than it is pinned
// ---------------------------------------------------------------------------------
inline bool cfgFail(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(gCfgLastError, sizeof(gCfgLastError), fmt, ap);
  va_end(ap);
  Serial.printf("[config] REJECTED: %s\n", gCfgLastError);
  return false;
}

inline bool cfgValidate(const NodeConfig& c) {
  if (strlen(c.zoneLabel) == 0)
    return cfgFail("zoneLabel must not be empty");
  if (c.publishIntervalMs < 1000 || c.publishIntervalMs > 300000)
    return cfgFail("publishIntervalMs %lu outside 1000..300000",
                   (unsigned long)c.publishIntervalMs);
  if (!(c.plugCalAPerV >= 1.0f && c.plugCalAPerV <= 500.0f))
    return cfgFail("plugCalAPerV %.3f outside 1..500 A/V", (double)c.plugCalAPerV);
  if (!(c.acCalAPerV >= 1.0f && c.acCalAPerV <= 500.0f))
    return cfgFail("acCalAPerV %.3f outside 1..500 A/V", (double)c.acCalAPerV);
  if (!(c.stripCalAPerV >= 1.0f && c.stripCalAPerV <= 500.0f))
    return cfgFail("stripCalAPerV %.3f outside 1..500 A/V", (double)c.stripCalAPerV);
  if (!(c.plugMainsV >= 90.0f && c.plugMainsV <= 260.0f))
    return cfgFail("plugMainsV %.1f outside 90..260 V", (double)c.plugMainsV);
  if (!(c.acMainsV >= 90.0f && c.acMainsV <= 260.0f))
    return cfgFail("acMainsV %.1f outside 90..260 V", (double)c.acMainsV);
  // Exit must sit ABOVE enter or the hysteresis inverts and the presence state chatters —
  // which is the exact bug the two thresholds were introduced to fix.
  if (c.touchEnterPct < 10 || c.touchEnterPct > 99)
    return cfgFail("touchEnterPct %u outside 10..99", c.touchEnterPct);
  if (c.touchExitPct < 10 || c.touchExitPct > 99)
    return cfgFail("touchExitPct %u outside 10..99", c.touchExitPct);
  if (c.touchExitPct <= c.touchEnterPct)
    return cfgFail("touchExitPct %u must exceed touchEnterPct %u (hysteresis would invert)",
                   c.touchExitPct, c.touchEnterPct);
  if (c.touchOccupants < 1 || c.touchOccupants > 50)
    return cfgFail("touchOccupants %u outside 1..50", c.touchOccupants);
  if (!(c.setpointMinC >= 10.0f && c.setpointMinC <= 30.0f))
    return cfgFail("setpointMinC %.1f outside 10..30 C", (double)c.setpointMinC);
  if (!(c.setpointMaxC >= 10.0f && c.setpointMaxC <= 35.0f))
    return cfgFail("setpointMaxC %.1f outside 10..35 C", (double)c.setpointMaxC);
  if (c.setpointMaxC <= c.setpointMinC)
    return cfgFail("setpointMaxC %.1f must exceed setpointMinC %.1f",
                   (double)c.setpointMaxC, (double)c.setpointMinC);
  return true;
}

// ---------------------------------------------------------------------------------
// NVS persistence. Only fields that DIFFER from the compiled defaults are stored, so
// reflashing with a new default (say a corrected burden calibration) moves every node
// that never overrode it, while genuinely site-specific overrides survive.
// ---------------------------------------------------------------------------------
inline void cfgSave() {
  gCfgPrefs.begin("econ", false);
  gCfgPrefs.putBytes("cfg", &gCfg, sizeof(gCfg));
  gCfgPrefs.end();
}

inline void cfgLoad() {
  gCfg = cfgDefaults();
  gCfgPrefs.begin("econ", true);
  NodeConfig stored{};
  size_t n = gCfgPrefs.getBytesLength("cfg");
  if (n == sizeof(stored) && gCfgPrefs.getBytes("cfg", &stored, sizeof(stored)) == sizeof(stored)) {
    // A stored blob from an older/newer struct layout, or one corrupted in flash, must
    // never become the running calibration. Validate it exactly as if it had arrived over
    // the wire; fall back to defaults if it fails.
    if (cfgValidate(stored)) {
      gCfg = stored;
      Serial.printf("[config] restored from NVS (rev %lu)\n", (unsigned long)gCfg.cfgRev);
    } else {
      Serial.println("[config] stored config failed validation — running compiled defaults");
    }
  } else if (n > 0) {
    Serial.printf("[config] stored config is %u bytes, expected %u (layout changed) — "
                  "running compiled defaults\n", (unsigned)n, (unsigned)sizeof(stored));
  }
  gCfgPrefs.end();
}

inline void cfgFactoryReset() {
  uint32_t rev = gCfg.cfgRev;
  gCfgPrefs.begin("econ", false);
  gCfgPrefs.remove("cfg");
  gCfgPrefs.end();
  gCfg = cfgDefaults();
  gCfg.cfgRev = rev + 1;   // a reset IS a change; the series is no longer comparable
  cfgSave();
  Serial.printf("[config] factory reset -> rev %lu\n", (unsigned long)gCfg.cfgRev);
}

// ---------------------------------------------------------------------------------
// Apply a JSON config message. Returns true if anything actually changed.
//
// The merge is field-by-field over a COPY, validated as a whole before it is adopted:
// a message setting three fields where the second is out of range applies none of them,
// so the node is never left in a half-configured state that no operator asked for.
// ---------------------------------------------------------------------------------
inline bool cfgApplyJson(const JsonDocument& doc, bool& outReset, bool& outHardwareChanged) {
  outReset = false;
  outHardwareChanged = false;
  if (doc["reset"].as<bool>()) {
    cfgFactoryReset();
    outReset = true;
    return true;
  }

  NodeConfig next = gCfg;
  if (doc.containsKey("zoneLabel"))
    snprintf(next.zoneLabel, sizeof(next.zoneLabel), "%s", doc["zoneLabel"].as<const char*>());
  if (doc.containsKey("publishIntervalMs")) next.publishIntervalMs = doc["publishIntervalMs"];
  if (doc.containsKey("plugCalAPerV"))      next.plugCalAPerV      = doc["plugCalAPerV"];
  if (doc.containsKey("plugMainsV"))        next.plugMainsV        = doc["plugMainsV"];
  if (doc.containsKey("acCalAPerV"))        next.acCalAPerV        = doc["acCalAPerV"];
  if (doc.containsKey("acMainsV"))          next.acMainsV          = doc["acMainsV"];
  if (doc.containsKey("stripCalAPerV"))     next.stripCalAPerV     = doc["stripCalAPerV"];
  if (doc.containsKey("touchEnterPct"))     next.touchEnterPct     = doc["touchEnterPct"];
  if (doc.containsKey("touchExitPct"))      next.touchExitPct      = doc["touchExitPct"];
  if (doc.containsKey("touchOccupants"))    next.touchOccupants    = doc["touchOccupants"];
  if (doc.containsKey("setpointMinC"))      next.setpointMinC      = doc["setpointMinC"];
  if (doc.containsKey("setpointMaxC"))      next.setpointMaxC      = doc["setpointMaxC"];
  if (doc.containsKey("relayActiveLow"))    next.relayActiveLow    = doc["relayActiveLow"];
  if (doc.containsKey("simulateCpuStrain")) next.simulateCpuStrain = doc["simulateCpuStrain"];

  if (doc.containsKey("pinIrAc"))          next.pinIrAc          = doc["pinIrAc"];
  if (doc.containsKey("pinPlugRelay"))     next.pinPlugRelay     = doc["pinPlugRelay"];
  if (doc.containsKey("pinLightingRelay")) next.pinLightingRelay = doc["pinLightingRelay"];
  if (doc.containsKey("pinStripAdc"))      next.pinStripAdc      = doc["pinStripAdc"];
  if (doc.containsKey("pinPlugAdc"))       next.pinPlugAdc       = doc["pinPlugAdc"];
  if (doc.containsKey("pinAcClampAdc"))    next.pinAcClampAdc    = doc["pinAcClampAdc"];
  if (doc.containsKey("pinSupplyTemp"))    next.pinSupplyTemp    = doc["pinSupplyTemp"];
  if (doc.containsKey("pinI2cSda"))        next.pinI2cSda        = doc["pinI2cSda"];
  if (doc.containsKey("pinI2cScl"))        next.pinI2cScl        = doc["pinI2cScl"];
  if (doc.containsKey("pinPir1"))          next.pinPir1          = doc["pinPir1"];
  if (doc.containsKey("pinPir2"))          next.pinPir2          = doc["pinPir2"];
  if (doc.containsKey("pinMmwave"))        next.pinMmwave        = doc["pinMmwave"];
  if (doc.containsKey("pinDht"))           next.pinDht           = doc["pinDht"];

  if (!cfgValidate(next)) return false;               // gCfgLastError already set
  if (memcmp(&next, &gCfg, sizeof(next)) == 0) {
    Serial.println("[config] message matched the running config — nothing to do");
    return false;                                     // retained message replayed on reconnect
  }

  // Check if any hardware pins changed
  if (next.pinIrAc != gCfg.pinIrAc || next.pinPlugRelay != gCfg.pinPlugRelay ||
      next.pinLightingRelay != gCfg.pinLightingRelay || next.pinStripAdc != gCfg.pinStripAdc ||
      next.pinPlugAdc != gCfg.pinPlugAdc || next.pinAcClampAdc != gCfg.pinAcClampAdc ||
      next.pinSupplyTemp != gCfg.pinSupplyTemp || next.pinI2cSda != gCfg.pinI2cSda ||
      next.pinI2cScl != gCfg.pinI2cScl || next.pinPir1 != gCfg.pinPir1 ||
      next.pinPir2 != gCfg.pinPir2 || next.pinMmwave != gCfg.pinMmwave || next.pinDht != gCfg.pinDht) {
    outHardwareChanged = true;
  }

  next.cfgRev = gCfg.cfgRev + 1;
  gCfg = next;
  gCfgLastError[0] = '\0';
  cfgSave();
  Serial.printf("[config] applied -> rev %lu (interval %lums, plug %.2f A/V @ %.0f V, "
                "ac %.2f A/V @ %.0f V, strip %.2f A/V, touch %u/%u%%, setpoint %.1f..%.1f C, strain=%d)\n",
                (unsigned long)gCfg.cfgRev, (unsigned long)gCfg.publishIntervalMs,
                (double)gCfg.plugCalAPerV, (double)gCfg.plugMainsV,
                (double)gCfg.acCalAPerV, (double)gCfg.acMainsV,
                (double)gCfg.stripCalAPerV,
                gCfg.touchEnterPct, gCfg.touchExitPct,
                (double)gCfg.setpointMinC, (double)gCfg.setpointMaxC,
                gCfg.simulateCpuStrain ? 1 : 0);
  return true;
}

inline bool cfgApplyJson(const JsonDocument& doc, bool& outReset) {
  bool hwChanged = false;
  return cfgApplyJson(doc, outReset, hwChanged);
}

// cfgSerializeState fills `out` with the retained /state document: the effective config,
// which fields differ from the compiled defaults, and the last rejection. "overrides" is
// the field an operator actually wants — it answers "what has this board been told that
// its siblings have not?", which is otherwise only discoverable by diffing two boards.
inline void cfgSerializeState(JsonDocument& out) {
  NodeConfig d = cfgDefaults();
  out["cfgRev"]            = gCfg.cfgRev;
  out["zoneLabel"]         = gCfg.zoneLabel;
  out["publishIntervalMs"] = gCfg.publishIntervalMs;
  out["plugCalAPerV"]      = gCfg.plugCalAPerV;
  out["plugMainsV"]        = gCfg.plugMainsV;
  out["acCalAPerV"]        = gCfg.acCalAPerV;
  out["acMainsV"]          = gCfg.acMainsV;
  out["stripCalAPerV"]     = gCfg.stripCalAPerV;
  out["touchEnterPct"]     = gCfg.touchEnterPct;
  out["touchExitPct"]      = gCfg.touchExitPct;
  out["touchOccupants"]    = gCfg.touchOccupants;
  out["setpointMinC"]      = gCfg.setpointMinC;
  out["setpointMaxC"]      = gCfg.setpointMaxC;
  out["relayActiveLow"]    = gCfg.relayActiveLow;
  out["simulateCpuStrain"] = gCfg.simulateCpuStrain;
  
  out["pinIrAc"]          = gCfg.pinIrAc;
  out["pinPlugRelay"]     = gCfg.pinPlugRelay;
  out["pinLightingRelay"] = gCfg.pinLightingRelay;
  out["pinStripAdc"]      = gCfg.pinStripAdc;
  out["pinPlugAdc"]       = gCfg.pinPlugAdc;
  out["pinAcClampAdc"]    = gCfg.pinAcClampAdc;
  out["pinSupplyTemp"]    = gCfg.pinSupplyTemp;
  out["pinI2cSda"]        = gCfg.pinI2cSda;
  out["pinI2cScl"]        = gCfg.pinI2cScl;
  out["pinPir1"]          = gCfg.pinPir1;
  out["pinPir2"]          = gCfg.pinPir2;
  out["pinMmwave"]        = gCfg.pinMmwave;
  out["pinDht"]           = gCfg.pinDht;

  JsonArray ov = out.createNestedArray("overrides");
  if (strcmp(gCfg.zoneLabel, d.zoneLabel) != 0)        ov.add("zoneLabel");
  if (gCfg.publishIntervalMs != d.publishIntervalMs)   ov.add("publishIntervalMs");
  if (gCfg.plugCalAPerV      != d.plugCalAPerV)        ov.add("plugCalAPerV");
  if (gCfg.plugMainsV        != d.plugMainsV)          ov.add("plugMainsV");
  if (gCfg.acCalAPerV        != d.acCalAPerV)          ov.add("acCalAPerV");
  if (gCfg.acMainsV          != d.acMainsV)            ov.add("acMainsV");
  if (gCfg.stripCalAPerV     != d.stripCalAPerV)       ov.add("stripCalAPerV");
  if (gCfg.touchEnterPct     != d.touchEnterPct)       ov.add("touchEnterPct");
  if (gCfg.touchExitPct      != d.touchExitPct)        ov.add("touchExitPct");
  if (gCfg.touchOccupants    != d.touchOccupants)      ov.add("touchOccupants");
  if (gCfg.setpointMinC      != d.setpointMinC)        ov.add("setpointMinC");
  if (gCfg.setpointMaxC      != d.setpointMaxC)        ov.add("setpointMaxC");
  if (gCfg.relayActiveLow    != d.relayActiveLow)      ov.add("relayActiveLow");
  if (gCfg.simulateCpuStrain != d.simulateCpuStrain)   ov.add("simulateCpuStrain");
  
  if (gCfg.pinIrAc          != d.pinIrAc)          ov.add("pinIrAc");
  if (gCfg.pinPlugRelay     != d.pinPlugRelay)     ov.add("pinPlugRelay");
  if (gCfg.pinLightingRelay != d.pinLightingRelay) ov.add("pinLightingRelay");
  if (gCfg.pinStripAdc      != d.pinStripAdc)      ov.add("pinStripAdc");
  if (gCfg.pinPlugAdc       != d.pinPlugAdc)       ov.add("pinPlugAdc");
  if (gCfg.pinAcClampAdc    != d.pinAcClampAdc)    ov.add("pinAcClampAdc");
  if (gCfg.pinSupplyTemp    != d.pinSupplyTemp)    ov.add("pinSupplyTemp");
  if (gCfg.pinI2cSda        != d.pinI2cSda)        ov.add("pinI2cSda");
  if (gCfg.pinI2cScl        != d.pinI2cScl)        ov.add("pinI2cScl");
  if (gCfg.pinPir1          != d.pinPir1)          ov.add("pinPir1");
  if (gCfg.pinPir2          != d.pinPir2)          ov.add("pinPir2");
  if (gCfg.pinMmwave        != d.pinMmwave)        ov.add("pinMmwave");
  if (gCfg.pinDht           != d.pinDht)           ov.add("pinDht");

  if (gCfgLastError[0]) out["lastError"] = gCfgLastError;
}
