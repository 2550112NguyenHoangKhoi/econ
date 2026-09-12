#pragma once
// The command surface: everything an operator or the engine can ask this node to do.
//
// Accepts "LIGHTS_ON;SETPOINT=22.0" and friends, ignoring unknown ;KEY=VAL tokens such as
// the gateway's ;SRC=FAILSAFE. Also hosts the bring-up diagnostics -- IR_CARRIER,
// IR_GPIO_TEST, IR_LOAD_TEST, IR_SWEEP, RD03_LINETEST, CO2_CAL -- each isolating one layer
// of one subsystem so a fault can be attributed rather than guessed at.
//
// Split out of main.cpp for readability. It is #included from there at the point this
// code used to sit, so this is the same translation unit -- file-scope statics, include
// order and initialisation order are all exactly as they were. Verified by comparing
// the built firmware.bin before and after the split.

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
    // Hardware-only test for the emitter, with no protocol involved.
    //
    // "The AC does not respond" has two causes that look identical from the serial log: the
    // LED is not firing, or it is firing a vendor protocol this unit does not speak. A
    // normal frame cannot tell them apart -- it is 20 % duty cycle spread over a couple of
    // hundred milliseconds, too brief and too dim to judge by eye and far too brief to put
    // a multimeter across. This emits 2 s of unmodulated 38 kHz carrier instead, which is
    // long enough to photograph and long enough to measure:
    //
    //   phone camera  -> steady violet glow, not a flicker. Nothing = the LED, the
    //                    transistor pinout or a leg in the wrong column. Protocol is
    //                    irrelevant to this test.
    //   meter across R2 -> the carrier is 50 % duty, so a DC meter reads half the peak drop.
    //                    ~1.4 V across 15 ohm = 95 mA average = 190 mA peak, which is the
    //                    design figure. Near 0 V means no current is flowing at all; the
    //                    full rail means the transistor is never turning on.
    //
    // Blocks loop() for the full 2 s. That is the point -- it is a deliberate diagnostic,
    // not something the engine should ever send on its own.
    // Which of head 1's two UART wires is broken.
    //
    // "no ACK on open-command-mode" is a symptom of three different faults and cannot tell
    // them apart: our TX never reaches the module (GPIO17 -> module RX), the module's reply
    // never reaches us (module OT1 -> GPIO16), or the module is deaf. The OT2 pull test
    // already settles the power question, so what is left is the pair of data wires.
    //
    // A UART transmitter idles HIGH. So the RX pin can be interrogated exactly the way OT2
    // is: park an internal pulldown on it and see whether it still reads high. Only a real
    // driver on the far end holds a line up against a ~45k pulldown, so:
    //
    //   DRIVEN HIGH -> the module's TX pad is connected and idling. That wire is good, and
    //                  the fault is on the OTHER wire (GPIO17 -> module RX) or in the module.
    //   FOLLOWS THE PULLS -> nothing is driving the line: that wire is open, or the module's
    //                  TX pad is dead. This is the half to reseat.
    //
    // Head 2 is tested too, as a control. Its UART demonstrably works, so its reading is
    // what "good" looks like on this board -- without that reference a single result is
    // hard to trust.
    else if (tok == "RD03_LINETEST") {
#if USE_MMWAVE_UART || USE_MMWAVE2_UART
      for (int h = 0; h < 2; h++) {
        HardwareSerial* io = nullptr; const char* label = nullptr;
        uint8_t rxPin = 255, txPin = 255;
  #if USE_MMWAVE_UART
        if (h == 0) { io = &Serial2; label = "head1"; rxPin = MMWAVE_UART_RX;  txPin = MMWAVE_UART_TX;  }
  #endif
  #if USE_MMWAVE2_UART
        if (h == 1) { io = &Serial1; label = "head2"; rxPin = MMWAVE2_UART_RX; txPin = MMWAVE2_UART_TX; }
  #endif
        if (!io) continue;

        io->end();                       // release the pin from the UART peripheral
        delay(20);
        pinMode(rxPin, INPUT_PULLDOWN); delay(5);
        const int withPulldown = digitalRead(rxPin);
        pinMode(rxPin, INPUT_PULLUP);   delay(5);
        const int withPullup   = digitalRead(rxPin);
        pinMode(rxPin, INPUT);

        const bool driven  = (withPulldown == HIGH);          // held up against the pulldown
        const bool floating = (withPulldown == LOW && withPullup == HIGH);
        Serial.printf("[rd03:%s] RX line GPIO%d: pulldown=%s pullup=%s -> %s\n",
                      label, rxPin,
                      withPulldown == HIGH ? "HIGH" : "low",
                      withPullup   == HIGH ? "high" : "LOW",
                      driven   ? "DRIVEN HIGH by the module (TX pad connected, UART idling)"
                      : floating ? "FLOATING — nothing is driving this line: the wire is open "
                                   "or the module's TX pad is dead"
                                 : "STUCK LOW — shorted to GND, or the module is mid-transmission");

        io->begin(115200, SERIAL_8N1, rxPin, txPin);
        delay(20);
        while (io->available()) (void)io->read();

        // Anything arriving unprompted? A silent line here with a DRIVEN verdict above
        // means the module is connected but not talking, which points at our TX wire.
        // Hex AND the ASCII rendering. These modules do not all speak the same protocol:
        // the binary report frame opens F4 F3 F2 F1, but a head running the ASCII presence
        // firmware emits plain text instead, and in hex the two are indistinguishable to
        // anyone not decoding by hand. Printing both makes the difference obvious in the log.
        const uint32_t until = millis() + 2500;
        uint8_t got[192];
        int n = 0;
        while (millis() < until && n < (int)sizeof(got)) {
          if (io->available()) got[n++] = (uint8_t)io->read();
        }
        if (!n) {
          Serial.printf("[rd03:%s] listening 2.5 s for unprompted bytes: (silence)\n", label);
        } else {
          Serial.printf("[rd03:%s] %d bytes in 2.5 s\n", label, n);
          Serial.printf("[rd03:%s]   hex:   ", label);
          for (int i = 0; i < n; i++) Serial.printf("%02X ", got[i]);
          Serial.printf("\n[rd03:%s]   ascii: ", label);
          for (int i = 0; i < n; i++) {
            const uint8_t c = got[i];
            if (c == 0x0D) Serial.print("\\r");
            else if (c == 0x0A) Serial.print("\\n");
            else if (c >= 0x20 && c < 0x7F) Serial.write(c);
            else Serial.print(".");
          }
          const bool binary = (n >= 4 && got[0] == 0xF4 && got[1] == 0xF3 &&
                               got[2] == 0xF2 && got[3] == 0xF1);
          Serial.printf("\n[rd03:%s]   -> %s\n", label,
                        binary ? "binary Rd-03 report frames (this is what the parser expects)"
                               : "NOT the binary report frame. If this reads as plain text, the "
                                 "head is running ASCII presence firmware and will never ACK a "
                                 "binary command — different protocol, not a broken link");
        }
      }
      Serial.println("[rd03] line test done — heads reinitialise on the next probe cycle");
#else
      Serial.println("[rd03] RD03_LINETEST ignored (no radar UART compiled in)");
#endif
    }
    // The same 2 s of 38 kHz, bit-banged on the pin directly — no IRsend, no IRac, no
    // library state. Run it back to back with IR_CARRIER:
    //   both light the LED   -> the emitter and the library are both fine
    //   only this one lights -> the IRsend object is driving a different pin than we think
    //   neither lights       -> the fault is in the circuit, not the code
    // Every AC protocol IRac can build, one after another, ~2 s apart.
    //
    // Hand-picking a dozen candidates was never going to be enough: the Vietnamese market is
    // full of OEM units (Midea, TCL, Haier, Sharp, Funiki, Sumikura, Carrier) whose remotes
    // are nothing like the brand on the front panel, and a miss looks identical to a dead
    // emitter. IRac knows exactly which protocols it can construct a frame for, so ask it
    // rather than guessing, and try all of them.
    //
    // Each step alternates 18/30 C so a unit that understands the frame reacts visibly --
    // nearly all of them beep and redraw the setpoint. Watch the AC and note the index.
    // MQTT is serviced between steps so the session survives the couple of minutes this takes.
    else if (tok == "IR_SWEEP") {
#if USE_IR_AC
      const decode_type_t restore = gIrProtocol;
      int idx = 0;
      Serial.println("[ir sweep] starting — watch the AC and note the index when it reacts");
      for (int t = 1; t <= kLastDecodeType; t++) {
        const decode_type_t p = (decode_type_t)t;
        if (!IRac::isProtocolSupported(p)) continue;
        idx++;
        IRac::initState(&ac.next);
        ac.next.protocol = p;
        ac.next.model    = 1;
        ac.next.mode     = stdAc::opmode_t::kCool;
        ac.next.celsius  = true;
        ac.next.degrees  = (idx % 2) ? 30 : 18;
        ac.next.fanspeed = stdAc::fanspeed_t::kAuto;
        ac.next.power    = true;
        Serial.printf("[ir sweep] %3d  %-20s -> %2.0f C\n",
                      idx, typeToString(p).c_str(), (double)ac.next.degrees);
        ac.sendAc();
        for (int w = 0; w < 20; w++) { client.loop(); delay(100); }   // keep MQTT alive
      }
      gIrProtocol = restore;
      hvacPowerOn = !hvacPowerOn;          // force the next real command to transmit
      Serial.printf("[ir sweep] done — %d protocols tried, restored %s\n",
                    idx, typeToString(restore).c_str());
#else
      Serial.println("[ir] IR_SWEEP ignored (built without USE_IR_AC=1)");
#endif
    }
    // Does the IR LED actually draw current? Answered without a multimeter.
    //
    // The ACS712 on the strip channel is powered from the same 5 V rail as the emitter and
    // idles at Vcc/2, halved again by its 10k/10k divider — so the strip ADC is a live
    // voltmeter on that rail, already wired and already calibrated. Hold the LED hard on,
    // and if current is really flowing the rail sags through the jumper and contact
    // resistance feeding it. No sag means no current, whatever the LED looks like.
    //
    // The earlier attempt at this failed because IR_CARRIER blocks loop(), so the strip
    // channel never sampled while the carrier ran. Here both live in one function.
    // Single-point CO2 calibration, command 0x5204, with a gate on the air it is given.
    //
    // This writes the sensor's zero. Issue it in occupied air and you do not get a slightly
    // wrong sensor, you get a confidently wrong one: tell a sensor sitting in 2000 ppm that
    // it is breathing 420, and from then on it under-reports by 1600 ppm while every
    // self-check it has still passes. There is no way to detect that downstream, and the
    // twin would act on it. So the node refuses unless the air looks like still outdoor air.
    //
    // The gate is stability, not absolute value, because stability is the thing that
    // actually distinguishes the two cases. Outdoor air with nobody near it sits within a
    // few ppm for minutes. An occupied room wanders and spikes -- one breath within a metre
    // moves this sensor hundreds of ppm, which is how the 5742 ppm peak in this node's
    // history got there. 60 s of sampling, and a peak-to-peak over 50 ppm means whatever is
    // in front of the sensor is not a stable reference and the write is refused.
    else if (tok.startsWith("CO2_CAL=")) {
#if USE_CO2
      String arg = tok.substring(8);
      bool forced = false;
      const int comma = arg.indexOf(',');
      if (comma >= 0) { forced = arg.substring(comma + 1) == "FORCE"; arg = arg.substring(0, comma); }
      const long target = arg.toInt();
      if (target < 380 || target > 2000) {
        Serial.printf("[co2 cal] target %ld ppm rejected — expected 380..2000. Outdoor air is "
                      "~420 ppm and is the only reference worth using.\n", target);
      } else {
        Serial.printf("[co2 cal] sampling 60 s before writing %ld ppm — hold still and stay "
                      "away from the sensor\n", target);
        long sum = 0; int n = 0, lo = 99999, hi = 0;
        for (int i = 0; i < 30; i++) {
          int ppm;
          if (readCo2(ppm)) { sum += ppm; n++; if (ppm < lo) lo = ppm; if (ppm > hi) hi = ppm; }
          for (int w = 0; w < 20; w++) { client.loop(); delay(100); }
        }
        const int spread = (n ? hi - lo : 9999);
        const double mean = (n ? (double)sum / n : 0.0);
        Serial.printf("[co2 cal] %d/30 valid reads, mean %.0f ppm, range %d..%d (spread %d)\n",
                      n, mean, lo, hi, spread);
        if (n < 20) {
          Serial.println("[co2 cal] REFUSED — too few valid reads to trust the air sample.");
        } else if (spread > 50) {
          Serial.printf("[co2 cal] REFUSED — %d ppm of drift over a minute is not a stable "
                        "reference. Still outdoor air holds within a few ppm; this is someone "
                        "breathing nearby, or a room that is still changing.\n", spread);
        } else if (fabs(mean - (double)target) > 800.0 && !forced) {
          // Stability is necessary but NOT sufficient: a still, closed, occupied room is
          // also stable, and that is precisely the situation in which someone impatient
          // runs this command and silently destroys the sensor's zero. ABC drift is
          // typically a few hundred ppm; a correction approaching four figures is far more
          // likely to mean the sensor is still indoors than that it has drifted that far.
          Serial.printf("[co2 cal] REFUSED — the air reads %.0f ppm and you declared %ld. A "
                        "%+.0f ppm correction is larger than baseline drift explains, and the "
                        "usual cause is running this indoors. If the sensor really is outside "
                        "and settled, repeat as CO2_CAL=%ld,FORCE\n",
                        mean, target, (double)target - mean, target);
        } else {
          const uint8_t hiB = (uint8_t)((target >> 8) & 0xFF), loB = (uint8_t)(target & 0xFF);
          Wire1.beginTransmission(ACD1200_ADDR);
          Wire1.write(0x52); Wire1.write(0x04);
          Wire1.write(hiB);  Wire1.write(loB);
          Wire1.write(crc8_31(hiB, loB));
          const bool wrote = (Wire1.endTransmission() == 0);
          delay(20);
          Serial.printf("[co2 cal] %s — sensor was reading %.0f ppm in air declared to be "
                        "%ld ppm, a %+.0f ppm correction\n",
                        wrote ? "WRITTEN" : "WRITE FAILED (sensor did not ACK)",
                        mean, target, (double)target - mean);
          if (wrote) Serial.println("[co2 cal] allow a few minutes for the reading to settle");
        }
      }
#else
      Serial.println("[co2 cal] ignored (built without USE_CO2=1)");
#endif
    }
    else if (tok == "IR_LOAD_TEST") {
#if USE_IR_AC && USE_STRIP
      const uint8_t adcPin = gCfg.pinStripAdc;
      auto avgCounts = [&](int n) {
        long total = 0;
        for (int i = 0; i < n; i++) { total += analogRead(adcPin); delayMicroseconds(150); }
        return (double)total / n;
      };
      pinMode(kIrPin, OUTPUT);
      digitalWrite(kIrPin, LOW);
      delay(60);
      const double before = avgCounts(400);
      digitalWrite(kIrPin, HIGH);           // LED hard on, DC, for the sample window only
      delayMicroseconds(500);               // let the rail settle
      const double loaded = avgCounts(400);
      digitalWrite(kIrPin, LOW);
      delay(60);
      const double after = avgCounts(400);

      // V_pin = Vcc/4, so Vcc = 4 * counts * 3.3/4095.
      const double kVoltsPerCount = 4.0 * 3.3 / 4095.0;
      const double idle = (before + after) / 2.0;
      const double sagCounts = idle - loaded;
      Serial.printf("[ir load] rail idle %.1f cts (%.2f V)  |  LED on %.1f cts (%.2f V)  |  "
                    "sag %+.1f cts = %+.3f V\n",
                    idle, idle * kVoltsPerCount, loaded, loaded * kVoltsPerCount,
                    sagCounts, sagCounts * kVoltsPerCount);
      // Three bands, not two. The first version only had a lower threshold, so a dead short
      // -- which collapses the rail to near zero -- reported the same cheerful "current is
      // flowing" as a healthy 374 mA. It is flowing, but that is not the useful thing to say.
      if (sagCounts >= 150.0) {
        Serial.printf("[ir load] -> RAIL COLLAPSE, NOT A LOAD. %.0f counts of sag is a near "
                      "short, not an emitter: disconnect it now. At this impedance the 15 ohm "
                      "resistors dissipate several times their rating.\n", sagCounts);
      } else if (sagCounts >= 8.0) {
        Serial.println("[ir load] -> CURRENT IS FLOWING. The emitter circuit conducts; if the AC "
                       "still ignores it, the fault is the protocol, not the wiring.");
      } else {
        Serial.println("[ir load] -> NO MEASURABLE CURRENT. The transistor is being driven but "
                       "nothing is conducting: check the LED polarity (long leg to the resistor), "
                       "the transistor's E/B/C order, and that every leg is truly seated.");
      }
#else
      Serial.println("[ir] IR_LOAD_TEST needs USE_IR_AC and USE_STRIP");
#endif
    }
    else if (tok == "IR_GPIO_TEST") {
#if USE_IR_AC
      Serial.printf("[ir] raw GPIO test: 2 s of bit-banged 38 kHz on GPIO%d (no IR library)\n",
                    kIrPin);
      pinMode(kIrPin, OUTPUT);
      const uint32_t until = millis() + 2000;
      noInterrupts();
      while (millis() < until) {
        for (int i = 0; i < 380 && millis() < until; i++) {   // ~10 ms of carrier per pass
          digitalWrite(kIrPin, HIGH); delayMicroseconds(13);
          digitalWrite(kIrPin, LOW);  delayMicroseconds(13);
        }
        interrupts();                     // let WiFi/MQTT breathe between bursts
        delayMicroseconds(50);
        noInterrupts();
      }
      interrupts();
      digitalWrite(kIrPin, LOW);
      Serial.println("[ir] raw GPIO test done");
#else
      Serial.println("[ir] IR_GPIO_TEST ignored (built without USE_IR_AC=1)");
#endif
    }
    // IR_CARRIER, or IR_CARRIER=<seconds> for a longer window.
    //
    // 2 s is plenty to photograph but too short to METER: a typical handheld updates about
    // twice a second and needs a second or two to settle, so a 2 s burst reads somewhere
    // between zero and the real figure. Anyone putting probes across R2 wants ~10 s.
    //
    // Capped at 10 s deliberately. The carrier is 50 % duty, so a 10 s run puts ~95 mA
    // average through each emitter (rated 100 mA continuous) and ~0.27 W in a quarter-watt
    // R2 — inside the short-overload a resistor's thermal mass absorbs, but the part will be
    // warm to the touch and there is no reason to hold it longer than a reading takes.
    else if (tok == "IR_CARRIER" || tok.startsWith("IR_CARRIER=")) {
#if USE_IR_AC
      long secs = 2;
      if (tok.startsWith("IR_CARRIER=")) {
        secs = tok.substring(11).toInt();
        if (secs < 1)  secs = 2;
        if (secs > 10) secs = 10;
      }
      Serial.printf("[ir] carrier test: %ld s of 38 kHz on GPIO%d -- phone camera, "
                    "or DC volts across one 15 ohm\n", secs, kIrPin);
      customIrSend.begin();
      customIrSend.enableIROut(38);
      for (long i = 0; i < secs * 20; i++) customIrSend.mark(50000);  // mark() takes uint16_t
      customIrSend.space(0);                                          // leave the pin low
      Serial.println("[ir] carrier test done");
#else
      Serial.println("[ir] IR_CARRIER ignored (built without USE_IR_AC=1)");
#endif
    }
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
            // send() returns false for every state-based protocol. Those carry their frame
            // in a byte array, not a 64-bit value, so there is no data to hand this overload
            // and IRsend refuses rather than emitting something wrong. Ignoring the return
            // and printing "sent" regardless reports a transmission that never left the pin —
            // exactly the kind of fabricated confirmation the log exists to prevent.
            if (customIrSend.send(protocol, data, nbits)) {
              Serial.printf("[ir] sent %s: 0x%llx (%d bits)\n",
                            protoStr.c_str(), (unsigned long long)data, nbits);
            } else {
              Serial.printf("[ir] %s REFUSED — nothing was transmitted. It is a state-based "
                            "protocol: its frame is a byte array, not a %d-bit value, so raw "
                            "IR_SEND cannot express it. Use SETPOINT=/HVAC_OFF, which go "
                            "through IRac and can build the full frame.\n",
                            protoStr.c_str(), nbits);
            }
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
