#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <Arduino_GFX_Library.h>
#include <ArduinoJson.h>
#include <time.h>

#include "AudioFileSourceICYStream.h"
#include "AudioFileSourceBuffer.h"
#include "AudioGeneratorMP3.h"
#include "AudioOutputI2S.h"
#include "aws_secrets.h"

#define LCD_MOSI 6
#define LCD_SCLK 7
#define LCD_CS 14
#define LCD_DC 15
#define LCD_RST 21
#define LCD_BL 22
#define I2S_BCLK 18
#define I2S_LRC 19
#define I2S_DOUT 20

constexpr uint16_t COLOR_BLACK = 0x0000;
constexpr uint16_t COLOR_WHITE = 0xFFFF;
constexpr uint16_t COLOR_RED = 0xF800;
constexpr uint16_t COLOR_GREEN = 0x07E0;
constexpr uint16_t COLOR_BLUE = 0x001F;

const char* THING_NAME = "esp32-c6-demo";
const char* PUB_TOPIC = "esp32/demo/telemetry";
const char* CMD_TOPIC = "esp32/demo/commands";
const char* RESP_TOPIC = "esp32/demo/responses";
const char* DEFAULT_STATION = "http://regiocast.streamabc.net/regc-80s80smweb2517500-mp3-192-1672667";

constexpr unsigned long TELEMETRY_INTERVAL_MS = 10000;
constexpr unsigned long DISPLAY_INTERVAL_MS = 5000;
constexpr unsigned long WIFI_RETRY_MS = 15000;
constexpr unsigned long MQTT_RETRY_MS = 10000;
constexpr unsigned long AUDIO_RETRY_MS = 10000;
constexpr unsigned long AUDIO_COOLDOWN_MS = 60000;
constexpr unsigned long AUDIO_STABLE_RESET_MS = 120000;
constexpr int MAX_AUDIO_FAILURES = 3;

Arduino_DataBus* bus = new Arduino_ESP32SPI(LCD_DC, LCD_CS, LCD_SCLK, LCD_MOSI, GFX_NOT_DEFINED);
Arduino_GFX* gfx = new Arduino_ST7789(bus, LCD_RST, 0, true, 172, 320, 34, 0, 34, 0);
WiFiClientSecure secureClient;
PubSubClient mqtt(secureClient);
Preferences prefs;

AudioGeneratorMP3* mp3 = nullptr;
AudioFileSourceICYStream* stream = nullptr;
AudioFileSourceBuffer* buffer = nullptr;
AudioOutputI2S* output = nullptr;

String stationURL = DEFAULT_STATION;
String colorName = "blue";
String screenMode = "status";
String displayMessage = "Internet Radio";
String lastCommand = "None";
String lastAudioError = "";
uint16_t bgColor = COLOR_BLUE;
int brightness = 50;
int volume = 25;
bool radioPlaying = false;
bool wantPlayback = true;
bool restartPending = false;
bool stopPending = false;
bool audioFault = false;
bool rebootPending = false;
int audioFailures = 0;
uint32_t messageCount = 0;
unsigned long lastPublish = 0;
unsigned long lastDisplay = 0;
unsigned long lastWiFiAttempt = 0;
unsigned long lastMQTTAttempt = 0;
unsigned long lastAudioAttempt = 0;
unsigned long playbackStarted = 0;
unsigned long cooldownStarted = 0;
unsigned long rebootAt = 0;

void drawScreen();
void publishStatus(const String& requestId = "");
void sendResponse(const String& command, bool success, const String& message, const String& requestId = "");

void audioStatus(void*, int code, const char* msg) {
  Serial.printf("[%lu ms] Audio status %d: %s\n", millis(), code, msg ? msg : "(none)");
}

bool isPlaylistURL(String url) {
  url.toLowerCase();
  int q = url.indexOf('?');
  if (q >= 0) url.remove(q);
  int hash = url.indexOf('#');
  if (hash >= 0) url.remove(hash);
  return url.endsWith(".m3u") || url.endsWith(".m3u8") ||
         url.endsWith(".pls") || url.endsWith(".asx") || url.endsWith(".xspf");
}

bool validStationURL(const String& url) {
  return url.length() > 7 && url.length() <= 400 &&
         url.startsWith("http://") && !isPlaylistURL(url);
}

void setBrightness(int percent) {
  brightness = constrain(percent, 0, 100);
  ledcWrite(LCD_BL, map(brightness, 0, 100, 0, 255));
}

bool setBackgroundColor(String color) {
  color.toLowerCase();
  if (color == "red") bgColor = COLOR_RED;
  else if (color == "green") bgColor = COLOR_GREEN;
  else if (color == "blue") bgColor = COLOR_BLUE;
  else if (color == "black") bgColor = COLOR_BLACK;
  else return false;
  colorName = color;
  return true;
}

