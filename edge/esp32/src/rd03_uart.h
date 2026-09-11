#pragma once
//
// Ai-Thinker Rd-03_V2 (S3KM1110) UART configuration.
//
// The OT2 pin is one bit: high when the module senses, low when it does not. When a head
// reports presence forever, OT2 cannot tell you why -- the reason is always one of the
// module's internal parameters, and those are reachable only over UART:
//
//   * Maximum detection range gate (0x0001). Gates are 70 cm each, so the factory maximum
//     of 15 is ~10.5 m. In a room that is 4 m deep the radar is then looking through the
//     wall and reporting the corridor as your occupancy.
//   * Target disappearance delay (0x0004), in SECONDS, range 0..65535. The module only
//     reports unmanned after a full T seconds with nobody detected, and any detection
//     restarts the timer. A large T looks exactly like a stuck-high pin.
//
// Vendor's own configurator is a Windows .exe, so this implements the wire protocol
// directly (Rd-03_V2 Serial communication protocol V1.0.0). 115200 8N1, little-endian.
//
// Wiring for one head: module TX -> ESP32 RX pin, module RX -> ESP32 TX pin, common GND.
// OT2 stays wired as it is; configuring over UART does not change how OT2 behaves.

#include <Arduino.h>

namespace rd03 {

static const uint8_t  kHead[4] = { 0xFD, 0xFC, 0xFB, 0xFA };
static const uint8_t  kTail[4] = { 0x04, 0x03, 0x02, 0x01 };

// Command words
static const uint16_t kCmdOpen      = 0x00FF;
static const uint16_t kCmdClose     = 0x00FE;
static const uint16_t kCmdSetParam  = 0x0007;
static const uint16_t kCmdReadParam = 0x0008;
static const uint16_t kCmdSave      = 0x00FD;

// Parameter words (Table 7)
static const uint16_t kParamMinGate  = 0x0000;  // 0..15, 70 cm per gate
static const uint16_t kParamMaxGate  = 0x0001;  // 0..15, 70 cm per gate
static const uint16_t kParamDelay    = 0x0004;  // 0..65535 seconds
// Rd-03 **V1 only**. The V1 protocol has no threshold registers at all -- it says so
// outright: "The agreement does not support to modify the threshold for currently" -- and
// instead filters by frame count. These are the only sensitivity controls V1 exposes, and
// they are absent from the V2 document that the rest of this file was first written from.
static const uint16_t kParamFramesDetect  = 0x0002;  // consecutive frames required to assert
static const uint16_t kParamFramesVanish  = 0x0003;  // consecutive frames required to clear
static const uint16_t kParamInterf   = 0x0005;  // read-only supply-interference alarm

// A frame is: FD FC FB FA | len(2) | payload(len) | 04 03 02 01
static void sendFrame(Stream& io, const uint8_t* payload, uint16_t len) {
  io.write(kHead, 4);
  io.write((uint8_t)(len & 0xFF));
  io.write((uint8_t)(len >> 8));
  io.write(payload, len);
  io.write(kTail, 4);
  io.flush();
}

// Reads one ACK frame. Returns payload length, or -1 on timeout / malformed.
// An ACK echoes the sent command word with 0x01 in the high byte: send 0x0007 -> "07 01".
// Checking that is what distinguishes this command's reply from a stale frame.
static bool ackMatches(const uint8_t* ack, int n, uint8_t cmdLow) {
  return n >= 4 && ack[0] == cmdLow && ack[1] == 0x01 && ack[2] == 0x00 && ack[3] == 0x00;
}

static int readFrame(Stream& io, uint8_t* buf, size_t cap, uint32_t timeoutMs = 400) {
  const uint32_t deadline = millis() + timeoutMs;
  int matched = 0;
  while ((int32_t)(millis() - deadline) < 0) {            // hunt for the header
    if (!io.available()) { delay(1); continue; }
    const uint8_t b = (uint8_t)io.read();
    matched = (b == kHead[matched]) ? matched + 1 : (b == kHead[0] ? 1 : 0);
    if (matched == 4) break;
  }
  if (matched != 4) return -1;

  uint8_t lenb[2];
  for (int i = 0; i < 2; i++) {
    while (!io.available()) {
      if ((int32_t)(millis() - deadline) >= 0) return -1;
      delay(1);
    }
    lenb[i] = (uint8_t)io.read();
  }
  const uint16_t len = (uint16_t)lenb[0] | ((uint16_t)lenb[1] << 8);
  if (len > cap) return -1;

  for (uint16_t i = 0; i < len; i++) {
    while (!io.available()) {
      if ((int32_t)(millis() - deadline) >= 0) return -1;
      delay(1);
    }
    buf[i] = (uint8_t)io.read();
  }
  for (int i = 0; i < 4; i++) {                            // consume the tail
    while (!io.available()) {
      if ((int32_t)(millis() - deadline) >= 0) return -1;
      delay(1);
    }
    (void)io.read();
  }
  return (int)len;
}

// The module streams waveform data unless it is in command mode, so the vendor's own note
// says: send open, discard whatever comes back, wait ~100 ms, then send open again and
// parse that reply. Skipping the first one is the classic reason this never works.
static bool openCommandMode(Stream& io) {
  const uint8_t payload[] = { 0xFF, 0x00, 0x01, 0x00 };
  uint8_t ack[32];
  sendFrame(io, payload, sizeof(payload));
  (void)readFrame(io, ack, sizeof(ack), 150);
  delay(100);
  while (io.available()) (void)io.read();                  // clear residual waveform bytes

  sendFrame(io, payload, sizeof(payload));
  const int n = readFrame(io, ack, sizeof(ack));
  // ack: cmdword(2) status(2) version(2) buffer(2)
  // The version field tells the two module generations apart and is worth recording: V1
  // replies 0x0001 with a 0x0040 buffer, V2 replies 0x0002 with 0x0020. Mixing them up is
  // how this bring-up spent hours on commands the hardware never implemented.
  if (ackMatches(ack, n, 0xFF) && n >= 8) {
    const uint16_t ver = (uint16_t)ack[4] | ((uint16_t)ack[5] << 8);
    const uint16_t buf = (uint16_t)ack[6] | ((uint16_t)ack[7] << 8);
    static uint16_t reported = 0xFFFF;
    if (ver != reported) {
      reported = ver;
      Serial.printf("[rd03] protocol version 0x%04X, buffer %u bytes -> Rd-03 %s\n",
                    ver, buf, ver == 1 ? "V1 (no threshold registers; frame-count filters "
                                         "0x0002/0x0003 instead)" : "V2");
    }
  }
  return ackMatches(ack, n, 0xFF);
}

static bool closeCommandMode(Stream& io) {
  const uint8_t payload[] = { 0xFE, 0x00 };
  uint8_t ack[16];
  for (int attempt = 0; attempt < 3; attempt++) {
    while (io.available()) (void)io.read();      // drop anything left from the last command
    sendFrame(io, payload, sizeof(payload));
    const int n = readFrame(io, ack, sizeof(ack));
    if (ackMatches(ack, n, 0xFE)) return true;
    delay(50);
  }
  return false;
}

static bool readParam(Stream& io, uint16_t param, uint32_t* out) {
  const uint8_t payload[] = { 0x08, 0x00, (uint8_t)(param & 0xFF), (uint8_t)(param >> 8) };
  uint8_t ack[32];
  sendFrame(io, payload, sizeof(payload));
  const int n = readFrame(io, ack, sizeof(ack));
  if (!ackMatches(ack, n, 0x08) || n < 8) return false;
  *out = (uint32_t)ack[4] | ((uint32_t)ack[5] << 8) | ((uint32_t)ack[6] << 16) | ((uint32_t)ack[7] << 24);
  return true;
}

static bool setParam(Stream& io, uint16_t param, uint32_t value) {
  const uint8_t payload[] = {
    0x07, 0x00,
    (uint8_t)(param & 0xFF), (uint8_t)(param >> 8),
    (uint8_t)(value & 0xFF), (uint8_t)((value >> 8) & 0xFF),
    (uint8_t)((value >> 16) & 0xFF), (uint8_t)((value >> 24) & 0xFF),
  };
  uint8_t ack[16];
  sendFrame(io, payload, sizeof(payload));
  const int n = readFrame(io, ack, sizeof(ack));
  return ackMatches(ack, n, 0x07);
}

// Returns: 1 saved, 0 command not implemented by this module firmware, -1 refused.
//
// Not every Rd-03_V2 build implements 0x00FD. On the two heads here it returns no ACK at
// all -- not a failure status, no frame -- which is the same signature as the interference
// register (0x0005) reading back 0xFFFF. Every other command ACKs normally, so this is a
// firmware revision difference, not a fault, and treating it as an error would be wrong.
// A generous timeout is used anyway, because where the command IS implemented it erases
// and rewrites parameter flash and takes far longer than a register poke.
static int saveConfig(Stream& io) {
  const uint8_t payload[] = { 0xFD, 0x00 };
  uint8_t ack[16];
  sendFrame(io, payload, sizeof(payload));
  const int n = readFrame(io, ack, sizeof(ack), 3000);
  if (n < 0) return 0;
  return ackMatches(ack, n, 0xFD) ? 1 : -1;
}

// Print what the head is actually configured with. This is the whole point: it turns
// "OT2 is always high" into a number you can act on.
static bool dumpConfig(Stream& io, const char* label) {
  if (!openCommandMode(io)) {
    Serial.printf("[rd03:%s] no ACK on open-command-mode — check TX/RX are not swapped, "
                  "and that the head is powered\n", label);
    return false;
  }
  uint32_t minGate = 0, maxGate = 0, delaySec = 0, interference = 0;
  const bool okMin = readParam(io, kParamMinGate, &minGate);
  const bool okMax = readParam(io, kParamMaxGate, &maxGate);
  const bool okDly = readParam(io, kParamDelay, &delaySec);
  const bool okInt = readParam(io, kParamInterf, &interference);

  if (okMin && okMax)
    Serial.printf("[rd03:%s] range gates %u..%u  (= %.1f..%.1f m, 0.7 m per gate)\n",
                  label, (unsigned)minGate, (unsigned)maxGate,
                  minGate * 0.7f, maxGate * 0.7f);
  if (okDly)
    Serial.printf("[rd03:%s] target disappearance delay %u s%s\n", label, (unsigned)delaySec,
                  delaySec > 60 ? "  <-- long: presence will look permanently stuck" : "");
  if (okInt) {
    // Lower 16 bits are the state, upper 16 the interfering frequency in kHz (valid only
    // when the state is 2). Raw value is printed too: the decode below is from the spec
    // table, and a value that matches none of its cases is worth seeing verbatim rather
    // than being flattened into a wrong label.
    const uint16_t stateBits = (uint16_t)(interference & 0xFFFF);
    const uint16_t freqKHz   = (uint16_t)(interference >> 16);
    const char* state = stateBits == 0xFFFF ? "not implemented on this module firmware"
                      : stateBits == 0 ? "detection not active"
                      : stateBits == 1 ? "no interference"
                      : stateBits == 2 ? "INTERFERENCE ACTIVE"
                                       : "undocumented state";
    Serial.printf("[rd03:%s] supply interference alarm: %s (raw 0x%08lX, state=%u", label,
                  state, (unsigned long)interference, (unsigned)stateBits);
    if (stateBits == 2) Serial.printf(", %u kHz", (unsigned)freqKHz);
    Serial.printf(")\n");
  }
  if (!closeCommandMode(io)) {
    Serial.printf("[rd03:%s] WARNING: did not ACK exit-command-mode. While in command mode the "
                  "module does NOT detect, and OT2 holds its last level — a blind head that "
                  "still looks alive. Power-cycle it.\n", label);
  }
  return okMin && okMax && okDly;
}

// Apply a room-sized configuration and persist it.
//
// minGate matters more than it looks. Gate 0 covers 0-0.7 m, which includes the module's own
// near field: anything resting against the antenna -- a breadboard, a dupont wire lying over
// the PCB patch, the enclosure wall -- returns a reflection that saturates gate 0 and pins
// detection permanently. Excluding gate 0 is what stops the head reporting itself.
static bool applyConfig(Stream& io, const char* label, uint32_t minGate, uint32_t maxGate,
                        uint32_t delaySec) {
  if (!openCommandMode(io)) {
    Serial.printf("[rd03:%s] no ACK on open-command-mode; nothing written\n", label);
    return false;
  }
  const bool z = setParam(io, kParamMinGate, minGate);
  const bool a = setParam(io, kParamMaxGate, maxGate);
  const bool b = setParam(io, kParamDelay, delaySec);
  const int  c = (z && a && b) ? saveConfig(io) : -1;
  if (!closeCommandMode(io)) {
    Serial.printf("[rd03:%s] WARNING: did not ACK exit-command-mode — head may be left blind. "
                  "Power-cycle it.\n", label);
  }
  Serial.printf("[rd03:%s] gates %u..%u (%.1f..%.1f m) %s, delay %u s %s, %s\n",
                label, (unsigned)minGate, (unsigned)maxGate, minGate * 0.7f, maxGate * 0.7f,
                (z && a) ? "ok" : "FAILED", (unsigned)delaySec, b ? "ok" : "FAILED",
                c == 1 ? "saved to module flash"
              : c == 0 ? "not saved (module firmware has no save command) — settings are "
                         "volatile and re-applied on every boot, so keep RD03_SET_* in the build"
                       : "save refused");
  // A save that is simply unavailable is not a failure: the values are live either way,
  // and this node rewrites them at every boot.
  return z && a && b;
}


// ---------------------------------------------------------------------------------------
// Reporting mode. OT2 is a verdict with no evidence behind it; this is the evidence.
//
// A head that reports presence into an empty room has exactly three possible stories, and
// only this stream can tell them apart:
//   1. The module says "no one" but OT2 is high  -> the OT2 pin or its wiring is the fault.
//   2. The module says "someone" at a plausible distance -> it really is detecting something
//      (a fan, a curtain, the AC's louvre, a neighbouring room through a stud wall).
//   3. The module says "someone" with energy spread across every gate -> the thresholds are
//      below the noise floor and it is triggering on itself.
static const uint16_t kSysReportMode = 0x0004;
static const uint16_t kSysNormalMode = 0x0064;

static bool setSystemMode(Stream& io, uint32_t mode) {
  const uint8_t payload[] = {
    0x12, 0x00, 0x00, 0x00,
    (uint8_t)(mode & 0xFF), (uint8_t)((mode >> 8) & 0xFF),
    (uint8_t)((mode >> 16) & 0xFF), (uint8_t)((mode >> 24) & 0xFF),
  };
  uint8_t ack[16];
  sendFrame(io, payload, sizeof(payload));
  const int n = readFrame(io, ack, sizeof(ack));
  return ackMatches(ack, n, 0x12);
}

// Reporting frame: F4 F3 F2 F1 | len(2) | detected(1) | distance(2) | per-gate energy | F8 F7 F6 F5
//
// The datasheet specifies the energy block as "128 bytes, 32 (total number of range gates) *
// 4 bytes". The modules here send len=35, i.e. 32 energy bytes -- 16 gates of 2 bytes, which
// is what the documented gate range of 0..15 implies in the first place. Parsing it as the
// datasheet describes produced 0xFFFFFFFF for gate 0 (two saturated 16-bit gates read as one
// 32-bit value) and billions for its neighbour, which is how the mismatch was caught.
// The width is therefore derived from the frame length rather than assumed.
static const uint8_t kRptHead[4] = { 0xF4, 0xF3, 0xF2, 0xF1 };

static bool readReportFrame(Stream& io, uint8_t* detected, uint16_t* distanceCm,
                            uint32_t* energy, int energyCap, int* gateCount,
                            uint32_t timeoutMs) {
  const uint32_t deadline = millis() + timeoutMs;
  int matched = 0;
  while ((int32_t)(millis() - deadline) < 0) {
    if (!io.available()) { delay(1); continue; }
    const uint8_t b = (uint8_t)io.read();
    matched = (b == kRptHead[matched]) ? matched + 1 : (b == kRptHead[0] ? 1 : 0);
    if (matched == 4) break;
  }
  if (matched != 4) return false;

  uint8_t body[160];
  auto grab = [&](uint8_t* dst, int count) -> bool {
    for (int i = 0; i < count; i++) {
      while (!io.available()) {
        if ((int32_t)(millis() - deadline) >= 0) return false;
        delay(1);
      }
      dst[i] = (uint8_t)io.read();
    }
    return true;
  };
  uint8_t lenb[2];
  if (!grab(lenb, 2)) return false;
  const uint16_t len = (uint16_t)lenb[0] | ((uint16_t)lenb[1] << 8);
  if (len < 3 || len > sizeof(body)) return false;
  if (!grab(body, len)) return false;

  // Dump the first few frames verbatim. Field offsets taken from a table are a hypothesis;
  // the bytes are the evidence. This caught a wrong decode twice already this bring-up.
  static int dumped = 0;
  if (dumped < 2) {
    dumped++;
    Serial.printf("[rd03] RAW report frame: len=%u body:", (unsigned)len);
    for (uint16_t i = 0; i < len && i < 24; i++) Serial.printf(" %02X", body[i]);
    Serial.printf(" ...(%u total)\n", (unsigned)len);
  }

  *detected   = body[0];
  *distanceCm = (uint16_t)body[1] | ((uint16_t)body[2] << 8);

  const int energyBytes = len - 3;
  const int width = (energyBytes % 4 == 0 && energyBytes >= 128) ? 4 : 2;
  const int gates = energyBytes / width;
  for (int g = 0; g < gates && g < energyCap; g++) {
    const uint8_t* e = &body[3 + g * width];
    energy[g] = (width == 2)
        ? ((uint32_t)e[0] | ((uint32_t)e[1] << 8))
        : ((uint32_t)e[0] | ((uint32_t)e[1] << 8) | ((uint32_t)e[2] << 16) | ((uint32_t)e[3] << 24));
  }
  // Report only what was actually written. `gates` is derived from the frame length and can
  // exceed the caller's array (a 160-byte frame yields 78 gates into a 32-entry buffer), so
  // handing back the raw count invites the caller to read past the end of its own array.
  *gateCount = (gates < energyCap) ? gates : energyCap;
  return true;
}

// verifyOt2() REMOVED.
//
// It commanded the head to a far-only range gate and expected OT2 to go LOW. That premise was
// disproven on this hardware: the head reports ON at every gate setting from 0..5 through
// 15..15 in an empty room, so the gate config does not constrain detection and the test could
// never conclude anything. It reported both heads FAULTY when both were fine.
//
// The boot-time pull test is the honest check -- on a clean GPIO it proves the pin is driven,
// which is the part that is actually knowable. Do not reintroduce a test whose reference
// signal has not been shown to track the thing it is being used to judge.

// Dump whatever the head emits in NORMAL mode, verbatim, as both hex and text.
//
// Normal mode is documented as "the serial port prints out the status" -- target state and
// range. If it carries a usable presence indication, the OT2 wire becomes unnecessary and
// presence can come from the UART, which is already proven working on both heads. Nothing
// is parsed here on purpose: the point is to see the real bytes before writing a parser,
// because every field layout taken from this datasheet has been wrong so far.
static void sniffNormalMode(Stream& io, const char* label, uint32_t seconds) {
  if (!openCommandMode(io)) {
    Serial.printf("[rd03:%s] normal-mode sniff: head not answering\n", label);
    return;
  }
  const bool ok = setSystemMode(io, kSysNormalMode);
  closeCommandMode(io);
  Serial.printf("[rd03:%s] normal mode %s — raw output for %us:\n",
                label, ok ? "set" : "REFUSED", (unsigned)seconds);

  const uint32_t until = millis() + seconds * 1000UL;
  char line[96];
  int n = 0, total = 0;
  while ((int32_t)(millis() - until) < 0) {
    if (!io.available()) { delay(2); continue; }
    const uint8_t b = (uint8_t)io.read();
    total++;
    if (b == '\n' || b == '\r' || n >= (int)sizeof(line) - 1) {
      if (n > 0) { line[n] = 0; Serial.printf("[rd03:%s]   TEXT: %s\n", label, line); n = 0; }
    } else if (b >= 0x20 && b <= 0x7E) {
      line[n++] = (char)b;
    } else {
      if (n > 0) { line[n] = 0; Serial.printf("[rd03:%s]   TEXT: %s\n", label, line); n = 0; }
      Serial.printf("[rd03:%s]   BYTE: %02X\n", label, b);
    }
  }
  if (n > 0) { line[n] = 0; Serial.printf("[rd03:%s]   TEXT: %s\n", label, line); }
  Serial.printf("[rd03:%s] normal-mode sniff done: %d bytes\n", label, total);
}

// Which range gates can the head actually use without latching permanently ON?
//
// Gates 0..1 read a constant 0xFFFF near-field blanking sentinel -- the maximum a 16-bit
// value can hold. If detection thresholds gate energy, including a blanked gate guarantees
// the threshold is exceeded on every frame, so the head reports presence forever regardless
// of the room. This sweeps the minimum gate and reads the head's own normal-mode verdict
// for each, which needs no OT2 wire and no parsing guesswork: the module prints "ON"/"OFF".
static void sweepMinGate(Stream& io, const char* label, uint32_t maxGate) {
  Serial.printf("[rd03:%s] min-gate sweep (room should be EMPTY for this to mean anything)\n", label);
  for (uint32_t lo = 0; lo <= maxGate && lo <= 15; lo++) {
    if (!openCommandMode(io)) { Serial.printf("[rd03:%s]   gate %lu: head stopped answering\n",
                                              label, (unsigned long)lo); return; }
    setParam(io, kParamMinGate, lo);
    setParam(io, kParamMaxGate, maxGate);
    setSystemMode(io, kSysNormalMode);
    closeCommandMode(io);

    delay(5000);                                   // clear the disappearance delay
    while (io.available()) (void)io.read();        // drop anything from before the settle

    // Count ON vs OFF over a couple of seconds of its own status printing.
    int on = 0, off = 0;
    char buf[32]; int n = 0;
    const uint32_t until = millis() + 2500;
    while ((int32_t)(millis() - until) < 0) {
      if (!io.available()) { delay(2); continue; }
      const uint8_t b = (uint8_t)io.read();
      if (b == '\n' || b == '\r' || n >= (int)sizeof(buf) - 1) {
        if (n > 0) {
          buf[n] = 0;
          if (strstr(buf, "OFF")) off++;
          else if (strstr(buf, "ON")) on++;
          n = 0;
        }
      } else if (b >= 0x20 && b <= 0x7E) buf[n++] = (char)b;
    }
    Serial.printf("[rd03:%s]   gates %lu..%lu -> ON:%d OFF:%d  %s\n", label,
                  (unsigned long)lo, (unsigned long)maxGate, on, off,
                  (on == 0 && off == 0) ? "(no output)"
                  : (off > 0 && on == 0) ? "<-- CLEARS in an empty room"
                  : (on > 0 && off == 0) ? "latched ON" : "mixed");
  }
}

// ---------------------------------------------------------------------------------------
// Automatic threshold generation (0x0009 / 0x000A) and the interference report (0x0014).
//
// This is the module's own answer to a head that reports presence into an empty room. The
// detection thresholds ship at a factory default that has never seen this room; if the
// ambient return in any gate sits above them, the head latches ON forever and NO amount of
// range-gate tuning helps -- which is exactly what the gate sweep showed (ON at every
// setting from 0..5 through 5..5, room empty).
//
// Generation learns the room's noise floor and places thresholds a coefficient above it.
// THE ROOM MUST BE EMPTY WHILE THIS RUNS, or the occupant is learned as background and the
// head goes permanently blind instead -- the opposite failure, and a worse one.
//
// Coefficients are 10x: a factor of 2.0 is sent as 20 (0x0014). Range 0x000A..0x00C8,
// i.e. 1.0 .. 20.0. Higher = thresholds further above the noise = less sensitive.
static const uint16_t kCmdAutoThreshold = 0x0009;
static const uint16_t kCmdAutoProgress  = 0x000A;
static const uint16_t kCmdInterference  = 0x0014;

// Which range gates is the module seeing interference in? Returns false if unsupported.
static bool interferenceReport(Stream& io, const char* label) {
  const uint8_t payload[] = { 0x14, 0x00 };
  uint8_t ack[32];
  sendFrame(io, payload, sizeof(payload));
  const int n = readFrame(io, ack, sizeof(ack), 1000);
  if (!ackMatches(ack, n, 0x14) || n < 6) {
    Serial.printf("[rd03:%s] interference report: not supported on this firmware\n", label);
    return false;
  }
  const uint16_t status = (uint16_t)ack[2] | ((uint16_t)ack[3] << 8);
  const uint16_t gates  = (uint16_t)ack[4] | ((uint16_t)ack[5] << 8);
  Serial.printf("[rd03:%s] interference: %s", label,
                status == 0 ? "none" : "PRESENT — moving-human interference during calibration");
  if (gates) {
    Serial.printf("  affected gates:");
    for (int g = 0; g < 16; g++) if (gates & (1u << g)) Serial.printf(" %d", g);
  }
  Serial.printf("  (raw status=0x%04X gates=0x%04X)\n", status, gates);
  return true;
}

// Runs generation to completion. trig/hold/micro are the 10x coefficients.
static bool autoThreshold(Stream& io, const char* label,
                          uint16_t trig, uint16_t hold, uint16_t micro) {
  if (!openCommandMode(io)) {
    Serial.printf("[rd03:%s] auto-threshold: head not answering\n", label);
    return false;
  }
  const uint8_t payload[] = {
    0x09, 0x00,
    (uint8_t)(trig  & 0xFF), (uint8_t)(trig  >> 8),
    (uint8_t)(hold  & 0xFF), (uint8_t)(hold  >> 8),
    (uint8_t)(micro & 0xFF), (uint8_t)(micro >> 8),
  };
  uint8_t ack[32];
  sendFrame(io, payload, sizeof(payload));
  int n = readFrame(io, ack, sizeof(ack), 1500);
  if (!ackMatches(ack, n, 0x09)) {
    Serial.printf("[rd03:%s] auto-threshold: command 0x0009 refused or unsupported "
                  "(this firmware is missing 0x00FD and 0x0005 too)\n", label);
    closeCommandMode(io);
    return false;
  }
  Serial.printf("[rd03:%s] auto-threshold started (coefficients trig=%.1f hold=%.1f micro=%.1f) "
                "— ROOM MUST BE EMPTY\n", label, trig / 10.0f, hold / 10.0f, micro / 10.0f);

  // Poll progress. 100 % means done.
  int pct = 0;
  const uint32_t deadline = millis() + 90000;
  while (pct < 100 && (int32_t)(millis() - deadline) < 0) {
    delay(2000);
    const uint8_t q[] = { 0x0A, 0x00 };
    sendFrame(io, q, sizeof(q));
    n = readFrame(io, ack, sizeof(ack), 1500);
    if (!ackMatches(ack, n, 0x0A) || n < 6) {
      Serial.printf("[rd03:%s] auto-threshold: progress query unsupported — cannot confirm "
                    "completion\n", label);
      break;
    }
    pct = (int)((uint16_t)ack[4] | ((uint16_t)ack[5] << 8));
    Serial.printf("[rd03:%s] auto-threshold progress %d%%\n", label, pct);
  }

  interferenceReport(io, label);
  const bool saved = saveConfig(io) == 1;
  closeCommandMode(io);
  Serial.printf("[rd03:%s] auto-threshold %s%s\n", label,
                pct >= 100 ? "COMPLETE" : "did not reach 100%",
                saved ? ", saved to flash" : ", NOT saved (no save command on this firmware)");
  return pct >= 100;
}

// Dump the per-gate detection thresholds and compare them with the energy the head is
// actually seeing. This is the last lever these modules leave us: 0x0009 auto-generation is
// refused, but the thresholds themselves live behind 0x0007/0x0008, which ARE supported.
//
// A head latched ON in an empty room means, by definition, that some gate's ambient energy
// sits above that gate's trigger threshold. Printing both side by side shows exactly which
// gate and by how much, instead of guessing at coefficients.
//
//   0x0010..0x001F  motion trigger, one per gate
//   0x0020..0x002F  motion hold
//   0x0030..0x003F  fine-motion & still
static void dumpThresholds(Stream& io, const char* label, const uint32_t* energy, int gates) {
  if (!openCommandMode(io)) {
    Serial.printf("[rd03:%s] threshold dump: head not answering\n", label);
    return;
  }
  Serial.printf("[rd03:%s] gate | trigger | hold | micro/still | live energy | verdict\n", label);
  for (int g = 0; g < 16; g++) {
    uint32_t trig = 0, hold = 0, micro = 0;
    const bool a = readParam(io, (uint16_t)(0x0010 + g), &trig);
    const bool b = readParam(io, (uint16_t)(0x0020 + g), &hold);
    const bool c = readParam(io, (uint16_t)(0x0030 + g), &micro);
    if (!a && !b && !c) {
      Serial.printf("[rd03:%s]  %2d  | (thresholds not readable on this firmware)\n", label, g);
      break;
    }
    const uint32_t e = (g < gates) ? energy[g] : 0;
    const bool over = (trig > 0) && (e >= trig);
    Serial.printf("[rd03:%s]  %2d  | %7lu | %6lu | %11lu | %11lu | %s\n", label, g,
                  (unsigned long)trig, (unsigned long)hold, (unsigned long)micro,
                  (unsigned long)e,
                  over ? "ENERGY ABOVE TRIGGER -> this gate fires" : "below");
  }
  closeCommandMode(io);
}

// Read and optionally set the V1 frame-count filters.
//
// V1 cannot adjust thresholds, so these are the only sensitivity controls it has:
//   0x0002  frames of agreement required before the head asserts presence
//   0x0003  frames of agreement required before it clears
// Raising the detect count makes a head that trips on noise stop asserting; lowering the
// vanish count makes it clear sooner.
static void frameFilters(Stream& io, const char* label, int32_t setDetect, int32_t setVanish) {
  if (!openCommandMode(io)) {
    Serial.printf("[rd03:%s] frame filters: head not answering\n", label);
    return;
  }
  uint32_t d = 0, v = 0;
  const bool okD = readParam(io, kParamFramesDetect, &d);
  const bool okV = readParam(io, kParamFramesVanish, &v);
  if (!okD && !okV) {
    Serial.printf("[rd03:%s] frame filters not readable — module is not Rd-03 V1\n", label);
    closeCommandMode(io);
    return;
  }
  Serial.printf("[rd03:%s] frame filters: detect=%lu vanish=%lu\n", label,
                (unsigned long)d, (unsigned long)v);

  if (setDetect >= 0 && setParam(io, kParamFramesDetect, (uint32_t)setDetect))
    Serial.printf("[rd03:%s]   detect frames -> %ld\n", label, (long)setDetect);
  if (setVanish >= 0 && setParam(io, kParamFramesVanish, (uint32_t)setVanish))
    Serial.printf("[rd03:%s]   vanish frames -> %ld\n", label, (long)setVanish);

  if (setDetect >= 0 || setVanish >= 0) {
    readParam(io, kParamFramesDetect, &d);
    readParam(io, kParamFramesVanish, &v);
    Serial.printf("[rd03:%s] frame filters now: detect=%lu vanish=%lu\n", label,
                  (unsigned long)d, (unsigned long)v);
  }
  closeCommandMode(io);
}

// Park the head in reporting mode and leave it there, so the main loop can read detection
// and range continuously rather than only during a bench sniff.
static bool enableReporting(Stream& io, const char* label) {
  if (!openCommandMode(io)) {
    Serial.printf("[rd03:%s] could not enter command mode to start reporting\n", label);
    return false;
  }
  const bool ok = setSystemMode(io, kSysReportMode);
  if (!closeCommandMode(io)) {
    Serial.printf("[rd03:%s] WARNING: stuck in command mode — blind until power-cycled\n", label);
    return false;
  }
  Serial.printf("[rd03:%s] reporting mode %s — distance will be published\n",
                label, ok ? "on" : "REFUSED");
  return ok;
}

// Stream the head's own view for a few seconds. Prints the strongest gates so the number
// that is actually tripping detection is visible, rather than inferred.
static void sniff(Stream& io, const char* label, uint32_t seconds) {
  if (!openCommandMode(io)) {
    Serial.printf("[rd03:%s] sniff: no ACK on open-command-mode\n", label);
    return;
  }
  const bool modeOk = setSystemMode(io, kSysReportMode);
  if (!closeCommandMode(io)) {
    Serial.printf("[rd03:%s] sniff: could not exit command mode — the module streams nothing "
                  "and detects nothing while stuck there, which is why no frames arrive\n", label);
    return;
  }
  if (!modeOk) {
    Serial.printf("[rd03:%s] sniff: module refused reporting mode (0x0012 may be "
                  "unimplemented on this firmware)\n", label);
    return;
  }

  // Before parsing anything, show what the module actually emits for a second. A parser that
  // finds no frames cannot distinguish "module is silent" from "module is talking in a format
  // I am not looking for", and those need opposite fixes.
  {
    Serial.printf("[rd03:%s] raw output sample:", label);
    const uint32_t rawUntil = millis() + 1200;
    int shown = 0, total = 0;
    bool printable = true;
    while ((int32_t)(millis() - rawUntil) < 0) {
      if (!io.available()) { delay(1); continue; }
      const uint8_t b = (uint8_t)io.read();
      total++;
      if (b != 0x0A && b != 0x0D && (b < 0x20 || b > 0x7E)) printable = false;
      if (shown < 32) { Serial.printf(" %02X", b); shown++; }
    }
    Serial.printf("  (%d bytes in 1.2s%s)\n", total,
                  total == 0 ? " — SILENT" : (printable ? ", looks like ASCII text" : ""));
  }

  Serial.printf("[rd03:%s] reporting mode for %us — detected / distance / strongest gates\n",
                label, (unsigned)seconds);
  const uint32_t until = millis() + seconds * 1000UL;
  int frames = 0, saidPresent = 0;
  while ((int32_t)(millis() - until) < 0) {
    uint8_t detected = 0; uint16_t dist = 0; uint32_t energy[32] = {0}; int gates = 0;
    if (!readReportFrame(io, &detected, &dist, energy, 32, &gates, 1000)) continue;
    frames++;
    if (detected) saidPresent++;
    if (frames % 10 == 1) {                       // roughly one line per second
      Serial.printf("[rd03:%s] detected=%u dist=%3ucm energy:", label,
                    (unsigned)detected, (unsigned)dist);
      for (int g = 0; g < gates && g < 16; g++) Serial.printf(" %5lu", (unsigned long)energy[g]);
      Serial.printf("\n");
    }
  }
  Serial.printf("[rd03:%s] sniff done: %d frames, module said PRESENT in %d of them\n",
                label, frames, saidPresent);

  if (openCommandMode(io)) {                       // put it back the way we found it
    setSystemMode(io, kSysNormalMode);
    if (!closeCommandMode(io)) {
      Serial.printf("[rd03:%s] WARNING: left in command mode after sniff — it is blind until "
                    "power-cycled\n", label);
    }
  }
}

}  // namespace rd03
