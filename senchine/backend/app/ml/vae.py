"""Variational Autoencoder for unsupervised anomaly detection — pure NumPy.

Why a VAE rather than a threshold
---------------------------------
Fixed thresholds ("alarm above 4.5 mm/s") catch only single-channel excursions
and generate constant false alarms across a fleet whose machines run at
different duty points. A VAE learns the *joint manifold of healthy operation*:
it captures that high vibration is normal at high load but abnormal at idle, and
flags the combination rather than the number. It needs only healthy data, which
is the only data a plant reliably has — real failures are rare and unlabelled.

Why hand-written NumPy
----------------------
The model is ~1.5k parameters. Implementing forward and backward passes directly
keeps the prototype dependency-free (no torch wheel), makes the maths auditable
during a code walkthrough, and trains the whole fleet baseline in about a second.

Scoring
-------
Anomaly score combines reconstruction error (how far the point is off the healthy
manifold) with the KL term (how atypical its latent encoding is), then maps the
result through percentiles calibrated on the training set, so the published score
is a *calibrated* 0-1 value rather than an uninterpretable raw error.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

from .features import N_FEATURES


class VAE:
    """Gaussian VAE with one hidden layer per side."""

    def __init__(
        self,
        n_input: int = N_FEATURES,
        n_hidden: int = 24,
        n_latent: int = 4,
        beta: float = 0.55,
        seed: int = 7,
    ) -> None:
        rng = np.random.default_rng(seed)
        self.n_input = n_input
        self.n_hidden = n_hidden
        self.n_latent = n_latent
        self.beta = beta

        def init(fan_in: int, fan_out: int) -> np.ndarray:
            # Xavier init keeps tanh activations in their responsive range.
            limit = np.sqrt(6.0 / (fan_in + fan_out))
            return rng.uniform(-limit, limit, size=(fan_in, fan_out))

        self.W1 = init(n_input, n_hidden)
        self.b1 = np.zeros(n_hidden)
        self.Wmu = init(n_hidden, n_latent)
        self.bmu = np.zeros(n_latent)
        self.Wlv = init(n_hidden, n_latent)
        self.blv = np.zeros(n_latent)
        self.W3 = init(n_latent, n_hidden)
        self.b3 = np.zeros(n_hidden)
        self.W4 = init(n_hidden, n_input)
        self.b4 = np.zeros(n_input)

        # Feature standardisation, fitted at training time.
        self.mean = np.zeros(n_input)
        self.scale = np.ones(n_input)

        # Score calibration percentiles, fitted on healthy training data.
        self.p50 = 1.0
        self.p95 = 2.0
        self.p999 = 4.0
        self.trained = False
        self.version = "vae-1.0.0"
        self._adam: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self._step = 0

    # -- parameter plumbing -------------------------------------------------

    @property
    def _param_names(self) -> list[str]:
        return ["W1", "b1", "Wmu", "bmu", "Wlv", "blv", "W3", "b3", "W4", "b4"]

    def _adam_update(self, grads: dict[str, np.ndarray], lr: float) -> None:
        b1, b2, eps = 0.9, 0.999, 1e-8
        self._step += 1
        for name, grad in grads.items():
            m, v = self._adam.get(
                name, (np.zeros_like(grad), np.zeros_like(grad))
            )
            m = b1 * m + (1 - b1) * grad
            v = b2 * v + (1 - b2) * grad**2
            self._adam[name] = (m, v)
            m_hat = m / (1 - b1**self._step)
            v_hat = v / (1 - b2**self._step)
            setattr(
                self, name, getattr(self, name) - lr * m_hat / (np.sqrt(v_hat) + eps)
            )

    # -- forward ------------------------------------------------------------

    def standardize(self, x: np.ndarray) -> np.ndarray:
        return (x - self.mean) / self.scale

    def encode(self, xs: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        he = np.tanh(xs @ self.W1 + self.b1)
        mu = he @ self.Wmu + self.bmu
        logvar = np.clip(he @ self.Wlv + self.blv, -8.0, 8.0)
        return he, mu, logvar

    def decode(self, z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        hd = np.tanh(z @ self.W3 + self.b3)
        return hd, hd @ self.W4 + self.b4

    # -- training -----------------------------------------------------------

    def fit(
        self,
        x: np.ndarray,
        epochs: int = 400,
        batch_size: int = 64,
        lr: float = 6e-3,
        seed: int = 11,
    ) -> dict[str, Any]:
        """Train on healthy-operation vectors only."""
        rng = np.random.default_rng(seed)
        x = np.asarray(x, dtype=float)
        if x.ndim != 2 or x.shape[1] != self.n_input:
            raise ValueError(f"expected (N, {self.n_input}) training matrix")

        self.mean = x.mean(axis=0)
        # Floor the scale so a constant channel does not explode when divided.
        self.scale = np.maximum(x.std(axis=0), 1e-3)
        xs = self.standardize(x)

        n = xs.shape[0]
        history: list[float] = []
        for epoch in range(epochs):
            order = rng.permutation(n)
            epoch_loss = 0.0
            batches = 0
            for start in range(0, n, batch_size):
                batch = xs[order[start : start + batch_size]]
                loss = self._train_batch(batch, rng, lr)
                epoch_loss += loss
                batches += 1
            if batches:
                history.append(epoch_loss / batches)

        self._calibrate(xs)
        self.trained = True
        return {
            "epochs": epochs,
            "samples": int(n),
            "final_loss": round(history[-1], 5) if history else None,
            "loss_curve": [round(v, 5) for v in history[:: max(1, epochs // 25)]],
            "p50": round(self.p50, 5),
            "p95": round(self.p95, 5),
        }

    def _train_batch(self, xb: np.ndarray, rng: np.random.Generator, lr: float) -> float:
        b = xb.shape[0]

        he = np.tanh(xb @ self.W1 + self.b1)
        mu = he @ self.Wmu + self.bmu
        logvar = np.clip(he @ self.Wlv + self.blv, -8.0, 8.0)
        std = np.exp(0.5 * logvar)
        eps = rng.standard_normal(size=mu.shape)
        z = mu + std * eps
        hd = np.tanh(z @ self.W3 + self.b3)
        xhat = hd @ self.W4 + self.b4

        diff = xhat - xb
        recon = float(np.sum(diff**2) / b)
        kl = float(
            -0.5 * np.sum(1 + logvar - mu**2 - np.exp(logvar)) / b
        )
        loss = recon + self.beta * kl

        # --- backward pass (derived by hand; see docs/ARCHITECTURE for notes) --
        d_xhat = 2.0 * diff / b
        gW4 = hd.T @ d_xhat
        gb4 = d_xhat.sum(axis=0)
        d_hd = d_xhat @ self.W4.T
        d_zpre = d_hd * (1 - hd**2)
        gW3 = z.T @ d_zpre
        gb3 = d_zpre.sum(axis=0)
        d_z = d_zpre @ self.W3.T

        d_mu = d_z + self.beta * mu / b
        d_logvar = d_z * eps * std * 0.5 + self.beta * 0.5 * (np.exp(logvar) - 1) / b

        gWmu = he.T @ d_mu
        gbmu = d_mu.sum(axis=0)
        gWlv = he.T @ d_logvar
        gblv = d_logvar.sum(axis=0)

        d_he = d_mu @ self.Wmu.T + d_logvar @ self.Wlv.T
        d_hepre = d_he * (1 - he**2)
        gW1 = xb.T @ d_hepre
        gb1 = d_hepre.sum(axis=0)

        self._adam_update(
            {
                "W1": gW1, "b1": gb1,
                "Wmu": gWmu, "bmu": gbmu,
                "Wlv": gWlv, "blv": gblv,
                "W3": gW3, "b3": gb3,
                "W4": gW4, "b4": gb4,
            },
            lr,
        )
        return loss

    def _calibrate(self, xs: np.ndarray) -> None:
        raw = self._raw_scores(xs)
        self.p50 = float(np.percentile(raw, 50))
        self.p95 = float(np.percentile(raw, 95))
        self.p999 = float(np.percentile(raw, 99.9))
        # Keep the calibration monotone even on a degenerate training set.
        self.p95 = max(self.p95, self.p50 + 1e-4)
        self.p999 = max(self.p999, self.p95 + 1e-4)

    # -- inference ----------------------------------------------------------

    def _raw_scores(self, xs: np.ndarray) -> np.ndarray:
        """Deterministic novelty distance, using z = mu.

        Square roots are deliberate: squared error grows quadratically with
        deviation, which drives the calibrated score to saturation while a fault
        is still early. Taking the root makes the quantity a *distance* that
        grows linearly with deviation, so the published score keeps resolving
        differences across the whole degradation trajectory instead of pinning
        at 1.0 the moment a fault becomes visible.
        """
        he, mu, logvar = self.encode(xs)
        _, xhat = self.decode(mu)
        recon = np.sqrt(np.sum((xhat - xs) ** 2, axis=1))
        kl = -0.5 * np.sum(1 + logvar - mu**2 - np.exp(logvar), axis=1)
        return recon + self.beta * np.sqrt(np.maximum(kl, 0.0))

    def score(self, x: np.ndarray) -> dict[str, Any]:
        """Score a single feature vector. Returns a calibrated 0-1 anomaly score."""
        single = np.asarray(x, dtype=float).reshape(1, -1)
        xs = self.standardize(single)
        he, mu, logvar = self.encode(xs)
        _, xhat = self.decode(mu)

        per_feature = ((xhat - xs) ** 2)[0]
        recon = float(np.sqrt(per_feature.sum()))
        kl = float(-0.5 * np.sum(1 + logvar - mu**2 - np.exp(logvar)))
        raw = recon + self.beta * math.sqrt(max(kl, 0.0))

        # Piecewise calibration anchored on the healthy distribution:
        #   p50   -> 0.08  (a typical healthy machine)
        #   p95   -> 0.45  (edge of the healthy envelope — worth watching)
        #   p99.9 -> 0.70  (outside anything seen in healthy operation)
        # then a soft exponential tail. Anchoring at 0.70 rather than 0.85 leaves
        # headroom so that severe and catastrophic states remain distinguishable
        # instead of collapsing onto the same score.
        if raw <= self.p50:
            calibrated = 0.08 * (raw / max(self.p50, 1e-6))
        elif raw <= self.p95:
            calibrated = 0.08 + 0.37 * (raw - self.p50) / (self.p95 - self.p50)
        elif raw <= self.p999:
            calibrated = 0.45 + 0.25 * (raw - self.p95) / (self.p999 - self.p95)
        else:
            over = (raw - self.p999) / max(self.p999 - self.p50, 1e-6)
            calibrated = 0.70 + 0.30 * (1 - math.exp(-over / 2.5))

        return {
            "anomaly_score": float(np.clip(calibrated, 0.0, 1.0)),
            "raw": raw,
            "reconstruction_error": recon,
            "kl_divergence": kl,
            "latent": [round(float(v), 4) for v in mu[0]],
            # Per-feature reconstruction error localises *which* channel is off
            # the healthy manifold — the first hint the Prediction agent uses.
            "per_feature_error": {
                i: float(v) for i, v in enumerate(per_feature)
            },
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
            calib=np.array([self.p50, self.p95, self.p999]),
            dims=np.array([self.n_input, self.n_hidden, self.n_latent]),
            beta=np.array([self.beta]),
        )

    @classmethod
    def load(cls, path: str | Path) -> "VAE":
        data = np.load(Path(path))
        dims = data["dims"]
        model = cls(
            n_input=int(dims[0]),
            n_hidden=int(dims[1]),
            n_latent=int(dims[2]),
            beta=float(data["beta"][0]),
        )
        for name in model._param_names:
            setattr(model, name, data[name])
        model.mean = data["mean"]
        model.scale = data["scale"]
        model.p50, model.p95, model.p999 = (float(v) for v in data["calib"])
        model.trained = True
        return model
