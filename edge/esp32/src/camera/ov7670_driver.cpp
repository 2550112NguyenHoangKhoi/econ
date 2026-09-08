
#include "ov7670_driver.h"
#if USE_CAMERA

#include <cstring>
#include <cstdlib>

#if defined(ESP32) && !defined(HOST_TEST)
#include <Arduino.h>
#include <Wire.h>
#include "esp_camera.h"
#else
#include <chrono>
static inline uint32_t getHostMillis() {
  static auto start = std::chrono::steady_clock::now() - std::chrono::milliseconds(1000);
  auto now = std::chrono::steady_clock::now();
  return (uint32_t)std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count();
}
#endif

// Complete OV7670 QQVGA Grayscale / YUV Initialization Register Table
static const OV7670RegisterConfig kOV7670_QQVGA_InitRegs[] = {
  // 1. Soft Reset
  {OV7670_REG_COM7, 0x80},
  {OV7670_REG_DELAY_TOKEN, 5}, // 5 ms stabilization delay

  // 2. Clock setup (20 MHz XCLK -> ~15 fps)
  {OV7670_REG_CLKRC, 0x03}, // Prescaler /4 -> 2.5 MHz internal clock
  {OV7670_REG_DBLV, 0x4A},  // PLL bypass / disabled

  // 3. Output Format: YUV 4:2:2 Full Range
  {OV7670_REG_COM7, 0x00},  // YUV format, VGA base
  {OV7670_REG_COM15, 0xC0}, // YUV full range [0, 255]
  {OV7670_REG_TSLB, 0x04},  // YUYV sequence, auto window enable

  // 4. QQVGA Windowing & DCW Downsampling (640x480 -> 160x120)
  {OV7670_REG_COM3, 0x0C},  // Scale enable + DCW enable
  {OV7670_REG_COM14, 0x1A}, // DCW manual + PCLK divider /4
  {OV7670_REG_SCALING_XSC, 0x3A}, // Horizontal scale
  {OV7670_REG_SCALING_YSC, 0x35}, // Vertical scale
  {OV7670_REG_SCALING_DCWCTR, 0x22}, // Downsample /4 horizontal & vertical
  {OV7670_REG_SCALING_PCLK_DIV, 0x02}, // Clock divider /4

  // 5. Hardware Timing & Edge Control
  {OV7670_REG_COM10, 0x20}, // PCLK reverse, gated PCLK
  {OV7670_REG_HSTART, 0x16},
  {OV7670_REG_HSTOP, 0x04},
  {OV7670_REG_HREF, 0x24},
  {OV7670_REG_VSTART, 0x02},
  {OV7670_REG_VSTOP, 0x7A},
  {OV7670_REG_VREF, 0x0A},

  // 6. Automatic Image Quality Controls (AEC, AGC, AWB)
  {OV7670_REG_COM8, 0xE7}, // Fast AEC/AGC, Banding filter, AWB enable
  {OV7670_REG_GAIN, 0x00}, // AGC gain base
  {OV7670_REG_AECH, 0x00}, // Exposure base
  {OV7670_REG_COM9, 0x18}, // 4x AGC ceiling
  {OV7670_REG_AEW, 0x95},  // AGC upper threshold
  {OV7670_REG_AEB, 0x33},  // AGC lower threshold
  {OV7670_REG_VPT, 0xE3},  // Fast AGC control

  // End Token
  {OV7670_REG_DELAY_TOKEN, OV7670_REG_DELAY_TOKEN}
};

