"""EdgeSense Retrofit — sensor fusion for machines with no onboard instrumentation.

The problem
-----------
Most of the installed base in heavy industry predates IoT. A 1998 gearbox has no
CAN bus, no Modbus register, no telemetry of any kind. Conventional predictive
maintenance platforms simply cannot see these machines, which is exactly where
unplanned downtime concentrates.

The approach
------------
Do not instrument the machine — instrument its *neighbourhood*. Clamp-on and
non-contact devices (accelerometer, thermal camera, current clamp, power meter,
microphone, ultrasonic probe, industrial camera, environmental sensors) each
observe the machine indirectly. Any one of them is a weak, biased estimator of
the machine's true state. Fused with the right weights, they become a usable
one.

Every device/channel pair carries three multiplicative weights:

1. **Relevance** — how directly this modality observes this channel. An
   accelerometer bolted to the frame measures vibration almost directly (0.95);
   a microphone infers it from radiated sound (0.55).
2. **Distance attenuation** — `exp(-d / decay)`, with a modality-specific decay
   length. Structure-borne vibration dies within a metre; airborne sound carries
   several; a current clamp is a galvanic connection and does not attenuate.
3. **Signal quality** — live sensor health, degraded by dropouts and faults.

Confidence, not just a number
-----------------------------
Every fused estimate is published with a calibrated confidence built from
*coverage* (how much total evidence weight backs the channel) and *agreement*
(do independent estimators concur). One noisy microphone at 6 m yields a low
confidence, and the platform says so rather than presenting a guess as a
measurement. This is what makes the estimate safe to act on: downstream agents
widen their thresholds when confidence is low, and the UI marks it visibly.
"""

from __future__ import annotations

import math
from typing import Any

# device kind -> channel -> relevance in [0, 1]
RELEVANCE: dict[str, dict[str, float]] = {
    "vibration":    {"vib_rms": 0.95, "speed_rpm": 0.35},
    "acoustic":     {"acoustic_db": 1.00, "vib_rms": 0.55, "speed_rpm": 0.30},
    "ultrasonic":   {"ultrasonic_db": 1.00, "vib_rms": 0.45},
    "thermal":      {"temp_c": 0.85},
    "temperature":  {"temp_c": 0.92},
    "current":      {"current_a": 0.95, "power_kw": 0.60},
    "power":        {"power_kw": 0.98, "current_a": 0.70},
    "camera":       {"speed_rpm": 0.60, "vib_rms": 0.20},
    "ambient_temp": {"ambient_c": 1.00},
    "humidity":     {"humidity_pct": 1.00},
    "speed":        {"speed_rpm": 0.95},
    "pressure":     {"pressure_bar": 0.95},
}

# Modality-specific attenuation decay length in metres. Electrical measurements
# are wired, so distance is irrelevant (represented as a very long decay).
DECAY_M: dict[str, float] = {
    # Retrofit accelerometers and clamp-on probes are bolted to the machine
    # frame, so sub-metre offsets are normal mounting practice, not a signal
    # quality problem. The decay lengths reflect distance from the *fault
    # source* for a correctly installed device.
    "vibration": 1.8,
    "acoustic": 4.0,
    "ultrasonic": 2.5,
    "thermal": 3.5,
    "temperature": 2.0,
    "current": 1e6,
    "power": 1e6,
    "camera": 6.0,
    "ambient_temp": 25.0,
    "humidity": 25.0,
    "speed": 1.5,
    "pressure": 1.5,
}

# How much each channel matters when rolling per-channel confidence into one
# machine-level number.
CHANNEL_IMPORTANCE: dict[str, float] = {
    "vib_rms": 1.00,
    "temp_c": 0.90,
    "current_a": 0.70,
    "power_kw": 0.55,
    "ultrasonic_db": 0.50,
    "acoustic_db": 0.40,
    "speed_rpm": 0.35,
    "pressure_bar": 0.30,
    "ambient_c": 0.15,
    "humidity_pct": 0.10,
}

