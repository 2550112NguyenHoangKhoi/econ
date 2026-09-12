#pragma once
// Building and publishing the telemetry frame.
//
// Publishes only what was genuinely measured this cycle: any field whose sensor is absent
// or failed its read is omitted, so the engine keeps modelling it rather than trusting an
// invented number. Rule 1 of this project, enforced at the point of transmission.
//
// Split out of main.cpp for readability. It is #included from there at the point this
// code used to sit, so this is the same translation unit -- file-scope statics, include
// order and initialisation order are all exactly as they were. Verified by comparing
// the built firmware.bin before and after the split.

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
