
#include "ov7670_driver.h"
#if USE_CAMERA

#include <cstring>
#include <cstdlib>

#if defined(ESP32) && !defined(HOST_TEST)
#include <Arduino.h>
#include <Wire.h>
#include "esp_camera.h"
#include "esp_log.h"
#else
#include <chrono>
static inline uint32_t getHostMillis() {
  static auto start = std::chrono::steady_clock::now() - std::chrono::milliseconds(1000);
  auto now = std::chrono::steady_clock::now();
  return (uint32_t)std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count();
}
#endif

// Complete OV7670 QQVGA Grayscale / YUV Initialization Register Table
static const OV7670RegisterConfig kOV7670_QQVGA_InitRegs[] = {
  // Register set ported from a known-working OV7670 implementation (the Linux driver's
  // table, as used by Siarhei Charkes' AVR capture sketch), rather than the 28-register
  // subset this file previously carried. Three of those 28 were provably wrong:
  //
  //   0x73 SCALING_PCLK_DIV  was 0x02, must be 0xf0|divider — the upper nibble is a
  //                          reserved value the part requires, and writing 0 there is
  //                          exactly the kind of thing that yields timing with no frame.
  //   0x32 HREF              was 0x24, known-good is 0xa4.
  //   reset settle           was 5 ms, the working driver waits 100 ms after COM7=0x80.
  //
  // The rest of what was missing is the gamma curve, the AGC/AEC parameters and the
  // 0x79/0xc8 multiplexor sequence — the "magic reserved" writes that look skippable and
  // are not: many OV7670s will configure happily without them and never emit a stable
  // signal, which is the symptom on this node.
  //
  // ORDER MATTERS. The default set writes COM10 = 0x00, so the PCLK-gating bit has to be
  // re-applied AFTER it (see the COM10 entry below); doing it earlier gets overwritten.

  // ---- 1. Soft reset, then the full default register set ----
  {OV7670_REG_COM7, 0x80}, {OV7670_REG_DELAY_TOKEN, 100},
  {OV7670_REG_TSLB, 0x04}, {OV7670_REG_COM7, 0x00},
  {OV7670_REG_HSTART, 0x13}, {OV7670_REG_HSTOP, 0x01},
  {OV7670_REG_HREF, 0xb6},   {OV7670_REG_VSTART, 0x02},
  {OV7670_REG_VSTOP, 0x7a},  {OV7670_REG_VREF, 0x0a},
  {OV7670_REG_COM3, 0x00},   {OV7670_REG_COM14, 0x00},
  {0x70, 0x3a}, {0x71, 0x35}, {0x72, 0x11}, {0x73, 0xf0},
  {0xa2, 0x01}, {OV7670_REG_COM10, 0x00},
  {0x7a, 0x20}, {0x7b, 0x10}, {0x7c, 0x1e}, {0x7d, 0x35},
  {0x7e, 0x5a}, {0x7f, 0x69}, {0x80, 0x76}, {0x81, 0x80},
  {0x82, 0x88}, {0x83, 0x8f}, {0x84, 0x96}, {0x85, 0xa3},
  {0x86, 0xaf}, {0x87, 0xc4}, {0x88, 0xd7}, {0x89, 0xe8},
  {OV7670_REG_COM8, 0xc0}, {OV7670_REG_GAIN, 0x00}, {OV7670_REG_AECH, 0x00},
  {OV7670_REG_COM4, 0x40}, {OV7670_REG_COM9, 0x18},
  {0xa5, 0x05}, {0xab, 0x07},
  {OV7670_REG_AEW, 0x95}, {OV7670_REG_AEB, 0x33}, {OV7670_REG_VPT, 0xe3},
  {0x9f, 0x78}, {0xa0, 0x68}, {0xa1, 0x03}, {0xa6, 0xd8}, {0xa7, 0xd8},
  {0xa8, 0xf0}, {0xa9, 0x90}, {0xaa, 0x94},
  {OV7670_REG_COM8, 0xc5},
  {0x30, 0x00}, {0x31, 0x00},
  {OV7670_REG_COM5, 0x61}, {OV7670_REG_COM6, 0x4b},
  {0x16, 0x02}, {OV7670_REG_MVFP, 0x07}, {0x21, 0x02}, {0x22, 0x91},
  {0x29, 0x07}, {0x33, 0x0b}, {0x35, 0x0b}, {0x37, 0x1d},
  {0x38, 0x71}, {0x39, 0x2a}, {0x3c, 0x78}, {0x4d, 0x40},
  {0x4e, 0x20}, {0x69, 0x00}, {0x74, 0x10},
  {0x8d, 0x4f}, {0x8e, 0x00}, {0x8f, 0x00}, {0x90, 0x00},
  {0x91, 0x00}, {0x96, 0x00}, {0x9a, 0x00}, {0xb0, 0x84},
  {0xb1, 0x0c}, {0xb2, 0x0e}, {0xb3, 0x82}, {0xb8, 0x0a},
  {0x43, 0x0a}, {0x44, 0xf0}, {0x45, 0x34}, {0x46, 0x58},
  {0x47, 0x28}, {0x48, 0x3a}, {0x59, 0x88}, {0x5a, 0x88},
  {0x5b, 0x44}, {0x5c, 0x67}, {0x5d, 0x49}, {0x5e, 0x0e},
  {0x6c, 0x0a}, {0x6d, 0x55}, {0x6e, 0x11}, {0x6f, 0x9e},
  {0x6a, 0x40}, {OV7670_REG_BLUE, 0x40}, {OV7670_REG_RED, 0x60},
  {OV7670_REG_COM8, 0xc7},
  {0x4f, 0x80}, {0x50, 0x80}, {0x51, 0x00}, {0x52, 0x22},
  {0x53, 0x5e}, {0x54, 0x80}, {0x58, 0x9e},
  {OV7670_REG_COM16, 0x08}, {OV7670_REG_EDGE, 0x00},
  {0x75, 0x05}, {0x76, 0xe1}, {0x4c, 0x00}, {0x77, 0x01},
  {0x3d, 0x48}, {0x4b, 0x09}, {0xc9, 0x60}, {0x56, 0x40},
  {0x34, 0x11}, {0x3b, 0x12},
  {0xa4, 0x82}, {0x96, 0x00}, {0x97, 0x30}, {0x98, 0x20},
  {0x99, 0x30}, {0x9a, 0x84}, {0x9b, 0x29}, {0x9c, 0x03},
  {0x9d, 0x4c}, {0x9e, 0x3f}, {0x78, 0x04},
  {0x79, 0x01}, {0xc8, 0xf0}, {0x79, 0x0f}, {0xc8, 0x00},
  {0x79, 0x10}, {0xc8, 0x7e}, {0x79, 0x0a}, {0xc8, 0x80},
  {0x79, 0x0b}, {0xc8, 0x01}, {0x79, 0x0c}, {0xc8, 0x0f},
  {0x79, 0x0d}, {0xc8, 0x20}, {0x79, 0x09}, {0xc8, 0x80},
  {0x79, 0x02}, {0xc8, 0xc0}, {0x79, 0x03}, {0xc8, 0x40},
  {0x79, 0x05}, {0xc8, 0x30}, {0x79, 0x26},

  // ---- 2. PCLK must not toggle during horizontal blanking ----
  // Re-applied here deliberately: the default set above cleared it. With a free-running
  // pixel clock the I2S peripheral keeps latching through the blank interval, the line
  // length stops matching what the DMA expects, and frames overflow.
  {OV7670_REG_COM10, 0x20},

  // ---- 3. QQVGA scaling: 640x480 -> 160x120 via DCW ----
  {OV7670_REG_COM3, 0x04},            // DCW enable
  {OV7670_REG_COM14, 0x1a},           // DCW + PCLK divider /4
  {0x72, 0x22},                       // SCALING_DCWCTR: /4 horizontal and vertical
  {0x73, 0xf2},                       // SCALING_PCLK_DIV: reserved 0xf0 | /4  <-- was 0x02
  {OV7670_REG_HSTART, 0x16}, {OV7670_REG_HSTOP, 0x04},
  {OV7670_REG_HREF, 0xa4},            // <-- was 0x24
  {OV7670_REG_VSTART, 0x02}, {OV7670_REG_VSTOP, 0x7a},
  {OV7670_REG_VREF, 0x0a},

  // ---- 4. YUV422 output (esp_camera takes the Y byte of each pair for GRAYSCALE) ----
  {OV7670_REG_COM7, 0x00},            // YUV, VGA base
  {0x8c, 0x00},                       // RGB444 off
  {OV7670_REG_COM1, 0x00},
  {OV7670_REG_COM15, 0xc0},           // full range 0x00-0xFF
  {OV7670_REG_COM9, 0x6a},            // 128x gain ceiling
  {0x4f, 0x80}, {0x50, 0x80}, {0x51, 0x00},
  {0x52, 0x22}, {0x53, 0x5e}, {0x54, 0x80},
  {0x3d, 0x40},                       // COM13: UV saturation auto

  // ---- 5. Internal clock prescaler, last ----
  {OV7670_REG_CLKRC, 0x01},

  {OV7670_REG_DELAY_TOKEN, OV7670_REG_DELAY_TOKEN}   // END MARKER
};