void drawScreen() {
  gfx->fillScreen(bgColor);
  gfx->setTextColor(COLOR_WHITE);
  gfx->setTextSize(2);
  gfx->setCursor(8, 15);
  gfx->println("ESP32-C6");
  gfx->setCursor(8, 42);
  gfx->println("RADIO");
  gfx->drawLine(8, 72, 164, 72, COLOR_WHITE);
  if (screenMode == "message") {
    gfx->setCursor(8, 95);
    String remaining = displayMessage;
    while (remaining.length() && gfx->getCursorY() < 290) {
      String line = remaining.substring(0, 13);
      remaining.remove(0, line.length());
      gfx->println(line);
    }
    return;
  }
  gfx->setTextSize(1);
  gfx->setCursor(8, 90);
  gfx->printf("WiFi: %s\n", WiFi.status() == WL_CONNECTED ? "Connected" : "Offline");
  gfx->setCursor(8, 115);
  gfx->printf("AWS: %s\n", mqtt.connected() ? "Connected" : "Offline");
  gfx->setCursor(8, 140);
  gfx->printf("Radio: %s\n", radioPlaying ? "Playing" : (audioFault ? "Cooldown" : "Stopped"));
  gfx->setCursor(8, 165);
  gfx->printf("Volume: %d%%\n", volume);
  gfx->setCursor(8, 190);
  gfx->printf("RSSI: %d dBm\n", WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
  gfx->setCursor(8, 215);
  gfx->printf("Heap: %u\n", ESP.getFreeHeap());
  gfx->setCursor(8, 245);
  gfx->println("Last command:");
  gfx->setCursor(8, 265);
  gfx->println(lastCommand.substring(0, 25));
}

void stopRadio() {
  if (mp3) {
    if (mp3->isRunning()) mp3->stop();
    delete mp3;
    mp3 = nullptr;
  }
  if (buffer) {
    buffer->close();
    delete buffer;
    buffer = nullptr;
  }
  if (stream) {
    stream->close();
    delete stream;
    stream = nullptr;
  }
  if (output) {
    delete output;
    output = nullptr;
  }
  radioPlaying = false;
  playbackStarted = 0;
  Serial.println("Radio stopped");
}

bool startRadio() {
  stopRadio();
  if (WiFi.status() != WL_CONNECTED || !validStationURL(stationURL)) {
    lastAudioError = "WiFi offline or invalid station URL";
    Serial.println(lastAudioError);
    return false;
  }
  Serial.println("Opening radio stream:");
  Serial.println(stationURL);
  // These calls may block inside the ESP8266Audio library.
  stream = new AudioFileSourceICYStream(stationURL.c_str());
  buffer = new AudioFileSourceBuffer(stream, 32768);
  buffer->RegisterStatusCB(audioStatus, nullptr);
  output = new AudioOutputI2S();
  if (!output->SetPinout(I2S_BCLK, I2S_LRC, I2S_DOUT)) {
    lastAudioError = "I2S pin configuration failed";
    stopRadio();
    return false;
  }
  output->SetGain(volume / 100.0f);
  mp3 = new AudioGeneratorMP3();
  mp3->RegisterStatusCB(audioStatus, nullptr);
  if (!mp3->begin(buffer, output)) {
    lastAudioError = "MP3 decoder failed to start";
    stopRadio();
    return false;
  }
  radioPlaying = true;
  playbackStarted = millis();
  lastAudioError = "";
  Serial.println("Radio streaming started (decoder initialized; audio not yet verified)");
  return true;
}

void recordAudioFailure(const String& reason) {
  lastAudioError = reason;
  Serial.println("Audio failure: " + reason);
  stopRadio();
  lastAudioAttempt = millis();
  audioFailures++;
  Serial.printf("Consecutive audio failures: %d/%d\n", audioFailures, MAX_AUDIO_FAILURES);
  if (audioFailures >= MAX_AUDIO_FAILURES) {
    audioFault = true;
    cooldownStarted = millis();
    Serial.println("Retry limit reached: 60-second cooldown");
  }
}

void sendResponse(const String& command, bool success, const String& message, const String& requestId) {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  doc["device"] = THING_NAME;
  doc["command"] = command;
  doc["success"] = success;
  doc["message"] = message;
  doc["uptime"] = millis() / 1000UL;
  if (requestId.length()) doc["requestId"] = requestId;
  char payload[768];
  size_t n = serializeJson(doc, payload, sizeof(payload));
  if (!n || n >= sizeof(payload) - 1) {
    Serial.println("Response too large");
    return;
  }
  bool ok = mqtt.publish(RESP_TOPIC, payload);
  Serial.printf("Response %s: %s\n", ok ? "sent" : "failed", payload);
}

void publishStatus(const String& requestId) {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  doc["device"] = THING_NAME;
  doc["type"] = "status";
  doc["uptime"] = millis() / 1000UL;
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["rssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  doc["brightness"] = brightness;
  doc["color"] = colorName;
  doc["screen"] = screenMode;
  doc["messageCount"] = messageCount;
  doc["playing"] = radioPlaying;
  doc["playRequested"] = wantPlayback;
  doc["volume"] = volume;
  doc["station"] = stationURL;
  doc["audioFailures"] = audioFailures;
  doc["audioFault"] = audioFault;
  doc["lastAudioError"] = lastAudioError;
  if (requestId.length()) doc["requestId"] = requestId;
  char payload[1536];
  size_t n = serializeJson(doc, payload, sizeof(payload));
  if (!n || n >= sizeof(payload) - 1) {
    Serial.println("Telemetry too large");
    return;
  }
  if (mqtt.publish(PUB_TOPIC, payload)) {
    messageCount++;
    Serial.println("Telemetry published");
  } else {
    Serial.println("Telemetry publish failed");
  }
}

void processCommand(const String& payload) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    sendResponse("unknown", false, "Invalid JSON");
    return;
  }
  String command = doc["command"] | "";
  String requestId = doc["requestId"] | "";
  if (command.isEmpty() && doc["color"].is<String>()) command = "set_color";
  lastCommand = command;
  Serial.println("Command: " + command);

  if (command == "play") {
    wantPlayback = true;
    stopPending = false;
    restartPending = true;
    audioFailures = 0;
    audioFault = false;
    sendResponse(command, true, "Playback requested", requestId);
  } else if (command == "stop") {
    wantPlayback = false;
    restartPending = false;
    stopPending = true;
    audioFault = false;
    audioFailures = 0;
    sendResponse(command, true, "Stop requested", requestId);
  } else if (command == "set_station") {
    String url = doc["url"] | "";
    if (isPlaylistURL(url)) {
      Serial.println("Rejected playlist URL: " + url);
      sendResponse(command, false, "Playlist URL unsupported; provide direct HTTP MP3 stream", requestId);
      return;
    }
    if (!validStationURL(url)) {
      Serial.println("Rejected station URL: " + url);
      sendResponse(command, false, "Expected direct HTTP MP3 URL (max 400 chars)", requestId);
      return;
    }
    stationURL = url;
    wantPlayback = true;
    stopPending = false;
    restartPending = true;
    audioFault = false;
    audioFailures = 0;
    lastAudioError = "";
    sendResponse(command, true, "Station change requested", requestId);
  } else if (command == "set_volume") {
    if (!doc["volume"].is<int>()) {
      sendResponse(command, false, "Volume must be an integer", requestId);
      return;
    }
    int v = doc["volume"].as<int>();
    if (v < 0 || v > 100) {
      sendResponse(command, false, "Volume must be 0-100", requestId);
      return;
    }
    volume = v;
    if (output) output->SetGain(volume / 100.0f);
    sendResponse(command, true, "Volume updated", requestId);
  } else if (command == "set_brightness") {
    if (!doc["brightness"].is<int>()) {
      sendResponse(command, false, "Brightness must be an integer", requestId);
      return;
    }
    int v = doc["brightness"].as<int>();
    if (v < 0 || v > 100) {
      sendResponse(command, false, "Brightness must be 0-100", requestId);
      return;
    }
    setBrightness(v);
    sendResponse(command, true, "Brightness updated", requestId);
  } else if (command == "set_color") {
    bool ok = setBackgroundColor(doc["color"] | "");
    sendResponse(command, ok, ok ? "Color updated" : "Invalid color", requestId);
  } else if (command == "display_text") {
    if (!doc["text"].is<String>()) {
      sendResponse(command, false, "Text required", requestId);
      return;
    }
    String value = doc["text"].as<String>();
    if (value.length() > 200) {
      sendResponse(command, false, "Text too long", requestId);
      return;
    }
    displayMessage = value;
    screenMode = "message";
    sendResponse(command, true, "Text displayed", requestId);
  } else if (command == "set_screen") {
    String mode = doc["screen"] | "";
    if (mode != "status" && mode != "message") {
      sendResponse(command, false, "Invalid screen", requestId);
      return;
    }
    screenMode = mode;
    sendResponse(command, true, "Screen updated", requestId);
  } else if (command == "get_status") {
    publishStatus(requestId);
    sendResponse(command, true, "Status published", requestId);
  } else if (command == "reboot") {
    sendResponse(command, true, "Reboot scheduled", requestId);
    rebootPending = true;
    rebootAt = millis() + 1500;
  } else {
    sendResponse(command, false, "Unknown command", requestId);
  }
}

