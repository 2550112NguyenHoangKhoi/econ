package main

import (
	"fmt"
	"math"
	"econ/simulation"
)

func main() {
	cfg := simulation.DefaultCurrentDenoiseConfig()
	denoiser := simulation.NewCurrentDenoiser(cfg)
	
	// Generate a perfect 50Hz sine wave over 100ms, decimated to 30 samples
	samples := make([]int, 30)
	for i := 0; i < 30; i++ {
		// 5 cycles in 30 samples
		phase := float64(i) / 30.0 * 2.0 * math.Pi * 5.0
		// 5 Amps RMS -> 292 counts peak. ADC mean is 2048.
		val := 2048.0 + 292.0*math.Sin(phase)
		samples[i] = int(val)
	}
	
	amps := denoiser.ProcessWindow(samples)
	fmt.Printf("ProcessWindow for 5A sine wave: %f Amps\n", amps)
}
