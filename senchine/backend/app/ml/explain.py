"""Explainable AI — Monte-Carlo Shapley attribution over the failure-probability head.

Why Shapley rather than "top deviating sensor"
----------------------------------------------
Sorting features by how far they sit from nominal is not an explanation: it
ignores the model entirely and will happily blame ambient humidity because the
factory is damp. Shapley values answer the question a maintenance planner
actually asks — *how much did each signal move this prediction?* — and carry the
efficiency guarantee that the attributions sum to the gap between this
prediction and the fleet-baseline prediction, so the explanation is complete
rather than a hand-picked highlight.

Implementation
--------------
Exact Shapley over 16 features needs 2^16 coalitions. We use the standard
permutation-sampling estimator, which is unbiased and converges quickly on a
smooth model, and we evaluate every sampled coalition in a *single* batched
forward pass — the whole explanation costs one matrix multiply and lands in
single-digit milliseconds, which is what makes it affordable to attach to every
prediction rather than offering it as an opt-in "explain" button.
"""

from __future__ import annotations

from typing import Any, Callable

import numpy as np

from .features import FEATURE_LABELS, FEATURE_NAMES, N_FEATURES


def shapley_values(
    predict_fn: Callable[[np.ndarray], np.ndarray],
    x: np.ndarray,
    baseline: np.ndarray,
    n_permutations: int = 96,
    seed: int = 3,
) -> np.ndarray:
    """Estimate Shapley values for `x` against `baseline`.

    `predict_fn` must accept an (M, n_features) matrix and return (M,) scores.
    """
    rng = np.random.default_rng(seed)
    x = np.asarray(x, dtype=float).ravel()
    baseline = np.asarray(baseline, dtype=float).ravel()
    n = x.size

    # Build every intermediate coalition point up front: for each permutation we
    # walk from baseline to x one feature at a time, giving n+1 points.
    points = np.empty((n_permutations, n + 1, n), dtype=float)
    perms = np.empty((n_permutations, n), dtype=int)
    for p in range(n_permutations):
        perm = rng.permutation(n)
        perms[p] = perm
        current = baseline.copy()
        points[p, 0] = current
        for step, feature in enumerate(perm, start=1):
            current = current.copy()
            current[feature] = x[feature]
            points[p, step] = current

    scores = predict_fn(points.reshape(-1, n)).reshape(n_permutations, n + 1)
    deltas = np.diff(scores, axis=1)  # (P, n) marginal contribution per step

    phi = np.zeros(n, dtype=float)
    for p in range(n_permutations):
        phi[perms[p]] += deltas[p]
    return phi / n_permutations


def explain_prediction(
    predict_fn: Callable[[np.ndarray], np.ndarray],
    x: np.ndarray,
    baseline: np.ndarray,
    top_k: int = 6,
    n_permutations: int = 96,
) -> dict[str, Any]:
    """Full, presentation-ready explanation of one failure-probability prediction."""
    x = np.asarray(x, dtype=float).ravel()
    baseline = np.asarray(baseline, dtype=float).ravel()

    phi = shapley_values(predict_fn, x, baseline, n_permutations=n_permutations)
    base_score = float(predict_fn(baseline.reshape(1, -1))[0])
    actual = float(predict_fn(x.reshape(1, -1))[0])

    order = np.argsort(-np.abs(phi))
    contributions = []
    for idx in order[:top_k]:
        name = FEATURE_NAMES[idx]
        contributions.append(
            {
                "feature": name,
                "label": FEATURE_LABELS[name],
                "shap_value": round(float(phi[idx]), 5),
                "direction": "increases risk" if phi[idx] > 0 else "reduces risk",
                "observed": round(float(x[idx]), 4),
                "baseline": round(float(baseline[idx]), 4),
                "deviation_pct": round(
                    100.0 * (float(x[idx]) - float(baseline[idx]))
                    / max(abs(float(baseline[idx])), 1e-6),
                    1,
                ),
            }
        )

    # Efficiency residual: how much of (actual - baseline) the sampled
    # attributions failed to account for. Reported rather than hidden — a large
    # residual means the explanation should be trusted less.
    residual = actual - base_score - float(phi.sum())

    return {
        "method": "monte-carlo-shapley",
        "permutations": n_permutations,
        "baseline_score": round(base_score, 5),
        "predicted_score": round(actual, 5),
        "contributions": contributions,
        "attribution_residual": round(float(residual), 5),
        "explanation_quality": round(
            float(np.clip(1.0 - abs(residual) / max(abs(actual - base_score), 1e-6), 0, 1)),
            4,
        ),
    }


def narrate(explanation: dict[str, Any], category_label: str) -> str:
    """Turn attributions into a grounded one-paragraph root-cause summary.

    Deliberately templated from the numbers, not generated: this text appears on
    work orders, so it must be reproducible and impossible to hallucinate. The
    Copilot may paraphrase it, but this is the authoritative version.
    """
    contributions = [c for c in explanation["contributions"] if c["shap_value"] > 0]
    if not contributions:
        return (
            "No signal is currently pushing this machine's risk above the fleet "
            "baseline; all channels sit within their healthy envelope."
        )

    lead = contributions[0]
    parts = [
        f"{category_label} is indicated primarily by {lead['label'].lower()} at "
        f"{lead['observed']:.2f}x nominal "
        f"({lead['deviation_pct']:+.0f}% versus the healthy baseline), which "
        f"contributes {lead['shap_value']:+.3f} to the failure probability."
    ]
    if len(contributions) > 1:
        supporting = ", ".join(
            f"{c['label'].lower()} ({c['shap_value']:+.3f})" for c in contributions[1:3]
        )
        parts.append(f"Supporting evidence: {supporting}.")
    if explanation["explanation_quality"] < 0.85:
        parts.append(
            "Attribution residual is elevated, so treat the ranking as indicative "
            "rather than definitive."
        )
    return " ".join(parts)


def fleet_baseline(vectors: np.ndarray) -> np.ndarray:
    """Baseline for attribution: the median healthy machine state.

    Median rather than mean so a handful of already-degrading machines in the
    reference window cannot drag the baseline toward fault.
    """
    arr = np.asarray(vectors, dtype=float)
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    if arr.size == 0:
        return np.ones(N_FEATURES)
    return np.median(arr, axis=0)
