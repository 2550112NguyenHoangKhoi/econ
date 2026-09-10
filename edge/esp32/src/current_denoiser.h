#pragma once

#include <cmath>
#include <vector>
#include <cstdint>
#include <cstdlib>
#include <algorithm>

// Configuration parameters for two-stage current sensor denoising
struct CurrentDenoiseConfig {
  float  calAPerV       = 15.0f;   // A/V sensitivity (ACS712-30A: 66.6 mV/A -> 15 A/V)
  float  dividerRatio   = 0.5f;    // 10k/10k voltage divider (halves ACS712 voltage swing)
  float  adcVref        = 3.3f;    // ESP32 ADC reference voltage (3.3V)
  float  adcMaxCounts   = 4095.0f; // 12-bit ADC resolution (4095 counts full scale)
  double noiseVariance = 300.0;   // ESP32 ADC intrinsic noise variance (~17.3 counts sigma)
  float  cutoffAmps     = 0.15f;   // Sub-threshold noise floor cutoff (<0.15A -> 0.0A)
  float  emaAlpha       = 0.35f;   // Inter-window EMA smoothing factor
  float  deadbandAmps   = 0.03f;   // Jitter deadband (holds steady reading within band)
};

class CurrentDenoiser {
public:
  explicit CurrentDenoiser(const CurrentDenoiseConfig& cfg = CurrentDenoiseConfig())
      : cfg_(cfg), filteredAmps_(0.0f), initialized_(false) {}

