import numpy as np
import math

def simulate(n_windows=10000, signal_amp=0.05, noise_var=300):
    n_samples = 1200
    
    # Calculate rms counts for given signal_amp
    # A = rms * (3.3 / 4095) / 0.5 * 15
    # rms = A / ( (3.3/4095)/0.5 * 15 )
    factor = (3.3 / 4095) / 0.5 * 15.0
    signal_rms = signal_amp / factor
    signal_var = signal_rms**2
    
    total_var_expected = signal_var + noise_var
    
    # Simulate window variances (chi-squared distributed)
    # The sum of squared normal variables is chi-squared.
    # We can approximate with normal for large N
    std_dev_var = np.sqrt(2 * total_var_expected**2 / (n_samples - 1))
    
    simulated_vars = np.random.normal(total_var_expected, std_dev_var, n_windows)
    
    zeroes = np.sum(simulated_vars <= noise_var)
    return zeroes / n_windows * 100

print(f"0.05A zero rate: {simulate(signal_amp=0.05):.2f}%")
print(f"0.10A zero rate: {simulate(signal_amp=0.10):.2f}%")
print(f"0.20A zero rate: {simulate(signal_amp=0.20):.2f}%")
