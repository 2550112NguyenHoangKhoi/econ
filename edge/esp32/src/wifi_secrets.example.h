#pragma once
// Copy this file to wifi_secrets.h (gitignored) and fill in your site's values.
// The ESP32 only joins 2.4 GHz networks.
//
// These are only the FACTORY DEFAULTS. Anything provisioned over the USB console
// ("[wifi] connect", "[mqtt] host") is stored in NVS and takes precedence, so a node
// does not need reflashing to move network or laptop.
//
// MQTT_HOST accepts either form:
//   "Khois-MacBook-Air.local"  - an mDNS name, resolved over Bonjour at connect time.
//                                PREFER THIS: it follows the machine across networks
//                                and DHCP leases. macOS advertises <hostname>.local
//                                automatically (`scutil --get LocalHostName`); on Linux
//                                install avahi-daemon.
//   "192.168.1.100"            - a literal LAN IP, used as-is. Pins the node to one
//                                network (macOS: `ipconfig getifaddr en0`).
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char* MQTT_HOST = "YOUR-MACHINE.local";

// Broker credentials, printed by econ/server/setup-mqtt-auth.sh. Every node shares the
// econ-node identity, which may publish telemetry and subscribe to its own commands but
// may NOT publish commands — so one compromised ceiling box cannot switch the floor.
//
// Comment these out only for a bench test against the anonymous dev broker
// (mosquitto.dev.conf). Against the shipped broker, a node without them fails with rc=5.
#define MQTT_USER "econ-node"
#define MQTT_PASS "PASTE_FROM_setup-mqtt-auth.sh"
