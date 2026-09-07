# ECON local models

This bundle is the twin's learned intelligence, exported so you can run recommendations and
alerts **locally** — no server, no cloud, no network. Everything here was produced by the
running ECON digital twin from your building's own telemetry.

## What's inside

| File | What it is |
|------|-----------|
| `baselines.json` | The **learned baseline model**: per-`(zone, metric, hour-of-day)` distributions (mean, variance, sample count) the engine built online from the live telemetry stream. This is the model that decides what's *normal* for each room at each hour. |
| `model-spec.json` | The model's parameters and per-metric thresholds (σ floor, alert level, action, the ASHRAE CO₂ floor). Keeps offline scoring identical to the live engine. |
| `recommender.py` | A dependency-free (**Python 3 standard library only**) recommender that reproduces the engine's σ-scoring. Feed it your current readings; it prints the same recommendations and alerts the dashboard shows. |
| `sample_readings.json` | An example input so you can try it immediately. |
| `forecaster/` | The trained **LSTM peak-load forecaster** (`model_weights.pth`, `scaler.pkl`, `config.json`) — present when the forecasting service was reachable at export time. Running it needs PyTorch; the recommender does not. |
| `infer.py` | Standalone CLI & stdin runner for the local models (LSTM and TimesFM). |
| `MANIFEST.json` | Provenance: when it was exported, the model's maturity, and which pieces are included. |

## Run it

### 1. Offline Anomaly Recommender
```bash
python3 recommender.py sample_readings.json
```

### 2. Standalone Peak-Load Forecaster (`infer.py`)
```bash
# Run LSTM inference on sensor sequence
python3 infer.py --model lstm --input '{"sensor_sequence": [[24.5, 0.4], [25.0, 0.5], [25.2, 0.6], [25.5, 0.7], [26.0, 0.8], [26.2, 0.8], [26.5, 0.9], [26.8, 0.9], [27.0, 1.0], [27.2, 1.0], [27.5, 1.0], [28.0, 1.0]], "outdoor_temp": 32.0, "outdoor_humidity": 65.0}'

# Or pipe JSON via standard input
cat input.json | python3 infer.py

# Run TimesFM zero-shot foundation model (if available)
python3 infer.py --model timesfm --input '{"history": [1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9], "horizon": 12}'
```

- **stdout** is machine-readable JSON (pipe it into your monitoring).
- **stderr** is human-readable alert lines (`[CRITICAL] …`, `[WARNING] …`, or `[OK] …`).
- **exit code** is the alert signal: `0` nothing abnormal, `1` a warning, `2` a critical — so
  a cron job can page on a non-zero exit.

### Feeding your own readings

`recommender.py` takes a JSON array of your live sensor values:

```json
[
  {"zone": "zone-office-a", "metric": "co2",  "value": 1180, "hour": 14},
  {"zone": "zone-office-a", "metric": "temp", "value": 27.5, "hour": 14, "setpoint": 24}
]
```

- `metric` is one of the keys in `model-spec.json` (`co2`, `temp`, `buildingLoadMw`, `plugKw`).
- `hour` is optional (defaults to the current local hour); scoring falls back to the model's
  pooled all-hours distribution when a specific hour hasn't matured.
- `setpoint` is optional and only used for `temp` — a hot room at/below setpoint is being
  cooled correctly and is not flagged.

## How scoring works (the short version)

For each reading, the recommender looks up the learned distribution for that zone, metric and
hour, and measures how many standard deviations (σ) the value sits from that learned mean. A
reading past the metric's alert threshold (default ~3σ) is flagged — an anomaly **relative to
what this room actually does**, not a fixed number. Until a zone's baseline has seen enough
samples to be trusted, a recognized fixed standard (the ASHRAE ≤ 1000 ppm CO₂ guideline) is
the labelled fallback. That's exactly what the live twin does; this bundle just lets you do it
on your own machine.