const OV7670RegisterConfig* OV7670Driver::getInitRegisterTable(size_t* count) {
  if (count) {
    *count = sizeof(kOV7670_QQVGA_InitRegs) / sizeof(kOV7670_QQVGA_InitRegs[0]);
  }
  return kOV7670_QQVGA_InitRegs;
}

// Single SCCB register write. The OV7670's control interface is plain 2-byte I2C at 0x21,
// and esp_camera was told to share Arduino's bus (pin_sccb_sda = -1, sccb_i2c_port = 0),
// so Wire is the correct owner and there is no second driver to fight with.
bool OV7670Driver::writeSccb(uint8_t reg, uint8_t value) {
#if defined(ESP32) && !defined(HOST_TEST)
  Wire.beginTransmission(OV7670_I2C_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
#else
  (void)reg; (void)value;
  return true;
#endif
}

// Apply the QQVGA/YUV table above, overriding whatever esp_camera configured.
//
// Why this is the fix worth trying: esp_camera's built-in OV7670 profile leaves this sensor
// producing frames the ESP32 cannot capture — fb_get() returns NULL and cam_hal reports
// EV-VSYNC-OVF. The table here sets the things that profile does not, and one entry in
// particular matters: COM10 = 0x20 stops PCLK toggling during horizontal blanking. With a
// free-running pixel clock the I2S peripheral keeps latching bytes through the blank
// interval, the line length no longer matches what the DMA expects, and frames overflow —
// which is exactly the failure observed. The rest of the table pins the windowing, the DCW
// downsample chain and the scaling dividers that turn 640x480 into a real 160x120.
//
// The first entry is a soft reset (COM7 = 0x80), so this deliberately discards esp_camera's
// register state; the pixel format it selects (YUV422) is the same one esp_camera drives the
// sensor into for GRAYSCALE, taking the Y byte of each pair, so the DMA's expectations still
// hold.
int OV7670Driver::applyInitRegisterTable() {
#if defined(ESP32) && !defined(HOST_TEST)
  size_t count = 0;
  const OV7670RegisterConfig* regs = getInitRegisterTable(&count);
  int written = 0, failed = 0;
  for (size_t i = 0; i < count; i++) {
    const uint8_t reg = regs[i].reg;
    const uint8_t val = regs[i].val;
    if (reg == OV7670_REG_DELAY_TOKEN) {
      if (val == OV7670_REG_DELAY_TOKEN) break;   // {0xFF,0xFF} terminates the table
      delay(val);                                 // {0xFF,ms} is a settling delay
      continue;
    }
    if (writeSccb(reg, val)) written++; else failed++;
    delayMicroseconds(300);   // SCCB needs settling between consecutive writes
  }
  Serial.printf("[camera] applied OV7670 register table: %d written, %d failed\n",
                written, failed);
  if (failed > 0) {
    Serial.println("[camera] some register writes were NACKed — the sensor is on the bus but "
                   "not accepting configuration reliably");
  }
  delay(100);   // let the sensor settle on the new timing before the first grab
  return written;
#else
  return -1;
#endif
}

OV7670Driver::OV7670Driver()
    : state_(DRIVER_UNINITIALIZED),
      hardware_present_(false),
      mock_mode_(true),
      mock_pattern_(PATTERN_EMPTY_SCENE),
      mock_person_active_(false),
      frame_counter_(0),
      last_capture_time_ms_(0),
      injected_frame_(nullptr),
      injected_frame_len_(0) {
  memset(frame_buffer_, 0, sizeof(frame_buffer_));
}

OV7670Driver::~OV7670Driver() {}


// --- software I2C probe -------------------------------------------------------------
// A scan that owes nothing to the hardware peripheral or to TwoWire's internal state.
// Both of those have already produced misleading results on this bus: pinMode() silently
// detaches the pins from the I2C signal matrix, and begin() refuses to re-attach them once
// the bus has been started elsewhere. Bit-banging the protocol on plain GPIO removes every
// one of those variables, so whatever this reports is the wiring and nothing else.
// Open-drain is emulated the way I2C requires: drive low, or release to the pull-up.
// Target-only: the host test build has no GPIO to bang.
#if defined(ESP32) && !defined(HOST_TEST)
namespace {
  const int BB_US = 5;                                   // ~100 kHz
  inline void bbRelease(uint8_t p){ pinMode(p, INPUT_PULLUP); }
  inline void bbPullLow(uint8_t p){ pinMode(p, OUTPUT); digitalWrite(p, LOW); }

  bool bbProbeAddr(uint8_t sda, uint8_t scl, uint8_t addr) {
    bbRelease(sda); bbRelease(scl); delayMicroseconds(BB_US);
    bbPullLow(sda); delayMicroseconds(BB_US);            // START
    bbPullLow(scl); delayMicroseconds(BB_US);

    uint8_t frame = (uint8_t)((addr << 1) | 0);          // address + write
    for (int i = 7; i >= 0; --i) {
      if (frame & (1 << i)) bbRelease(sda); else bbPullLow(sda);
      delayMicroseconds(BB_US);
      bbRelease(scl); delayMicroseconds(BB_US);
      bbPullLow(scl); delayMicroseconds(BB_US);
    }

    bbRelease(sda); delayMicroseconds(BB_US);            // let the peripheral answer
    bbRelease(scl); delayMicroseconds(BB_US);
    bool ack = digitalRead(sda) == LOW;                  // ACK = peripheral holds SDA down
    bbPullLow(scl); delayMicroseconds(BB_US);

    bbPullLow(sda); delayMicroseconds(BB_US);            // STOP
    bbRelease(scl); delayMicroseconds(BB_US);
    bbRelease(sda); delayMicroseconds(BB_US);
    return ack;
  }
}
#endif  // ESP32 && !HOST_TEST
// -------------------------------------------------------------------------------------

bool OV7670Driver::init() {
#if defined(ESP32) && !defined(HOST_TEST)
  // Probe the OV7670 on SCCB to see if it is physically present, so a missing camera falls
  // back to simulation instead of stalling esp_camera_init() into a watchdog reset.
  //
  // XCLK FIRST, and this is not optional: the OV7670 has no internal oscillator. Every
  // block inside it — the SCCB slave included — is clocked from XCLK. Probing a silent
  // XCLK line therefore ALWAYS returns NACK, camera present or not, which pinned this
  // node in simulation mode permanently and reported occupancy 0 forever. esp_camera_init
  // gets this right internally (it enables the clock before its own probe); the guard in
  // front of it did not. Drive the 20 MHz clock, let the sensor come up, then ask.
  // Sequence the sensor rather than assuming a rail holds it in the right state. The order
  // is the datasheet's and each step depends on the one before it: the part must be out of
  // power-down before it responds to anything, and RESET must be released while XCLK is
  // already running, because the reset itself is clocked.
#if PIN_CAM_PWDN >= 0
  pinMode(PIN_CAM_PWDN, OUTPUT);
  digitalWrite(PIN_CAM_PWDN, LOW);        // leave power-down
#endif
#if PIN_CAM_RESET >= 0
  pinMode(PIN_CAM_RESET, OUTPUT);
  digitalWrite(PIN_CAM_RESET, LOW);       // hold in reset while the clock starts
#endif
  delay(5);

  bool xclkUp = ledcSetup(LEDC_CHANNEL_0, 10000000, 1) != 0;
  if (!xclkUp) {
    Serial.println("[camera] WARNING: could not start 10 MHz XCLK on LEDC; probe will be unreliable");
  }
  ledcAttachPin(PIN_CAM_XCLK, LEDC_CHANNEL_0);
  ledcWrite(LEDC_CHANNEL_0, 1);
  delay(10);                              // let the clock settle before releasing reset

#if PIN_CAM_RESET >= 0
  digitalWrite(PIN_CAM_RESET, HIGH);      // release reset, XCLK already running
  Serial.printf("[camera] sequenced: RESET=GPIO%d released with XCLK up (PWDN hard-wired to GND)\n",
                PIN_CAM_RESET);
#endif
  delay(20);                       // OV7670 needs a few hundred XCLK cycles before SCCB answers

  // Check the lines are electrically idle BEFORE touching the bus. I2C rests high on both
  // wires; if either is held low, every transaction blocks in hardware and the 112-address
  // scan below turns a diagnostic into an indefinite boot hang — which is exactly what it
  // did once a short appeared on this bus. A stuck line is also the one fault a scan cannot
  // report, because a scan needs a working bus to produce any result at all.
  // Two different questions, and only asking both separates the two faults that look
  // identical from a scan.
  //
  // (a) With the ESP32's own pull-up engaged, is the line held low? That finds a short.
  // (b) With NO internal pull-up — line discharged, then released floating — does anything
  //     still pull it high? Only an external pull-up can. The SHT30 module carries 10k
  //     pull-ups fed from its own VCC, so this answers "is that module powered and actually
  //     connected to these two wires" without a meter. This is the probe that settled the
  //     CO2 bus, where it proved the level shifter was alive and the sensor simply unpowered.
  auto floatsHigh = [](uint8_t pin) -> bool {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    delayMicroseconds(50);          // discharge the line and its cable capacitance
    pinMode(pin, INPUT);            // release with NO internal pull-up
    delayMicroseconds(20);          // 10k against ~20 pF settles in well under 1 us
    return digitalRead(pin) == HIGH;
  };
  bool sdaExtPull = floatsHigh(PIN_CAM_SIOD);
  bool sclExtPull = floatsHigh(PIN_CAM_SIOC);
  Serial.printf("[camera] SCCB external pull-up probe: SDA(GPIO%d)=%s SCL(GPIO%d)=%s -> %s\n",
                PIN_CAM_SIOD, sdaExtPull ? "pulled HIGH" : "stays LOW",
                PIN_CAM_SIOC, sclExtPull ? "pulled HIGH" : "stays LOW",
                (sdaExtPull && sclExtPull)
                  ? "a powered device IS holding this bus up (SHT30's onboard 10k) — the wires "
                    "reach it and it has VCC, so look at addressing, not power"
                  : "NOTHING external is pulling this bus up. The SHT30's 10k pull-ups are fed "
                    "from its own VCC, so either that module has no power or these two wires do "
                    "not reach it. Check SHT30 VCC/GND first, then the GPIO21/22 runs.");

  // Are the two lines shorted TO EACH OTHER? This is the fault that survives both checks
  // above and still kills the bus: healthy pull-ups hold the shorted pair high, so the
  // idle and external-pull-up probes both pass, while every transaction fails — the moment
  // the controller drives SCL low, SDA follows, the peripheral sees the data line stolen
  // and reports arbitration-lost/timeout instead of a clean NACK. err=5 on every one of
  // 112 addresses, with pull-ups confirmed present, is that signature exactly.
  //
  // Test it directly: drive one line low and see whether the other follows.
  auto shortedTo = [](uint8_t driven, uint8_t watched) -> bool {
    pinMode(watched, INPUT_PULLUP);
    pinMode(driven, OUTPUT);
    digitalWrite(driven, LOW);
    delayMicroseconds(50);
    bool followed = digitalRead(watched) == LOW;   // should stay HIGH on a healthy bus
    pinMode(driven, INPUT_PULLUP);
    delayMicroseconds(50);
    return followed;
  };
  // Software scan: opt-in only, via -DCAM_SOFT_SCAN=1.
  //
  // This sweep answered the question it was built for — it proved the wiring was dead while
  // the peripheral said the same thing for a different reason, and later proved 0x21 alive.
  // But sweeping 112 addresses makes ~2000 pinMode() calls, each taking the GPIO spinlock,
  // and on this board that reliably trips TG1WDT_SYS_RESET mid-scan and loops the node. A
  // diagnostic that reboots the thing it is diagnosing has negative value on the default
  // path, so it stays behind a flag: turn it on deliberately when a bus is unexplained,
  // and leave it off in normal operation. The cheap probes above (pull-up presence, short
  // test) are a handful of pinMode calls and stay unconditional.
#ifndef CAM_SOFT_SCAN
  #define CAM_SOFT_SCAN 0
#endif
#if CAM_SOFT_SCAN
  {
    int bbFound = 0;
    Serial.print("[camera] software (bit-banged) I2C scan on GPIO21/22:");
    for (uint8_t a = 0x08; a < 0x78; a++) {
      if (bbProbeAddr(PIN_CAM_SIOD, PIN_CAM_SIOC, a)) { Serial.printf(" 0x%02X", a); bbFound++; }
      // Yield to the scheduler. Each probe makes ~18 pinMode() calls and every one takes a
      // spinlock, so sweeping 112 addresses back to back holds the CPU long enough to trip
      // the interrupt watchdog — TG1WDT_SYS_RESET, mid-scan, in a loop. A diagnostic that
      // reboots the node is worse than no diagnostic.
      if ((a & 0x0F) == 0x0F) delay(1);
    }
    Serial.println(bbFound ? "" : " nothing");
    Serial.printf("[camera] software scan found %d device(s). This bypasses the I2C peripheral "
                  "entirely, so it reports the WIRING: devices here means the wires and power "
                  "are good; nothing here means they are not.\n", bbFound);

    // Nothing answered, yet the external-pull-up probe says a powered device is holding this
    // bus up and the two lines are not shorted. Exactly one common fault fits all three:
    // the data and clock wires are crossed. A swapped pair keeps its pull-ups and stays
    // independent, but the controller then clocks the data wire, so no device ever sees a
    // valid clock and none can ever ACK — in hardware or in software. Re-run the scan with
    // the roles reversed; if devices appear, the wires are simply the wrong way round.
    if (bbFound == 0) {
      int swapFound = 0;
      Serial.print("[camera] retrying software scan with SDA/SCL SWAPPED (SDA=GPIO22 SCL=GPIO21):");
      for (uint8_t a = 0x08; a < 0x78; a++) {
        if (bbProbeAddr(PIN_CAM_SIOC, PIN_CAM_SIOD, a)) { Serial.printf(" 0x%02X", a); swapFound++; }
        if ((a & 0x0F) == 0x0F) delay(1);
      }
      Serial.println(swapFound ? "" : " nothing");
      if (swapFound > 0) {
        Serial.printf("[camera] *** SDA AND SCL ARE CROSSED *** %d device(s) answer when the "
                      "lines are reversed. Swap the two wires: SDA belongs on GPIO%d and SCL on "
                      "GPIO%d. Nothing is wrong with any sensor.\n",
                      swapFound, PIN_CAM_SIOD, PIN_CAM_SIOC);
      } else {
        Serial.println("[camera] nothing on either orientation. The wires do not reach a powered "
                       "device at all — check SHT30 VCC/GND and the GPIO21/22 runs end to end.");
      }
    }
  }
#endif  // CAM_SOFT_SCAN

  // Can each line actually be pulled DOWN? Everything above only proves the lines can go
  // high. A wire shorted to 3.3 V passes the pull-up probe (it is high), passes the
  // short-to-each-other test (they are independent) and passes the idle check — and still
  // makes I2C impossible, because the controller can never assert a start condition. Worse,
  // it can leave the peripheral spinning on arbitration-lost with interrupts masked, which
  // is an interrupt-watchdog reset and a boot loop, not an error code.
  auto canDriveLow = [](uint8_t pin) -> bool {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    delayMicroseconds(50);
    bool wentLow = digitalRead(pin) == LOW;
    pinMode(pin, INPUT_PULLUP);
    return wentLow;
  };
  bool sdaCanLow = canDriveLow(PIN_CAM_SIOD);
  bool sclCanLow = canDriveLow(PIN_CAM_SIOC);
  if (!sdaCanLow || !sclCanLow) {
    Serial.printf("[camera] LINE SHORTED TO A SUPPLY RAIL: SDA(GPIO%d)=%s SCL(GPIO%d)=%s. "
                  "A line that cannot be pulled low makes I2C physically impossible — look "
                  "for a jumper landing in the 3.3V rail row instead of its signal row.\n",
                  PIN_CAM_SIOD, sdaCanLow ? "ok" : "CANNOT GO LOW",
                  PIN_CAM_SIOC, sclCanLow ? "ok" : "CANNOT GO LOW");
    ledcDetachPin(PIN_CAM_XCLK);
    Wire.end();
    Wire.begin(PIN_CAM_SIOD, PIN_CAM_SIOC, 100000);
    state_ = DRIVER_SIMULATION_MODE;
    hardware_present_ = false;
    mock_mode_ = true;
    return true;                        // never let this path reach a blocking transaction
  }

  bool sclFollowsSda = shortedTo(PIN_CAM_SIOD, PIN_CAM_SIOC);
  bool sdaFollowsScl = shortedTo(PIN_CAM_SIOC, PIN_CAM_SIOD);
  if (sclFollowsSda || sdaFollowsScl) {
    Serial.printf("[camera] SDA/SCL ARE SHORTED TOGETHER: driving GPIO%d low pulls GPIO%d low "
                  "(%s/%s). Every device on this bus is unreachable until the bridge between "
                  "these two wires is removed — check for adjacent breadboard rows tied "
                  "together, or a jumper in the wrong hole. Nothing is wrong with the sensors.\n",
                  PIN_CAM_SIOD, PIN_CAM_SIOC,
                  sclFollowsSda ? "SCL follows SDA" : "-",
                  sdaFollowsScl ? "SDA follows SCL" : "-");
  } else {
    Serial.printf("[camera] SDA/SCL short test: clean — GPIO%d and GPIO%d are independent\n",
                  PIN_CAM_SIOD, PIN_CAM_SIOC);
  }

  pinMode(PIN_CAM_SIOD, INPUT_PULLUP);
  pinMode(PIN_CAM_SIOC, INPUT_PULLUP);
  delayMicroseconds(200);
  bool sdaIdleHigh = digitalRead(PIN_CAM_SIOD) == HIGH;
  bool sclIdleHigh = digitalRead(PIN_CAM_SIOC) == HIGH;
  if (!sdaIdleHigh || !sclIdleHigh) {
    Serial.printf("[camera] SCCB bus is STUCK LOW: SDA(GPIO%d)=%s SCL(GPIO%d)=%s\n",
                  PIN_CAM_SIOD, sdaIdleHigh ? "high" : "LOW",
                  PIN_CAM_SIOC, sclIdleHigh ? "high" : "LOW");
    Serial.println("[camera] a line held low shorts the whole bus — every device on it, the "
                   "SHT30 included, will go silent. Find the short to GND on that pin before "
                   "suspecting any sensor. Skipping the scan so the node still boots.");
    ledcDetachPin(PIN_CAM_XCLK);
    Wire.end();                                        // hand the pins back to the I2C
    Wire.begin(PIN_CAM_SIOD, PIN_CAM_SIOC, 100000);    // peripheral so the SHT30 still works
    state_ = DRIVER_SIMULATION_MODE;
    hardware_present_ = false;
    mock_mode_ = true;
    return true;
  }

  // Re-attach the pins to the I2C peripheral. Every probe above used pinMode(), which pulls
  // these GPIOs out of the I2C signal matrix — and TwoWire::begin() will NOT put them back:
  // main.cpp already started this bus in setup(), so begin() takes its
  //   if (i2cIsInit(num)) { log_w("Bus already started in Master Mode."); goto end; }
  // path and returns without calling i2cInit(). The controller then drives nothing and
  // every transaction reports timeout, which looks exactly like a dead bus and is not one.
  // end() first forces the full re-initialisation the probes made necessary.
  Wire.end();
  Wire.begin(PIN_CAM_SIOD, PIN_CAM_SIOC, 100000);
  Wire.setTimeOut(20);   // a failed probe must cost ~20 ms, not 100: this runs up to 12
                         // times across two retry loops plus a 112-address sweep, and the
                         // whole of it happens inside setup() where blocking too long is
                         // an interrupt-watchdog reset rather than a slow boot.
  // Probe with retries rather than once. The OV7670 takes appreciably longer to answer
  // after RESET is released than a single 20 ms settle allows: on this board the first two
  // probes NACKed and a bus scan moments later found 0x21 without anything changing, which
  // is a settle-time problem being misread as an absent sensor. Poll until it comes up.
  uint8_t i2c_err = 0xFF;
  for (int attempt = 1; attempt <= 4; attempt++) {
    Wire.beginTransmission(OV7670_I2C_ADDR); // 0x21
    i2c_err = Wire.endTransmission();
    if (i2c_err == 0) {
      Serial.printf("[camera] OV7670 answered at 0x%02X on attempt %d\n", OV7670_I2C_ADDR, attempt);
      break;
    }
    delay(30);
  }

  // A NACK at 0x21 has several causes that look identical from the probe alone, so scan
  // the whole bus before giving up. This bus is shared with the SHT30 at 0x44: seeing that
  // device and not the camera proves the bus, its pull-ups and the ESP32 side are all fine
  // and isolates the fault to the camera's own wiring or supply. Seeing nothing at all
  // means the bus itself is down and the camera is not the thing to investigate first.
  // One hard power-cycle before believing the bus. A sensor that came up in a bad state —
  // brown-out on a shared rail, a marginal reset at power-on — recovers from this and from
  // nothing else, and it costs 60 ms on the failure path only.
#if PIN_CAM_RESET >= 0
  if (i2c_err != 0) {
    // Reset pulse only. PWDN is hard-wired to GND (see camera_config.h): driving it from a
    // GPIO cost a boot loop, and a reset pulse recovers the same bad-power-on states that a
    // power-cycle would, as long as XCLK keeps running across it.
    Serial.println("[camera] no ACK; pulsing RESET and retrying once");
    digitalWrite(PIN_CAM_RESET, LOW);
    delay(20);
    digitalWrite(PIN_CAM_RESET, HIGH);    // release, XCLK still running
    delay(60);                            // a released reset needs real settle time
    for (int attempt = 1; attempt <= 4; attempt++) {
      Wire.beginTransmission(OV7670_I2C_ADDR);
      i2c_err = Wire.endTransmission();
      if (i2c_err == 0) break;
      delay(30);
    }
    Serial.printf("[camera] retry after RESET pulse: %s\n",
                  i2c_err == 0 ? "ACK — sensor is alive" : "still silent");
  }
#endif

  if (i2c_err != 0) {
    int found = 0;
    bool sawTarget = false;
    Serial.printf("[camera] scanning SCCB bus (SDA=GPIO%d SCL=GPIO%d, xclk %s):",
                  PIN_CAM_SIOD, PIN_CAM_SIOC, xclkUp ? "running" : "FAILED");
    unsigned long scanStart = millis();
    bool scanAborted = false;
    for (uint8_t addr = 0x08; addr < 0x78; addr++) {
      Wire.beginTransmission(addr);
      if (Wire.endTransmission() == 0) {
        Serial.printf(" 0x%02X", addr); found++;
        if (addr == OV7670_I2C_ADDR) sawTarget = true;
      }
      // Hard ceiling on the sweep. A healthy bus finishes all 112 addresses in a few
      // milliseconds; anything slower means transactions are timing out, and continuing
      // would stall the node's boot for minutes for no extra information.
      if (millis() - scanStart > 1500) { scanAborted = true; break; }
    }
    if (scanAborted) {
      Serial.print(" ... ABORTED, bus is timing out (degraded or intermittently held low)");
    }
    // The sweep can succeed where the direct probes did not, simply because it happens
    // later. Treat that as the sensor being present rather than reporting "none at 0x21"
    // while 0x21 sits in the list — which is what this said before.
    if (sawTarget) {
      Serial.printf("\n[camera] 0x%02X DID answer during the sweep — it was a settle-time "
                    "miss, not an absent sensor. Continuing with initialisation.\n",
                    OV7670_I2C_ADDR);
      i2c_err = 0;
    } else if (found == 0) {
      Serial.println(" nothing at all — the bus is down, not just the camera.");
    } else {
      Serial.printf("\n[camera] %d device(s) answered but none at 0x%02X. The bus works, so"
                    " check the camera itself: 3V3 and GND actually reaching the module,"
                    " SIOD->GPIO%d and SIOC->GPIO%d continuity, PWDN low, RESET high.\n",
                    found, OV7670_I2C_ADDR, PIN_CAM_SIOD, PIN_CAM_SIOC);
    }
  }

  // Hand XCLK back before esp_camera_init: it configures this same LEDC timer/channel itself.
  ledcDetachPin(PIN_CAM_XCLK);

  if (i2c_err != 0) {
    Serial.printf("[camera] OV7670 not found on SCCB (addr=0x%02X, err=%d, xclk=%s) -> Simulation Mode\n",
                  OV7670_I2C_ADDR, i2c_err, xclkUp ? "on" : "FAILED");
    state_ = DRIVER_SIMULATION_MODE;
    hardware_present_ = false;
    mock_mode_ = true;
    return true;
  }
  Serial.println("[camera] OV7670 detected on SCCB, initializing esp_camera...");

  // Probe the PARALLEL BUS before handing the pins to esp_camera.
  //
  // SCCB working proves the control wires and nothing else — the pixels travel on eleven
  // separate lines, and every failure so far has been consistent with those simply not
  // carrying anything. The OV7670 free-runs as soon as XCLK is present (it powers up in a
  // default VGA mode without needing configuration), so with the clock running these lines
  // MUST be moving. Sampling them as plain inputs says which ones are.
  //
  // Edges are not counted — PCLK runs at MHz and digitalRead cannot keep up. What matters is
  // whether a line is ever seen in both states across the window: a wire that is connected
  // and driven shows both, one that is open or dead shows only one.
  {
    struct BusLine { const char* name; uint8_t pin; };
    const BusLine lines[] = {
      {"PCLK ", PIN_CAM_PCLK}, {"VSYNC", PIN_CAM_VSYNC}, {"HREF ", PIN_CAM_HREF},
      {"D0", PIN_CAM_D0}, {"D1", PIN_CAM_D1}, {"D2", PIN_CAM_D2}, {"D3", PIN_CAM_D3},
      {"D4", PIN_CAM_D4}, {"D5", PIN_CAM_D5}, {"D6", PIN_CAM_D6}, {"D7", PIN_CAM_D7},
    };
    const int nLines = sizeof(lines) / sizeof(lines[0]);
    bool sawHigh[16] = {false}, sawLow[16] = {false};
    for (int i = 0; i < nLines; i++) pinMode(lines[i].pin, INPUT);

    // ~60 ms covers at least one full frame at any plausible rate, so VSYNC gets a chance
    // to move even at its slowest.
    unsigned long probeStart = millis();
    while (millis() - probeStart < 60) {
      for (int i = 0; i < nLines; i++) {
        if (digitalRead(lines[i].pin)) sawHigh[i] = true; else sawLow[i] = true;
      }
    }

    int dead = 0;
    Serial.print("[camera] parallel bus activity:");
    for (int i = 0; i < nLines; i++) {
      bool alive = sawHigh[i] && sawLow[i];
      if (!alive) dead++;
      Serial.printf(" %s=%s", lines[i].name, alive ? "toggling" : (sawHigh[i] ? "STUCK-HI" : "STUCK-LO"));
    }
    Serial.println();
    if (dead == 0) {
      Serial.println("[camera] every data and sync line is moving — the bus is wired and the sensor "
                     "is driving it. If frames still fail, the fault is timing, not connectivity.");
    } else {
      Serial.printf("[camera] %d of %d lines are NOT moving. With XCLK running the OV7670 free-runs "
                    "and drives all of them, so a stuck line is an open wire, a wrong pin, or a "
                    "short. Those are the ones to check — the rest of the bus is fine.\n",
                    dead, nLines);
    }
  }


  // Zero-initialise: camera_config_t carries fb_location, grab_mode and sccb_i2c_port,
  // none of which were assigned below. On a plain stack struct those held whatever was on
  // the stack — and a garbage fb_location that happens to land on CAMERA_FB_IN_PSRAM (0)
  // makes esp_camera_init fail ESP_ERR_NO_MEM on this WROOM, which has no PSRAM at all.
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = PIN_CAM_D0;
  config.pin_d1 = PIN_CAM_D1;
  config.pin_d2 = PIN_CAM_D2;
  config.pin_d3 = PIN_CAM_D3;
  config.pin_d4 = PIN_CAM_D4;
  config.pin_d5 = PIN_CAM_D5;
  config.pin_d6 = PIN_CAM_D6;
  config.pin_d7 = PIN_CAM_D7;
  config.pin_xclk = PIN_CAM_XCLK;
  config.pin_pclk = PIN_CAM_PCLK;
  config.pin_vsync = PIN_CAM_VSYNC;
  config.pin_href = PIN_CAM_HREF;
  // Reuse the I2C bus Arduino already owns instead of letting esp_camera install its own.
  //
  // Passing real pins here makes the driver call SCCB_Init(), which installs an ESP-IDF I2C
  // driver on ITS OWN port — esp32-camera defaults that to I2C_NUM_1, which is precisely
  // the port Wire1 is using for the CO2 sensor. So initialising the camera tore down the
  // CO2 bus: 0x2A answered during the boot scan and then every read returned
  // "endTransmission failed on Wire1". It also collides with Wire on port 0, which is what
  // esp_camera_init was returning 0xffffffff (ESP_FAIL) over.
  //
  // Per esp_camera.h: "If pin_sccb_sda is -1, use the already configured I2C bus by number."
  // Wire is port 0 and is already up on these exact pins, so hand the driver that instead.
  config.pin_sccb_sda = -1;            // -1 => do not init SCCB, reuse the port below
  config.pin_sccb_scl = -1;
  config.sccb_i2c_port = 0;            // Arduino's Wire == I2C_NUM_0, already on GPIO21/22
  config.pin_pwdn = PIN_CAM_PWDN;
  config.pin_reset = PIN_CAM_RESET;
  // 10 MHz, not 20. The OV7670 derives PCLK from XCLK, and at 20 MHz this board returns
  // short, inconsistent frames — cam_hal logs "FB-SIZE: 17280 != 19200" then "7680 != 19200",
  // i.e. the I2S parallel capture is not keeping up with the pixel clock and each frame is
  // truncated at a different point. Halving XCLK halves PCLK and lets the DMA stay ahead.
  // The sensor is specified from 10 to 48 MHz, so this is well inside its range, and QQVGA
  // at ~7 fps is far more than an occupancy check needs.
  config.xclk_freq_hz = 10000000;
  config.pixel_format = PIXFORMAT_GRAYSCALE;
  config.frame_size = FRAMESIZE_QQVGA; // 160x120
  config.jpeg_quality = 12;
  // ONE buffer, and it has to stay one. Double buffering would give the DMA headroom
  // against the truncated frames this sensor produces, but two 19,200 B buffers must come
  // out of internal DRAM (no PSRAM on a WROOM) and have to coexist with the detector's
  // 80 KB tensor arena — esp_camera_init returns ESP_FAIL outright when asked. Frame
  // truncation therefore has to be solved in the sensor's timing, not with more memory.
  config.fb_count = 1;
  config.fb_location = CAMERA_FB_IN_DRAM;   // ESP32-WROOM has no PSRAM; 160x120 grayscale = 19,200 B
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;


  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[camera] esp_camera_init failed with error 0x%x -> Fallback to Simulation Mode\n", err);
    state_ = DRIVER_SIMULATION_MODE;
    hardware_present_ = false;
    mock_mode_ = true;
    return true;
  }
  
  // cam_hal logs one line per short frame. At ~20 ms a frame that is 50 lines a second of
  // console traffic, which drowns every other diagnostic and is itself enough load to
  // trip the watchdog. Silence the tag and account for the same condition ourselves, once
  // every few seconds, so the information survives without the flood.
  esp_log_level_set("cam_hal", ESP_LOG_NONE);
  Serial.println("[camera] esp_camera Initialized Successfully (QQVGA Grayscale 160x120)");
  state_ = DRIVER_HARDWARE_OK;
  hardware_present_ = true;
  mock_mode_ = false;

  // Override esp_camera's generic OV7670 profile with this repo's own table before judging
  // whether the sensor can produce an image.
  applyInitRegisterTable();

  // Prove the sensor can actually produce a picture before leaving the pipeline running.
  //
  // SCCB answering only proves the control bus works: address, power, PWDN and RESET all
  // live on wires the parallel data bus does not share. A sensor can therefore configure
  // perfectly and still deliver nothing, which is this board's state — every pixel reads 0
  // and cam_hal reports EV-VSYNC-OVF. That is not a benign "no image yet": the DMA task
  // overflows on its own, without any client asking for a frame, and abort()s the node.
  // A miswired camera must not be able to take down a working building sensor node, so if
  // it cannot deliver an image, stand the pipeline down and say exactly what to check.
  int good = 0;
  for (int i = 0; i < 3; i++) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) {
      size_t nonZero = 0, first = 0; bool haveFirst = false;
      unsigned maxByte = 0;
      for (size_t k = 0; k < fb->len; k++) {
        if (fb->buf[k]) {
          nonZero++;
          if (!haveFirst) { first = k; haveFirst = true; }
          if (fb->buf[k] > maxByte) maxByte = fb->buf[k];
        }
      }
      // Distinguish the failure modes: a short frame means the capture is losing lines,
      // an all-zero full frame means the data bus is delivering nothing, and a frame with
      // scattered non-zero bytes means data is arriving but the sync is wrong.
      Serial.printf("[camera] test frame %d: len=%u (expected %d) nonzero=%u/%u maxByte=%u%s\n",
                    i + 1, (unsigned)fb->len, (int)CAMERA_FRAME_BYTES,
                    (unsigned)nonZero, (unsigned)fb->len, maxByte,
                    haveFirst ? "" : "  <- ENTIRELY ZERO");
      if (nonZero > 0 && fb->len == CAMERA_FRAME_BYTES) good++;
      esp_camera_fb_return(fb);
    } else {
      Serial.printf("[camera] test frame %d: esp_camera_fb_get() returned NULL\n", i + 1);
    }
    delay(120);
  }
  if (good == 0) {
    Serial.println("[camera] sensor configures but returns NO IMAGE (blank or short frames, "
                   "cam_hal reports VSYNC overflow). SCCB proves only the control wires; the "
                   "parallel bus is separate. Check D0->GPIO4, D1->13, D2->14, D3->16, "
                   "D4->17, D5->18, D6->19, D7->34, PCLK->35, VSYNC->39, HREF->36.");
    Serial.println("[camera] standing the capture pipeline down so the node stays up — "
                   "other sensors keep reporting normally");
    esp_camera_deinit();
    state_ = DRIVER_SIMULATION_MODE;
    hardware_present_ = false;
    mock_mode_ = true;
    return true;
  }
  Serial.printf("[camera] capture validated: %d/3 test frames carried real image data\n", good);
  return true;
