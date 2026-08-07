"""Feature engineering: raw sensor windows -> a fixed 16-dim machine state vector.

Why a canonical vector
----------------------
A cement kiln drive and a pharma tablet press expose completely different sensor
tags. Every downstream model (VAE, multi-task MLP, SHAP explainer) works on one
*canonical, machine-agnostic* feature vector so a single trained model
generalises across all ten supported industries. Adding a new machine type means
mapping its tags onto these channels — not retraining a bespoke model.

Scaling convention
------------------
Each channel is normalised against the sensor's declared `nominal` so that
**1.0 == healthy nominal operation**. Deviations are therefore directly
comparable across channels and units, which is also what makes SHAP attributions
readable ("vib_rms at 1.9x nominal").
"""

from __future__ import annotations

import math
from typing import Any, Sequence

import numpy as np

# Canonical feature order. Index positions are a wire contract: persisted model
# weights depend on it, so append-only changes here require a model version bump.
FEATURE_NAMES: list[str] = [
    "vib_rms",           # broadband vibration energy
    "vib_peak",          # peak amplitude in window
    "vib_crest",         # peak / rms — impulsiveness, an early bearing marker
    "temp_c",            # body/bearing temperature
    "temp_rise",         # temperature above ambient
    "current_a",         # motor current draw
    "current_imbalance", # phase imbalance proxy
    "power_kw",          # electrical power
    "acoustic_db",       # airborne sound level
    "ultrasonic_db",     # 20-100 kHz — friction, leaks, early lubrication loss
    "ambient_c",         # environment temperature
    "humidity_pct",      # environment humidity
    "speed_rpm",         # process speed
    "pressure_bar",      # process pressure
    "vib_trend",         # slope of vibration across window
    "temp_trend",        # slope of temperature across window
]
N_FEATURES = len(FEATURE_NAMES)
FEATURE_INDEX = {name: i for i, name in enumerate(FEATURE_NAMES)}

# Peak-to-RMS ratio of a healthy machine's vibration window.
#
# This constant is shared by the training-set generator and the runtime feature
# builder, and it must stay shared. A healthy broadband vibration signal is a
# steady level plus noise, not a sinusoid, so its measured crest sits just above
# 1.0 — not the textbook 1.41. Normalising by it makes a healthy crest read 1.0
# on the same scale as every other channel. Defining it in two places is how the
# runtime feature distribution silently drifts away from the one the models were
# fitted on, which reads as every healthy machine being anomalous.
HEALTHY_CREST_RATIO = 1.05

# Phase-imbalance estimation from a single current measurement.
#
# Textbook phase imbalance needs three current channels. Real retrofit
# installations have one clamp, and even instrumented drives usually publish a
# single aggregate current — so an imbalance feature that requires three
# channels is a feature that is never populated in the field, and the model
# silently loses the single most decisive electrical-fault signal.
#
# Unbalanced phases modulate the measured line current, so imbalance shows up as
# excess variability within the measurement window. We estimate it as the
# coefficient of variation above the healthy noise floor, scaled so the result
# lands on the same 0-1.45 range the training signatures use.
# The floor sits above the noisiest healthy current sensor in the fleet
# (nominal sigma 0.022, up to 0.028 with unit variation) so ordinary measurement
# noise never registers as imbalance. Margin here is cheap; a false electrical-
# fault alert is not.
CURRENT_CV_HEALTHY = 0.038
CURRENT_CV_SCALE = 0.10

# Human-readable labels used in explanations and the UI.
FEATURE_LABELS: dict[str, str] = {
    "vib_rms": "Vibration RMS",
    "vib_peak": "Vibration peak",
    "vib_crest": "Vibration crest factor",
    "temp_c": "Body temperature",
    "temp_rise": "Temperature rise over ambient",
    "current_a": "Motor current",
    "current_imbalance": "Phase current imbalance",
    "power_kw": "Power draw",
    "acoustic_db": "Acoustic level",
    "ultrasonic_db": "Ultrasonic level",
    "ambient_c": "Ambient temperature",
    "humidity_pct": "Relative humidity",
    "speed_rpm": "Process speed",
    "pressure_bar": "Process pressure",
    "vib_trend": "Vibration trend",
    "temp_trend": "Temperature trend",
}

# Which canonical channel each sensor kind primarily feeds.
KIND_TO_CHANNEL: dict[str, str] = {
    "vibration": "vib_rms",
    "temperature": "temp_c",
    "thermal": "temp_c",
    "current": "current_a",
    "power": "power_kw",
    "acoustic": "acoustic_db",
    "ultrasonic": "ultrasonic_db",
    "ambient_temp": "ambient_c",
    "humidity": "humidity_pct",
    "speed": "speed_rpm",
    "pressure": "pressure_bar",
}


def clean_window(values: Sequence[float | None]) -> list[float]:
    """Drop missing samples and remove single-sample spikes.

    Sensor streams in the field carry dropouts and impulse noise from EMI. We
    handle both before any statistic is computed:
      * `None` (dropped sample) is removed rather than zero-filled — zero-filling
        would masquerade as a real low reading.
      * A 3-point median filter suppresses single-sample spikes while preserving
        genuine step changes, which matter for fault detection.
    """
    present = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    if len(present) < 3:
        return present
    smoothed = [present[0]]
    for i in range(1, len(present) - 1):
        smoothed.append(sorted(present[i - 1 : i + 2])[1])
    smoothed.append(present[-1])
    return smoothed


# Fraction of the window used for *level* statistics. Level and trend need
# different time bases and must not share one.
LEVEL_TAIL_FRACTION = 0.25
LEVEL_TAIL_MIN = 8


