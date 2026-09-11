package simulation

import (
	"strings"
	"testing"
)

func strPtr(s string) *string { return &s }

// acOn / acOff are expressed relative to the library's own threshold rather than as
// literals, so the test still means what it says if the coefficient is recalibrated.
func acOn() float64  { return Phys().AcRunningThresholdW * 2 }
func acOff() float64 { return Phys().AcRunningThresholdW / 2 }

func findRec(recs []Recommendation, id string) (Recommendation, bool) {
	for _, r := range recs {
		if r.Id == id {
			return r, true
		}
	}
	return Recommendation{}, false
}

// TestCapabilityGate_DropsAcAdviceWithoutEvidence is the case that motivated the gate: a
// vacant room whose AC state has never been reported by anything. The old pass emitted
// "Room Vacant but AC may be ON" here, which is a recommendation inferred from a missing
// measurement rather than from a present one.
func TestCapabilityGate_DropsAcAdviceWithoutEvidence(t *testing.T) {
	rec := Recommendation{Id: "vacant_ac:z1", Zone: "z1", Metric: "occupancy", Action: "turn_off_ac"}

	cases := map[string]ZoneCapability{
		"no node bound at all":     {},
		"node bound, AC unknown":   {NodeBound: true, NodeOnline: true},
		"node says AC not wired":   {NodeBound: true, NodeOnline: true, AcControlKnown: true, AcControlReal: false},
		"IR state never reported":  {NodeBound: true, NodeOnline: true, AcControlKnown: true, AcControlReal: true},
		"clamp says AC is not on":  {NodeBound: true, NodeOnline: true, AcControlKnown: true, AcControlReal: true, AcPowerLive: true, AcPowerW: acOff()},
		"clamp overrules stale IR": {NodeBound: true, NodeOnline: true, AcControlKnown: true, AcControlReal: true, AcPowerLive: true, AcPowerW: acOff(), IrState: strPtr("COOL_22")},
	}

	for name, zc := range cases {
		t.Run(name, func(t *testing.T) {
			out := applyActuationCapability([]Recommendation{rec}, map[string]ZoneCapability{"z1": zc})
			if len(out) != 0 {
				t.Fatalf("expected the AC recommendation to be withdrawn (%s), got %+v", name, out)
			}
		})
	}
}

// TestCapabilityGate_KeepsAcAdviceOnMeasuredEvidence: a clamp reading above the library's
// running threshold is positive evidence, and a confirmed IR path is a real remediation,
// so the card survives intact with its button.
func TestCapabilityGate_KeepsAcAdviceOnMeasuredEvidence(t *testing.T) {
	rec := Recommendation{Id: "vacant_ac:z1", Zone: "z1", Metric: "occupancy", Action: "turn_off_ac", Message: "vacant."}
	zc := ZoneCapability{
		NodeBound: true, NodeOnline: true,
		AcControlKnown: true, AcControlReal: true,
		AcPowerLive: true, AcPowerW: acOn(),
	}

	out := applyActuationCapability([]Recommendation{rec}, map[string]ZoneCapability{"z1": zc})
	got, ok := findRec(out, "vacant_ac:z1")
	if !ok {
		t.Fatalf("a measurably-running AC in a vacant room must still be reported, got %+v", out)
	}
	if got.Action != "turn_off_ac" {
		t.Fatalf("a wired IR path must keep its action, got %q", got.Action)
	}
	if got.Message != "vacant." {
		t.Fatalf("an actionable card must not be annotated, got %q", got.Message)
	}
}

// TestCapabilityGate_KeepsAcAdviceOnCommandedIrState: with no clamp on the circuit, the
// commanded IR state is the only evidence available — and it counts only because the node
// has confirmed those commands reach a real machine.
func TestCapabilityGate_KeepsAcAdviceOnCommandedIrState(t *testing.T) {
	rec := Recommendation{Id: "vacant_ac:z1", Zone: "z1", Metric: "occupancy", Action: "turn_off_ac"}
	zc := ZoneCapability{
		NodeBound: true, NodeOnline: true,
		AcControlKnown: true, AcControlReal: true,
		IrState: strPtr("COOL_22"),
	}

	out := applyActuationCapability([]Recommendation{rec}, map[string]ZoneCapability{"z1": zc})
	if got, ok := findRec(out, "vacant_ac:z1"); !ok || got.Action != "turn_off_ac" {
		t.Fatalf("a confirmed IR path reporting a non-OFF state is evidence, got %+v", out)
	}

	zc.IrState = strPtr("OFF")
	if out := applyActuationCapability([]Recommendation{rec}, map[string]ZoneCapability{"z1": zc}); len(out) != 0 {
		t.Fatalf("an AC the node reports as OFF must not be recommended off again, got %+v", out)
	}
}