#else
  state_ = DRIVER_SIMULATION_MODE;
  hardware_present_ = false;
  mock_mode_ = true;
  return true;
#endif
}

bool OV7670Driver::captureFrame(uint8_t* out_buffer, size_t max_len) {
  if (state_ == DRIVER_UNINITIALIZED) return false;

#if defined(ESP32) && !defined(HOST_TEST)
  last_capture_time_ms_ = millis();
#else
  last_capture_time_ms_ = getHostMillis();
#endif

  if (injected_frame_ != nullptr && injected_frame_len_ >= CAMERA_FRAME_BYTES) {
    memcpy(frame_buffer_, injected_frame_, CAMERA_FRAME_BYTES);
  } else if (mock_mode_ || state_ == DRIVER_SIMULATION_MODE) {
    last_capture_real_ = false;
    generateSyntheticFrame();
  } else {
#if defined(ESP32) && !defined(HOST_TEST)
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[camera] Frame capture failed");
      last_capture_real_ = false;
      generateSyntheticFrame();
    } else {
      // Rate-limited short-frame accounting, replacing cam_hal's per-frame error line.
      static uint32_t shortFrames = 0, totalFrames = 0;
      static unsigned long lastFrameReport = 0;
      totalFrames++;
      if (fb->len != CAMERA_FRAME_BYTES) shortFrames++;
      if (millis() - lastFrameReport > 5000) {
        lastFrameReport = millis();
        if (shortFrames) {
          Serial.printf("[camera] %lu/%lu frames were the wrong size in the last window "
                        "(last len=%u, expected %d) — capture is not yet clean\n",
                        (unsigned long)shortFrames, (unsigned long)totalFrames,
                        (unsigned)fb->len, (int)CAMERA_FRAME_BYTES);
        } else {
          Serial.printf("[camera] %lu frames captured clean at %d B\n",
                        (unsigned long)totalFrames, (int)CAMERA_FRAME_BYTES);
        }
        shortFrames = 0; totalFrames = 0;
      }

      if (fb->len > sizeof(frame_buffer_)) {
        Serial.printf("[camera] Size mismatch: fb->len=%d, expected=%d\n", fb->len, sizeof(frame_buffer_));
      }
      size_t copy_len = fb->len < sizeof(frame_buffer_) ? fb->len : sizeof(frame_buffer_);
      memcpy(frame_buffer_, fb->buf, copy_len);
      esp_camera_fb_return(fb);
      last_capture_real_ = true;
    }
#endif
  }

  frame_counter_++;
  if (out_buffer != nullptr && max_len >= CAMERA_FRAME_BYTES) {
    memcpy(out_buffer, frame_buffer_, CAMERA_FRAME_BYTES);
  }
  return true;
}

