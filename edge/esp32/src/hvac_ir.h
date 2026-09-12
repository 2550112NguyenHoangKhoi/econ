#pragma once
// HVAC control over IR -- where the engine's optimizer becomes a real setpoint change.
//
// acReal in telemetry says whether a frame was actually sent, and IRsend's return value is
// checked so a refused send reports REFUSED rather than counting as sent. A setback the AC
// never received must never be booked as a saving.
//
// Split out of main.cpp for readability. It is #included from there at the point this
// code used to sit, so this is the same translation unit -- file-scope statics, include
// order and initialisation order are all exactly as they were. Verified by comparing
// the built firmware.bin before and after the split.

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

  // Both of these capture their pin ONCE, in the constructor, and IRsend gives no way to
  // move it afterwards. They must therefore be built from a constant, not from gCfg:
  // gCfg is an inline variable whose dynamic initializer runs at static-init time, and
  // relying on it being ordered before these two objects in the same translation unit is
  // leaning on a corner of the standard (inline variables are only *partially* ordered)
  // for no benefit. kIrPin is constant-initialized, so there is no ordering question.
  //
  // The consequence, stated plainly because the config surface implies otherwise: the
  // blaster is bound to the compiled IR_PIN. Setting pinIrAc over MQTT changes what the
  // logs and /api report without moving a single pulse. setup() checks for that and says so.
  #ifdef IR_PIN
    static const uint8_t kIrPin = IR_PIN;
  #else
    static const uint8_t kIrPin = 25;
  #endif
  IRac ac(kIrPin);
  IRsend customIrSend(kIrPin);             // Generic IR sender for fans, TVs, etc.
  bool irAcReady = false;            // protocol compiled AND supported by the library

  // How many times each state frame is transmitted.
  //
  // Range is not the only thing that loses a frame. At the far end of the link the
  // receiver is deciding on a handful of microwatts against whatever else in the room is
  // radiating at 940 nm -- sunlight through a window, a fluorescent ballast, another
  // handset -- and one corrupted burst is the whole command gone, silently. There is no
  // acknowledgement on this link: the firmware cannot tell a frame that landed from one
  // that did not, and the twin goes on believing it set a setpoint it never set.
  //
  // Repeating is safe here specifically because these are absolute-state protocols. Every
  // frame IRac emits carries the complete desired state -- power, mode, temperature, fan --
  // so a second copy sets exactly what the first one set. That is NOT true of toggle-style
  // protocols, where a repeat would undo the command; if IR_AC_PROTOCOL is ever pointed at
  // one, this must go back to 1.
  //
  // The cost is blocking time in loop(), and it scales with the protocol's frame length:
  // ELECTRA_AC is 104 bits (~100 ms per frame), but HITACHI_AC344 and HITACHI_AC424 run
  // 344 and 424 bits -- closer to 400 ms each. Two frames is the useful default; on the
  // long Hitachi variants, weigh a second frame against ~0.8 s of stalled loop before
  // raising it.
  #ifndef IR_AC_REPEATS
    #define IR_AC_REPEATS 2
  #endif
  #ifndef IR_AC_REPEAT_GAP_MS
    #define IR_AC_REPEAT_GAP_MS 45     // handsets leave a similar gap between state frames
  #endif

  // Send the frame already staged in ac.next, IR_AC_REPEATS times.
  static void sendAcFrameRepeated() {
    for (int i = 0; i < (IR_AC_REPEATS); i++) {
      if (i) delay(IR_AC_REPEAT_GAP_MS);
      ac.sendAc();
    }
  }
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
    sendAcFrameRepeated();
    Serial.printf("[hvac] IR frame sent x%d: %s -> %.1f C\n",
                  (IR_AC_REPEATS), typeToString(gIrProtocol).c_str(), celsius);
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
    sendAcFrameRepeated();
    Serial.printf("[hvac] IR frame sent x%d: %s -> POWER OFF\n",
                  (IR_AC_REPEATS), typeToString(gIrProtocol).c_str());
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
