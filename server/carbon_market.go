package main

import (
	"context"
	"econ/simulation"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"sync"
	"time"
)

// Voluntary carbon market — what offsetting the building's overshoot would cost.
//
// Split out of carbon.go because it is the one part of sustainability accounting that
// leaves the machine. Everything else there is arithmetic on the building's own measured
// energy; this talks to an external price feed, and therefore has to answer for staleness,
// timeouts, unparseable bodies and the difference between a live quote and a fallback. The
// `IsLive` flag on every quote exists so nothing downstream can present a hardcoded
// reference price as a market observation.

type CarbonCreditRecommendationsData struct {
	CarbonBudgetKgCO2e      float64       `json:"carbonBudgetKgCO2e"`
	CurrentEmissionsKgCO2e  float64       `json:"currentEmissionsKgCO2e"`
	OverBudget              bool          `json:"overBudget"`
	DeficitKgCO2e           float64       `json:"deficitKgCO2e"`
	CreditsNeededMetricTons float64       `json:"creditsNeededMetricTons"`
	WholeCertificatesNeeded int           `json:"wholeCertificatesNeeded"`
	MarketQuote             MarketQuote   `json:"marketQuote"`
	AlternativeQuotes       []MarketQuote `json:"alternativeQuotes"`
	EstimatedCostUSD        float64       `json:"estimatedCostUSD"`
	Recommendation          string        `json:"recommendation"`
}

type MarketQuote struct {
	Source                   string  `json:"source"`
	SpotPricePerMetricTonUSD float64 `json:"spotPricePerMetricTonUSD"`
	Currency                 string  `json:"currency"`
	IsLive                   bool    `json:"isLive"`
	FetchedAt                string  `json:"fetchedAt"`
	URL                      string  `json:"url,omitempty"`
}

// sustainabilityState represents the persisted state across server restarts.
type sustainabilityState struct {
	BuildingId            string             `json:"buildingId"`
	CumulativeEmissionsKg float64            `json:"cumulativeEmissionsKg"`
	EquipmentRuntimeHours map[string]float64 `json:"equipmentRuntimeHours"`
}

// CalculateScope2Emissions translates electrical energy into kgCO2e using the exact integration formula:
// E_kWh = (P_watts * dt_seconds) / 3.6e6
// kgCO2e = E_kWh * gridFactor
func CalculateScope2Emissions(powerW float64, dtSec float64, gridFactor float64) (energyKwh float64, kgCO2e float64) {
	energyKwh = (powerW * dtSec) / 3.6e6
	kgCO2e = energyKwh * gridFactor
	return energyKwh, kgCO2e
}

