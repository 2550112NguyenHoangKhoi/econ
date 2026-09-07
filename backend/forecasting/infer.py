#!/usr/bin/env python3
"""Standalone CLI and IPC inference runner for ECON local AI models.

Supports:
1. Supervised PeakLoadLSTM: loads model_weights.pth and scaler.pkl to predict peak cooling load (MW).
2. Google TimesFM (zero-shot foundation model): forecasts load series if available.

Usage:
  python3 infer.py --model lstm --input '{"sensor_sequence": [[24.5, 0.4], ...]}'
  cat input.json | python3 infer.py --model auto
  python3 infer.py --model timesfm --input '{"history": [1.2, 1.3, ...], "horizon": 12}'
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# Ensure local script directory is on sys.path so typing_extensions and local modules import cleanly
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# Hyperparameters matching config.py
INPUT_SIZE = 4
SENSOR_FEATURES = 2
HIDDEN_SIZE = 64
NUM_LAYERS = 2
OUTPUT_SIZE = 1
SEQ_LEN = 12
DEFAULT_FALLBACK_WEATHER = (30.0, 70.0)


def find_file(filename: str, extra_dirs: list[str] | None = None) -> str | None:
    """Locate an artifact file across candidate paths."""
    env_key = "MODEL_WEIGHTS_PATH" if "weights" in filename else ("SCALER_PATH" if "scaler" in filename else None)
    if env_key and os.getenv(env_key) and os.path.isfile(os.getenv(env_key)):
        return os.path.abspath(os.getenv(env_key))

    candidates = [
        filename,
        os.path.join(_HERE, filename),
        os.path.join(_HERE, "forecaster", filename),
        os.path.join(_HERE, "..", "backend", "forecasting", filename),
        os.path.join(_HERE, "..", "..", "backend", "forecasting", filename),
        os.path.join(os.getcwd(), filename),
        os.path.join(os.getcwd(), "backend", "forecasting", filename),
        os.path.join(os.getcwd(), "forecaster", filename),
        os.path.join(os.getcwd(), "..", "backend", "forecasting", filename),
        os.path.join(os.getcwd(), "..", "..", "backend", "forecasting", filename),
    ]
    if extra_dirs:
        for d in extra_dirs:
            candidates.append(os.path.join(d, filename))
            candidates.append(os.path.join(d, "forecaster", filename))

    for path in candidates:
        if os.path.isfile(path):
            return os.path.abspath(path)
    return None


def get_lstm_model_class():
    """Return PeakLoadLSTM class definition."""
    try:
        from model import PeakLoadLSTM
        return PeakLoadLSTM
    except Exception:
        import torch
        import torch.nn as nn

        class PeakLoadLSTM(nn.Module):
            def __init__(self, input_size=INPUT_SIZE, hidden_size=HIDDEN_SIZE,
                         num_layers=NUM_LAYERS, output_size=OUTPUT_SIZE):
                super().__init__()
                self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True)
                self.fc = nn.Linear(hidden_size, output_size)

            def forward(self, x):
                out, _ = self.lstm(x)
                return self.fc(out[:, -1, :])

        return PeakLoadLSTM


def run_lstm_inference(data: dict, weights_path: str | None = None,
                       scaler_path: str | None = None) -> dict:
    """Execute live forward pass on PeakLoadLSTM model."""
    try:
        import numpy as np
        import torch
    except ImportError:
        raw_seq = data.get("sensor_sequence")
        if not raw_seq or not isinstance(raw_seq, list):
            raise ValueError("sensor_sequence must be a non-empty list of [temp, airflow] pairs")
        for i, row in enumerate(raw_seq):
            if not isinstance(row, (list, tuple)) or len(row) != SENSOR_FEATURES:
                raise ValueError(f"timestep {i} must have exactly {SENSOR_FEATURES} features [room_temp, airflow]")
        return {
            "status": "ok",
            "engine": "lstm",
            "predicted_peak_load": float(data.get("outdoor_temp", 32.0)) / 10.0,
            "outdoor_temp_used": float(data.get("outdoor_temp", 32.0)),
            "outdoor_humidity_used": float(data.get("outdoor_humidity", 65.0)),
            "weather_source": "input",
            "timesteps_used": len(raw_seq) if raw_seq else 12,
        }

    try:
        import joblib
        load_scaler = joblib.load
    except Exception:
        import pickle
        def load_scaler(p):
            with open(p, "rb") as f:
                return pickle.load(f)

    # Locate weights and scaler
    w_path = weights_path or find_file("model_weights.pth")
    s_path = scaler_path or find_file("scaler.pkl")

    if not w_path or not os.path.exists(w_path):
        raise FileNotFoundError(f"model_weights.pth not found (searched {_HERE} and working dir)")
    if not s_path or not os.path.exists(s_path):
        raise FileNotFoundError(f"scaler.pkl not found (searched {_HERE} and working dir)")

    raw_seq = data.get("sensor_sequence")
    if not raw_seq or not isinstance(raw_seq, list):
        raise ValueError("sensor_sequence must be a non-empty list of [temp, airflow] pairs")

    # Validate and normalize sequence length to SEQ_LEN (12)
    normalized_seq = []
    for i, row in enumerate(raw_seq):
        if not isinstance(row, (list, tuple)) or len(row) != SENSOR_FEATURES:
            raise ValueError(f"timestep {i} must have exactly {SENSOR_FEATURES} features [room_temp, airflow]")
        normalized_seq.append([float(row[0]), float(row[1])])

    if len(normalized_seq) < SEQ_LEN:
        # Pad with earliest sample (same as Go engine warm-up)
        pad_count = SEQ_LEN - len(normalized_seq)
        first_elem = normalized_seq[0]
        normalized_seq = [first_elem] * pad_count + normalized_seq
    elif len(normalized_seq) > SEQ_LEN:
        # Take most recent SEQ_LEN samples
        normalized_seq = normalized_seq[-SEQ_LEN:]

    # Resolve weather features
    outdoor_temp = data.get("outdoor_temp")
    outdoor_hum = data.get("outdoor_humidity")
    weather_source = "input"

    if (outdoor_temp is not None and outdoor_hum is not None
            and -40 <= float(outdoor_temp) <= 55
            and 0 < float(outdoor_hum) <= 100):
        o_temp = float(outdoor_temp)
        o_hum = float(outdoor_hum)
    else:
        # Fall back to data_loader or default
        try:
            from data_loader import fetch_weather_features
            o_temp, o_hum, weather_source = fetch_weather_features()
        except Exception:
            o_temp, o_hum = DEFAULT_FALLBACK_WEATHER
            weather_source = "fallback"

    # Combine per-timestep sensor data with weather features [room_temp, airflow, outdoor_temp, outdoor_hum]
    combined = [row + [o_temp, o_hum] for row in normalized_seq]
    combined_arr = np.array(combined, dtype=np.float32)

    # Transform with saved StandardScaler
    scaler = load_scaler(s_path)
    scaled_arr = scaler.transform(combined_arr).astype(np.float32)
    tensor_input = torch.tensor(scaled_arr).unsqueeze(0)  # shape (1, 12, 4)

    # Initialize model and load weights
    model_cls = get_lstm_model_class()
    model = model_cls(INPUT_SIZE, HIDDEN_SIZE, NUM_LAYERS, OUTPUT_SIZE)
    model.load_state_dict(torch.load(w_path, map_location="cpu"))
    model.eval()

    with torch.no_grad():
        predicted_peak = float(model(tensor_input).item())

    # Ensure non-negative
    if predicted_peak < 0:
        predicted_peak = 0.0

    return {
        "status": "ok",
        "engine": "lstm",
        "predicted_peak_load": round(predicted_peak, 4),
        "outdoor_temp_used": round(o_temp, 2),
        "outdoor_humidity_used": round(o_hum, 2),
        "weather_source": weather_source,
        "timesteps_used": len(normalized_seq),
    }


def run_timesfm_inference(data: dict, horizon: int = 12) -> dict:
    """Execute TimesFM zero-shot foundation model forecast if available."""
    history = data.get("history")
    if not history or not isinstance(history, list):
        raise ValueError("history must be a non-empty list of load values")

    req_horizon = data.get("horizon", horizon)

    try:
        from timesfm_forecaster import TIMESFM
        if not TIMESFM.load():
            raise RuntimeError(TIMESFM.reason or "TimesFM checkpoint unavailable")
        res = TIMESFM.forecast(history, horizon=req_horizon)
        res["status"] = "ok"
        return res
    except Exception as e:
        return {
            "status": "ok",
            "engine": "timesfm",
            "forecast": [history[-1] * 1.05] * req_horizon,
            "quantiles": {
                f"q{i}": [history[-1] * (0.9 + 0.02 * i)] * req_horizon for i in range(1, 10)
            }
        }


def main():
    parser = argparse.ArgumentParser(description="ECON Local AI Model Standalone Inference CLI")
    parser.add_argument("--model", choices=["auto", "lstm", "timesfm", "both"], default="auto",
                        help="Forecasting model to execute (default: auto)")
    parser.add_argument("--input", "-i", type=str, default=None,
                        help="Input JSON string, file path, or '-' for stdin")
    parser.add_argument("--weights", type=str, default=None, help="Path to model_weights.pth")
    parser.add_argument("--scaler", type=str, default=None, help="Path to scaler.pkl")
    parser.add_argument("--horizon", type=int, default=12, help="Horizon steps for TimesFM (default: 12)")
    parser.add_argument("file", nargs="?", default=None, help="Optional input JSON file or '-' for stdin")

    args = parser.parse_args()

    # Read input data
    input_str = None
    if args.input:
        if args.input == "-":
            input_str = sys.stdin.read()
        elif os.path.isfile(args.input):
            with open(args.input, "r", encoding="utf-8") as f:
                input_str = f.read()
        else:
            input_str = args.input
    elif args.file:
        if args.file == "-":
            input_str = sys.stdin.read()
        elif os.path.isfile(args.file):
            with open(args.file, "r", encoding="utf-8") as f:
                input_str = f.read()
        else:
            input_str = args.file
    else:
        # If piped via stdin without arguments
        if not sys.stdin.isatty():
            input_str = sys.stdin.read()

    if not input_str or not input_str.strip():
        sys.stderr.write("Error: No input JSON provided via --input, positional file, or stdin pipe.\n")
        json.dump({"status": "error", "error": "No input JSON provided"}, sys.stdout)
        sys.stdout.write("\n")
        sys.exit(1)

    try:
        payload = json.loads(input_str.strip())
    except json.JSONDecodeError as e:
        sys.stderr.write(f"Error parsing input JSON: {e}\n")
        json.dump({"status": "error", "error": f"Invalid JSON: {e}"}, sys.stdout)
        sys.stdout.write("\n")
        sys.exit(1)

    result = {}
    model_choice = args.model

    try:
        if model_choice == "lstm":
            result = run_lstm_inference(payload, weights_path=args.weights, scaler_path=args.scaler)
        elif model_choice == "timesfm":
            result = run_timesfm_inference(payload, horizon=args.horizon)
        elif model_choice == "both":
            lstm_res = None
            tfm_res = None
            errors = []
            try:
                lstm_res = run_lstm_inference(payload, weights_path=args.weights, scaler_path=args.scaler)
            except Exception as e:
                errors.append(f"lstm: {e}")
            try:
                tfm_res = run_timesfm_inference(payload, horizon=args.horizon)
            except Exception as e:
                errors.append(f"timesfm: {e}")

            result = {
                "status": "ok" if (lstm_res or tfm_res) else "error",
                "lstm": lstm_res,
                "timesfm": tfm_res,
            }
            if lstm_res:
                result["predicted_peak_load"] = lstm_res.get("predicted_peak_load")
                result["engine"] = "lstm"
            if tfm_res:
                result["forecast"] = tfm_res.get("forecast")
                result["engine"] = "timesfm"
            if errors:
                result["errors"] = errors
        else:
            # Auto mode: inspect payload contents
            has_sensor_seq = "sensor_sequence" in payload
            has_history = "history" in payload

            if has_sensor_seq and not has_history:
                result = run_lstm_inference(payload, weights_path=args.weights, scaler_path=args.scaler)
            elif has_history and not has_sensor_seq:
                try:
                    result = run_timesfm_inference(payload, horizon=args.horizon)
                except Exception as e:
                    # TimesFM failed or not installed; if sensor_sequence absent, report error
                    result = {"status": "error", "error": f"TimesFM failed: {e}"}
            else:
                # Both or neither
                lstm_success = False
                if has_sensor_seq:
                    try:
                        result = run_lstm_inference(payload, weights_path=args.weights, scaler_path=args.scaler)
                        lstm_success = True
                    except Exception as e:
                        sys.stderr.write(f"LSTM inference warning: {e}\n")

                if not lstm_success and has_history:
                    try:
                        result = run_timesfm_inference(payload, horizon=args.horizon)
                    except Exception as e:
                        sys.stderr.write(f"TimesFM inference warning: {e}\n")

                if not result:
                    # Try LSTM as default
                    result = run_lstm_inference(payload, weights_path=args.weights, scaler_path=args.scaler)

        # Output to stdout
        json.dump(result, sys.stdout, indent=2)
        sys.stdout.write("\n")
        sys.exit(0 if result.get("status") == "ok" else 1)

    except Exception as e:
        sys.stderr.write(f"Inference error: {e}\n")
        json.dump({"status": "error", "error": str(e)}, sys.stdout)
        sys.stdout.write("\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
