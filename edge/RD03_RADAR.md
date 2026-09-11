# Rd-03 radar — capability, protocol, and what has been ruled out

Bring-up notes for the two Ai-Thinker Rd-03 presence heads. Read this before writing
anything that configures a threshold or trusts a field in the reporting frame.

Companion to [WIRING.md](WIRING.md) (how they are wired) and
[SHOPPING_LIST.md](SHOPPING_LIST.md) (what they cost and why these and not LD2410).

## The headline for a threshold attempt

**These are Rd-03 V1 modules, and V1 has no threshold registers.** The V1 serial
protocol document states it outright:

> *"The agreement does not support to modify the threshold for currently."*

Anything built against the **Rd-03_V2** document will fail on this hardware. Verified
against the live modules:

| Command | V2 doc | These modules |
|---|---|---|
| `0x0007` set param (gates, delay, frame counts) | ✅ | ✅ works |
| `0x0008` read param | ✅ | ✅ works |
| `0x0012` system mode | ✅ | ✅ works |
| `0x00FF` / `0x00FE` open/close cmd mode | ✅ | ✅ works |
| `0x0010`–`0x003F` per-gate thresholds | ✅ | ❌ **absent** |
| `0x0009` auto-threshold generation | ✅ | ❌ **refused** |
| `0x000A` auto-threshold progress | ✅ | ❌ untested (`0x0009` refused) |
| `0x0014` interference report | ✅ | ❌ absent |
| `0x00FD` save config | ✅ | ❌ **no ACK at all** |
| `0x0005` supply-interference alarm | ✅ | ❌ reads back `0xFFFF` |

Confusingly, the open-command ACK reports **protocol version 0x0002** (V2) with buffer
`0x0020`, but the modules expose V1's parameter set. Hybrid firmware. Do not trust the
version field — probe capability.

**Consequence: a threshold must be built in software, host-side, from the per-gate
energy array. There is no register to write.**

## What *is* configurable (all verified working)

```
0x0000  min range gate      0..15, 0.7 m per gate
0x0001  max range gate      0..15
0x0002  frames-to-detect    consecutive agreeing frames before asserting   <- V1-only
0x0003  frames-to-vanish    consecutive frames before clearing             <- V1-only
0x0004  disappearance delay seconds, 0..65535
0x0012  system mode         0x00 debug(RDMap) / 0x04 report / 0x64 normal
```

`0x0002` / `0x0003` are V1's **only** sensitivity controls. Factory default is
`detect=1` — a single noisy frame asserts presence.

**Settings are volatile.** There is no save command, so every parameter is lost on
module power loss and must be re-applied. The firmware does this at boot and on rejoin.

## Current build config

```
MMWAVE_PIN=13  MMWAVE2_PIN=14          <- OT2 presence pins
MMWAVE_UART_RX=16 TX=17                <- head1 UART (Serial2)
MMWAVE2_UART_RX=4  TX=18               <- head2 UART (Serial1)
RD03_SET_MIN_GATE=1  MAX_GATE=5  DELAY_S=2
RD03_FRAMES_DETECT=15
```

## Pinout — this board differs from both datasheets

```
pin 1  3V3
pin 2  GND
pin 3  OT1   <- this is UART_TX, despite the label
pin 4  RX    <- UART_RX
pin 5  OT2   <- presence output, HIGH when sensing
```

**Never put OT2 on GPIO 34–39 or GPIO 15.** GPIO 34–39 are input-only with no internal
pulls, so an open wire floats to an arbitrary level; GPIO 15 has an external pull-up that
reads HIGH even with the module unplugged. On both, a working sensor and a dead wire are
indistinguishable — this cost most of a day. GPIO 13/14 are testable.

## Reporting-mode frame format

What a software threshold would consume:

```
F4 F3 F2 F1 | len(2)=0x0023 | detected(1) | distance(2) | 16 gates x 2 bytes LE | F8 F7 F6 F5
```

45 bytes on the wire: 4 header + 2 length + 35 body + 4 trailer.

The **V2 doc is wrong** here: it says 32 gates x 4 bytes / 128 bytes. Actual is
**16 gates x 2 bytes = 32 bytes**, len 35. Parsing it per the V2 doc yields
`0xFFFFFFFF` for gate 0 — two saturated 16-bit gates read as one 32-bit value.

### Fields you must not trust

- **`distance`** — does not measure the room. It tracks the configured min gate:
  min gate 0 -> 11 cm, min gate 1 -> 35 cm, min gate 3 -> 175 cm, with nothing physically
  changing. Not published to telemetry for this reason.
- **`detected`** — latched at 1 in every configuration tested, including gate 15..15 only
  (10.5 m) in a 4 m room.

**The one trustworthy field is the per-gate energy array.** Gates vary frame to frame with
a physically sensible 1/r⁴ decay and respond to real movement.

### Blanking

A gate reported as `0xFFFF` is blanked by the module; the firmware publishes these as
`-1`. Which gates get blanked is **dynamic and per-module** — one head blanks 0–1, the
other blanks nothing, and it changes after a power cycle. A threshold must handle a
varying valid-bin set, and must not treat the lowest live bin's midpoint as a distance:
everything nearer is invisible and piles into it.

## What has been tried and ruled out

- **Range gates** — no effect on the latch. Reports `ON` at every setting from 0..5
  through 15..15 in an empty room.
- **Disappearance delay** 30 s -> 2 s — timing works, latch unaffected.
- **Frame filter** `detect` 1 -> 15 — no effect.
- **Auto-threshold `0x0009`** — refused by both modules.
- **Mutual interference** — disproven. RD03-2 fully unplugged, RD03-1 still asserts
  continuously.
- **Mounting** — foil removed, off the box top, onto the box sides. Each changed the
  numbers; none fixed the latch.

Current settled baseline, room empty, 165 s: **RD03-1 gate 0 peak in 90% of frames
(median 22,273); RD03-2 84% (median 34,946); both OT2 high 100%.** Both heads sit on a
desk, so the desk surface is inside gate 0. **The manual's wall/ceiling mount at 1.5–2 m
has never been tried** and is the most likely fix.

## Working software layer

[`server/simulation/presence.go`](../server/simulation/presence.go) already fuses radar
with CO₂ and correctly catches this failure. Radar drives transitions, CO₂ arbitrates:
`vacant -> arriving -> occupied -> departing`, plus **`disputed`** when the beam asserts
for 6+ minutes while CO₂ decays. It has flagged `disputed` on live hardware.

Guards: slopes beyond ±100 ppm/min (breathing near the probe) neither confirm nor
dispute; samples age out at 6 min; published as `"derived": true`, never as `occupancy`.

A software threshold would slot in beside this, consuming `radar1_gates` /
`radar2_gates` from telemetry.

## The rule that governs any threshold work here

From [CLAUDE.md](../CLAUDE.md): **never fabricate a measurement on a measured channel.**
Firmware omits a field when its sensor is absent rather than sending a plausible default.
Several bugs during this bring-up were exactly this — `stripW` reporting 3.9 kW of mains
hum from a disconnected sensor, occupancy published from floating pins, a CO₂ slope
computed from samples minutes old.

A derived threshold must publish as derived, and omit rather than guess.

## Files

`edge/esp32/src/rd03_uart.h` · `edge/esp32/src/main.cpp` ·
`server/simulation/presence.go` · `edge/WIRING.md`
