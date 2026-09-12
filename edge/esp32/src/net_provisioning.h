#pragma once
// WiFi provisioning and MQTT broker resolution.
//
// Credentials and broker host live in NVS (Preferences) so a node can be re-pointed at a
// different site without a reflash. wifi_secrets.h supplies the compile-time default; what
// is stored in NVS overrides it.
//
// Split out of main.cpp for readability. It is #included from there at the point this
// code used to sit, so this is the same translation unit -- file-scope statics, include
// order and initialisation order are all exactly as they were. Verified by comparing
// the built firmware.bin before and after the split.

// ---------------------------------------------------------------------------------------
// WiFi provisioning.
//
// Credentials used to live only in wifi_secrets.h, so moving the node to another network
// meant editing a header and reflashing. These are stored in NVS instead: pick a network
// from a scan by number, type the password once, and it survives reboots and reflashes.
// The compile-time values in wifi_secrets.h remain the fallback for a node that has never
// been provisioned.
static Preferences gWifiPrefs;
static String  gScanSsids[24];        // index -> SSID from the last scan
static int     gScanCount = 0;

static const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000;

// The broker address is compiled into wifi_secrets.h, which pins it to one network's
// DHCP lease. Carry the node -- or the laptop -- to another site and it dials an
// address that no longer exists ("Host is unreachable"), with no way to correct it
// short of a reflash. gMqttHost may therefore hold either a literal IP or an mDNS
// name: macOS and avahi-equipped Linux advertise <hostname>.local on whatever network
// they join, so a name follows the machine and a fresh site needs no lookup at all.
static Preferences gMqttPrefs;
static char        gMqttHost[64];
static IPAddress   gBrokerIp;
static bool        gBrokerResolved = false;

static void mqttLoadHost() {
  String host = MQTT_HOST;
  if (gMqttPrefs.begin("econmqtt", true)) {
    host = gMqttPrefs.getString("host", MQTT_HOST);
    gMqttPrefs.end();
  }
  snprintf(gMqttHost, sizeof(gMqttHost), "%s", host.c_str());
}

static void mqttSaveHost(const char* host) {
  snprintf(gMqttHost, sizeof(gMqttHost), "%s", host);
  gBrokerResolved = false; // force a fresh lookup against the new name
  if (gMqttPrefs.begin("econmqtt", false)) {
    gMqttPrefs.putString("host", host);
    gMqttPrefs.end();
  }
}

// Turn gMqttHost into an address. A literal IP is used as-is; anything else is treated
// as an mDNS name. Returns false when it cannot be resolved yet, and the caller simply
// retries on its normal 5 s cadence.
static bool resolveBroker() {
  if (gBrokerResolved) return true;
  IPAddress parsed;
  if (parsed.fromString(gMqttHost)) {
    gBrokerIp = parsed;
    gBrokerResolved = true;
    return true;
  }
  if (WiFi.status() != WL_CONNECTED) return false;
  String name(gMqttHost);
  if (name.endsWith(".local")) name = name.substring(0, name.length() - 6);
  IPAddress found = MDNS.queryHost(name.c_str(), 2000);
  if (found != IPAddress((uint32_t)0)) {
    gBrokerIp = found;
    gBrokerResolved = true;
    Serial.printf("[mqtt] resolved %s -> %s via mDNS\n", gMqttHost, gBrokerIp.toString().c_str());
    return true;
  }
  Serial.printf("[mqtt] could not resolve \"%s\" over mDNS yet\n", gMqttHost);
  return false;
}

static bool wifiLoadSaved(String* ssid, String* pass) {
  if (!gWifiPrefs.begin("econwifi", true)) return false;
  *ssid = gWifiPrefs.getString("ssid", "");
  *pass = gWifiPrefs.getString("pass", "");
  gWifiPrefs.end();
  return ssid->length() > 0;
}

static void wifiSaveCredentials(const String& ssid, const String& pass) {
  if (!gWifiPrefs.begin("econwifi", false)) {
    Serial.println("[wifi] could not open NVS — credentials NOT saved");
    return;
  }
  gWifiPrefs.putString("ssid", ssid);
  gWifiPrefs.putString("pass", pass);
  gWifiPrefs.end();
  // Never echo the password, not even its length.
  Serial.printf("[wifi] saved \"%s\" to NVS — will be used on every boot from now on\n",
                ssid.c_str());
}

static void wifiForget() {
  if (gWifiPrefs.begin("econwifi", false)) {
    gWifiPrefs.clear();
    gWifiPrefs.end();
  }
  Serial.println("[wifi] saved credentials cleared — reverting to wifi_secrets.h on next boot");
}
#ifndef USE_MMWAVE_UART
  #define USE_MMWAVE_UART 0
#endif
#ifndef USE_MMWAVE2_UART
  #define USE_MMWAVE2_UART 0
#endif
// Per-head liveness. Defaults to true: with no UART wired we cannot know, and refusing to
// report a head we simply cannot interrogate would be worse than trusting OT2. Where the
// UART *is* wired, a head that does not answer is known-dead and its OT2 must be ignored.
#ifndef RD03_SET_MIN_GATE
  #define RD03_SET_MIN_GATE 1         // exclude gate 0: the module's own near field
#endif
#ifndef RD03_SET_MAX_GATE
  #define RD03_SET_MAX_GATE 15
#endif