void mqttCallback(char*, byte* payload, unsigned int length) {
  if (length > 768) {
    Serial.println("MQTT command too large");
    return;
  }
  String message;
  message.reserve(length);
  for (unsigned int i = 0; i < length; i++) message += (char)payload[i];
  Serial.println("MQTT received: " + message);
  processCommand(message);
}

void connectWiFi() {
  prefs.begin("wifi-config", true);
  String ssid = prefs.getString("ssid", "");
  String password = prefs.getString("password", "");
  prefs.end();
  if (ssid.isEmpty()) {
    Serial.println("No saved WiFi credentials in wifi-config");
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), password.c_str());
  Serial.print("Connecting to WiFi");
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 15000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected: ");
    Serial.println(WiFi.localIP());
    configTime(0, 0, "pool.ntp.org", "time.google.com");
  } else {
    Serial.println("WiFi connection failed");
  }
}

void connectMQTT() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (time(nullptr) < 1700000000) {
    Serial.println("Waiting for NTP time sync");
    return;
  }
  Serial.println("Connecting to AWS IoT Core");
  if (mqtt.connect(THING_NAME)) {
    Serial.println("AWS MQTT connected");
    if (mqtt.subscribe(CMD_TOPIC)) Serial.println("Subscribed to commands");
    else Serial.println("MQTT subscribe failed");
    publishStatus();
  } else {
    Serial.printf("MQTT connection failed: %d\n", mqtt.state());
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32-C6 AWS Internet Radio (guarded playback)");
  gfx->begin();
  ledcAttach(LCD_BL, 5000, 8);
  setBrightness(brightness);
  drawScreen();
  secureClient.setCACert(AWS_ROOT_CA);
  secureClient.setCertificate(AWS_DEVICE_CERT);
  secureClient.setPrivateKey(AWS_PRIVATE_KEY);
  secureClient.setHandshakeTimeout(15);
  mqtt.setServer(AWS_IOT_ENDPOINT, 8883);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(1536);
  mqtt.setKeepAlive(60);
  mqtt.setSocketTimeout(3);
  connectWiFi();
  lastAudioAttempt = millis();
  if (WiFi.status() == WL_CONNECTED && !startRadio()) {
    recordAudioFailure(lastAudioError);
  }
  lastPublish = lastDisplay = lastWiFiAttempt = lastMQTTAttempt = millis();
}

