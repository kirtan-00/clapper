"""Detectability — which failure modes a machine's sensor kit can actually resolve.

A predictive-maintenance platform that reports the same confidence for every
machine regardless of what is instrumented is lying by omission. A CNC centre
with no ultrasonic probe cannot cleanly separate bearing wear from rotor
imbalance: both raise vibration, and the signal that distinguishes them
(ultrasonic emission) is simply not being measured. The platform will still
produce a classification, and it will still be useful, but the honest thing to do
is say which diagnoses this asset's instrumentation can and cannot support.

Detectability is computed by intersecting each failure mode's signature channels
(weighted by sensitivity) with the channels the machine's sensors observe. It
feeds three things: a coverage badge in the UI, a gap report telling a planner
which single device would most improve coverage, and preset selection for demo
scenarios so a mode is only injected where it can be seen.
"""

from __future__ import annotations

from typing import Any

from ..physics import FAILURE_SIGNATURES
from .features import KIND_TO_CHANNEL
from .fusion import RELEVANCE

# Detectability at or above this is considered adequate for confident diagnosis.
GOOD_COVERAGE = 0.70
MARGINAL_COVERAGE = 0.45


def observable_channels(sensor_kinds: list[str]) -> dict[str, float]:
    """Best relevance achievable per canonical channel from these sensor kinds."""
    observable: dict[str, float] = {}
    for kind in sensor_kinds:
        for channel, relevance in RELEVANCE.get(kind, {}).items():
            observable[channel] = max(observable.get(channel, 0.0), relevance)
        # A sensor always observes its own primary channel directly.
        primary = KIND_TO_CHANNEL.get(kind)
        if primary:
            observable[primary] = max(observable.get(primary, 0.0), 1.0)
    return observable


def _signature_channels(mode: str) -> dict[str, float]:
    """Signature channels, mapped onto channels a sensor can actually observe.

    Derived features (`vib_peak`, `vib_crest`, `temp_rise`, trends) are computed
    from a base channel rather than measured, so they are credited to whichever
    sensor supplies that base.
    """
    derived_from = {
        "vib_peak": "vib_rms", "vib_crest": "vib_rms", "vib_trend": "vib_rms",
        "temp_rise": "temp_c", "temp_trend": "temp_c",
        "current_imbalance": "current_a",
    }
    mapped: dict[str, float] = {}
    for channel, sensitivity in FAILURE_SIGNATURES.get(mode, {}).items():
        base = derived_from.get(channel, channel)
        mapped[base] = mapped.get(base, 0.0) + abs(sensitivity)
    return mapped


def mode_detectability(mode: str, sensor_kinds: list[str]) -> dict[str, Any]:
    """Score how well this sensor kit can detect one failure mode."""
    required = _signature_channels(mode)
    if not required:
        return {"mode": mode, "score": 0.0, "band": "none", "missing": []}

    observable = observable_channels(sensor_kinds)
    total_weight = sum(required.values())
    covered = 0.0
    missing: list[str] = []

    for channel, weight in required.items():
        relevance = observable.get(channel, 0.0)
        covered += weight * min(1.0, relevance)
        if relevance < 0.4:
            missing.append(channel)

    score = covered / total_weight if total_weight else 0.0
    band = (
        "good" if score >= GOOD_COVERAGE
        else "marginal" if score >= MARGINAL_COVERAGE
        else "poor"
    )
    return {
        "mode": mode,
        "score": round(score, 3),
        "band": band,
        "missing": sorted(missing),
    }


def assess(sensor_kinds: list[str]) -> dict[str, Any]:
    """Full detectability report for a machine's sensor kit."""
    modes = [mode_detectability(mode, sensor_kinds) for mode in FAILURE_SIGNATURES]
    modes.sort(key=lambda m: m["score"], reverse=True)

    scores = [m["score"] for m in modes]
    overall = sum(scores) / len(scores) if scores else 0.0

    # Which single additional device would improve coverage most? Answering this
    # turns a limitation into a concrete, costed recommendation.
    gaps: dict[str, float] = {}
    for mode in modes:
        if mode["band"] == "good":
            continue
        for channel in mode["missing"]:
            gaps[channel] = gaps.get(channel, 0.0) + (1.0 - mode["score"])

    recommendation = None
    if gaps:
        channel = max(gaps.items(), key=lambda kv: kv[1])[0]
        device_for_channel = {
            "ultrasonic_db": ("ultrasonic", "Airborne ultrasonic probe"),
            "vib_rms": ("vibration", "Wireless triaxial accelerometer"),
            "temp_c": ("thermal", "Thermal imaging camera"),
            "current_a": ("current", "Split-core current clamp"),
            "power_kw": ("power", "Three-phase power meter"),
            "acoustic_db": ("acoustic", "Industrial microphone array"),
            "pressure_bar": ("pressure", "Inline pressure transmitter"),
            "speed_rpm": ("speed", "Optical tachometer"),
        }.get(channel)
        if device_for_channel:
            kind, device = device_for_channel
            improved = assess_with_extra(sensor_kinds, kind)
            recommendation = {
                "channel": channel,
                "sensor_kind": kind,
                "device": device,
                "current_score": round(overall, 3),
                "projected_score": round(improved, 3),
                "improvement": round(improved - overall, 3),
            }

    return {
        "overall": round(overall, 3),
        "band": (
            "good" if overall >= GOOD_COVERAGE
            else "marginal" if overall >= MARGINAL_COVERAGE
            else "poor"
        ),
        "modes": modes,
        "well_covered": [m["mode"] for m in modes if m["band"] == "good"],
        "poorly_covered": [m["mode"] for m in modes if m["band"] == "poor"],
        "recommendation": recommendation,
    }


def assess_with_extra(sensor_kinds: list[str], extra_kind: str) -> float:
    """Overall detectability if one more device kind were added."""
    kinds = list(sensor_kinds) + [extra_kind]
    scores = [
        mode_detectability(mode, kinds)["score"] for mode in FAILURE_SIGNATURES
    ]
    return sum(scores) / len(scores) if scores else 0.0
