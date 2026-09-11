#!/usr/bin/env python3
"""Send a command to the node over MQTT.

The engine's /api/command allowlist is the normal path, but the running binary can
lag a newly-added command, and a few (REBOOT) are deliberately not exposed over HTTP
at all. This publishes straight to the broker.

  ./node-cmd.py RD03_LINETEST     line test on both radar UARTs
  ./node-cmd.py IR_CARRIER        2 s of 38 kHz on the IR LED
  ./node-cmd.py 'SETPOINT=24.0'   change the AC setpoint
"""
import sys, paho.mqtt.client as mqtt

if len(sys.argv) < 2:
    sys.exit(__doc__)
cmd = " ".join(sys.argv[1:])
c = mqtt.Client()
c.connect("localhost", 1883, 10)
c.loop_start()
c.publish("econ/commands/zone_1", cmd, qos=1).wait_for_publish()
c.loop_stop(); c.disconnect()
print(f"sent: {cmd}")
