# syntax=docker/dockerfile:1.4
FROM python:3.10-slim

WORKDIR /app

COPY requirements.txt .
# CPU-only torch keeps the image lean (no multi-GB CUDA wheel); LSTM inference needs no GPU.
#
# The pip cache is a BuildKit cache mount rather than --no-cache-dir. Both flags aim at the
# same thing — keeping the wheel out of the image layer — but --no-cache-dir achieved it by
# discarding every download, and that had a measured cost:
#
#   requirements.txt ALSO pins torch (torch>=2.2), so the second pip install re-resolved it
#   and, with nothing cached, pulled the same 159 MB wheel a second time. One build was
#   observed downloading torch at t=17s and again at t=947s — 318 MB per build, at the
#   40-350 kB/s pip manages here, before transformers/scipy/scikit-learn were even reached.
#
# A cache mount is not stored in the image, so the image stays exactly as lean, while the
# second install and every later rebuild hit the cache instead of the network.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install torch --extra-index-url https://download.pytorch.org/whl/cpu \
 && pip install -r requirements.txt

COPY . .

# Train at build time so the image ships with weights + scaler (no random-init predictions,
# no model artifacts committed to git). Swap for a `model_weights.pth` COPY once a real
# trained model is produced from persisted telemetry.
#
# train.py also stamps model_provenance.json beside the weights, recording whether it
# learned from the building's own TimescaleDB history or from the synthetic physics
# generator. /model/info reports that record rather than asserting a provenance nothing
# checked — see provenance.py.
RUN python train.py

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