void loop() {
  unsigned long now = millis();
  if (rebootPending && (int32_t)(now - rebootAt) >= 0) {
    stopRadio();
    Serial.flush();
    ESP.restart();
  }

  // The decoder must be serviced frequently. This timing check is diagnostic,
  // not a hard deadline: a blocking mp3->loop() cannot be preempted here.
  if (radioPlaying && mp3) {
    if (!mp3->isRunning()) {
      recordAudioFailure("Decoder stopped");
    } else {
      unsigned long started = millis();
      bool ok = mp3->loop();
      unsigned long elapsed = millis() - started;
      if (elapsed > 250) {
        Serial.printf("WARNING: mp3->loop() took %lu ms\n", elapsed);
      }
      if (!ok) recordAudioFailure("Decoder ended or stream read failed");
      else if (playbackStarted && millis() - playbackStarted >= AUDIO_STABLE_RESET_MS && audioFailures) {
        // Runtime is a heuristic, not proof of uninterrupted audible playback.
        audioFailures = 0;
      }
    }
  }

  if (stopPending) {
    stopPending = false;
    stopRadio();
  }
  if (restartPending) {
    restartPending = false;
    lastAudioAttempt = millis();
    if (wantPlayback && !startRadio()) recordAudioFailure(lastAudioError);
  }

  now = millis();
  if (WiFi.status() != WL_CONNECTED && now - lastWiFiAttempt >= WIFI_RETRY_MS) {
    lastWiFiAttempt = now;
    connectWiFi();
  }

  if (audioFault && now - cooldownStarted >= AUDIO_COOLDOWN_MS) {
    audioFault = false;
    audioFailures = 0;
    Serial.println("Audio cooldown complete");
  }

  if (wantPlayback && !radioPlaying && !restartPending && !audioFault &&
      WiFi.status() == WL_CONNECTED && now - lastAudioAttempt >= AUDIO_RETRY_MS) {
    lastAudioAttempt = now;
    if (!startRadio()) recordAudioFailure(lastAudioError);
  }

  now = millis();
  if (WiFi.status() == WL_CONNECTED && !mqtt.connected() && now - lastMQTTAttempt >= MQTT_RETRY_MS) {
    lastMQTTAttempt = now;
    connectMQTT();
  }
  if (mqtt.connected()) {
    mqtt.loop();
    if (millis() - lastPublish >= TELEMETRY_INTERVAL_MS) {
      lastPublish = millis();
      publishStatus();
    }
  }
  if (millis() - lastDisplay >= DISPLAY_INTERVAL_MS) {
    lastDisplay = millis();
    if (screenMode == "status") drawScreen();
  }
  delay(1);
}