void OV7670Driver::setMockMode(bool enable) {
  mock_mode_ = enable;
  if (enable && state_ == DRIVER_HARDWARE_OK) {
    state_ = DRIVER_SIMULATION_MODE;
  } else if (!enable && hardware_present_) {
    state_ = DRIVER_HARDWARE_OK;
  }
}

void OV7670Driver::setMockPattern(SyntheticPattern pattern) {
  mock_pattern_ = pattern;
  if (pattern == PATTERN_PERSON_SILHOUETTE) {
    mock_person_active_ = true;
  } else if (pattern == PATTERN_EMPTY_SCENE) {
    mock_person_active_ = false;
  }
}

void OV7670Driver::setMockPersonDetected(bool detected) {
  mock_person_active_ = detected;
  mock_pattern_ = detected ? PATTERN_PERSON_SILHOUETTE : PATTERN_EMPTY_SCENE;
}

void OV7670Driver::injectTestFrame(const uint8_t* raw_frame, size_t len) {
  injected_frame_ = raw_frame;
  injected_frame_len_ = len;
}

void OV7670Driver::clearInjectedFrame() {
  injected_frame_ = nullptr;
  injected_frame_len_ = 0;
}

void OV7670Driver::generateSyntheticFrame() {
  if (mock_person_active_ || mock_pattern_ == PATTERN_PERSON_SILHOUETTE) {
    generatePersonSilhouette();
    return;
  }

  switch (mock_pattern_) {
    case PATTERN_SOLID_BLACK:
      memset(frame_buffer_, 0, sizeof(frame_buffer_));
      break;
    case PATTERN_SOLID_WHITE:
      memset(frame_buffer_, 255, sizeof(frame_buffer_));
      break;
    case PATTERN_SOLID_GRAY:
      memset(frame_buffer_, 128, sizeof(frame_buffer_));
      break;
    case PATTERN_GRADIENT:
      generateGradientFrame();
      break;
    case PATTERN_CHECKERBOARD:
      generateCheckerboardFrame();
      break;
    case PATTERN_EMPTY_SCENE:
    default: {
      // Generate uniform ambient scene (intensity ~35 with minor noise)
      for (size_t i = 0; i < CAMERA_FRAME_BYTES; ++i) {
        frame_buffer_[i] = (uint8_t)(35 + (i % 5));
      }
      break;
    }
  }
}