# Evidence weight at which coverage is considered saturated. Tuned so a single
# well-mounted, healthy device (effective weight ~0.8) reaches ~0.77 coverage,
# and two corroborating devices approach saturation.
COVERAGE_SCALE = 0.45
# Confidence ceiling for a channel backed by exactly one indirect estimator —
# an unverifiable reading should never present as certain.
SINGLE_SOURCE_CEILING = 0.74
# A purpose-mounted contact device this close to the fault source is treated as
# a direct measurement rather than an inference, and is not capped.
DIRECT_RELEVANCE = 0.90
DIRECT_ATTENUATION = 0.75
# Channels at or above this importance drive the machine-level confidence roll-up.
PRIMARY_IMPORTANCE = 0.5


def attenuation(kind: str, distance_m: float) -> float:
    decay = DECAY_M.get(kind, 3.0)
    return math.exp(-max(0.0, distance_m) / decay)


def quality_factor(status: str, missing: float, noisy: float = 0.0) -> float:
    """Map live sensor condition onto a [0, 1] trust multiplier."""
    base = {
        "ok": 1.0,
        "noisy": 0.72,
        "degraded": 0.5,
        "stuck": 0.18,
        "fault": 0.0,
        "offline": 0.0,
    }.get(status, 0.6)
    return max(0.0, base * (1.0 - 0.85 * missing) * (1.0 - 0.3 * noisy))


class Contribution:
    """One device's estimate of one canonical channel."""

    __slots__ = ("channel", "sensor_tag", "device", "kind", "value", "weight", "parts")

    def __init__(
        self,
        channel: str,
        sensor_tag: str,
        device: str,
        kind: str,
        value: float,
        weight: float,
        parts: dict[str, float],
    ) -> None:
        self.channel = channel
        self.sensor_tag = sensor_tag
        self.device = device
        self.kind = kind
        self.value = value
        self.weight = weight
        self.parts = parts

    def as_dict(self) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "sensor": self.sensor_tag,
            "device": self.device,
            "kind": self.kind,
            "estimate_ratio": round(self.value, 4),
            "weight": round(self.weight, 4),
            "relevance": round(self.parts["relevance"], 3),
            "attenuation": round(self.parts["attenuation"], 3),
            "quality": round(self.parts["quality"], 3),
        }


def collect_contributions(sensor_views: list[dict[str, Any]]) -> list[Contribution]:
    """Turn per-sensor observations into weighted per-channel contributions.

    Each `sensor_view` carries: tag, kind, device, source, distance_m, status,
    missing, noisy, ratio (measured value / nominal), plus optional nominal.
    """
    out: list[Contribution] = []
    for view in sensor_views:
        kind = view["kind"]
        targets = RELEVANCE.get(kind)
        if not targets:
            continue
        quality = quality_factor(
            view.get("status", "ok"),
            float(view.get("missing", 0.0)),
            float(view.get("noisy", 0.0)),
        )
        if quality <= 0.0:
            continue

        onboard = view.get("source") == "onboard"
        distance = 0.0 if onboard else float(view.get("distance_m", 0.0))

        for channel, relevance in targets.items():
            # An onboard sensor measures its own channel directly; there is no
            # inference step to discount.
            eff_relevance = 1.0 if (onboard and KIND_PRIMARY.get(kind) == channel) else relevance
            atten = 1.0 if onboard else attenuation(kind, distance)
            weight = eff_relevance * atten * quality
            if weight < 0.02:
                continue
            out.append(
                Contribution(
                    channel=channel,
                    sensor_tag=view["tag"],
                    device=view.get("device", kind),
                    kind=kind,
                    value=float(view.get("ratio", 1.0)),
                    weight=weight,
                    parts={
                        "relevance": eff_relevance,
                        "attenuation": atten,
                        "quality": quality,
                    },
                )
            )
    return out