  // Process a discrete window of raw ADC sample counts (Stage 1 + Stage 2)
  float processWindow(const int* samples, int n) {
    if (samples == nullptr || n < 100) {
      return -1.0f; // Starvation guard: window must contain at least 100 samples
    }

    // Pass 1: Transient spike suppression and statistics for linear detrending
    std::vector<double> cleanSamples(n);
    double sum = 0.0;

    for (int i = 0; i < n; ++i) {
      double val = static_cast<double>(samples[i]);
      if (i > 0 && i < n - 1) {
        double prev = static_cast<double>(samples[i - 1]);
        double next = static_cast<double>(samples[i + 1]);
        double d1 = val - prev;
        double d2 = val - next;
        // Suppress isolated single-sample transient spikes exceeding 50 counts
        if ((d1 > 50.0 && d2 > 50.0) || (d1 < -50.0 && d2 < -50.0)) {
          val = 0.5 * (prev + next);
        }
      }
      cleanSamples[i] = val;
      sum += val;
    }

    // Effective acquisition rate for this window. When the caller has measured it, use that.
    // Otherwise fall back to "n samples span 100 ms", which is what every lag here assumed
    // implicitly before — so a caller that does not measure gets exactly the old behaviour
    // rather than a silently wrong one.
    const double fs = rateExplicit_ ? (double)sampleRateHz_ : ((double)n * 10.0);

    double mean = sum / n;

    // Linear detrending to eliminate intra-window dynamic DC offset drift:
    // Compute the slope via period-differencing to ensure zero attenuation on AC mains (50Hz / 60Hz) waveforms.
    int period50 = (int)std::round(fs / 50.0);
    int period60 = (int)std::round(fs / 60.0);
    if (period50 >= n) period50 = 0;
    if (period60 >= n) period60 = 0;
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

    // Pass 2: Linear detrending (subtracting y_i = mean + slope*(i - iMean)) and variance computation
    double sumSqDiff = 0.0;
    for (int i = 0; i < n; ++i) {
      double trend = mean + slope * (i - iMean);
      cleanSamples[i] -= trend;
      sumSqDiff += cleanSamples[i] * cleanSamples[i];
    }
    double variance = sumSqDiff / n;

    // Stage 1a: remove sub-mains DRIFT before measuring anything.
    //
    // Total-window variance answers "how much is this signal moving", which counts supply
    // wander and slow drift as current. On this node a real load measured variance 1999, of
    // which the genuine 50 Hz component was 11 counts while a 10 Hz wander was 48 — so the
    // RMS was mostly drift, and that drift also wrecked the autocorrelation gate, which then
    // discarded the load as noise.
    //
    // Rejecting a fixed set of mains bins was the obvious fix and the wrong one: it assumes
    // the frequency, and this channel has to survive generator drift (the suite exercises
    // 45 and 65 Hz), where the fundamental falls between bins and the reading collapses.
    // So target the fault instead of the signal. A 100 ms window puts bin k at k*10 Hz, and
    // nothing below ~30 Hz can be mains on any grid or generator. Subtract the energy in
    // bins 1-2 and every real fundamental survives wherever it sits, while the drift that
    // was swamping it does not. Parseval keeps this exact: bin energies sum to the variance.
    double driftEnergy = 0.0;
    // Bin 1 only (10 Hz). Extending this to bin 2 removed a little more real drift but also
    // clipped an off-bin fundamental's leakage: a 45 Hz generator sits at bin 4.5 and smears
    // into its neighbours, and taking bin 2 with it cost 3.2% accuracy there. One bin is
    // enough — it carried the bulk of the 48-count wander measured on this node — and it
    // leaves every plausible fundamental untouched.
    // Reject below ~15 Hz, expressed in bins: bin k sits at k*(fs/n) Hz, which only equals
    // k*10 Hz when the window happens to be exactly 100 ms — hence the rate, not a fixed
    // bin index.
    //
    // 15 Hz, not 30. A fundamental that falls between bins smears into its neighbours, and
    // a 45 Hz generator (bin 4.5 at these settings) leaks far enough down that reaching up
    // to 30 Hz starts eating real signal — it cost 6.6% accuracy on exactly that case. The
    // drift this exists to remove sat at 10 Hz, comfortably inside the tighter band.
    const int driftBins = (fs > 0.0) ? (int)std::floor(15.0 * (double)n / fs) : 1;
    for (int k = 1; k <= (driftBins < 1 ? 1 : driftBins); ++k) {
      if (k * 2 >= n) break;
      double re = 0.0, im = 0.0;
      const double w = 2.0 * M_PI * k / n;
      for (int i = 0; i < n; ++i) {
        re += cleanSamples[i] * std::cos(w * i);
        im += cleanSamples[i] * std::sin(w * i);
      }
      double amp = 2.0 * std::sqrt(re * re + im * im) / n;   // peak amplitude of this bin
      driftEnergy += 0.5 * amp * amp;                        // its variance contribution
    }
    lastDriftEnergy_ = driftEnergy;
    double deDrifted = (variance > driftEnergy) ? (variance - driftEnergy) : 0.0;

    // Stage 1b: intra-window noise variance subtraction, against a MEASURED floor.
    //
    // cfg_.noiseVariance is a configured prior and it has been wrong in both directions on
    // this hardware: 300 (sigma 17.3) put the plug channel's detection floor at 173 W, and
    // a hand-corrected 100 still sat at 109 W, while the quietest window this node actually
    // produces measures variance 5.1 (sigma 2.25). A constant cannot track a per-board,
    // per-installation property like an analog front end's noise, so identify it instead
    // and let the library value act only as a ceiling — the prior, not the answer.
    //
    // The running minimum is the right estimator: the quietest window a channel has ever
    // produced is an upper bound on its noise floor, and taking the minimum can only ever
    // under-subtract, never over-subtract. Under-subtracting is the safe direction, because
    // whatever survives still has to pass the mains-periodicity gate below before it can be
    // published as power.
    if (variance > 0.0 && variance < observedFloor_) observedFloor_ = variance;
    double effectiveNoiseVar = (observedFloor_ < cfg_.noiseVariance) ? observedFloor_
                                                                     : cfg_.noiseVariance;

    double signalVariance = (deDrifted > effectiveNoiseVar) ? (deDrifted - effectiveNoiseVar) : 0.0;
    double rmsCounts = std::sqrt(signalVariance);

    float divRatio = (cfg_.dividerRatio > 0.001f) ? cfg_.dividerRatio : 1.0f;
    float rawAmps = (float)(rmsCounts * (cfg_.adcVref / cfg_.adcMaxCounts) / divRatio * cfg_.calAPerV);

    // Keep the numbers that decided this window. noiseVariance is an ASSUMPTION about the
    // ADC, not a measurement of it: when the real input is quieter than the assumption
    // every load below sqrt(noiseVariance) counts RMS is subtracted to exactly zero, and
    // when it is noisier the residual is published as power that was never drawn. Neither
    // failure is visible from the output alone, so expose the inputs to the decision.
    lastMean_     = mean;
    lastVariance_ = variance;
    lastRawAmps_  = rawAmps;
    lastNoiseVar_ = effectiveNoiseVar;

    // Periodicity / Autocorrelation check:
    // Expand autocorrelation / normalized covariance check across small-to-moderate signals (< 1.50A).
    // Check both 50Hz (n / 10) and 60Hz (n / 12) half-period lags.
    // Real AC signals exhibit negative half-period normalized covariance (< -0.20),
    // whereas uncorrelated white noise or dynamic drift exhibits ~0.
    // Run this at EVERY amplitude. The old `rawAmps < 1.50f` bound meant the periodicity
    // test — the only check that asks whether a window looks like mains at all — was
    // skipped exactly where a false positive costs most. A single non-periodic excursion
    // (relay contact bounce, a loose clamp, ESD on a breadboard rail) lands above 1.5 A by
    // definition, bypassed the check untouched, and was published at full magnitude: this
    // node emitted "stripW":2442.7, i.e. 10.6 A through a power strip, on a channel the
    // twin treats as measured. A genuine large load is still strongly anti-correlated at
    // half a period, clipped motor inrush included, so it passes this gate unharmed.
    if (variance > 1e-6) {
      int halfPeriod50 = (int)std::round(fs / 100.0);   // half a 50 Hz cycle
      int halfPeriod60 = (int)std::round(fs / 120.0);   // half a 60 Hz cycle
      if (halfPeriod50 >= n) halfPeriod50 = 0;
      if (halfPeriod60 >= n) halfPeriod60 = 0;

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

      // Apply this at every amplitude, not just above 0.5 A. It is the only test here that
      // asks whether the window actually looks like mains current rather than merely
      // carrying enough energy: a 50/60 Hz waveform is anti-correlated with itself at half
      // a period (normCov ~ -0.5 even when the signal is only as large as the noise), while
      // ADC noise and thermal drift sit near 0. Exempting small signals removed the one
      // check that could tell a genuine 40 W load from a quiet window that happened to
      // fluctuate, and let 12 of 120 pure-noise windows publish current.
      //
      // The concern it was exempted for — small real signals being "buried in the noise
      // variance and artificially failing" — only bites when the signal is below the noise
      // floor, which is precisely when it must not be published as a measurement anyway.
      // Second, independent test: correlation at a FULL mains period, which must be
      // strongly POSITIVE for any repeating waveform.
      //
      // The half-period test above only recognises a sinusoid — it asks whether the signal
      // inverts itself every 10 ms, which is true of a sine and false of most real loads.
      // A power strip carries switch-mode supplies (laptop and phone chargers, LED drivers)
      // that draw current in narrow spikes near the voltage peak: unmistakably periodic,
      // heavily harmonic, and nothing like a sine. On this node such a load measured
      // normCov = -0.088 at half a period and was discarded as noise, while its spectrum
      // showed equal peaks at the 50 Hz fundamental and its second harmonic. Judging shape
      // instead of periodicity threw away precisely the loads this channel exists to meter.
      //
      // Correlating at the full period asks the question that actually matters — does this
      // window repeat at 50/60 Hz — and answers it for any waveform. White noise and slow
      // drift still score near zero, so nothing is loosened for real noise.
      double maxFullCov = -1.0;
      bool fullChecked = false;
      // Lags computed from the MEASURED sample rate, not from assuming the window spans
      // exactly one 100 ms period. n/5 is only "one 50 Hz cycle" if the window really is
      // 100 ms; when analogRead overruns its slot the window stretches, the lag points at
      // the wrong phase, and a genuine mains signal scores near zero and is discarded as
      // noise. That failure looks identical on every channel at once — which is exactly what
      // two independent sensors on the same conductor were showing.
      const int lag50 = (int)std::round(fs / 50.0);
      const int lag60 = (int)std::round(fs / 60.0);
      const int fullPeriods[2] = { (lag50 > 0 && lag50 < n) ? lag50 : 0,
                                   (lag60 > 0 && lag60 < n) ? lag60 : 0 };
      for (int p = 0; p < 2; ++p) {
        int lag = fullPeriods[p];
        if (lag <= 0 || lag >= n) continue;
        double covSum = 0.0;
        int cnt = n - lag;
        for (int i = 0; i < cnt; ++i) covSum += cleanSamples[i] * cleanSamples[i + lag];
        double nc = (covSum / cnt) / variance;
        if (!fullChecked || nc > maxFullCov) { maxFullCov = nc; fullChecked = true; }
      }
      lastFullPeriodCov_ = fullChecked ? maxFullCov : 0.0;

      // Accept on EITHER signature: a sine (anti-correlated at half a period) or any
      // periodic waveform (correlated at a full one). Reject only when both say no.
      bool looksSinusoidal = checked && minNormCov <= -0.20;
      bool looksPeriodic   = fullChecked && maxFullCov >= 0.30;
      if (!looksSinusoidal && !looksPeriodic) {
        rawAmps = 0.0f; // neither a sine nor periodic at mains -> not a load
      }
    }

    // Noise floor cutoff (< cutoffAmps -> 0.0A)
    float gatedAmps = (rawAmps < cfg_.cutoffAmps) ? 0.0f : rawAmps;

    // A gated-to-zero window means Stage 1 found no signal above the noise floor, and it
    // must publish zero immediately rather than decaying towards it. Feeding zero through
    // the EMA instead spreads one noise excursion across the following ~7 windows as a
    // 50 -> 39 -> 25 -> 16 W tail, and that tail travels on plugW/stripW, which are
    // measured channels: it is exactly the fabricated measurement the twin must never
    // emit. Resetting initialized_ also means the next genuine load appears at full value
    // on its first window instead of being dragged up from zero over several seconds.
    //
    // This costs nothing in small-signal sensitivity now that noiseVariance is measured
    // per channel rather than assumed: what gets through Stage 1 is real, and what does
    // not was never a load. Removing this was what made the host suite fail 6/28.
    if (gatedAmps == 0.0f) {
      filteredAmps_ = 0.0f;
      initialized_ = false;
      return 0.0f;
    }

    // Stage 2: Inter-window Exponential Moving Average with jitter deadband
    if (!initialized_) {
      filteredAmps_ = gatedAmps;
      initialized_ = true;
      return filteredAmps_;
    }

    // Always apply EMA smoothing (unless within deadband)
    if (std::abs(gatedAmps - filteredAmps_) > cfg_.deadbandAmps) {
      filteredAmps_ = cfg_.emaAlpha * gatedAmps + (1.0f - cfg_.emaAlpha) * filteredAmps_;
    }

    // Clean zero-snap AFTER smoothing
    if (filteredAmps_ < cfg_.cutoffAmps) {
      filteredAmps_ = 0.0f;
      initialized_ = false; // Reset so the next spike isn't dragged down
    }
    
    return filteredAmps_;
  }

