package simulation

// Recursive least squares — the estimator dynamics.go fits every room's physics with.
//
// Split out of dynamics.go because it is the only part of that file with no opinion about
// buildings: a general online least-squares recursion with exponential forgetting, a leak
// toward a prior, and an excitation gate. dynamics.go supplies the physics — which drivers
// go in the regressor and what the coefficients mean; this file supplies the arithmetic.

import "math"

// rlsState is a small recursive-least-squares estimator with exponential forgetting. It
// is the standard online system-identification recursion: exact least squares over all
// observations seen, updated in O(n²) per sample with no stored history. Exported fields
// so the whole learned state round-trips through JSON for persistence.
type rlsState struct {
	Theta  []float64 `json:"theta"` // fitted coefficients
	P      []float64 `json:"p"`     // n×n inverse-correlation matrix, row-major
	N      int       `json:"n"`     // observations folded in
	ResEma float64   `json:"res"`   // EMA of |residual|, the fit-quality readout
	// Skipped counts updates the excitation gate rejected, so the model can report how much
	// of the stream carried no identifying information.
	Skipped int `json:"skipped,omitempty"`
}

// excitedBy reports whether any driver has moved by at least one characteristic unit since
// the reference vector, and returns the drivers to remember when it has. cur and ref are
// parallel; scales gives each driver's unit of genuine movement.
func excitedBy(cur, ref, scales []float64) bool {
	if len(ref) != len(cur) {
		return true // nothing to compare against yet
	}
	for i := range cur {
		if math.Abs(cur[i]-ref[i]) >= scales[i] {
			return true
		}
	}
	return false
}

func newRLS(n int) *rlsState {
	s := &rlsState{Theta: make([]float64, n), P: make([]float64, n*n)}
	for i := 0; i < n; i++ {
		s.P[i*n+i] = dynamicsP0
	}
	return s
}

func (s *rlsState) dim() int { return len(s.Theta) }

// valid reports whether the estimator survived deserialization intact — a truncated or
// hand-edited state file must not be able to panic the engine.
func (s *rlsState) valid(n int) bool {
	return s != nil && len(s.Theta) == n && len(s.P) == n*n
}

func (s *rlsState) predict(x []float64) float64 {
	y := 0.0
	for i, xi := range x {
		y += s.Theta[i] * xi
	}
	return y
}

// update folds one (x, y) observation into the fit.
func (s *rlsState) update(x []float64, y float64, prior []float64) {
	n := s.dim()
	if len(x) != n || math.IsNaN(y) || math.IsInf(y, 0) {
		return
	}
	for _, xi := range x {
		if math.IsNaN(xi) || math.IsInf(xi, 0) {
			return
		}
	}

	// Px = P·x
	Px := make([]float64, n)
	for i := 0; i < n; i++ {
		sum := 0.0
		row := s.P[i*n : i*n+n]
		for j := 0; j < n; j++ {
			sum += row[j] * x[j]
		}
		Px[i] = sum
	}

	// info = xᵀ·P·x — how much this sample actually tells us. A near-zero value means the
	// regressors have not moved into any direction the estimator is still uncertain about.
	info := 0.0
	for i := 0; i < n; i++ {
		info += x[i] * Px[i]
	}
	// Forget only on informative samples (see dynamicsMinInfo): λ = 1 turns the update
	// into plain recursive least squares, which cannot inflate the covariance.
	lambda := dynamicsLambda
	if info < dynamicsMinInfo {
		lambda = 1.0
	}

	den := lambda + info
	if den < 1e-12 || math.IsNaN(den) || math.IsInf(den, 0) {
		return
	}

	err := y - s.predict(x)

	// θ ← θ + (P·x / denominator)·err
	for i := 0; i < n; i++ {
		s.Theta[i] += (Px[i] / den) * err
	}
	// P ← (P − P·x·xᵀ·P / denominator) / λ
	for i := 0; i < n; i++ {
		for j := 0; j < n; j++ {
			s.P[i*n+j] = (s.P[i*n+j] - Px[i]*Px[j]/den) / lambda
		}
	}

	// Backstop: bound the covariance magnitude, preserving its shape.
	trace := 0.0
	for i := 0; i < n; i++ {
		trace += s.P[i*n+i]
	}
	if trace > dynamicsMaxTraceP && trace > 0 {
		scale := dynamicsMaxTraceP / trace
		for i := range s.P {
			s.P[i] *= scale
		}
	}

	// Guard against a divergent update poisoning the estimator permanently.
	for i := 0; i < n; i++ {
		if math.IsNaN(s.Theta[i]) || math.IsInf(s.Theta[i], 0) {
			*s = *newRLS(n)
			return
		}
	}

	s.N++
	a := 1.0 / float64(s.N)
	if a < dynamicsResAlphaFloor {
		a = dynamicsResAlphaFloor
	}
	s.ResEma += a * (math.Abs(err) - s.ResEma)

	// Ridge leak toward the prior (see dynamicsLeak), weighted by how UNCERTAIN each
	// coefficient still is. P[i][i] is the estimator's own variance for coefficient i, so a
	// direction the data has pinned down leaks essentially not at all and keeps the room's
	// individually measured value, while a direction the data never constrained — the null
	// space collinearity leaves behind — relaxes to the prior instead of drifting.
	//
	// An unweighted leak was tried first and was wrong: it dragged well-determined values
	// toward the prior too, pulling a genuinely under-ventilated room's measured 0.5 ACH up
	// to 0.89 and hiding the very fault the model exists to find.
	if len(prior) == n {
		for i := 0; i < n; i++ {
			w := s.P[i*n+i] / dynamicsP0
			if w > 1 {
				w = 1
			} else if w < 0 {
				w = 0
			}
			s.Theta[i] += dynamicsLeak * w * (prior[i] - s.Theta[i])
		}
	}
}