def window_stats(values: Sequence[float | None]) -> dict[str, float]:
    """Summary statistics for one sensor window.

    Level statistics (mean, RMS, peak) are computed over the **recent tail**;
    the slope is computed over the **whole window**.

    This split matters more than it looks. Averaging level over the full window
    mixes pre-fault and post-fault samples, so a fault that developed over the
    last minute reads at roughly half its true magnitude — the platform
    under-reports severity and over-estimates remaining life exactly while a
    fault is developing, which is the moment the product exists to get right.
    The slope genuinely wants the long baseline, so it keeps it.
    """
    clean = clean_window(values)
    if not clean:
        return {"mean": 0.0, "rms": 0.0, "peak": 0.0, "std": 0.0, "slope": 0.0, "n": 0}

    arr = np.asarray(clean, dtype=float)
    tail_n = max(LEVEL_TAIL_MIN, int(round(arr.size * LEVEL_TAIL_FRACTION)))
    tail = arr[-tail_n:] if arr.size > tail_n else arr

    slope = 0.0
    if arr.size >= 4:
        x = np.arange(arr.size, dtype=float)
        # Least-squares slope, expressed per-window so it is window-length agnostic.
        slope = float(np.polyfit(x, arr, 1)[0] * arr.size)

    return {
        "mean": float(tail.mean()),
        "rms": float(np.sqrt(np.mean(tail**2))),
        "peak": float(np.max(np.abs(tail))),
        "std": float(tail.std()),
        "slope": slope,
        "n": int(arr.size),
        "level_samples": int(tail.size),
        # Dispersion over the *full* window. A standard deviation estimated from
        # ~16 tail samples is itself noisy enough to fake a signal, so anything
        # that reads variance as physics (phase imbalance) needs the long
        # baseline even though levels do not.
        "full_mean": float(arr.mean()),
        "full_std": float(arr.std()),
    }


def missing_ratio(values: Sequence[float | None]) -> float:
    if not values:
        return 1.0
    missing = sum(1 for v in values if v is None)
    return missing / len(values)


def build_vector(channels: dict[str, dict[str, float]]) -> np.ndarray:
    """Assemble the canonical vector from per-channel estimates.

    `channels` maps a canonical channel name to `{"value": .., "nominal": ..}`.
    Channels with no contributing sensor default to 1.0 (nominal) so a missing
    signal never *looks like* a fault — it is reported separately as reduced
    confidence by the Monitoring agent.
    """
    vec = np.ones(N_FEATURES, dtype=float)

    def norm(name: str, default: float = 1.0) -> float:
        entry = channels.get(name)
        if not entry:
            return default
        nominal = entry.get("nominal") or 1.0
        if nominal == 0:
            return default
        return float(entry["value"]) / float(nominal)

    vib = norm("vib_rms")
    vec[FEATURE_INDEX["vib_rms"]] = vib
    peak = channels.get("vib_rms", {}).get("peak_ratio")
    # Fall back to the *shared* healthy crest ratio, not a separate constant —
    # any second definition of this number is a train/serve skew waiting to
    # happen.
    vec[FEATURE_INDEX["vib_peak"]] = (
        float(peak) if peak else vib * HEALTHY_CREST_RATIO
    )
    crest = channels.get("vib_rms", {}).get("crest")
    vec[FEATURE_INDEX["vib_crest"]] = float(crest) if crest else 1.0

    temp = norm("temp_c")
    ambient = norm("ambient_c")
    vec[FEATURE_INDEX["temp_c"]] = temp
    vec[FEATURE_INDEX["ambient_c"]] = ambient
    # Temperature rise isolates machine-generated heat from a hot factory floor —
    # without it, a summer afternoon reads as a developing fault.
    vec[FEATURE_INDEX["temp_rise"]] = max(0.0, temp - ambient) + 1.0

    vec[FEATURE_INDEX["current_a"]] = norm("current_a")
    imbalance = channels.get("current_a", {}).get("imbalance")
    vec[FEATURE_INDEX["current_imbalance"]] = 1.0 + float(imbalance or 0.0)
    vec[FEATURE_INDEX["power_kw"]] = norm("power_kw")
    vec[FEATURE_INDEX["acoustic_db"]] = norm("acoustic_db")
    vec[FEATURE_INDEX["ultrasonic_db"]] = norm("ultrasonic_db")
    vec[FEATURE_INDEX["humidity_pct"]] = norm("humidity_pct")
    vec[FEATURE_INDEX["speed_rpm"]] = norm("speed_rpm")
    vec[FEATURE_INDEX["pressure_bar"]] = norm("pressure_bar")

    vib_slope = channels.get("vib_rms", {}).get("slope_ratio", 0.0)
    temp_slope = channels.get("temp_c", {}).get("slope_ratio", 0.0)
    vec[FEATURE_INDEX["vib_trend"]] = 1.0 + float(vib_slope)
    vec[FEATURE_INDEX["temp_trend"]] = 1.0 + float(temp_slope)

    # Clip to a physically plausible band. Guards the models against a wild
    # sensor value (unplugged probe reading full-scale) dominating everything.
    return np.clip(vec, 0.0, 6.0)


def describe_vector(vec: np.ndarray) -> list[dict[str, Any]]:
    """Render a feature vector for API/UI consumption."""
    return [
        {
            "feature": name,
            "label": FEATURE_LABELS[name],
            "value": round(float(vec[i]), 4),
            "deviation": round(float(vec[i]) - 1.0, 4),
        }
        for i, name in enumerate(FEATURE_NAMES)
    ]
