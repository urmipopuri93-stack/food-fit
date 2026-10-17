"""Plug your model in here. A model is anything with .name, .version and .predict(points).
predict returns one (score, details) per point, in the same order."""
from typing import Protocol, Sequence
from .models import Point


class Model(Protocol):
    name: str
    version: str

    def predict(self, points: Sequence[Point]) -> list[tuple[float | None, dict]]: ...


class PlaceholderModel:
    """Stand-in so the pipeline works end to end. Replace with a real model."""
    name = "placeholder"
    version = "0.1"

    def predict(self, points):
        # Fake score: mean of the numeric props, scaled to 0-1. Swap this out.
        out = []
        for p in points:
            nums = [v for v in (p.props or {}).values() if isinstance(v, (int, float))]
            score = min(1.0, (sum(nums) / len(nums)) / 100) if nums else None
            out.append((score, {"note": "placeholder"}))
        return out


# Examples of real models (load once at startup, not per request):
#   scikit-learn:  joblib.load("model.joblib").predict(features)
#   PyTorch/ONNX:  onnxruntime.InferenceSession("model.onnx").run(...)
#   Claude API:    call the Anthropic API per batch and store the JSON result in details

MODEL: Model = PlaceholderModel()