  // Convenience overload for std::vector<int>
  float processWindow(const std::vector<int>& samples) {
    return processWindow(samples.data(), static_cast<int>(samples.size()));
  }

  // Statistical window processing when individual samples are not retained in RAM
  float processWindowStats(double sum, double sumSq, int n) {
    if (n < 100) {
      return -1.0f; // Starvation guard
    }

    double mean = sum / n;
    double variance = (sumSq / n) - (mean * mean);

    // Stage 1: Intra-window noise variance subtraction
    double signalVariance = (variance > cfg_.noiseVariance) ? (variance - cfg_.noiseVariance) : 0.0;
    double rmsCounts = std::sqrt(signalVariance);

    float divRatio = (cfg_.dividerRatio > 0.001f) ? cfg_.dividerRatio : 1.0f;
    float rawAmps = (float)(rmsCounts * (cfg_.adcVref / cfg_.adcMaxCounts) / divRatio * cfg_.calAPerV);
    float gatedAmps = (rawAmps < cfg_.cutoffAmps) ? 0.0f : rawAmps;

    if (gatedAmps == 0.0f) {   // see processWindow(): zero is published, never decayed towards
      filteredAmps_ = 0.0f;
      initialized_ = false;
      return 0.0f;
    }

    // Stage 2: Inter-window Exponential Moving Average with jitter deadband
    if (!initialized_) {
      filteredAmps_ = gatedAmps;
      initialized_ = true;
      return filteredAmps_;
    }

    if (std::abs(gatedAmps - filteredAmps_) > cfg_.deadbandAmps) {
      filteredAmps_ = cfg_.emaAlpha * gatedAmps + (1.0f - cfg_.emaAlpha) * filteredAmps_;
    }

    if (filteredAmps_ < cfg_.cutoffAmps) {
      filteredAmps_ = 0.0f;
      initialized_ = false;
    }
    
    return filteredAmps_;
  }

