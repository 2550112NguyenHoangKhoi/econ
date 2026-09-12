import math
import random

def process_window(amplitudes_A):
    # Config
    calAPerV = 15.0
    dividerRatio = 0.5
    adcVref = 3.3
    adcMaxCounts = 4095.0
    noiseVariance = 300.0
    cutoffAmps = 0.02

    # ADC params
    counts_per_amp = (1.0 / calAPerV) * dividerRatio * (adcMaxCounts / adcVref)
    print(f"counts_per_amp = {counts_per_amp:.4f}")
    
    n = 1200
    # 60Hz over 100ms = 6 periods.
    # period = 200 samples. half_period = 100 samples.
    
    for test_amps in amplitudes_A:
        # RMS = test_amps
        # Peak = test_amps * sqrt(2)
        peak_counts = test_amps * math.sqrt(2) * counts_per_amp
        
        # generate samples
        samples = []
        for i in range(n):
            # 60 Hz sine wave
            val = peak_counts * math.sin(2 * math.pi * 6 * i / n)
            # add noise (sigma = sqrt(300) = 17.32)
            val += random.gauss(0, math.sqrt(noiseVariance))
            # add DC offset
            val += 2048.0
            samples.append(val)
            
        # calculate mean
        mean = sum(samples) / n
        
        # zero mean
        clean = [s - mean for s in samples]
        
        # variance
        variance = sum(s*s for s in clean) / n
        
        # signal variance
        signalVariance = variance - noiseVariance if variance > noiseVariance else 0
        rmsCounts = math.sqrt(signalVariance)
        
        rawAmps = rmsCounts / counts_per_amp
        
        # autocov
        half_period = 100
        cov_sum = 0
        for i in range(n - half_period):
            cov_sum += clean[i] * clean[i + half_period]
        
        normCov = (cov_sum / (n - half_period)) / variance
        
        snapped = False
        if rawAmps < 1.50 and variance > 1e-6:
            if normCov > -0.20:
                snapped = True
                
        print(f"Input: {test_amps:.3f} A -> rawAmps: {rawAmps:.3f} A, variance: {variance:.1f}, normCov: {normCov:.4f}, Snapped to 0: {snapped}")

process_window([0.05, 0.1, 0.15, 0.2, 0.21, 0.22, 0.25, 0.3, 0.5])