// CalculateOffsetRecommendation compares cumulative emissions against a carbon budget and produces
// recommendations including metric tons, whole certificates (ceiling), and estimated cost.
func CalculateOffsetRecommendation(cumulativeEmissionsKg float64, budgetKg float64, quote MarketQuote) CarbonCreditRecommendationsData {
	rec := CarbonCreditRecommendationsData{
		CarbonBudgetKgCO2e:     budgetKg,
		CurrentEmissionsKgCO2e: math.Round(cumulativeEmissionsKg*100.0) / 100.0,
		MarketQuote:            quote,
		AlternativeQuotes: []MarketQuote{
			{
				Source:                   "Gold Standard VERs",
				SpotPricePerMetricTonUSD: 18.50,
				Currency:                 "USD",
				IsLive:                   false,
				FetchedAt:                time.Now().UTC().Format(time.RFC3339),
				URL:                      "https://www.goldstandard.org/",
			},
			{
				Source:                   "Puro.earth CORCs (Biochar)",
				SpotPricePerMetricTonUSD: 140.00,
				Currency:                 "USD",
				IsLive:                   false,
				FetchedAt:                time.Now().UTC().Format(time.RFC3339),
				URL:                      "https://puro.earth/",
			},
			{
				Source:                   "Moss.Earth MCO2",
				SpotPricePerMetricTonUSD: 8.75,
				Currency:                 "USD",
				IsLive:                   false,
				FetchedAt:                time.Now().UTC().Format(time.RFC3339),
				URL:                      "https://moss.earth/",
			},
			{
				Source:                   "Verra VCS (Verified Carbon Standard)",
				SpotPricePerMetricTonUSD: 14.20,
				Currency:                 "USD",
				IsLive:                   false,
				FetchedAt:                time.Now().UTC().Format(time.RFC3339),
				URL:                      "https://verra.org/",
			},
			{
				Source:                   "Climate Action Reserve (CAR)",
				SpotPricePerMetricTonUSD: 16.80,
				Currency:                 "USD",
				IsLive:                   false,
				FetchedAt:                time.Now().UTC().Format(time.RFC3339),
				URL:                      "https://www.climateactionreserve.org/",
			},
			{
				Source:                   "South Pole (Nature-Based)",
				SpotPricePerMetricTonUSD: 22.00,
				Currency:                 "USD",
				IsLive:                   false,
				FetchedAt:                time.Now().UTC().Format(time.RFC3339),
				URL:                      "https://www.southpole.com/",
			},
		},
	}

	if cumulativeEmissionsKg > budgetKg {
		rec.OverBudget = true
		deficit := cumulativeEmissionsKg - budgetKg
		rec.DeficitKgCO2e = math.Round(deficit*100.0) / 100.0
		tons := deficit / 1000.0
		rec.CreditsNeededMetricTons = math.Round(tons*10000.0) / 10000.0
		whole := int(math.Ceil(tons))
		if whole < 1 {
			whole = 1
		}
		rec.WholeCertificatesNeeded = whole
		rec.EstimatedCostUSD = math.Round((tons*quote.SpotPricePerMetricTonUSD)*1000.0) / 1000.0
		certWord := "certificate"
		if whole > 1 {
			certWord = "certificates"
		}
		rec.Recommendation = fmt.Sprintf("Purchase %d carbon credit %s (~%.4f tCO2e deficit) at $%.2f/tCO2e to offset emissions. You can purchase these credits via our integrated Toucan Protocol exchange, or explore verified alternative registries like Gold Standard and Verra below. Click the external links on each quote to open the corresponding marketplace and complete your purchase.",
			whole, certWord, rec.CreditsNeededMetricTons, quote.SpotPricePerMetricTonUSD)
	} else {
		rec.OverBudget = false
		rec.DeficitKgCO2e = 0.0
		rec.CreditsNeededMetricTons = 0.0
		rec.WholeCertificatesNeeded = 0
		rec.EstimatedCostUSD = 0.0
		rec.Recommendation = fmt.Sprintf("Emissions (%.2f kgCO2e) are within target budget (%.2f kgCO2e). No carbon offset purchase required.",
			rec.CurrentEmissionsKgCO2e, budgetKg)
	}
	return rec
}

// fallbackSpotPrice reads the benchmark from the programme library, falling back to the
// compiled constant only if the library carries no value.
func fallbackSpotPrice() float64 {
	if p := simulation.CarbonMkt().FallbackSpotUsdPerTon; p > 0 {
		return p
	}
	return defaultMarketFallbackPrice
}

// CarbonMarketClient queries live carbon market spot prices with in-memory caching and graceful fallback.
type CarbonMarketClient struct {
	mu            sync.RWMutex
	apiURL        string
	httpClient    *http.Client
	cachedQuote   *MarketQuote
	cacheExpiry   time.Time
	cacheTTL      time.Duration
	fallbackPrice float64
}

// NewCarbonMarketClient constructs an outbound carbon market client.
func NewCarbonMarketClient(apiURL string, ttl time.Duration) *CarbonMarketClient {
	if apiURL == "" {
		apiURL = defaultCarbonMarketURL
	}
	if ttl <= 0 {
		ttl = defaultMarketCacheTTL
	}
	return &CarbonMarketClient{
		apiURL:        apiURL,
		httpClient:    &http.Client{Timeout: defaultHTTPTimeout},
		cacheTTL:      ttl,
		fallbackPrice: fallbackSpotPrice(),
	}
}

// ClearCache invalidates any currently cached market quote.
func (c *CarbonMarketClient) ClearCache() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cachedQuote = nil
	c.cacheExpiry = time.Time{}
}

// SetHTTPClient allows configuring a custom http.Client (e.g. mockServer.Client() in unit tests).
func (c *CarbonMarketClient) SetHTTPClient(client *http.Client) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if client != nil {
		c.httpClient = client
	}
}

