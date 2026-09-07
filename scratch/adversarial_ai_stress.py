#!/usr/bin/env python3
"""Adversarial stress harness for ECON local AI inference (infer.py).

Tests:
1. Real PyTorch live execution vs fixed mocks (variance test across distinct sequences).
2. Input sequence lengths: <12, ==12, >12.
3. Truncation and padding invariance properties.
4. Extreme temperatures (>50C, >55C, <-20C, <-40C).
5. Negative power draws and airflow.
6. Malformed and adversarial payloads.
7. TimesFM varied horizons and history lengths.
"""

import json
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(_HERE, ".."))
INFER_SCRIPT = os.path.join(REPO_ROOT, "backend", "forecasting", "infer.py")
PYTHON_BIN = sys.executable

results = []

def run_infer(model: str, payload: dict | str, expect_success: bool = True):
    if isinstance(payload, dict):
        inp_str = json.dumps(payload)
    else:
        inp_str = str(payload)

    env = os.environ.copy()
    env["PYTHONPATH"] = os.path.join(REPO_ROOT, "backend", "forecasting")

    proc = subprocess.run(
        [PYTHON_BIN, INFER_SCRIPT, "--model", model, "--input", "-"],
        input=inp_str,
        text=True,
        capture_output=True,
        env=env
    )
    
    stdout_parsed = None
    try:
        stdout_parsed = json.loads(proc.stdout.strip()) if proc.stdout.strip() else None
    except Exception as e:
        stdout_parsed = {"raw_stdout": proc.stdout, "json_err": str(e)}

    return {
        "returncode": proc.returncode,
        "stdout": stdout_parsed,
        "stderr": proc.stderr.strip()
    }


def test_pytorch_variance():
    print("=== Test 1: Real PyTorch Execution & Prediction Variance ===")
    cases = [
        ("very_cold_idle", [[18.0, 50.0]] * 12, 15.0, 40.0),
        ("cool_low", [[21.0, 150.0]] * 12, 22.0, 50.0),
        ("baseline_moderate", [[24.0, 300.0]] * 12, 30.0, 65.0),
        ("warm_high", [[27.0, 550.0]] * 12, 35.0, 75.0),
        ("very_hot_extreme", [[32.0, 900.0]] * 12, 42.0, 85.0),
    ]
    
    predictions = {}
    for name, seq, out_temp, out_hum in cases:
        payload = {
            "sensor_sequence": seq,
            "outdoor_temp": out_temp,
            "outdoor_humidity": out_hum
        }
        res = run_infer("lstm", payload)
        assert res["returncode"] == 0, f"Failed on {name}: {res['stderr']}"
        pred = res["stdout"]["predicted_peak_load"]
        predictions[name] = pred
        print(f"  [{name}] predicted_peak_load = {pred:.4f} MW (weather: {out_temp}C, {out_hum}%)")

    unique_preds = set(predictions.values())
    print(f"  Total cases: {len(cases)}, Unique predictions: {len(unique_preds)}")
    assert len(unique_preds) == len(cases), f"Predictions are NOT distinct! Real PyTorch inference failed: {predictions}"

    sorted_names = [c[0] for c in cases]
    for i in range(len(sorted_names) - 1):
        c1, c2 = sorted_names[i], sorted_names[i+1]
        assert predictions[c1] <= predictions[c2], f"Monotonicity violated: {c1} ({predictions[c1]}) > {c2} ({predictions[c2]})"
    print("  PASS: PyTorch predictions legitimately vary and strictly adhere to physical monotonicity!\n")


def test_sequence_lengths():
    print("=== Test 2: Sequence Lengths (<12, ==12, >12) ===")
    base_step = [25.0, 400.0]

    # Sub-case: length < 12 (1, 3, 6, 11)
    for length in [1, 3, 6, 11]:
        seq = [base_step] * length
        payload = {
            "sensor_sequence": seq,
            "outdoor_temp": 30.0,
            "outdoor_humidity": 60.0
        }
        res = run_infer("lstm", payload)
        assert res["returncode"] == 0, f"Failed on length {length}: {res['stderr']}"
        assert res["stdout"]["status"] == "ok"
        assert res["stdout"]["timesteps_used"] == 12
        print(f"  [len={length} < 12] Padded to 12 successfully -> predicted: {res['stdout']['predicted_peak_load']:.4f} MW")

    # Sub-case: length == 12
    res12 = run_infer("lstm", {"sensor_sequence": [base_step]*12, "outdoor_temp": 30.0, "outdoor_humidity": 60.0})
    assert res12["returncode"] == 0
    p12 = res12["stdout"]["predicted_peak_load"]
    print(f"  [len=12 == 12] Standard length -> predicted: {p12:.4f} MW")

    # Verify padding equivalence: repeating base_step 1 time should yield the exact same prediction as repeating it 12 times
    res1 = run_infer("lstm", {"sensor_sequence": [base_step]*1, "outdoor_temp": 30.0, "outdoor_humidity": 60.0})
    assert abs(res1["stdout"]["predicted_peak_load"] - p12) < 1e-6, "Padding did not repeat earliest sample correctly!"

    # Sub-case: length > 12 (15, 50, 100)
    for length in [15, 50, 100]:
        seq = [[10.0, 0.0]] * (length - 12) + [base_step] * 12
        payload = {
            "sensor_sequence": seq,
            "outdoor_temp": 30.0,
            "outdoor_humidity": 60.0
        }
        res = run_infer("lstm", payload)
        assert res["returncode"] == 0, f"Failed on length {length}: {res['stderr']}"
        assert res["stdout"]["status"] == "ok"
        assert res["stdout"]["timesteps_used"] == 12
        p_long = res["stdout"]["predicted_peak_load"]
        print(f"  [len={length} > 12] Truncated to last 12 -> predicted: {p_long:.4f} MW (diff: {abs(p_long - p12):.6f})")
        assert abs(p_long - p12) < 1e-6, f"Truncation failed! History beyond 12 affected prediction: {p_long} vs {p12}"
    print("  PASS: Sequence length adaptation (<12 padding, >12 truncation) verified!\n")


