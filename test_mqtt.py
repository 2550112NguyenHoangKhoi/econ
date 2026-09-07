import paho.mqtt.client as mqtt
import json

client = mqtt.Client()
client.connect("localhost", 1883)
payload = {
    "zone": "zone-test",
    "circuitBreakerW": 1380.0,
    "plugW": 0.0,
    "stripW": 0.0,
    "source": "esp32",
    "tempReal": True
}
client.publish("econ/telemetry/esp32_test", json.dumps(payload))
client.loop_stop()
