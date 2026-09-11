"""Cover for the provenance reader — the part that decides what /model/info is entitled to
claim about where the served model learned what it knows.

Deliberately free of torch/numpy so it runs anywhere, including against the source tree
without the container.
"""
import io
import json

from provenance import UNSTAMPED, lstm_info, load_provenance


def _opener(payload):
    """An opener that yields `payload` as a file, for load_provenance."""
    def open_it(_path):
        return io.StringIO(payload)
    return open_it


def test_no_model_makes_no_claim():
    info = lstm_info(model_ready=False, provenance=None)
    assert info["available"] is False
    assert info["trained_on"] is None
    assert "run train.py" in info["reason"]


def test_unstamped_weights_say_so_instead_of_asserting():
    """The regression this module exists for: weights with no record must NOT be described
    as trained on this building's own history."""
    info = lstm_info(model_ready=True, provenance=None)
    assert info["available"] is True
    assert info["provenance_recorded"] is False
    assert info["trained_on"] == UNSTAMPED
    assert "own history" not in info["trained_on"]


def test_synthetic_provenance_is_reported_verbatim():
    record = {
        "source": "synthetic (physics-grounded)",
        "real_data": False,
        "sequences": 6000,
        "trained_at": "2026-07-28T08:44:00+00:00",
        "target_load_mw": {"min": 0.83, "max": 2.75, "mean": 1.62},
    }
    info = lstm_info(model_ready=True, provenance=record)
    assert info["trained_on"] == "synthetic (physics-grounded)"
    assert info["trained_on_real_data"] is False
    assert info["provenance_recorded"] is True
    assert info["training_sequences"] == 6000
    # The range is what makes a scale mismatch visible without running an inference.
    assert info["target_load_mw"]["max"] == 2.75


def test_real_provenance_is_reported_verbatim():
    record = {
        "source": "real telemetry (TimescaleDB history)",
        "real_data": True,
        "sequences": 412,
        "target_load_mw": {"min": 0.0041, "max": 0.0062, "mean": 0.0049},
    }
    info = lstm_info(model_ready=True, provenance=record)
    assert info["trained_on"] == "real telemetry (TimescaleDB history)"
    assert info["trained_on_real_data"] is True


def test_load_provenance_reads_a_record():
    record = {"source": "real telemetry (TimescaleDB history)", "real_data": True}
    assert load_provenance("ignored", opener=_opener(json.dumps(record))) == record


def test_load_provenance_treats_unreadable_as_absent():
    def missing(_path):
        raise OSError("no such file")

    assert load_provenance("ignored", opener=missing) is None


def test_load_provenance_treats_corrupt_as_absent():
    assert load_provenance("ignored", opener=_opener("{not json")) is None


def test_load_provenance_rejects_a_non_object():
    """A JSON array would sail through json.load and then fail on .get() at serve time."""
    assert load_provenance("ignored", opener=_opener("[1, 2, 3]")) is None
