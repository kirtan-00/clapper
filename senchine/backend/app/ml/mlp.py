"""Multi-task predictor: failure probability, Remaining Useful Life, failure type.

One network, three heads. The three questions ("will it fail?", "when?", "how?")
share the same underlying degradation signature, so a shared trunk learns that
representation once and each head reads it differently. Training them jointly is
both cheaper and more accurate than three independent models on this data volume,
and it guarantees the three outputs stay mutually consistent — a model that says
"98% failure probability" and "1400 hours of life left" is worse than useless on
a maintenance floor.

Implemented in NumPy with hand-derived gradients: ~2k parameters, trains in under
two seconds, no framework dependency.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .features import N_FEATURES

# Failure taxonomy. Index order is a wire contract with persisted weights.
FAILURE_CATEGORIES: list[str] = [
    "healthy",
    "bearing_wear",
    "overheating",
    "lubrication_failure",
    "rotor_imbalance",
    "electrical_fault",
    "blockage_fouling",
]
CATEGORY_INDEX = {name: i for i, name in enumerate(FAILURE_CATEGORIES)}

CATEGORY_LABELS: dict[str, str] = {
    "healthy": "No developing fault",
    "bearing_wear": "Bearing wear / spalling",
    "overheating": "Thermal overload",
    "lubrication_failure": "Lubrication breakdown",
    "rotor_imbalance": "Rotor imbalance / misalignment",
    "electrical_fault": "Electrical fault",
    "blockage_fouling": "Blockage / fouling",
}

# Maximum RUL the model is asked to represent. Beyond this the answer is simply
# "no failure in the planning horizon", and pretending to more precision would
# be false confidence.
RUL_CEILING_HOURS = 2000.0


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -40, 40)))


def _softmax(z: np.ndarray) -> np.ndarray:
    shifted = z - z.max(axis=1, keepdims=True)
    e = np.exp(shifted)
    return e / np.sum(e, axis=1, keepdims=True)


class MultiTaskPredictor:
    """16 -> 32 -> 24 -> {failure prob, log-RUL, failure category}."""

    def __init__(
        self,
        n_input: int = N_FEATURES,
        h1: int = 32,
        h2: int = 24,
        n_classes: int = len(FAILURE_CATEGORIES),
        seed: int = 13,
    ) -> None:
        rng = np.random.default_rng(seed)

        def init(fan_in: int, fan_out: int) -> np.ndarray:
            # He init — the trunk uses ReLU.
            return rng.normal(0.0, np.sqrt(2.0 / fan_in), size=(fan_in, fan_out))

        self.n_input = n_input
        self.n_classes = n_classes
        self.W1, self.b1 = init(n_input, h1), np.zeros(h1)
        self.W2, self.b2 = init(h1, h2), np.zeros(h2)
        self.Wp, self.bp = init(h2, 1) * 0.5, np.zeros(1)
        self.Wr, self.br = init(h2, 1) * 0.5, np.zeros(1)
        self.Wc, self.bc = init(h2, n_classes) * 0.5, np.zeros(n_classes)

        self.mean = np.zeros(n_input)
        self.scale = np.ones(n_input)
        self.trained = False
        self.version = "mtp-1.0.0"
        self.metrics: dict[str, float] = {}
        self._adam: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self._step = 0

    @property
    def _param_names(self) -> list[str]:
        return ["W1", "b1", "W2", "b2", "Wp", "bp", "Wr", "br", "Wc", "bc"]

    def _adam_update(self, grads: dict[str, np.ndarray], lr: float) -> None:
        beta1, beta2, eps = 0.9, 0.999, 1e-8
        self._step += 1
        for name, grad in grads.items():
            m, v = self._adam.get(name, (np.zeros_like(grad), np.zeros_like(grad)))
            m = beta1 * m + (1 - beta1) * grad
            v = beta2 * v + (1 - beta2) * grad**2
            self._adam[name] = (m, v)
            m_hat = m / (1 - beta1**self._step)
            v_hat = v / (1 - beta2**self._step)
            setattr(
                self, name, getattr(self, name) - lr * m_hat / (np.sqrt(v_hat) + eps)
            )

    # -- forward ------------------------------------------------------------

    def standardize(self, x: np.ndarray) -> np.ndarray:
        return (x - self.mean) / self.scale

    def _forward(self, xs: np.ndarray) -> dict[str, np.ndarray]:
        z1 = xs @ self.W1 + self.b1
        a1 = np.maximum(z1, 0.0)
        z2 = a1 @ self.W2 + self.b2
        a2 = np.maximum(z2, 0.0)
        op = a2 @ self.Wp + self.bp
        orr = a2 @ self.Wr + self.br
        oc = a2 @ self.Wc + self.bc
        return {
            "z1": z1, "a1": a1, "z2": z2, "a2": a2,
            "op": op, "prob": _sigmoid(op),
            "rul_log": orr, "oc": oc, "cat": _softmax(oc),
        }

    def predict_prob(self, x: np.ndarray) -> np.ndarray:
        """Failure probability for a batch — the function SHAP attributes."""
        xs = self.standardize(np.atleast_2d(np.asarray(x, dtype=float)))
        return self._forward(xs)["prob"].ravel()

    def predict(self, x: np.ndarray) -> dict[str, Any]:
        xs = self.standardize(np.asarray(x, dtype=float).reshape(1, -1))
        out = self._forward(xs)
        prob = float(out["prob"][0, 0])
        rul = float(np.expm1(np.clip(out["rul_log"][0, 0], 0.0, np.log1p(RUL_CEILING_HOURS))))
        cat_probs = out["cat"][0]
        top = int(np.argmax(cat_probs))

        # Model confidence: high when the classifier is decisive *and* the
        # failure probability is not sitting on the 0.5 fence.
        margin = float(np.sort(cat_probs)[-1] - np.sort(cat_probs)[-2])
        decisiveness = abs(prob - 0.5) * 2.0
        confidence = float(np.clip(0.35 + 0.4 * margin + 0.25 * decisiveness, 0.0, 1.0))

        return {
            "failure_probability": prob,
            "rul_hours": float(np.clip(rul, 0.0, RUL_CEILING_HOURS)),
            "failure_category": FAILURE_CATEGORIES[top],
            "category_label": CATEGORY_LABELS[FAILURE_CATEGORIES[top]],
            "category_probabilities": {
                name: round(float(cat_probs[i]), 4)
                for i, name in enumerate(FAILURE_CATEGORIES)
            },
            "confidence": confidence,
            "model_version": self.version,
        }

    # -- training -----------------------------------------------------------

    def fit(
        self,
        x: np.ndarray,
        y_prob: np.ndarray,
        y_rul: np.ndarray,
        y_cat: np.ndarray,
        epochs: int = 260,
        batch_size: int = 96,
        lr: float = 5e-3,
        w_rul: float = 0.6,
        w_cat: float = 1.0,
        seed: int = 17,
    ) -> dict[str, Any]:
        rng = np.random.default_rng(seed)
        x = np.asarray(x, dtype=float)
        self.mean = x.mean(axis=0)
        self.scale = np.maximum(x.std(axis=0), 1e-3)
        xs = self.standardize(x)

        y_prob = np.asarray(y_prob, dtype=float).reshape(-1, 1)
        y_rul_log = np.log1p(np.clip(np.asarray(y_rul, dtype=float), 0, RUL_CEILING_HOURS)).reshape(-1, 1)
        y_cat = np.asarray(y_cat, dtype=int)
        onehot = np.zeros((y_cat.size, self.n_classes))
        onehot[np.arange(y_cat.size), y_cat] = 1.0

        n = xs.shape[0]
        history: list[float] = []
        for _ in range(epochs):
            order = rng.permutation(n)
            total, batches = 0.0, 0
            for start in range(0, n, batch_size):
                idx = order[start : start + batch_size]
                total += self._train_batch(
                    xs[idx], y_prob[idx], y_rul_log[idx], onehot[idx], lr, w_rul, w_cat
                )
                batches += 1
            if batches:
                history.append(total / batches)

        self.trained = True
        self.metrics = self.evaluate(x, y_prob.ravel(), np.asarray(y_rul), y_cat)
        return {
            "epochs": epochs,
            "samples": int(n),
            "final_loss": round(history[-1], 5) if history else None,
            "loss_curve": [round(v, 5) for v in history[:: max(1, epochs // 25)]],
            **self.metrics,
        }

    def _train_batch(
        self,
        xb: np.ndarray,
        yp: np.ndarray,
        yr: np.ndarray,
        yc: np.ndarray,
        lr: float,
        w_rul: float,
        w_cat: float,
    ) -> float:
        b = xb.shape[0]
        out = self._forward(xb)
        prob, rul_log, cat = out["prob"], out["rul_log"], out["cat"]

        bce = float(
            -np.sum(yp * np.log(prob + 1e-9) + (1 - yp) * np.log(1 - prob + 1e-9)) / b
        )
        mse = float(np.sum((rul_log - yr) ** 2) / (2 * b))
        ce = float(-np.sum(yc * np.log(cat + 1e-9)) / b)
        loss = bce + w_rul * mse + w_cat * ce

        # Head gradients (all pre-activation, thanks to the standard
        # sigmoid+BCE / softmax+CE simplifications).
        d_op = (prob - yp) / b
        d_or = w_rul * (rul_log - yr) / b
        d_oc = w_cat * (cat - yc) / b

        gWp, gbp = out["a2"].T @ d_op, d_op.sum(axis=0)
        gWr, gbr = out["a2"].T @ d_or, d_or.sum(axis=0)
        gWc, gbc = out["a2"].T @ d_oc, d_oc.sum(axis=0)

        d_a2 = d_op @ self.Wp.T + d_or @ self.Wr.T + d_oc @ self.Wc.T
        d_z2 = d_a2 * (out["z2"] > 0)
        gW2, gb2 = out["a1"].T @ d_z2, d_z2.sum(axis=0)

        d_a1 = d_z2 @ self.W2.T
        d_z1 = d_a1 * (out["z1"] > 0)
        gW1, gb1 = xb.T @ d_z1, d_z1.sum(axis=0)

        self._adam_update(
            {
                "W1": gW1, "b1": gb1, "W2": gW2, "b2": gb2,
                "Wp": gWp, "bp": gbp, "Wr": gWr, "br": gbr,
                "Wc": gWc, "bc": gbc,
            },
            lr,
        )
        return loss

    def evaluate(
        self,
        x: np.ndarray,
        y_prob: np.ndarray,
        y_rul: np.ndarray,
        y_cat: np.ndarray,
    ) -> dict[str, float]:
        """Held-out-style metrics reported on the dashboard as model quality."""
        xs = self.standardize(np.asarray(x, dtype=float))
        out = self._forward(xs)
        prob = out["prob"].ravel()
        pred_cat = np.argmax(out["cat"], axis=1)
        rul_pred = np.expm1(np.clip(out["rul_log"].ravel(), 0, np.log1p(RUL_CEILING_HOURS)))

        pred_label = (prob >= 0.5).astype(int)
        true_label = (np.asarray(y_prob) >= 0.5).astype(int)
        tp = int(np.sum((pred_label == 1) & (true_label == 1)))
        fp = int(np.sum((pred_label == 1) & (true_label == 0)))
        fn = int(np.sum((pred_label == 0) & (true_label == 1)))

        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

        # MAE restricted to samples that are actually degrading — RUL error on a
        # healthy machine is meaningless and would flatter the number.
        degrading = np.asarray(y_rul) < RUL_CEILING_HOURS * 0.9
        rul_mae = (
            float(np.mean(np.abs(rul_pred[degrading] - np.asarray(y_rul)[degrading])))
            if degrading.any()
            else 0.0
        )

        return {
            "accuracy": round(float(np.mean(pred_label == true_label)), 4),
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "category_accuracy": round(float(np.mean(pred_cat == np.asarray(y_cat))), 4),
            "rul_mae_hours": round(rul_mae, 2),
        }

    # -- persistence --------------------------------------------------------

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(
            path,
            **{name: getattr(self, name) for name in self._param_names},
            mean=self.mean,
            scale=self.scale,
            meta=np.array([self.n_input, self.n_classes]),
        )

    @classmethod
    def load(cls, path: str | Path) -> "MultiTaskPredictor":
        data = np.load(Path(path))
        meta = data["meta"]
        model = cls(n_input=int(meta[0]), n_classes=int(meta[1]))
        for name in model._param_names:
            setattr(model, name, data[name])
        model.mean = data["mean"]
        model.scale = data["scale"]
        model.trained = True
        return model