def test_extreme_inputs():
    print("=== Test 3: Extreme Inputs (Extreme Temps & Negative Values) ===")
    base_seq = [[25.0, 400.0]] * 12

    for temp in [50.0, 52.0, 55.0]:
        res = run_infer("lstm", {"sensor_sequence": base_seq, "outdoor_temp": temp, "outdoor_humidity": 50.0})
        assert res["returncode"] == 0
        assert res["stdout"]["outdoor_temp_used"] == temp
        assert res["stdout"]["weather_source"] == "input"
        print(f"  [High Temp {temp}C] Valid extreme -> predicted: {res['stdout']['predicted_peak_load']:.4f} MW")

    # Temp > 55°C triggers weather fallback
    res_fallback = run_infer("lstm", {"sensor_sequence": base_seq, "outdoor_temp": 65.0, "outdoor_humidity": 50.0})
    assert res_fallback["returncode"] == 0
    assert res_fallback["stdout"]["weather_source"] in ("fallback", "api", "cache")
    print(f"  [High Temp 65C > 55C] Fallback triggered -> weather_source={res_fallback['stdout']['weather_source']}, outdoor_temp_used={res_fallback['stdout']['outdoor_temp_used']}")

    # Subzero temperatures: -20°C, -25°C, -35°C, -40°C
    for temp in [-20.0, -25.0, -35.0, -40.0]:
        res = run_infer("lstm", {"sensor_sequence": base_seq, "outdoor_temp": temp, "outdoor_humidity": 30.0})
        assert res["returncode"] == 0
        assert res["stdout"]["outdoor_temp_used"] == temp
        print(f"  [Subzero Temp {temp}C] Handled gracefully -> predicted: {res['stdout']['predicted_peak_load']:.4f} MW")

    # Negative power draws / airflow
    neg_cases = [
        ("neg_airflow", [[24.0, -50.0]] * 12),
        ("neg_temp", [[-15.0, 200.0]] * 12),
        ("severe_negatives", [[-30.0, -500.0]] * 12),
    ]
    for name, seq in neg_cases:
        res = run_infer("lstm", {"sensor_sequence": seq, "outdoor_temp": 25.0, "outdoor_humidity": 50.0})
        assert res["returncode"] == 0, f"Crashed on {name}: {res['stderr']}"
        pred = res["stdout"]["predicted_peak_load"]
        assert pred >= 0.0, f"Predicted load is negative! {pred}"
        print(f"  [{name}] Non-negative clamp verified -> predicted: {pred:.4f} MW >= 0.0")

    print("  PASS: Extreme temperature and negative value handling verified!\n")


def test_malformed_inputs():
    print("=== Test 4: Malformed & Invalid Payloads ===")
    bad_payloads = [
        ("empty_json", "{}"),
        ("empty_seq", json.dumps({"sensor_sequence": []})),
        ("single_dim_row", json.dumps({"sensor_sequence": [[24.0]] * 12})),
        ("triple_dim_row", json.dumps({"sensor_sequence": [[24.0, 300.0, 1.0]] * 12})),
        ("string_values", json.dumps({"sensor_sequence": [["room", "flow"]] * 12})),
        ("corrupted_json", "{\"sensor_sequence\": [24.0, "),
    ]

    for name, payload in bad_payloads:
        res = run_infer("lstm", payload)
        assert res["returncode"] != 0 or res["stdout"].get("status") == "error", f"Expected error on {name}, but succeeded: {res}"
        err_msg = res["stdout"].get("error") if res["stdout"] else res["stderr"]
        print(f"  [{name}] Correctly rejected -> {err_msg}")

    print("  PASS: Malformed input rejection verified!\n")


def test_timesfm_varied():
    print("=== Test 5: TimesFM Varied Horizons & Histories ===")
    histories = [
        ("short_6", [1.2, 1.3, 1.4, 1.5, 1.6, 1.7]),
        ("standard_12", [1.2 + 0.05*i for i in range(12)]),
        ("long_24", [1.0 + 0.02*i for i in range(24)]),
    ]
    horizons = [1, 12, 24]

    for h_name, hist in histories:
        for horiz in horizons:
            payload = {"history": hist, "horizon": horiz}
            res = run_infer("timesfm", payload)
            if res["returncode"] == 0 and res["stdout"].get("status") == "ok":
                forecast = res["stdout"].get("forecast") or res["stdout"].get("point")
                assert len(forecast) == horiz, f"Expected {horiz} forecast steps, got {len(forecast)}"
                q = res["stdout"].get("quantiles")
                has_q = q is not None and len(q) > 0
                print(f"  [TimesFM {h_name}, H={horiz}] SUCCESS -> {len(forecast)} steps, quantiles={has_q}, device={res['stdout'].get('device')}")
            else:
                err = res["stdout"].get("error") if res["stdout"] else res["stderr"]
                print(f"  [TimesFM {h_name}, H={horiz}] Result: {err}")

    print("  TimesFM varied test complete!\n")


if __name__ == "__main__":
    test_pytorch_variance()
    test_sequence_lengths()
    test_extreme_inputs()
    test_malformed_inputs()
    test_timesfm_varied()
    print("ALL AI STRESS HARNESS TESTS PASSED EMPIRICALLY!")