  void reset() {
    filteredAmps_ = 0.0f;
    initialized_ = false;
    observedFloor_ = 1e18;   // a re-identified channel must re-learn its floor
  }

  float getFilteredAmps() const { return filteredAmps_; }
  bool isInitialized() const { return initialized_; }

  // Diagnostics for the last processWindow() call: the detrended window's DC mean and
  // variance in ADC counts, and the amps recovered before gating and smoothing. Compare
  // lastVariance() against getConfig().noiseVariance to see which side of the noise-floor
  // subtraction a channel is sitting on.
  double lastMean() const { return lastMean_; }
  double lastVariance() const { return lastVariance_; }
  float  lastRawAmps() const { return lastRawAmps_; }
  // The noise variance actually subtracted, and the quietest window seen so far. Compare
  // against getConfig().noiseVariance to see whether the configured prior or the measured
  // floor is currently in force.
  double lastNoiseVariance() const { return lastNoiseVar_; }
  // Correlation at a full mains period for the last window: ~+1 for any periodic load,
  // ~0 for noise. This is what decides a non-sinusoidal load's fate.
  double lastFullPeriodCov() const { return lastFullPeriodCov_; }
  // Variance attributed to sub-mains drift (bin 1, i.e. ~10 Hz) and removed before
  // the reading was formed. Large values here mean the front end is wandering.
  double lastDriftEnergy() const { return lastDriftEnergy_; }
  double observedFloor() const { return observedFloor_; }