void OV7670Driver::generatePersonSilhouette() {
  // 1. Ambient Background (intensity ~30)
  for (size_t i = 0; i < CAMERA_FRAME_BYTES; ++i) {
    frame_buffer_[i] = (uint8_t)(30 + (i % 4));
  }

  // 2. High-Contrast Center Humanoid Silhouette (Center of 160x120: X~80, Y~60)
  // Head Oval: Y in [30..50], X in [70..90] -> intensity 220
  for (int y = 30; y <= 50; ++y) {
    for (int x = 70; x <= 90; ++x) {
      int dx = x - 80;
      int dy = y - 40;
      if (dx * dx + dy * dy <= 100) {
        frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = 220;
      }
    }
  }

  // Torso Rectangle: Y in [51..90], X in [65..95] -> intensity 200
  for (int y = 51; y <= 90; ++y) {
    for (int x = 65; x <= 95; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = 200;
    }
  }

  // Legs: Y in [91..115], X in [68..76] and [84..92] -> intensity 180
  for (int y = 91; y <= 115; ++y) {
    for (int x = 68; x <= 76; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = 180;
    }
    for (int x = 84; x <= 92; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = 180;
    }
  }
}

void OV7670Driver::generateGradientFrame() {
  for (int y = 0; y < CAMERA_FRAME_HEIGHT; ++y) {
    for (int x = 0; x < CAMERA_FRAME_WIDTH; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = (uint8_t)((x + y + frame_counter_) % 256);
    }
  }
}

void OV7670Driver::generateCheckerboardFrame() {
  for (int y = 0; y < CAMERA_FRAME_HEIGHT; ++y) {
    for (int x = 0; x < CAMERA_FRAME_WIDTH; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = ((x ^ y) & 1) ? 255 : 0;
    }
  }
}

#endif // USE_CAMERA
