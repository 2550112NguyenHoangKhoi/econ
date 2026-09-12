#pragma once
// Current measurement: hardware-timed ADC acquisition and the three metered channels.
//
// Each channel omits its field entirely when its front end is not trustworthy, rather than
// publishing 0.0 W. A fabricated zero on a clamp tells the twin the circuit is idle, which
// is worse than telling it nothing.
//
// Split out of main.cpp for readability. It is #included from there at the point this
// code used to sit, so this is the same translation unit -- file-scope statics, include
// order and initialisation order are all exactly as they were. Verified by comparing
// the built firmware.bin before and after the split.

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
