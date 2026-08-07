"""Model registry: train once, load thereafter, expose one inference surface.

Keeping model lifecycle behind a registry means the agents never touch training
code, weights, or file paths — they ask the registry for a scored prediction.
That is what allows the VAE or the multi-task head to be swapped for a different
implementation (or a hosted model endpoint) without any agent changing.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from .. import db
from ..config import settings
from . import training_data
from .explain import explain_prediction, fleet_baseline, narrate
from .features import N_FEATURES
from .mlp import CATEGORY_LABELS, MultiTaskPredictor
from .vae import VAE

_LOCK = threading.Lock()


class ModelRegistry:
    """Holds the trained models and the attribution baseline."""

    def __init__(self) -> None:
        self.vae: VAE | None = None
        self.predictor: MultiTaskPredictor | None = None
        self.baseline: np.ndarray = np.ones(N_FEATURES)
        self.report: dict[str, Any] = {}
        self.ready = False

    # -- lifecycle ----------------------------------------------------------

    def load_or_train(self, force: bool = False) -> dict[str, Any]:
        with _LOCK:
            model_dir = Path(settings.model_dir)
            vae_path = model_dir / "vae.npz"
            mtp_path = model_dir / "predictor.npz"

            report_path = model_dir / "report.json"

            if not force and vae_path.exists() and mtp_path.exists():
                try:
                    # The report is stored next to the weights, not only in the
                    # database. Weights and metrics are one artefact — loading
                    # cached weights against a fresh database must not silently
                    # produce a model with no reported accuracy.
                    stored = self._load_report(report_path)
                    if not stored or not stored.get("baseline"):
                        raise ValueError("model report missing or incomplete")

                    self.vae = VAE.load(vae_path)
                    self.predictor = MultiTaskPredictor.load(mtp_path)
                    self.baseline = np.asarray(stored["baseline"], dtype=float)
                    self.report = stored
                    db.kv_set("model_report", stored)
                    self.ready = True
                    return self.report
                except (OSError, KeyError, ValueError, json.JSONDecodeError):
                    # Corrupt, stale or incomplete artefacts: retrain rather than
                    # serving a model whose provenance cannot be established.
                    pass

            return self._train(vae_path, mtp_path)

    def _train(self, vae_path: Path, mtp_path: Path) -> dict[str, Any]:
        started = time.perf_counter()
        data = training_data.generate()

        vae = VAE()
        vae_report = vae.fit(data["healthy"])
        vae.save(vae_path)

        predictor = MultiTaskPredictor()
        mtp_report = predictor.fit(
            data["x"], data["y_prob"], data["y_rul"], data["y_cat"]
        )
        predictor.save(mtp_path)

        self.vae = vae
        self.predictor = predictor
        self.baseline = fleet_baseline(data["healthy"])
        self.ready = True

        self.report = {
            "trained_at": time.time(),
            "train_seconds": round(time.perf_counter() - started, 2),
            "vae": {
                "version": vae.version,
                "latent_dim": vae.n_latent,
                "hidden_dim": vae.n_hidden,
                **{k: v for k, v in vae_report.items() if k != "loss_curve"},
                "loss_curve": vae_report.get("loss_curve", []),
            },
            "predictor": {
                "version": predictor.version,
                "classes": len(CATEGORY_LABELS),
                **{k: v for k, v in mtp_report.items() if k != "loss_curve"},
                "loss_curve": mtp_report.get("loss_curve", []),
            },
            "baseline": [round(float(v), 5) for v in self.baseline],
            "training_samples": int(data["x"].shape[0]),
        }
        self._save_report(vae_path.parent / "report.json", self.report)
        db.kv_set("model_report", self.report)
        return self.report

    @staticmethod
    def _load_report(path: Path) -> dict[str, Any]:
        if not path.exists():
            # Fall back to the database copy for artefacts written before the
            # report file existed.
            return db.kv_get("model_report", {}) or {}
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _save_report(path: Path, report: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    # -- inference ----------------------------------------------------------

    def score_anomaly(self, vector: np.ndarray) -> dict[str, Any]:
        if self.vae is None:
            raise RuntimeError("model registry not initialised")
        return self.vae.score(vector)

    def predict(self, vector: np.ndarray) -> dict[str, Any]:
        if self.predictor is None:
            raise RuntimeError("model registry not initialised")
        return self.predictor.predict(vector)

    def explain(self, vector: np.ndarray, permutations: int = 96) -> dict[str, Any]:
        if self.predictor is None:
            raise RuntimeError("model registry not initialised")
        return explain_prediction(
            self.predictor.predict_prob,
            vector,
            self.baseline,
            n_permutations=permutations,
        )

    def full_assessment(
        self, vector: np.ndarray, permutations: int = 96
    ) -> dict[str, Any]:
        """Anomaly + prediction + explanation + narrated root cause, in one call."""
        anomaly = self.score_anomaly(vector)
        prediction = self.predict(vector)
        explanation = self.explain(vector, permutations=permutations)
        root_cause = narrate(explanation, prediction["category_label"])
        return {
            "anomaly": anomaly,
            "prediction": prediction,
            "explanation": explanation,
            "root_cause": root_cause,
        }

    def metrics(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "vae": self.report.get("vae", {}),
            "predictor": self.report.get("predictor", {}),
            "trained_at": self.report.get("trained_at"),
            "training_samples": self.report.get("training_samples"),
            "train_seconds": self.report.get("train_seconds"),
        }


registry = ModelRegistry()
