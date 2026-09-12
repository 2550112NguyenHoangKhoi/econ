#include <iostream>
#include <vector>
#include <cmath>
#include <random>

struct CurrentDenoiseConfig {
  float  calAPerV       = 15.0f;
  float  dividerRatio   = 0.5f;
  float  adcVref        = 3.3f;
  float  adcMaxCounts   = 4095.0f;
  double noiseVariance = 300.0;
  float  cutoffAmps     = 0.02f; // User lowered this to 0.02f
  float  emaAlpha       = 0.35f;
  float  deadbandAmps   = 0.03f;
};

class CurrentDenoiser {
public:
  explicit CurrentDenoiser(const CurrentDenoiseConfig& cfg = CurrentDenoiseConfig())
      : cfg_(cfg), filteredAmps_(0.0f), initialized_(false) {}

  float processWindow(const int* samples, int n, bool bypass_autocorr = false) {
    if (samples == nullptr || n < 100) return -1.0f;

    std::vector<double> cleanSamples(n);
    double sum = 0.0;
    for (int i = 0; i < n; ++i) {
      double val = static_cast<double>(samples[i]);
      if (i > 0 && i < n - 1) {
        double prev = static_cast<double>(samples[i - 1]);
        double next = static_cast<double>(samples[i + 1]);
        double d1 = val - prev;
        double d2 = val - next;
        if ((d1 > 50.0 && d2 > 50.0) || (d1 < -50.0 && d2 < -50.0)) {
          val = 0.5 * (prev + next);
        }
      }
      cleanSamples[i] = val;
      sum += val;
    }

    double mean = sum / n;
    int period50 = (n >= 20) ? (n / 5) : 0;
    int period60 = (n >= 24) ? static_cast<int>(std::round(n / 6.0)) : 0;
    double slope = 0.0;

    if (period50 > 0 && period50 < n) {
      double diffSum50 = 0.0;
      double diffSqSum50 = 0.0;
      int count50 = n - period50;
      for (int i = 0; i < count50; ++i) {
        double d = cleanSamples[i + period50] - cleanSamples[i];
        diffSum50 += d;
        diffSqSum50 += d * d;
      }
      double e50 = diffSqSum50 / count50;

      if (period60 > 0 && period60 < n) {
        double diffSum60 = 0.0;
        double diffSqSum60 = 0.0;
        int count60 = n - period60;
        for (int i = 0; i < count60; ++i) {
          double d = cleanSamples[i + period60] - cleanSamples[i];
          diffSum60 += d;
          diffSqSum60 += d * d;
        }
        double e60 = diffSqSum60 / count60;

        if (e60 < 0.7 * e50) {
          slope = (diffSum60 / count60) / period60;
        } else {
          slope = (diffSum50 / count50) / period50;
        }
      } else {
        slope = (diffSum50 / count50) / period50;
      }
    }

    double iMean = 0.5 * (n - 1);
    double sumSqDiff = 0.0;
    for (int i = 0; i < n; ++i) {
      double trend = mean + slope * (i - iMean);
      cleanSamples[i] -= trend;
      sumSqDiff += cleanSamples[i] * cleanSamples[i];
    }
    double variance = sumSqDiff / n;
    double signalVariance = (variance > cfg_.noiseVariance) ? (variance - cfg_.noiseVariance) : 0.0;
    double rmsCounts = std::sqrt(signalVariance);

    float divRatio = (cfg_.dividerRatio > 0.001f) ? cfg_.dividerRatio : 1.0f;
    float rawAmps = (float)(rmsCounts * (cfg_.adcVref / cfg_.adcMaxCounts) / divRatio * cfg_.calAPerV);

    bool autocorr_triggered = false;
    if (!bypass_autocorr && rawAmps < 1.50f && variance > 1e-6) {
      int halfPeriod50 = (n >= 10) ? (n / 10) : 0;
      int halfPeriod60 = (n >= 12) ? static_cast<int>(std::round(n / 12.0)) : 0;
      double minNormCov = 1.0;
      bool checked = false;
      if (halfPeriod50 > 0 && halfPeriod50 < n) {
        double covSum50 = 0.0;
        int covCount50 = n - halfPeriod50;
        for (int i = 0; i < covCount50; ++i) {
          covSum50 += cleanSamples[i] * cleanSamples[i + halfPeriod50];
        }
        double normCov50 = (covSum50 / covCount50) / variance;
        minNormCov = normCov50;
        checked = true;
      }
      if (halfPeriod60 > 0 && halfPeriod60 < n) {
        double covSum60 = 0.0;
        int covCount60 = n - halfPeriod60;
        for (int i = 0; i < covCount60; ++i) {
          covSum60 += cleanSamples[i] * cleanSamples[i + halfPeriod60];
        }
        double normCov60 = (covSum60 / covCount60) / variance;
        if (checked) {
          minNormCov = std::min(minNormCov, normCov60);
        } else {
          minNormCov = normCov60;
          checked = true;
        }
      }
      if (checked && minNormCov > -0.20) {
        rawAmps = 0.0f;
        autocorr_triggered = true;
      }
    }

    float gatedAmps = (rawAmps < cfg_.cutoffAmps) ? 0.0f : rawAmps;
    
    // Print internal state for analysis
    std::cout << "var=" << variance << " | sigVar=" << signalVariance << " | raw=" << rawAmps << " | auto=" << autocorr_triggered << " | gated=" << gatedAmps;

    if (gatedAmps == 0.0f) {
      filteredAmps_ = 0.0f;
      initialized_ = false;
      std::cout << " -> snapped to 0.0f\n";
      return 0.0f;
    }
    if (!initialized_) {
      filteredAmps_ = gatedAmps;
      initialized_ = true;
      std::cout << " -> initialized to " << filteredAmps_ << "\n";
      return filteredAmps_;
    }
    if (std::abs(gatedAmps - filteredAmps_) > cfg_.deadbandAmps) {
      filteredAmps_ = cfg_.emaAlpha * gatedAmps + (1.0f - cfg_.emaAlpha) * filteredAmps_;
      std::cout << " -> EMA applied: " << filteredAmps_ << "\n";
    } else {
      std::cout << " -> Deadband held: " << filteredAmps_ << "\n";
    }
    return filteredAmps_;
  }

private:
  CurrentDenoiseConfig cfg_;
  float filteredAmps_;
  bool initialized_;
};