// TestCapabilityGate_WithdrawsActionButKeepsMeasurement is the other half of the rule: the
// finding is measured and real, the remediation is not wired. Deleting the card would
// throw away a genuine measurement, so it keeps its evidence and loses its button.
func TestCapabilityGate_WithdrawsActionButKeepsMeasurement(t *testing.T) {
	t.Run("AC measurably running but no control path", func(t *testing.T) {
		rec := Recommendation{Id: "vacant_ac:z1", Zone: "z1", Metric: "occupancy", Action: "turn_off_ac", Message: "Room is vacant."}
		// A clamp is on the circuit and reads a running compressor; nothing can switch it.
		zc := ZoneCapability{NodeBound: true, NodeOnline: true, AcPowerLive: true, AcPowerW: acOn()}

		out := applyActuationCapability([]Recommendation{rec}, map[string]ZoneCapability{"z1": zc})
		got, ok := findRec(out, "vacant_ac:z1")
		if !ok {
			t.Fatalf("a measured waste must survive even when it cannot be acted on, got %+v", out)
		}
		if got.Action != "" {
			t.Fatalf("no wired IR path, so no action may be offered, got %q", got.Action)
		}
		if !strings.Contains(got.Message, "Room is vacant.") {
			t.Fatalf("the original finding must be preserved, got %q", got.Message)
		}
		if !strings.Contains(got.Message, "has not reported") {
			t.Fatalf("the message must name the missing hardware, got %q", got.Message)
		}
	})

	t.Run("CO2 measured but zone has no node", func(t *testing.T) {
		rec := Recommendation{Id: "co2:z1", Zone: "z1", Metric: "co2", Action: "purge", Message: "1400 ppm."}
		out := applyActuationCapability([]Recommendation{rec}, map[string]ZoneCapability{"z1": {}})
		got, ok := findRec(out, "co2:z1")
		if !ok {
			t.Fatalf("a live NDIR reading is a real finding regardless of actuation, got %+v", out)
		}
		if got.Action != "" {
			t.Fatalf("nothing can receive a purge command here, got %q", got.Action)
		}
		if !strings.Contains(got.Message, "1400 ppm.") || !strings.Contains(got.Message, "no edge node is bound") {
			t.Fatalf("expected the finding plus the reason, got %q", got.Message)
		}
	})

	t.Run("thermal prediction on an offline node", func(t *testing.T) {
		rec := Recommendation{Id: "predict-temp:z1", Zone: "z1", Metric: "temp", Kind: "prediction", Action: "cool", Message: "Breaches in 14 min."}
		zc := ZoneCapability{NodeBound: true, NodeOnline: false}
		out := applyActuationCapability([]Recommendation{rec}, map[string]ZoneCapability{"z1": zc})
		got, ok := findRec(out, "predict-temp:z1")
		if !ok || got.Action != "" {
			t.Fatalf("expected the prediction kept and its action withdrawn, got %+v", out)
		}
		if !strings.Contains(got.Message, "offline") {
			t.Fatalf("an offline node is a different fault from an absent one and must say so, got %q", got.Message)
		}
	})
}

// TestCapabilityGate_LeavesBuildingWideAdviceAlone: the pre-cool window and the load
// baseline are not per-zone actuations and have no node to check.
func TestCapabilityGate_LeavesBuildingWideAdviceAlone(t *testing.T) {
	recs := []Recommendation{
		{Id: "load:GLOBAL", Zone: "GLOBAL", Metric: "buildingLoadMw", Action: "precool", Message: "load high."},
		{Id: "advisory:z1", Zone: "z1", Metric: "temp", Action: "", Message: "drifting."},
	}
	out := applyActuationCapability(recs, map[string]ZoneCapability{"z1": {}})
	if len(out) != 2 {
		t.Fatalf("expected both advisories untouched, got %+v", out)
	}
	if out[0].Action != "precool" || out[0].Message != "load high." {
		t.Fatalf("building-wide advice must pass through unchanged, got %+v", out[0])
	}
	if out[1].Message != "drifting." {
		t.Fatalf("an already-advisory card needs no annotation, got %+v", out[1])
	}
}

// TestCapabilityGate_DropsUnknownZones: a recommendation naming a zone the engine no
// longer models cannot be checked, so nothing is asserted on its behalf.
func TestCapabilityGate_DropsUnknownZones(t *testing.T) {
	rec := Recommendation{Id: "co2:ghost", Zone: "ghost", Metric: "co2", Action: "purge"}
	if out := applyActuationCapability([]Recommendation{rec}, map[string]ZoneCapability{}); len(out) != 0 {
		t.Fatalf("expected an unknown zone's recommendation to be dropped, got %+v", out)
	}
}

// TestCapabilityGate_DoesNotAliasCallerSlice guards the ranked input the caller still
// holds: filtering must not write into it.
func TestCapabilityGate_DoesNotAliasCallerSlice(t *testing.T) {
	in := []Recommendation{
		{Id: "vacant_ac:z1", Zone: "z1", Metric: "occupancy", Action: "turn_off_ac"},
		{Id: "co2:z1", Zone: "z1", Metric: "co2", Action: "purge", Message: "1400 ppm."},
	}
	_ = applyActuationCapability(in, map[string]ZoneCapability{"z1": {}})
	if in[0].Id != "vacant_ac:z1" || in[1].Action != "purge" || in[1].Message != "1400 ppm." {
		t.Fatalf("the caller's slice was mutated: %+v", in)
	}
}
