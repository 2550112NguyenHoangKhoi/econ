#pragma once
// Rd-03 presence heads: liveness, the OT2 pull test, and the parsed frame state.
//
// The pull test is why OT2 sits on a full GPIO rather than an input-only pin: driving the
// pin both ways proves a head is connected, which a floating pin cannot fake. An unwired
// head that floats to a convincing HIGH would report a permanently occupied room.
//
// Split out of main.cpp for readability. It is #included from there at the point this
// code used to sit, so this is the same translation unit -- file-scope statics, include
// order and initialisation order are all exactly as they were. Verified by comparing
// the built firmware.bin before and after the split.

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
