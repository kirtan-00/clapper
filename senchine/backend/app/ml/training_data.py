"""Synthetic training-set generator grounded in failure physics.

Real plants do not have labelled failure data — that is the central obstacle to
predictive maintenance, not an artefact of this being a prototype. Machines that
fail often get replaced or repaired without the sensor trace being kept, and
labels for "which failure mode was developing 200 hours before the breakdown"
essentially never exist.

So we generate the training set from documented failure signatures. Each failure
mode has a characteristic multi-channel fingerprint drawn from condition-
monitoring literature: bearing wear raises impulsive vibration and ultrasonic
emission long before body temperature moves; lubrication breakdown shows up in
ultrasound first; an electrical fault shows current imbalance with barely any
vibration change. Severity ramps continuously from healthy to failed, so the
model learns the *trajectory*, not just the endpoint — which is what makes RUL
estimation possible at all.

The same generator drives the runtime simulator, so what the models were trained
on and what the platform observes come from one shared physical description.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..physics import FAILURE_SIGNATURES, PROGRESSION_RATE
from .features import (
    FEATURE_INDEX,
    HEALTHY_CREST_RATIO,
    KIND_TO_CHANNEL,
    N_FEATURES,
)
from .fusion import DECAY_M
from .mlp import CATEGORY_INDEX, FAILURE_CATEGORIES, RUL_CEILING_HOURS

# Percentage of fault samples presented as EdgeSense retrofit observations.
EDGE_AUGMENTATION_PCT = 40

# Trend channels measure a *rate of change*, not a damage level. Everything else
# in the signature scales with severity; these two scale with how fast severity
# is currently moving.
TREND_CHANNELS = frozenset({"vib_trend", "temp_trend"})


def apply_signature(
    base: np.ndarray,
    category: str,
    severity: float,
    rate: float | None = None,
) -> np.ndarray:
    """Impose a failure fingerprint at a given damage level and progression rate.

    Severity and rate are deliberately independent inputs, because physically
    they are independent states. A bearing can sit at 80% damage with a flat
    trend (stable, arrested wear) or at 30% damage climbing fast (a lubrication
    supply that just failed). Those two machines need very different remaining-
    life estimates, and the trend channels are the only thing that distinguishes
    them.

    Training them as if the trend were proportional to severity teaches the model
    that a fully-developed fault must *also* show a steep trend. At runtime a
    saturated fault has a flat trend, the vector then looks like a much milder
    fault, and remaining life is over-estimated exactly when it matters most.
    """
    if rate is None:
        rate = severity
    vec = base.copy()
    for channel, sensitivity in FAILURE_SIGNATURES.get(category, {}).items():
        idx = FEATURE_INDEX[channel]
        driver = rate if channel in TREND_CHANNELS else severity
        vec[idx] = vec[idx] * (1.0 + sensitivity * driver)
    return vec


def healthy_vector(rng: np.random.Generator, duty: float = 1.0) -> np.ndarray:
    """A plausible healthy operating point.

    `duty` models load: a machine at 60% load genuinely runs cooler and quieter,
    and the VAE must learn that this is normal rather than anomalous.
    """
    vec = np.ones(N_FEATURES, dtype=float)
    load = np.clip(duty, 0.35, 1.15)

    vec[FEATURE_INDEX["vib_rms"]] = 0.85 + 0.30 * load
    # Peak tracks RMS at the healthy crest ratio — the same constant the runtime
    # feature builder normalises by, so training and inference agree.
    vec[FEATURE_INDEX["vib_peak"]] = vec[FEATURE_INDEX["vib_rms"]] * HEALTHY_CREST_RATIO
    vec[FEATURE_INDEX["vib_crest"]] = 1.0
    vec[FEATURE_INDEX["temp_c"]] = 0.80 + 0.28 * load
    vec[FEATURE_INDEX["ambient_c"]] = 1.0
    vec[FEATURE_INDEX["temp_rise"]] = 1.0 + max(0.0, vec[FEATURE_INDEX["temp_c"]] - 1.0)
    vec[FEATURE_INDEX["current_a"]] = 0.70 + 0.35 * load
    vec[FEATURE_INDEX["current_imbalance"]] = 1.0
    vec[FEATURE_INDEX["power_kw"]] = 0.65 + 0.40 * load
    vec[FEATURE_INDEX["acoustic_db"]] = 0.88 + 0.18 * load
    vec[FEATURE_INDEX["ultrasonic_db"]] = 0.92 + 0.12 * load
    vec[FEATURE_INDEX["humidity_pct"]] = 1.0
    vec[FEATURE_INDEX["speed_rpm"]] = 0.90 + 0.14 * load
    vec[FEATURE_INDEX["pressure_bar"]] = 0.85 + 0.22 * load
    vec[FEATURE_INDEX["vib_trend"]] = 1.0
    vec[FEATURE_INDEX["temp_trend"]] = 1.0

    # Measurement noise and unit-to-unit variation.
    vec *= 1.0 + rng.normal(0.0, 0.035, size=N_FEATURES)
    return np.clip(vec, 0.05, 6.0)


def edge_transfer_profile() -> dict[str, float]:
    """Per-channel deviation transfer for a standard EdgeSense retrofit kit.

    An external device sees an attenuated version of the machine's true
    deviation, and the attenuation differs per modality: a clamp-on accelerometer
    at 0.35 m loses very little, a thermal camera at 3 m loses a third, a current
    clamp is a galvanic connection and loses nothing. The result is that a
    retrofitted machine's fault signature is not just weaker — it is *reshaped*,
    with the channel ratios that distinguish one failure mode from another
    distorted relative to each other.

    Derived from the real kit geometry rather than guessed, so training-time
    augmentation matches what the fusion layer actually produces at runtime.
    """
    from ..sim.profiles import STANDARD_EDGE_KIT

    transfer: dict[str, float] = {}
    for spec in STANDARD_EDGE_KIT:
        decay = DECAY_M.get(spec.kind, 3.0)
        # Matches the simulator's measurement model exactly.
        factor = float(np.exp(-spec.distance_m / (2.0 * decay)))
        channel = KIND_TO_CHANNEL.get(spec.kind)
        if channel:
            transfer[channel] = max(transfer.get(channel, 0.0), factor)

    # Derived features inherit their base channel's transfer.
    for derived, base in (
        ("vib_peak", "vib_rms"), ("vib_crest", "vib_rms"), ("vib_trend", "vib_rms"),
        ("temp_rise", "temp_c"), ("temp_trend", "temp_c"),
        ("current_imbalance", "current_a"),
    ):
        if base in transfer:
            transfer[derived] = transfer[base]
    return transfer


def apply_edge_observation(
    vec: np.ndarray, transfer: dict[str, float], rng: np.random.Generator
) -> np.ndarray:
    """Reshape a true-state vector into what a retrofit kit would observe."""
    observed = vec.copy()
    for channel, factor in transfer.items():
        idx = FEATURE_INDEX.get(channel)
        if idx is None:
            continue
        # Installation-to-installation variation in mounting distance.
        jittered = float(np.clip(factor * rng.uniform(0.85, 1.12), 0.3, 1.0))
        observed[idx] = 1.0 + (observed[idx] - 1.0) * jittered
    return observed


def severity_to_rul(
    category: str, severity: float, rng: np.random.Generator, rate: float = 0.5
) -> float:
    """Remaining useful life from damage level *and* how fast it is progressing.

    Degradation is super-linear near the end of life — the last 20% of severity
    consumes far more than 20% of remaining life — so the exponent is > 1. The
    rate term is what makes the estimate a real forecast rather than a lookup on
    current damage: the same 60%-worn bearing has months left if it is stable and
    days left if it is accelerating.
    """
    mode_rate = PROGRESSION_RATE.get(category, 0.7)
    remaining = max(0.0, 1.0 - severity) ** 2.2
    rul = RUL_CEILING_HOURS * mode_rate * remaining
    # A fast-moving fault consumes its remaining life proportionally faster.
    rul /= 0.55 + 1.45 * max(0.0, min(1.0, rate))
    rul *= 1.0 + rng.normal(0.0, 0.12)
    return float(np.clip(rul, 0.5, RUL_CEILING_HOURS))


def severity_to_probability(
    severity: float, rng: np.random.Generator, rate: float = 0.5
) -> float:
    """Probability of failure inside the planning horizon (~2 weeks).

    Rate contributes: a fault that is climbing is more likely to cross the
    failure threshold inside the horizon than a stable one at the same level.
    """
    logit = -4.2 + 8.2 * severity + 1.4 * max(0.0, min(1.0, rate))
    prob = 1.0 / (1.0 + np.exp(-logit))
    prob = float(np.clip(prob + rng.normal(0.0, 0.03), 0.001, 0.999))
    return prob


def generate(
    n_healthy: int = 2600, n_per_fault: int = 700, seed: int = 23
) -> dict[str, Any]:
    """Build the full supervised training set plus the healthy-only VAE set."""
    rng = np.random.default_rng(seed)
    xs: list[np.ndarray] = []
    y_prob: list[float] = []
    y_rul: list[float] = []
    y_cat: list[int] = []
    healthy_only: list[np.ndarray] = []

    for _ in range(n_healthy):
        duty = rng.uniform(0.4, 1.1)
        vec = healthy_vector(rng, duty)
        healthy_only.append(vec)
        xs.append(vec)
        y_prob.append(severity_to_probability(rng.uniform(0.0, 0.06), rng, rate=0.0))
        y_rul.append(RUL_CEILING_HOURS * rng.uniform(0.85, 1.0))
        y_cat.append(CATEGORY_INDEX["healthy"])

    transfer = edge_transfer_profile()

    fault_categories = [c for c in FAILURE_CATEGORIES if c != "healthy"]
    for category in fault_categories:
        for i in range(n_per_fault):
            duty = rng.uniform(0.4, 1.1)
            # Beta(1.6, 1.4) samples the whole degradation trajectory with a
            # slight bias toward mid/late stage, where labels matter most.
            severity = float(rng.beta(1.6, 1.4))
            # Progression rate is sampled largely independently of severity, so
            # the model sees stable-but-damaged and mild-but-accelerating
            # machines as distinct states. The mild correlation reflects reality:
            # advanced damage does tend to progress faster, but not always.
            rate = float(np.clip(rng.beta(1.5, 1.8) * 0.75 + severity * 0.3, 0.0, 1.0))
            vec = apply_signature(healthy_vector(rng, duty), category, severity, rate)

            # Augmentation: a share of every failure mode is presented as a
            # retrofit *observation* rather than a direct measurement. Without
            # this the classifier only ever learns the undistorted signature and
            # systematically mislabels legacy assets — which are precisely the
            # ones this platform exists to cover.
            if i % 100 < EDGE_AUGMENTATION_PCT:
                vec = apply_edge_observation(vec, transfer, rng)

            vec = np.clip(vec * (1.0 + rng.normal(0.0, 0.025, size=N_FEATURES)), 0.05, 6.0)
            xs.append(vec)
            y_prob.append(severity_to_probability(severity, rng, rate))
            y_rul.append(severity_to_rul(category, severity, rng, rate))
            y_cat.append(CATEGORY_INDEX[category])

    return {
        "x": np.asarray(xs),
        "y_prob": np.asarray(y_prob),
        "y_rul": np.asarray(y_rul),
        "y_cat": np.asarray(y_cat),
        "healthy": np.asarray(healthy_only),
    }