int main() {
  std::mt19937 gen(42);
  std::normal_distribution<double> noise_dist(2000.0, std::sqrt(300.0));
  
  // Create a small 0.1A signal (60Hz)
  // A = 0.1, rms = A / ( (3.3/4095)/0.5 * 15 ) = 4.136
  double rms_counts = 0.1 / ( (3.3/4095.0)/0.5 * 15.0 );
  double peak_counts = rms_counts * std::sqrt(2.0);
  
  CurrentDenoiser denoiser;
  
  for(int window = 0; window < 10; ++window) {
    std::vector<int> samples(1200);
    for(int i = 0; i < 1200; ++i) {
      double t = i / 12000.0;
      double sig = peak_counts * std::sin(2.0 * M_PI * 60.0 * t);
      samples[i] = static_cast<int>(std::round(noise_dist(gen) + sig));
    }
    denoiser.processWindow(samples.data(), 1200);
  }
  
  // Now try an even smaller signal: 0.05A (assuming we bypass autocorr)
  std::cout << "\nTesting 0.05A signal without autocorr (bypassed)...\n";
  
  rms_counts = 0.05 / ( (3.3/4095.0)/0.5 * 15.0 );
  peak_counts = rms_counts * std::sqrt(2.0);
  
  for(int window = 0; window < 10; ++window) {
    std::vector<int> samples(1200);
    for(int i = 0; i < 1200; ++i) {
      double t = i / 12000.0;
      double sig = peak_counts * std::sin(2.0 * M_PI * 60.0 * t);
      samples[i] = static_cast<int>(std::round(noise_dist(gen) + sig));
    }
    // MANUALLY bypass autocorr
    // Just inject the logic without autocorr here by printing output
    // Wait, let's just observe what happens with it.
    denoiser.processWindow(samples.data(), 1200, true);
  }
  
  return 0;
}
