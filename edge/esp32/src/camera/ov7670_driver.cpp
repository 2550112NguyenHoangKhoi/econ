
#include "ov7670_driver.h"
#if USE_CAMERA

#include <cstring>
#include <cstdlib>

#if defined(ESP32) && !defined(HOST_TEST)
#include <Arduino.h>
#include <Wire.h>
#include "esp_camera.h"
#endif

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

bool OV7670Driver::init() {
#if defined(ESP32) && !defined(HOST_TEST)
  // First, probe the OV7670 on I2C to see if it's physically present.
  // This avoids calling esp_camera_init() when no camera is attached,
  // which hangs indefinitely and triggers a watchdog reset.
  Wire.begin(PIN_CAM_SIOD, PIN_CAM_SIOC, 100000);
  Wire.beginTransmission(OV7670_I2C_ADDR); // 0x21
  uint8_t i2c_err = Wire.endTransmission();
  if (i2c_err != 0) {
    Serial.printf("[camera] OV7670 not found on I2C (addr=0x%02X, err=%d) -> Simulation Mode\n",
                  OV7670_I2C_ADDR, i2c_err);
    state_ = DRIVER_SIMULATION_MODE;
    hardware_present_ = false;
    mock_mode_ = true;
    return true;
  }
  Serial.println("[camera] OV7670 detected on I2C, initializing esp_camera...");

  camera_config_t config;
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
  config.pin_sccb_sda = PIN_CAM_SIOD;
  config.pin_sccb_scl = PIN_CAM_SIOC;
  config.pin_pwdn = -1;
  config.pin_reset = -1;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_GRAYSCALE;
  config.frame_size = FRAMESIZE_QQVGA; // 160x120
  config.jpeg_quality = 12;
  config.fb_count = 1;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[camera] esp_camera_init failed with error 0x%x -> Fallback to Simulation Mode\n", err);
    state_ = DRIVER_SIMULATION_MODE;
    hardware_present_ = false;
    mock_mode_ = true;
    return true;
  }
  
  Serial.println("[camera] esp_camera Initialized Successfully (QQVGA Grayscale 160x120)");
  state_ = DRIVER_HARDWARE_OK;
  hardware_present_ = true;
  mock_mode_ = false;
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
  last_capture_time_ms_ = 0;
#endif

  if (injected_frame_ != nullptr && injected_frame_len_ >= CAMERA_FRAME_BYTES) {
    memcpy(frame_buffer_, injected_frame_, CAMERA_FRAME_BYTES);
  } else if (mock_mode_ || state_ == DRIVER_SIMULATION_MODE) {
    generateSyntheticFrame();
  } else {
#if defined(ESP32) && !defined(HOST_TEST)
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[camera] Frame capture failed");
      generateSyntheticFrame();
    } else {
      if (fb->len <= sizeof(frame_buffer_)) {
      } else {
        Serial.printf("[camera] Size mismatch: fb->len=%d, expected=%d\n", fb->len, sizeof(frame_buffer_));
      }
      size_t copy_len = fb->len < sizeof(frame_buffer_) ? fb->len : sizeof(frame_buffer_);
      memcpy(frame_buffer_, fb->buf, copy_len);
      esp_camera_fb_return(fb);
    }
#endif
  }

  frame_counter_++;
  if (out_buffer != nullptr && max_len >= CAMERA_FRAME_BYTES) {
    memcpy(out_buffer, frame_buffer_, CAMERA_FRAME_BYTES);
  }
  return true;
}


void OV7670Driver::generateSyntheticFrame() {
  for (size_t i = 0; i < CAMERA_FRAME_BYTES; ++i) {
    frame_buffer_[i] = (uint8_t)(35 + (i % 5));
  }
}

// Stubs for functions that are no longer needed
bool OV7670Driver::initXclk(uint8_t pin, uint32_t freq_hz) { return true; }
bool OV7670Driver::initI2sDma() { return true; }
bool OV7670Driver::writeRegister(uint8_t reg, uint8_t val) { return true; }
bool OV7670Driver::readRegister(uint8_t reg, uint8_t& val) { return true; }
bool OV7670Driver::applyRegisterTable() { return true; }
void OV7670Driver::generateCheckerboardFrame() {}
void OV7670Driver::generateGradientFrame() {}
void OV7670Driver::generatePersonSilhouette() {}

#endif // USE_CAMERA
