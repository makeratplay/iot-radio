# ESP32-C6 firmware

Hardware: Waveshare ESP32-C6-LCD-1.47, MAX98357A I2S amplifier, speaker.
Existing Arduino sketch: MP3 streaming + AWS IoT Core MQTT + LCD.

## Pin assignments
- I2S: BCLK GPIO18, LRCLK GPIO19, DOUT GPIO20
- LCD: MOSI GPIO6, SCLK GPIO7, CS GPIO14, DC GPIO15, RST GPIO21, BL GPIO22

## Integration
1. Copy the latest **working** combined Arduino sketch into `firmware/src/main.ino` locally. That source is not present in this repository and must not be reconstructed from partial conversation excerpts.
2. Remove all hardcoded credentials; keep cert/key material in a gitignored local header or device provisioning storage.
3. Set MQTT client ID to the IoT Thing name (e.g. `radio-demo001`).
4. Replace legacy topic `esp32/demo/commands` with `radio/<thingName>/commands`, and likewise telemetry/responses.
5. On play/stop/station/volume changes, publish a Device Shadow reported state update to `$aws/things/<thingName>/shadow/update`.
6. Include `requestId` in command responses to correlate web UI actions.
7. Keep audio streams direct to stations. Validate URL and enforce connect/read timeouts, playlist resolution, and decoder recovery before enabling arbitrary URLs.

The firmware folder intentionally contains a protocol contract instead of an untested replacement for your already-working radio sketch.
