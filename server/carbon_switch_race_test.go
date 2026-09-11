package main

import (
	"bytes"
	"econ/simulation"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestCarbonSnapshot_SurvivesBuildingSwitch reproduces a crash that killed the engine.
//
// carbonPersistLoop takes a sustainability snapshot on a timer. computeSpaceUtilization
// used to collect the zone ids from engine.Zones and then look each one up again — with
// no lock. ReloadBuilding replaces that whole map under e.mu when the operator switches
// building, so a switch landing between the two steps returned a nil *ZoneSim for every
// id that had just disappeared:
//
//	panic: runtime error: invalid memory address or nil pointer dereference
//	main.computeSpaceUtilization(...) /app/carbon.go:739
//	main.(*CarbonTracker).Snapshot(...)
//	main.carbonPersistLoop(...)
//
// Exit 2, no restart policy, whole process gone — triggered by nothing more exotic than
// clicking between the two building models a few times.
//
// Run with -race to also catch the concurrent map access this shared with.
func TestCarbonSnapshot_SurvivesBuildingSwitch(t *testing.T) {
	engine := simulation.NewEngine()
	store := NewStateStore(filepath.Join(t.TempDir(), "dashboard-state.json"), nil)
	switchHandler := buildingSwitchHandler(engine, store)
	tracker := newCarbonTracker(engine)

	switchTo := func(model string) {
		req := httptest.NewRequest(http.MethodPost, "/api/building/switch",
			bytes.NewBufferString(`{"model":"`+model+`"}`))
		req.Header.Set("Content-Type", "application/json")
		switchHandler.ServeHTTP(httptest.NewRecorder(), req)
	}

	// Prime it on the big building so there are plenty of ids to lose.
	switchTo("multi-level")

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Flip between a 735-zone tower and a 5-zone house as fast as the handler allows.
	wg.Add(1)
	go func() {
		defer wg.Done()
		models := []string{"domestic-home", "multi-level"}
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			switchTo(models[i%2])
		}
	}()

	// Meanwhile take snapshots, exactly as carbonPersistLoop does. Before the fix this
	// panicked within a handful of iterations and took the test binary with it.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = tracker.Snapshot(engine, time.Now())
		}
	}()

	time.Sleep(2 * time.Second)
	close(stop)
	wg.Wait()

	// Reaching here without panicking is the assertion. Confirm the engine is still
	// coherent rather than merely un-crashed.
	zones := engine.SnapshotZones()
	if len(zones) == 0 {
		t.Fatal("engine has no zones after the switch storm")
	}
	for id, z := range zones {
		if z == nil {
			t.Fatalf("zone %q is nil in a snapshot: SnapshotZones must never hand out nil entries", id)
		}
	}
}