# Primary channel for each device kind — used to detect direct measurement.
KIND_PRIMARY: dict[str, str] = {
    kind: max(channels.items(), key=lambda kv: kv[1])[0]
    for kind, channels in RELEVANCE.items()
}


def fuse(sensor_views: list[dict[str, Any]]) -> dict[str, Any]:
    """Fuse sensor views into per-channel estimates with confidence.

    Returns `{channels: {name: {...}}, confidence: float, contributions: [...],
    mode: 'direct' | 'fused'}`.
    """
    contributions = collect_contributions(sensor_views)
    by_channel: dict[str, list[Contribution]] = {}
    for c in contributions:
        by_channel.setdefault(c.channel, []).append(c)

    channels: dict[str, dict[str, Any]] = {}
    for channel, items in by_channel.items():
        total_w = sum(i.weight for i in items)
        if total_w <= 0:
            continue
        value = sum(i.value * i.weight for i in items) / total_w

        # Coverage: saturating function of total evidence weight.
        coverage = 1.0 - math.exp(-total_w / COVERAGE_SCALE)

        # Agreement: weighted coefficient of variation across independent
        # estimators. Two sensors that disagree cannot both be right, and the
        # confidence must fall accordingly.
        if len(items) >= 2 and abs(value) > 1e-6:
            variance = sum(i.weight * (i.value - value) ** 2 for i in items) / total_w
            cv = math.sqrt(max(0.0, variance)) / abs(value)
            agreement = 1.0 / (1.0 + 3.0 * cv)
        else:
            agreement = 1.0

        confidence = coverage * agreement
        direct = any(
            i.parts["relevance"] >= DIRECT_RELEVANCE
            and i.parts["attenuation"] >= DIRECT_ATTENUATION
            for i in items
        )
        if not direct:
            confidence = min(confidence, SINGLE_SOURCE_CEILING if len(items) < 2 else 0.9)

        channels[channel] = {
            "value_ratio": round(value, 4),
            "confidence": round(max(0.0, min(1.0, confidence)), 4),
            "coverage": round(coverage, 4),
            "agreement": round(agreement, 4),
            "sources": len(items),
            "direct": direct,
        }

    # Machine-level confidence: importance-weighted mean over the channels that
    # actually drive the health assessment, penalised for any important channel
    # with no evidence at all.
    #
    # Only channels above PRIMARY_IMPORTANCE count. Low-importance channels
    # (humidity, ambient) are supplementary context — a weakly-observed one must
    # not drag down a machine whose load-bearing signals are well instrumented.
    primary = {
        name: data
        for name, data in channels.items()
        if CHANNEL_IMPORTANCE.get(name, 0.0) >= PRIMARY_IMPORTANCE
    }
    scored = primary or channels
    if scored:
        num = sum(
            CHANNEL_IMPORTANCE.get(name, 0.2) * data["confidence"]
            for name, data in scored.items()
        )
        den = sum(CHANNEL_IMPORTANCE.get(name, 0.2) for name in scored)
        overall = num / den if den else 0.0
        missing_important = [
            name
            for name, imp in CHANNEL_IMPORTANCE.items()
            if imp >= 0.7 and name not in channels
        ]
        overall *= max(0.35, 1.0 - 0.18 * len(missing_important))
    else:
        overall = 0.0

    mode = "direct" if any(c["direct"] for c in channels.values()) else "fused"
    return {
        "channels": channels,
        "confidence": round(max(0.0, min(1.0, overall)), 4),
        "contributions": [c.as_dict() for c in contributions],
        "mode": mode,
        "missing_channels": [
            name
            for name, imp in CHANNEL_IMPORTANCE.items()
            if imp >= 0.7 and name not in channels
        ],
    }


def confidence_band(confidence: float) -> str:
    if confidence >= 0.85:
        return "high"
    if confidence >= 0.65:
        return "medium"
    if confidence >= 0.4:
        return "low"
    return "insufficient"
