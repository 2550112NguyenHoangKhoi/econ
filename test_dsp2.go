package main

import (
	"fmt"
	"math"
	"econ/simulation"
)

func main() {
	cfg := simulation.DefaultCurrentDenoiseConfig()
	denoiser := simulation.NewCurrentDenoiser(cfg)
	
	// 5 cycles in 30 samples
	samples := make([]int, 30)
	for i := 0; i < 30; i++ {
		phase := float64(i) / 30.0 * 2.0 * math.Pi * 5.0
		val := 2048.0 + 29.1*math.Sin(phase) // 0.5A
		samples[i] = int(val)
	}
	amps := denoiser.ProcessWindow(samples)
	fmt.Printf("ProcessWindow for 0.5A sine wave: %f Amps\n", amps)
}
