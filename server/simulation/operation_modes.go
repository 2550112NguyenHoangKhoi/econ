package simulation

import (
	"strings"
)

// OperationMode defines whether the twin runs on mock/simulated or strictly real data.
type OperationMode int

const (
	ModeSimulation OperationMode = iota // Default mode: permits mock/simulated data
	ModeReal                            // Strict mode: requires genuine physical telemetry
)

// String returns the canonical lowercase string representation of an OperationMode.
func (m OperationMode) String() string {
	switch m {
	case ModeReal:
		return "real"
	default:
		return "simulation"
	}
}

// ParseOperationMode parses a string into an OperationMode.
func ParseOperationMode(s string) OperationMode {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "real", "mode_real", "modereal":
		return ModeReal
	default:
		return ModeSimulation
	}
}

// Mode returns the engine's current operation mode. Thread-safe.
func (e *Engine) Mode() OperationMode {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.mode
}

// SetMode updates the engine's operation mode. Thread-safe.
func (e *Engine) SetMode(m OperationMode) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.mode = m
}

// IsRealMode returns true if the engine is operating in ModeReal. Thread-safe.
func (e *Engine) IsRealMode() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.mode == ModeReal
}