const OV7670RegisterConfig* OV7670Driver::getInitRegisterTable(size_t* count) {
  if (count) {
    *count = sizeof(kOV7670_QQVGA_InitRegs) / sizeof(kOV7670_QQVGA_InitRegs[0]);
  }
  return kOV7670_QQVGA_InitRegs;
}

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
  Wire.setTimeOut(100);
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
  last_capture_time_ms_ = getHostMillis();
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
      if (fb->len > sizeof(frame_buffer_)) {
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

void OV7670Driver::setMockMode(bool enable) {
  mock_mode_ = enable;
  if (enable && state_ == DRIVER_HARDWARE_OK) {
    state_ = DRIVER_SIMULATION_MODE;
  } else if (!enable && hardware_present_) {
    state_ = DRIVER_HARDWARE_OK;
  }
}

void OV7670Driver::setMockPattern(SyntheticPattern pattern) {
  mock_pattern_ = pattern;
  if (pattern == PATTERN_PERSON_SILHOUETTE) {
    mock_person_active_ = true;
  } else if (pattern == PATTERN_EMPTY_SCENE) {
    mock_person_active_ = false;
  }
}

void OV7670Driver::setMockPersonDetected(bool detected) {
  mock_person_active_ = detected;
  mock_pattern_ = detected ? PATTERN_PERSON_SILHOUETTE : PATTERN_EMPTY_SCENE;
}

void OV7670Driver::injectTestFrame(const uint8_t* raw_frame, size_t len) {
  injected_frame_ = raw_frame;
  injected_frame_len_ = len;
}

void OV7670Driver::clearInjectedFrame() {
  injected_frame_ = nullptr;
  injected_frame_len_ = 0;
}

void OV7670Driver::generateSyntheticFrame() {
  if (mock_person_active_ || mock_pattern_ == PATTERN_PERSON_SILHOUETTE) {
    generatePersonSilhouette();
    return;
  }

  switch (mock_pattern_) {
    case PATTERN_SOLID_BLACK:
      memset(frame_buffer_, 0, sizeof(frame_buffer_));
      break;
    case PATTERN_SOLID_WHITE:
      memset(frame_buffer_, 255, sizeof(frame_buffer_));
      break;
    case PATTERN_SOLID_GRAY:
      memset(frame_buffer_, 128, sizeof(frame_buffer_));
      break;
    case PATTERN_GRADIENT:
      generateGradientFrame();
      break;
    case PATTERN_CHECKERBOARD:
      generateCheckerboardFrame();
      break;
    case PATTERN_EMPTY_SCENE:
    default: {
      // Generate uniform ambient scene (intensity ~35 with minor noise)
      for (size_t i = 0; i < CAMERA_FRAME_BYTES; ++i) {
        frame_buffer_[i] = (uint8_t)(35 + (i % 5));
      }
      break;
    }
  }
}

void OV7670Driver::generatePersonSilhouette() {
  // 1. Ambient Background (intensity ~30)
  for (size_t i = 0; i < CAMERA_FRAME_BYTES; ++i) {
    frame_buffer_[i] = (uint8_t)(30 + (i % 4));
  }

  // 2. High-Contrast Center Humanoid Silhouette (Center of 160x120: X~80, Y~60)
  // Head Oval: Y in [30..50], X in [70..90] -> intensity 220
  for (int y = 30; y <= 50; ++y) {
    for (int x = 70; x <= 90; ++x) {
      int dx = x - 80;
      int dy = y - 40;
      if (dx * dx + dy * dy <= 100) {
        frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = 220;
      }
    }
  }

  // Torso Rectangle: Y in [51..90], X in [65..95] -> intensity 200
  for (int y = 51; y <= 90; ++y) {
    for (int x = 65; x <= 95; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = 200;
    }
  }

  // Legs: Y in [91..115], X in [68..76] and [84..92] -> intensity 180
  for (int y = 91; y <= 115; ++y) {
    for (int x = 68; x <= 76; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = 180;
    }
    for (int x = 84; x <= 92; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = 180;
    }
  }
}

void OV7670Driver::generateGradientFrame() {
  for (int y = 0; y < CAMERA_FRAME_HEIGHT; ++y) {
    for (int x = 0; x < CAMERA_FRAME_WIDTH; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = (uint8_t)((x + y + frame_counter_) % 256);
    }
  }
}

void OV7670Driver::generateCheckerboardFrame() {
  for (int y = 0; y < CAMERA_FRAME_HEIGHT; ++y) {
    for (int x = 0; x < CAMERA_FRAME_WIDTH; ++x) {
      frame_buffer_[y * CAMERA_FRAME_WIDTH + x] = ((x ^ y) & 1) ? 255 : 0;
    }
  }
}

#endif // USE_CAMERA
