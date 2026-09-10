// -----------------------------------------------------------------------------
// ov7670_driver.h — OV7670 Camera Driver with I2S DMA & Hardware Simulation Fallback
//
// Manages:
// - Hardware 20 MHz XCLK generation via ESP32 LEDC PWM
// - SCCB / I2C register configuration & product ID verification (REG_PID == 0x76)
// - I2S0 DMA capture and line-by-line Y-channel extraction to 19.2 KB grayscale buffer
// - Graceful hardware absence detection and synthetic frame generation / test injection
// -----------------------------------------------------------------------------
#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "camera_config.h"

// Driver Lifecycle States
enum CameraDriverState {
  DRIVER_UNINITIALIZED    = 0,
  DRIVER_HARDWARE_OK      = 1,
  DRIVER_SIMULATION_MODE  = 2,
  DRIVER_ERROR            = 3
};

// Synthetic Test Patterns
enum SyntheticPattern {
  PATTERN_EMPTY_SCENE       = 0,
  PATTERN_SOLID_BLACK       = 1,
  PATTERN_SOLID_WHITE       = 2,
  PATTERN_SOLID_GRAY        = 3,
  PATTERN_GRADIENT          = 4,
  PATTERN_PERSON_SILHOUETTE = 5,
  PATTERN_CHECKERBOARD      = 6
};

class OV7670Driver {
public:
  OV7670Driver();
  ~OV7670Driver();

  // Lifecycle
  bool init();
  bool captureFrame(uint8_t* out_buffer, size_t max_len);

  // Buffer Accessor
  const uint8_t* getFrameBuffer() const { return frame_buffer_; }

  // Status Queries
  bool isHardwarePresent() const { return hardware_present_; }
  bool isMockMode() const { return mock_mode_; }

  // True only when the last captureFrame() copied bytes off the sensor. The driver falls
  // back to a synthetic frame when a grab fails, and a synthetic frame handed to an
  // occupancy model is a fabricated measurement wearing a real channel's clothes — the
  // stream must be able to refuse it rather than pass it off as a picture of the room.
  bool lastCaptureWasReal() const { return last_capture_real_; }
  CameraDriverState getState() const { return state_; }
  uint32_t getFrameCounter() const { return frame_counter_; }
  uint32_t getLastCaptureTimeMs() const { return last_capture_time_ms_; }

  // Simulation & Test Injection Controls
  void setMockMode(bool enable);
  void setMockPattern(SyntheticPattern pattern);
  void setMockPersonDetected(bool detected);
  void injectTestFrame(const uint8_t* raw_frame, size_t len);
  void clearInjectedFrame();

  // Register configuration table accessor (for test inspection)
  static const OV7670RegisterConfig* getInitRegisterTable(size_t* count);

  // Write that table to the sensor over SCCB. It has existed in this repo as data with no
  // caller since esp_camera replaced the hand-rolled driver; esp_camera configures OV7670
  // from its own generic profile instead, and that profile is what has been failing here.
  // Returns the number of registers successfully written, or -1 off-target.
  int applyInitRegisterTable();

private:
  bool writeSccb(uint8_t reg, uint8_t value);
public:

private:
  CameraDriverState state_;
  bool              hardware_present_;
  bool              mock_mode_;
  bool              last_capture_real_ = false;
  SyntheticPattern  mock_pattern_;
  bool              mock_person_active_;

  uint32_t          frame_counter_;
  uint32_t          last_capture_time_ms_;

  const uint8_t*    injected_frame_;
  size_t            injected_frame_len_;

  // Internal SRAM 19.2 KB Grayscale Frame Buffer (160 x 120)
  alignas(16) uint8_t frame_buffer_[CAMERA_FRAME_BYTES];

  // Helper generators
  void generateSyntheticFrame();
  void generatePersonSilhouette();
  void generateGradientFrame();
  void generateCheckerboardFrame();
};
