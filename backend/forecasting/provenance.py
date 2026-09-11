"""Where the served LSTM's knowledge actually came from.

`train.py` chooses between the building's own recorded telemetry and a synthetic
physics-grounded generator, and until now it printed that choice and discarded it. The
serving path therefore could not answer the question, and `/model/info` filled the gap by
asserting `"this building's own history (supervised)"` for every set of weights it loaded —
including weights fitted to the synthetic testbed, whose targets run 0.8–2.75 MW and which
will happily return 2.25 MW for a house drawing 4.5 kW.

Provenance is a claim that can only be recorded at the moment it is true. This module holds
the reading half, deliberately free of torch/numpy so it can be tested on its own.
"""

UNSTAMPED = "unknown — these weights carry no training record; re-run train.py to stamp them"


def load_provenance(path, opener=open):
    """Read the record train.py wrote beside the weights, or None if there isn't one.

    `opener` exists for tests. Any failure to read or parse is an absence of knowledge,
    not an error worth refusing to serve over: the model still works, it just cannot say
    where it learned what it knows.
    """
    import json

    try:
        with opener(path) as fh:
            record = json.load(fh)
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def lstm_info(model_ready, provenance):
    """The `lstm` block of GET /model/info.

    Three distinct states, kept distinct because collapsing them is what produced the
    original false claim:

      - no model loaded            -> trained_on is None; there is nothing to describe
      - loaded, no record          -> trained_on says so explicitly
      - loaded, record present     -> trained_on reports what was recorded, verbatim

    The recorded target range travels with it. It is what makes a scale mismatch legible
    without running an inference: a model trained over 0.8–2.75 MW, serving a building that
    draws 0.0045 MW, is not slightly miscalibrated.
    """
    info = {
        "available": bool(model_ready),
        "reason": None if model_ready else "not trained yet — run train.py",
    }
    if not model_ready:
        info["trained_on"] = None
        return info
    if provenance is None:
        info["trained_on"] = UNSTAMPED
        info["provenance_recorded"] = False
        return info

    info["trained_on"] = provenance.get("source")
    info["provenance_recorded"] = True
    info["trained_at"] = provenance.get("trained_at")
    info["training_sequences"] = provenance.get("sequences")
    info["target_load_mw"] = provenance.get("target_load_mw")
    # real_data is the one field a consumer can branch on without parsing prose.
    if "real_data" in provenance:
        info["trained_on_real_data"] = bool(provenance["real_data"])
    return info
