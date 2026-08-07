"""Failure physics — the single shared description of how machines degrade.

Both the training-data generator and the runtime simulator import from here.
That is deliberate and load-bearing: if the physics the models learn and the
physics the platform observes could drift apart, every accuracy number the demo
reports would be measuring the wrong thing. One definition, two consumers.

Signature values are sensitivities: `{"vib_rms": 0.95}` means that at full
severity this channel reads 1.95x its healthy nominal. The fingerprints follow
established condition-monitoring practice — bearing degradation appears first in
impulsive vibration and ultrasonic emission and only later in temperature; an
electrical fault shows current imbalance with almost no vibration change; a
blockage raises pressure and power draw while speed falls.
"""

from __future__ import annotations

# canonical channel -> sensitivity to fault severity
FAILURE_SIGNATURES: dict[str, dict[str, float]] = {
    "bearing_wear": {
        "vib_rms": 0.95, "vib_peak": 1.35, "vib_crest": 0.85,
        "ultrasonic_db": 0.70, "acoustic_db": 0.40, "temp_c": 0.30,
        "temp_rise": 0.35, "vib_trend": 0.55,
    },
    "overheating": {
        "temp_c": 1.10, "temp_rise": 1.25, "temp_trend": 0.70,
        "current_a": 0.35, "power_kw": 0.30, "vib_rms": 0.15,
    },
    "lubrication_failure": {
        "ultrasonic_db": 1.20, "acoustic_db": 0.40, "vib_rms": 0.45,
        "vib_crest": 0.35, "temp_c": 0.50, "temp_rise": 0.55, "temp_trend": 0.40,
    },
    "rotor_imbalance": {
        "vib_rms": 1.05, "vib_peak": 0.90, "vib_trend": 0.60,
        "current_a": 0.25, "power_kw": 0.20, "acoustic_db": 0.30,
    },
    "electrical_fault": {
        "current_a": 0.80, "current_imbalance": 1.45, "power_kw": 0.60,
        "temp_c": 0.40, "temp_rise": 0.45, "acoustic_db": 0.20,
    },
    "blockage_fouling": {
        "pressure_bar": 1.15, "current_a": 0.60, "power_kw": 0.70,
        "temp_c": 0.45, "temp_rise": 0.50, "speed_rpm": -0.30,
    },
}

# Failure modes progress at very different speeds. Bearing wear typically gives
# weeks of warning; a lubrication failure can take a machine down within a shift.
# This scales RUL for a given observed severity.
PROGRESSION_RATE: dict[str, float] = {
    "bearing_wear": 1.0,
    "overheating": 0.45,
    "lubrication_failure": 0.35,
    "rotor_imbalance": 0.85,
    "electrical_fault": 0.30,
    "blockage_fouling": 0.60,
}

# Plain-language description of each mode, used in explanations and the Copilot's
# retrieval corpus.
FAILURE_DESCRIPTIONS: dict[str, str] = {
    "bearing_wear": (
        "Rolling-element bearing degradation: surface spalling and increasing "
        "clearance. Presents as rising impulsive vibration and ultrasonic "
        "emission well before any measurable temperature rise, which is what "
        "makes it the most reliably predictable failure mode."
    ),
    "overheating": (
        "Thermal overload from cooling loss, overloading or ambient conditions. "
        "Temperature and its rate of change lead; current and power follow as "
        "efficiency falls."
    ),
    "lubrication_failure": (
        "Loss of lubricant film through contamination, degradation or supply "
        "failure. Ultrasonic emission rises sharply and early — often the only "
        "signal available before rapid secondary bearing damage begins."
    ),
    "rotor_imbalance": (
        "Mass imbalance or shaft misalignment. Dominated by vibration at running "
        "speed with a steady upward trend; drives coupling and bearing wear if "
        "left uncorrected."
    ),
    "electrical_fault": (
        "Winding, connection or drive-stage fault. Phase current imbalance is "
        "the primary marker; total current and power rise while mechanical "
        "signals stay near normal."
    ),
    "blockage_fouling": (
        "Flow-path restriction from fouling, scaling or debris. Discharge "
        "pressure and power draw rise together while throughput speed falls."
    ),
}