  void setCal(float cal) { cfg_.calAPerV = cal; }
  // Actual acquisition rate for the last window. Every lag and bin above derives from this;
  // leaving it at the nominal figure while the hardware ran slower is what made a real load
  // look aperiodic on both channels at once.
  void setSampleRateHz(float hz) { if (hz > 100.0f) { sampleRateHz_ = hz; rateExplicit_ = true; } }
  float sampleRateHz() const { return sampleRateHz_; }
  void setCalAPerV(float cal) { cfg_.calAPerV = cal; }
  void setNoiseVariance(double nv) { cfg_.noiseVariance = nv; }
  void setDividerRatio(float ratio) { cfg_.dividerRatio = ratio; }
  void setCutoffAmps(float cutoff) { cfg_.cutoffAmps = cutoff; }

  const CurrentDenoiseConfig& getConfig() const { return cfg_; }
  void setConfig(const CurrentDenoiseConfig& cfg) { cfg_ = cfg; }

private:
  CurrentDenoiseConfig cfg_;
  float filteredAmps_;
  bool initialized_;
  double lastMean_ = 0.0;
  double lastVariance_ = 0.0;
  float  lastRawAmps_ = 0.0f;
  double lastNoiseVar_ = 0.0;
  double lastFullPeriodCov_ = 0.0;
  double lastDriftEnergy_ = 0.0;
  float  sampleRateHz_ = 4000.0f;
  bool   rateExplicit_ = false;
  double observedFloor_ = 1e18;   // quietest window seen; identified, not configured
};
