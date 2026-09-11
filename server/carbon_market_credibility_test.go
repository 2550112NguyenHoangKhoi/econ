package main

import (
	"econ/simulation"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The panel rendered "Toucan Protocol BCT (CoinGecko) — $0.00 USD/tCO2e — LIVE", and used
// that as the best price to offset a carbon deficit against. The underlying fetch had
// genuinely succeeded: CoinGecko returned 0.00106119, the BCT token having decoupled from
// the tonne of CO2 it nominally represents. `price <= 0` let it through, IsLive was
// stamped, and the UI's two-decimal format turned it into a confident zero.
//
// These pin the rule: a number that parsed is not automatically a price.

func coingeckoServer(t *testing.T, usd float64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]map[string]float64{
			"toucan-protocol-base-carbon-tonne": {"usd": usd},
		})
	}))
}

// TestCarbonMarket_RejectsCollapsedTokenPrice is the exact observed failure.
func TestCarbonMarket_RejectsCollapsedTokenPrice(t *testing.T) {
	srv := coingeckoServer(t, 0.00106119)
	defer srv.Close()

	c := NewCarbonMarketClient(srv.URL, defaultMarketCacheTTL)

	quote, err := c.GetQuote()
	if err != nil {
		t.Fatalf("the client must degrade to a benchmark, not fail: %v", err)
	}
	if quote.IsLive {
		t.Fatalf("a $0.00106/tonne token price must not be reported as a LIVE market rate: %+v", quote)
	}
	if quote.SpotPricePerMetricTonUSD < simulation.CarbonMkt().MinCredibleSpotUsdPerTon {
		t.Fatalf("the fallback benchmark must itself be a credible price, got $%v",
			quote.SpotPricePerMetricTonUSD)
	}
	if want := simulation.CarbonMkt().FallbackSpotUsdPerTon; quote.SpotPricePerMetricTonUSD != want {
		t.Errorf("expected the library's benchmark $%v, got $%v", want, quote.SpotPricePerMetricTonUSD)
	}
}

// TestCarbonMarket_AcceptsACredibleQuote: the floor must not swallow real prices.
func TestCarbonMarket_AcceptsACredibleQuote(t *testing.T) {
	srv := coingeckoServer(t, 14.75)
	defer srv.Close()

	c := NewCarbonMarketClient(srv.URL, defaultMarketCacheTTL)

	quote, err := c.GetQuote()
	if err != nil {
		t.Fatalf("Quote: %v", err)
	}
	if !quote.IsLive {
		t.Fatalf("a credible fetched price must be reported live, got %+v", quote)
	}
	if quote.SpotPricePerMetricTonUSD != 14.75 {
		t.Fatalf("expected the fetched price through unmodified, got $%v", quote.SpotPricePerMetricTonUSD)
	}
}

// TestCarbonMarket_FloorIsReadFromTheLibrary guards rule 2: the coefficient lives in
// programme-library.json, not as a literal in carbon.go.
func TestCarbonMarket_FloorIsReadFromTheLibrary(t *testing.T) {
	cm := simulation.CarbonMkt()
	if cm.MinCredibleSpotUsdPerTon <= 0 {
		t.Fatal("the library must carry a credible-price floor")
	}
	if cm.FallbackSpotUsdPerTon < cm.MinCredibleSpotUsdPerTon {
		t.Fatalf("the fallback benchmark ($%v) must clear the floor ($%v), or the twin's own "+
			"last resort would be a price it refuses to believe from anyone else",
			cm.FallbackSpotUsdPerTon, cm.MinCredibleSpotUsdPerTon)
	}
}

// TestCarbonMarket_DeficitIsNeverPricedAtNothing is what the bug actually cost: with a
// ~zero spot price, offsetting any overshoot was quoted at $0.00.
func TestCarbonMarket_DeficitIsNeverPricedAtNothing(t *testing.T) {
	srv := coingeckoServer(t, 0.00106119)
	defer srv.Close()

	c := NewCarbonMarketClient(srv.URL, defaultMarketCacheTTL)
	quote, err := c.GetQuote()
	if err != nil {
		t.Fatalf("Quote: %v", err)
	}

	// 120 kgCO2e against a 50 kg budget: a real 70 kg deficit to offset.
	rec := CalculateOffsetRecommendation(120.0, 50.0, quote)
	if !rec.OverBudget {
		t.Fatalf("120 kg against a 50 kg budget is over budget: %+v", rec)
	}
	if rec.EstimatedCostUSD <= 0 {
		t.Fatalf("offsetting a real deficit must not be quoted as free: %+v", rec)
	}
	if strings.Contains(rec.Recommendation, "$0.00/tCO2e") {
		t.Errorf("the recommendation must not quote a zero rate: %q", rec.Recommendation)
	}
}