// GetQuote returns the current carbon market quote. It checks the in-memory cache first,
// and if expired or missing, performs an outbound HTTP GET. If the outbound call fails,
// it gracefully returns the default fallback benchmark without panicking.
func (c *CarbonMarketClient) GetQuote() (MarketQuote, error) {
	// In-memory sync.RWMutex read check
	c.mu.RLock()
	if c.cachedQuote != nil && time.Now().Before(c.cacheExpiry) {
		quote := *c.cachedQuote
		c.mu.RUnlock()
		return quote, nil
	}
	c.mu.RUnlock()

	// Cache expired or empty; acquire write lock
	c.mu.Lock()
	defer c.mu.Unlock()

	// Double check after acquiring write lock
	if c.cachedQuote != nil && time.Now().Before(c.cacheExpiry) {
		return *c.cachedQuote, nil
	}

	targetURL := c.apiURL
	if envURL := os.Getenv("CARBON_MARKET_URL"); envURL != "" {
		targetURL = envURL
	}

	// Demonstrable outbound HTTP request log per requirement R3
	log.Printf("[carbon-market] outbound HTTP GET %s", targetURL)

	quote, err := c.fetchPrice(targetURL)
	if err != nil {
		log.Printf("[carbon-market] outbound fetch failed (%v); using fallback $%.2f/ton", err, c.fallbackPrice)
		fallback := MarketQuote{
			Source:                   "Toucan Protocol BCT (CoinGecko) [Fallback]",
			SpotPricePerMetricTonUSD: c.fallbackPrice,
			Currency:                 "USD",
			IsLive:                   false,
			FetchedAt:                time.Now().UTC().Format(time.RFC3339),
		}
		return fallback, nil
	}

	c.cachedQuote = &quote
	c.cacheExpiry = time.Now().Add(c.cacheTTL)
	return quote, nil
}

func (c *CarbonMarketClient) fetchPrice(targetURL string) (MarketQuote, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultHTTPTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return MarketQuote{}, err
	}
	req.Header.Set("User-Agent", "econ-sustainability/1.0")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return MarketQuote{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return MarketQuote{}, fmt.Errorf("unexpected HTTP status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return MarketQuote{}, err
	}

	price, err := parseMarketPrice(body)
	if err != nil {
		return MarketQuote{}, err
	}

	if price <= 0 || math.IsNaN(price) || math.IsInf(price, 0) {
		return MarketQuote{}, fmt.Errorf("invalid spot price: %v", price)
	}

	// A number that parsed is not yet a carbon price. The feed reads the Toucan BCT token,
	// nominally one token per tonne of CO2 -- but the token has decoupled from the credit
	// it represents, and CoinGecko answered $0.00106/tonne. That passed `price <= 0`, was
	// stamped IsLive, and reached the panel as a LIVE market rate of "$0.00" (the UI
	// formats to cents), then became the best price the offset cost was computed against.
	// Any deficit would have been priced at nothing.
	//
	// So the quote is checked against the floor the library carries with its reasoning. A
	// figure below it means the token has decoupled or the feed changed shape -- either
	// way the twin does not know the price, and the fallback path says so with IsLive
	// false rather than presenting a fabricated one. This is rule 1 on the market channel:
	// an unavailable price must not travel as a measured one.
	if floor := simulation.CarbonMkt().MinCredibleSpotUsdPerTon; floor > 0 && price < floor {
		return MarketQuote{}, fmt.Errorf(
			"quote $%.6f/ton is below the $%.2f credible floor -- the BCT token has decoupled from the credit it represents, so this is not a carbon price",
			price, floor)
	}

	log.Printf("[carbon-market] live carbon spot price fetched: $%.2f/ton", price)
	return MarketQuote{
		Source:                   "Toucan Protocol BCT (CoinGecko)",
		SpotPricePerMetricTonUSD: price,
		Currency:                 "USD",
		IsLive:                   true,
		FetchedAt:                time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func parseMarketPrice(body []byte) (float64, error) {
	// 1. CoinGecko nested format: {"toucan-protocol-base-carbon-tonne": {"usd": 12.50}}
	var nested map[string]map[string]float64
	if err := json.Unmarshal(body, &nested); err == nil && len(nested) > 0 {
		for _, v := range nested {
			if usd, ok := v["usd"]; ok && usd > 0 {
				return usd, nil
			}
		}
	}

	// 2. Flat format: {"usd": 12.50} or {"price": 12.50} or {"spotPricePerMetricTonUSD": 12.50}
	var flat map[string]float64
	if err := json.Unmarshal(body, &flat); err == nil && len(flat) > 0 {
		for _, key := range []string{"usd", "price", "spotPricePerMetricTonUSD", "spotPrice"} {
			if p, ok := flat[key]; ok && p > 0 {
				return p, nil
			}
		}
	}

	// 3. Generic map format
	var anyMap map[string]interface{}
	if err := json.Unmarshal(body, &anyMap); err == nil {
		for _, v := range anyMap {
			if subMap, ok := v.(map[string]interface{}); ok {
				if usdVal, ok := subMap["usd"]; ok {
					switch num := usdVal.(type) {
					case float64:
						if num > 0 {
							return num, nil
						}
					case int:
						if num > 0 {
							return float64(num), nil
						}
					}
				}
			}
		}
	}

	return 0, fmt.Errorf("could not parse spot price from body: %s", string(body))
}
