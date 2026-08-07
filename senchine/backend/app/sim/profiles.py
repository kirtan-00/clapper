"""Industry profiles, machine archetypes and sensor kits.

The platform is deliberately industry-agnostic at its core: agents and models
operate on the canonical feature vector, never on plant-specific tags. Everything
industry-specific lives in this one module as *data*. Onboarding a new vertical
means adding entries here — no agent, model, or API change.

Each archetype declares:
  * the sensor kit it ships with when modern (`onboard`), and
  * the EdgeSense retrofit kit used when the asset is legacy (`edge`),

so the same machine type can appear in the fleet in both instrumented and
retrofitted form, which is exactly the situation on a real brownfield site.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Physical defaults per sensor kind: unit, nominal value, warn/crit multipliers.
SENSOR_KIND_SPEC: dict[str, dict[str, Any]] = {
    "vibration":    {"unit": "mm/s", "warn": 1.55, "crit": 2.25, "noise": 0.045},
    "temperature":  {"unit": "°C",   "warn": 1.28, "crit": 1.55, "noise": 0.018},
    "thermal":      {"unit": "°C",   "warn": 1.30, "crit": 1.60, "noise": 0.030},
    "current":      {"unit": "A",    "warn": 1.22, "crit": 1.45, "noise": 0.022},
    "power":        {"unit": "kW",   "warn": 1.25, "crit": 1.50, "noise": 0.020},
    "acoustic":     {"unit": "dB",   "warn": 1.14, "crit": 1.28, "noise": 0.028},
    "ultrasonic":   {"unit": "dB",   "warn": 1.30, "crit": 1.65, "noise": 0.040},
    "ambient_temp": {"unit": "°C",   "warn": 1.45, "crit": 1.80, "noise": 0.012},
    "humidity":     {"unit": "%RH",  "warn": 1.55, "crit": 1.85, "noise": 0.015},
    "speed":        {"unit": "rpm",  "warn": 1.15, "crit": 1.30, "noise": 0.012},
    "pressure":     {"unit": "bar",  "warn": 1.30, "crit": 1.60, "noise": 0.025},
    "camera":       {"unit": "idx",  "warn": 1.25, "crit": 1.50, "noise": 0.035},
}

# Physical device that produces each retrofit signal — surfaced in the UI so an
# engineer can see exactly what hardware backs an estimate.
EDGE_DEVICES: dict[str, str] = {
    "vibration": "Wireless triaxial accelerometer",
    "thermal": "Thermal imaging camera",
    "camera": "Industrial machine-vision camera",
    "current": "Split-core current clamp",
    "power": "Three-phase power meter",
    "acoustic": "Industrial microphone array",
    "ultrasonic": "Airborne ultrasonic probe",
    "ambient_temp": "Environmental sensor node",
    "humidity": "Environmental sensor node",
    "temperature": "Clamp-on RTD probe",
    "speed": "Optical tachometer",
    "pressure": "Inline pressure transmitter",
}

ONBOARD_DEVICES: dict[str, str] = {
    "vibration": "Integrated ISO-10816 vibration module",
    "temperature": "Embedded bearing RTD",
    "current": "Drive current telemetry",
    "power": "VFD power telemetry",
    "speed": "Drive encoder",
    "pressure": "Process pressure transmitter",
    "acoustic": "Integrated acoustic module",
    "ultrasonic": "Integrated ultrasonic module",
    "ambient_temp": "Cabinet temperature probe",
    "humidity": "Cabinet humidity probe",
    "thermal": "Integrated thermopile array",
    "camera": "Integrated vision module",
}


@dataclass(frozen=True)
class ChannelSpec:
    kind: str
    nominal: float
    placement: str
    distance_m: float = 0.0


@dataclass(frozen=True)
class MachineArchetype:
    key: str
    name: str
    industries: tuple[str, ...]
    rated_power_kw: float
    criticality: str
    # Failure modes this archetype is physically prone to.
    likely_failures: tuple[str, ...]
    onboard: tuple[ChannelSpec, ...]
    edge: tuple[ChannelSpec, ...]
    manufacturers: tuple[str, ...] = ("Siemens", "ABB", "SKF", "Flender", "Bosch Rexroth")
    description: str = ""
    duty_profile: str = "continuous"
    mtbf_hours: float = 8000.0
    hourly_downtime_cost: float = 4200.0


def _onboard(*specs: tuple[str, float, str]) -> tuple[ChannelSpec, ...]:
    return tuple(ChannelSpec(kind, nominal, place) for kind, nominal, place in specs)


def _edge(*specs: tuple[str, float, str, float]) -> tuple[ChannelSpec, ...]:
    return tuple(
        ChannelSpec(kind, nominal, place, dist) for kind, nominal, place, dist in specs
    )


# Standard EdgeSense retrofit kit — the hardware a technician bolts around a
# legacy asset in an afternoon. Nominals are archetype-scaled at instantiation.
STANDARD_EDGE_KIT = _edge(
    ("vibration", 2.6, "Magnetic mount, drive-end bearing housing", 0.35),
    ("thermal", 62.0, "Wall-mounted thermal camera, machine face", 3.0),
    ("current", 74.0, "Clamp on motor supply cable, MCC panel", 7.5),
    ("power", 55.0, "Three-phase meter at feeder breaker", 8.0),
    ("acoustic", 79.0, "Mic array on adjacent structural column", 2.4),
    ("ultrasonic", 33.0, "Ultrasonic probe aimed at gearbox seam", 1.6),
    ("camera", 1.0, "Vision camera on output shaft coupling", 3.6),
    ("ambient_temp", 27.0, "Environmental node, zone centre", 5.0),
    ("humidity", 47.0, "Environmental node, zone centre", 5.0),
)


ARCHETYPES: tuple[MachineArchetype, ...] = (
    MachineArchetype(
        key="cnc_machining_centre",
        name="CNC Machining Centre",
        industries=("Automotive", "Electronics", "Aerospace"),
        rated_power_kw=32.0,
        criticality="high",
        likely_failures=("bearing_wear", "rotor_imbalance", "overheating"),
        onboard=_onboard(
            ("vibration", 2.1, "Spindle front bearing"),
            ("temperature", 58.0, "Spindle housing"),
            ("current", 46.0, "Spindle drive"),
            ("power", 28.0, "Machine feeder"),
            ("speed", 8200.0, "Spindle encoder"),
            ("ambient_temp", 26.0, "Enclosure"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("DMG Mori", "Haas", "Mazak", "Okuma"),
        description="5-axis machining centre for powertrain components.",
        mtbf_hours=6500.0,
        hourly_downtime_cost=5800.0,
    ),
    MachineArchetype(
        key="robotic_weld_cell",
        name="Robotic Welding Cell",
        industries=("Automotive",),
        rated_power_kw=24.0,
        criticality="critical",
        likely_failures=("rotor_imbalance", "electrical_fault", "overheating"),
        onboard=_onboard(
            ("vibration", 1.7, "Axis-2 reducer"),
            ("temperature", 54.0, "Servo housing"),
            ("current", 38.0, "Weld controller"),
            ("power", 21.0, "Cell feeder"),
            ("speed", 1450.0, "Axis encoder"),
            ("ambient_temp", 29.0, "Cell interior"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("KUKA", "FANUC", "ABB", "Yaskawa"),
        description="Six-axis body-in-white spot welding robot.",
        mtbf_hours=7200.0,
        hourly_downtime_cost=9400.0,
    ),
    MachineArchetype(
        key="rolling_mill_stand",
        name="Hot Rolling Mill Stand",
        industries=("Steel",),
        rated_power_kw=1800.0,
        criticality="critical",
        likely_failures=("bearing_wear", "lubrication_failure", "overheating"),
        onboard=_onboard(
            ("vibration", 4.4, "Work roll chock"),
            ("temperature", 78.0, "Backup roll bearing"),
            ("current", 1420.0, "Main drive"),
            ("power", 1650.0, "Mill substation"),
            ("speed", 620.0, "Roll encoder"),
            ("ultrasonic", 36.0, "Roll neck lubrication line"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("SMS Group", "Danieli", "Primetals"),
        description="Finishing stand in a hot strip mill.",
        mtbf_hours=4200.0,
        hourly_downtime_cost=28000.0,
    ),
    MachineArchetype(
        key="induction_furnace",
        name="Induction Melting Furnace",
        industries=("Steel", "Mining"),
        rated_power_kw=2400.0,
        criticality="critical",
        likely_failures=("overheating", "electrical_fault"),
        onboard=_onboard(
            ("temperature", 92.0, "Coil cooling circuit"),
            ("current", 2100.0, "Power supply unit"),
            ("power", 2250.0, "Furnace transformer"),
            ("vibration", 1.4, "Hydraulic tilt frame"),
            ("ambient_temp", 38.0, "Furnace platform"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Inductotherm", "ABP Induction", "OTTO JUNKER"),
        description="Coreless induction furnace for scrap melting.",
        mtbf_hours=5200.0,
        hourly_downtime_cost=34000.0,
    ),
    MachineArchetype(
        key="centrifugal_pump",
        name="Process Centrifugal Pump",
        industries=("Chemical", "Energy", "Food Processing", "Pharmaceutical"),
        rated_power_kw=75.0,
        criticality="high",
        likely_failures=("bearing_wear", "lubrication_failure", "blockage_fouling"),
        onboard=_onboard(
            ("vibration", 2.8, "Pump drive-end bearing"),
            ("temperature", 64.0, "Bearing housing"),
            ("current", 108.0, "Motor terminal box"),
            ("power", 68.0, "MCC feeder"),
            ("pressure", 9.5, "Discharge header"),
            ("speed", 2960.0, "Motor encoder"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Grundfos", "KSB", "Flowserve", "Sulzer"),
        description="API-610 process pump on a continuous transfer duty.",
        mtbf_hours=7800.0,
        hourly_downtime_cost=6200.0,
    ),
    MachineArchetype(
        key="reactor_agitator",
        name="Reactor Agitator Drive",
        industries=("Chemical", "Pharmaceutical"),
        rated_power_kw=45.0,
        criticality="critical",
        likely_failures=("bearing_wear", "lubrication_failure", "rotor_imbalance"),
        onboard=_onboard(
            ("vibration", 2.2, "Agitator gearbox output"),
            ("temperature", 61.0, "Gearbox oil sump"),
            ("current", 64.0, "Agitator motor"),
            ("power", 41.0, "Reactor skid feeder"),
            ("speed", 145.0, "Shaft encoder"),
            ("ultrasonic", 32.0, "Mechanical seal"),
        ),
        manufacturers=("EKATO", "SPX Flow", "Chemineer"),
        edge=STANDARD_EDGE_KIT,
        description="Glass-lined reactor agitator on batch duty.",
        duty_profile="batch",
        mtbf_hours=6900.0,
        hourly_downtime_cost=15500.0,
    ),
    MachineArchetype(
        key="rotary_kiln",
        name="Rotary Cement Kiln Drive",
        industries=("Cement",),
        rated_power_kw=950.0,
        criticality="critical",
        likely_failures=("bearing_wear", "overheating", "lubrication_failure"),
        onboard=_onboard(
            ("vibration", 3.6, "Girth gear pinion bearing"),
            ("temperature", 84.0, "Support roller bearing"),
            ("current", 780.0, "Kiln main drive"),
            ("power", 890.0, "Kiln substation"),
            ("speed", 3.4, "Kiln shell rotation"),
            ("ambient_temp", 44.0, "Kiln hood platform"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("FLSmidth", "ThyssenKrupp", "KHD"),
        description="4.2 m x 64 m rotary kiln main drive train.",
        mtbf_hours=5600.0,
        hourly_downtime_cost=31000.0,
    ),
    MachineArchetype(
        key="ball_mill",
        name="Ball Mill",
        industries=("Cement", "Mining"),
        rated_power_kw=3200.0,
        criticality="critical",
        likely_failures=("bearing_wear", "lubrication_failure", "blockage_fouling"),
        onboard=_onboard(
            ("vibration", 4.1, "Trunnion bearing"),
            ("temperature", 71.0, "Trunnion white metal"),
            ("current", 2600.0, "Mill motor"),
            ("power", 3050.0, "Mill substation"),
            ("speed", 16.5, "Mill shell"),
            ("ultrasonic", 35.0, "Trunnion lube line"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Metso Outotec", "FLSmidth", "CITIC"),
        description="Closed-circuit ball mill for finish grinding.",
        mtbf_hours=4800.0,
        hourly_downtime_cost=26000.0,
    ),
    MachineArchetype(
        key="tablet_press",
        name="Rotary Tablet Press",
        industries=("Pharmaceutical",),
        rated_power_kw=18.0,
        criticality="high",
        likely_failures=("bearing_wear", "rotor_imbalance", "blockage_fouling"),
        onboard=_onboard(
            ("vibration", 1.6, "Turret main bearing"),
            ("temperature", 48.0, "Compression roller"),
            ("current", 26.0, "Main drive"),
            ("power", 15.0, "Machine feeder"),
            ("speed", 78.0, "Turret encoder"),
            ("humidity", 42.0, "Compression chamber"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Fette Compacting", "Korsch", "IMA"),
        description="GMP rotary tablet press, 61-station turret.",
        mtbf_hours=8600.0,
        hourly_downtime_cost=11800.0,
    ),
    MachineArchetype(
        key="lyophilizer",
        name="Freeze Dryer (Lyophilizer)",
        industries=("Pharmaceutical", "Food Processing"),
        rated_power_kw=88.0,
        criticality="critical",
        likely_failures=("blockage_fouling", "electrical_fault", "overheating"),
        onboard=_onboard(
            ("temperature", 42.0, "Condenser coil"),
            ("pressure", 0.8, "Chamber vacuum"),
            ("current", 126.0, "Refrigeration compressor"),
            ("power", 82.0, "Skid feeder"),
            ("vibration", 2.0, "Compressor frame"),
            ("humidity", 20.0, "Chamber"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("IMA Life", "GEA", "Telstar"),
        description="Production-scale lyophilizer on validated batch duty.",
        duty_profile="batch",
        mtbf_hours=7400.0,
        hourly_downtime_cost=22000.0,
    ),
    MachineArchetype(
        key="homogenizer",
        name="High-Pressure Homogenizer",
        industries=("Food Processing", "FMCG"),
        rated_power_kw=110.0,
        criticality="high",
        likely_failures=("bearing_wear", "blockage_fouling", "lubrication_failure"),
        onboard=_onboard(
            ("vibration", 3.2, "Plunger crankcase"),
            ("temperature", 66.0, "Crankcase oil"),
            ("current", 158.0, "Main motor"),
            ("power", 102.0, "Line feeder"),
            ("pressure", 180.0, "First-stage valve"),
            ("speed", 420.0, "Crankshaft"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("GEA", "SPX Flow", "Tetra Pak"),
        description="Two-stage homogenizer on a dairy processing line.",
        mtbf_hours=6100.0,
        hourly_downtime_cost=8700.0,
    ),
    MachineArchetype(
        key="filling_line",
        name="Aseptic Filling Line",
        industries=("Food Processing", "FMCG", "Pharmaceutical"),
        rated_power_kw=36.0,
        criticality="high",
        likely_failures=("blockage_fouling", "rotor_imbalance", "electrical_fault"),
        onboard=_onboard(
            ("vibration", 1.9, "Carousel main bearing"),
            ("temperature", 51.0, "Servo cabinet"),
            ("current", 52.0, "Line drive"),
            ("power", 33.0, "Line feeder"),
            ("speed", 640.0, "Carousel encoder"),
            ("humidity", 45.0, "Filling enclosure"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Krones", "Sidel", "Tetra Pak"),
        description="Rotary aseptic filler, 36 000 bottles/hour.",
        mtbf_hours=7000.0,
        hourly_downtime_cost=12400.0,
    ),
    MachineArchetype(
        key="jaw_crusher",
        name="Primary Jaw Crusher",
        industries=("Mining", "Cement"),
        rated_power_kw=450.0,
        criticality="critical",
        likely_failures=("bearing_wear", "blockage_fouling", "lubrication_failure"),
        onboard=_onboard(
            ("vibration", 5.2, "Eccentric shaft bearing"),
            ("temperature", 74.0, "Pitman bearing"),
            ("current", 620.0, "Crusher motor"),
            ("power", 410.0, "Crusher substation"),
            ("speed", 240.0, "Flywheel"),
            ("ultrasonic", 37.0, "Toggle lubrication point"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Metso Outotec", "Sandvik", "Terex"),
        description="Primary jaw crusher on run-of-mine feed.",
        mtbf_hours=3900.0,
        hourly_downtime_cost=19500.0,
    ),
    MachineArchetype(
        key="belt_conveyor_drive",
        name="Overland Conveyor Drive",
        industries=("Mining", "Cement", "Steel"),
        rated_power_kw=630.0,
        criticality="high",
        likely_failures=("bearing_wear", "rotor_imbalance", "overheating"),
        onboard=_onboard(
            ("vibration", 3.0, "Head pulley bearing"),
            ("temperature", 68.0, "Gearbox oil"),
            ("current", 880.0, "Drive motor"),
            ("power", 580.0, "Drive house"),
            ("speed", 985.0, "Motor encoder"),
            ("ambient_temp", 32.0, "Drive house"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Flender", "Siemens", "Voith"),
        description="2.4 km overland conveyor head drive.",
        mtbf_hours=6600.0,
        hourly_downtime_cost=14200.0,
    ),
    MachineArchetype(
        key="smt_reflow_oven",
        name="SMT Reflow Oven",
        industries=("Electronics",),
        rated_power_kw=64.0,
        criticality="high",
        likely_failures=("overheating", "electrical_fault", "blockage_fouling"),
        onboard=_onboard(
            ("temperature", 245.0, "Peak zone thermocouple"),
            ("current", 92.0, "Heater bank"),
            ("power", 58.0, "Oven feeder"),
            ("vibration", 1.2, "Conveyor drive"),
            ("speed", 95.0, "Conveyor"),
            ("ambient_temp", 28.0, "Line enclosure"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Heller", "BTU", "Rehm"),
        description="10-zone convection reflow oven.",
        mtbf_hours=9200.0,
        hourly_downtime_cost=7600.0,
    ),
    MachineArchetype(
        key="pick_and_place",
        name="SMT Pick-and-Place",
        industries=("Electronics",),
        rated_power_kw=12.0,
        criticality="critical",
        likely_failures=("bearing_wear", "rotor_imbalance", "electrical_fault"),
        onboard=_onboard(
            ("vibration", 1.1, "Gantry linear rail"),
            ("temperature", 44.0, "Head servo"),
            ("current", 18.0, "Machine supply"),
            ("power", 10.0, "Line feeder"),
            ("speed", 1200.0, "Head cycle rate"),
            ("humidity", 44.0, "Machine enclosure"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("ASM", "Fuji", "Panasonic", "Yamaha"),
        description="High-speed chip shooter, 100k CPH.",
        mtbf_hours=8800.0,
        hourly_downtime_cost=13100.0,
    ),
    MachineArchetype(
        key="air_compressor",
        name="Screw Air Compressor",
        industries=(
            "Automotive", "Chemical", "FMCG", "Electronics",
            "Food Processing", "Pharmaceutical", "Energy",
        ),
        rated_power_kw=160.0,
        criticality="high",
        likely_failures=("bearing_wear", "overheating", "lubrication_failure"),
        onboard=_onboard(
            ("vibration", 2.4, "Airend drive-end"),
            ("temperature", 82.0, "Discharge air"),
            ("current", 232.0, "Motor"),
            ("power", 148.0, "Compressor room feeder"),
            ("pressure", 7.5, "Discharge receiver"),
            ("speed", 2980.0, "Motor encoder"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Atlas Copco", "Ingersoll Rand", "Kaeser"),
        description="Oil-injected rotary screw compressor, plant air header.",
        mtbf_hours=7100.0,
        hourly_downtime_cost=9100.0,
    ),
    MachineArchetype(
        key="steam_turbine",
        name="Steam Turbine Generator",
        industries=("Energy", "Chemical", "Steel"),
        rated_power_kw=12000.0,
        criticality="critical",
        likely_failures=("bearing_wear", "rotor_imbalance", "overheating"),
        onboard=_onboard(
            ("vibration", 3.4, "Journal bearing #2"),
            ("temperature", 88.0, "Bearing white metal"),
            ("current", 1650.0, "Generator stator"),
            ("power", 11200.0, "Generator output"),
            ("speed", 3000.0, "Shaft"),
            ("pressure", 62.0, "Inlet steam header"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Siemens Energy", "GE Vernova", "Mitsubishi Power"),
        description="Condensing steam turbine generator set.",
        mtbf_hours=11000.0,
        hourly_downtime_cost=48000.0,
    ),
    MachineArchetype(
        key="cooling_tower_fan",
        name="Cooling Tower Fan Drive",
        industries=("Energy", "Chemical", "Steel", "Cement"),
        rated_power_kw=132.0,
        criticality="medium",
        likely_failures=("rotor_imbalance", "bearing_wear", "lubrication_failure"),
        onboard=_onboard(
            ("vibration", 3.8, "Fan gearbox output"),
            ("temperature", 58.0, "Gearbox oil"),
            ("current", 186.0, "Fan motor"),
            ("power", 122.0, "Cooling tower MCC"),
            ("speed", 168.0, "Fan shaft"),
            ("humidity", 82.0, "Fan deck"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Baltimore Aircoil", "SPX Cooling", "Hamon"),
        description="Induced-draft cooling tower cell fan drive.",
        mtbf_hours=6800.0,
        hourly_downtime_cost=4600.0,
    ),
    MachineArchetype(
        key="extruder",
        name="Twin-Screw Extruder",
        industries=("Chemical", "FMCG", "Food Processing"),
        rated_power_kw=250.0,
        criticality="high",
        likely_failures=("overheating", "blockage_fouling", "bearing_wear"),
        onboard=_onboard(
            ("vibration", 2.9, "Gearbox output shaft"),
            ("temperature", 186.0, "Barrel zone 4"),
            ("current", 352.0, "Main drive"),
            ("power", 236.0, "Extruder feeder"),
            ("pressure", 128.0, "Die head"),
            ("speed", 380.0, "Screw"),
        ),
        edge=STANDARD_EDGE_KIT,
        manufacturers=("Coperion", "Leistritz", "KraussMaffei"),
        description="Co-rotating twin-screw extruder on compounding duty.",
        mtbf_hours=5900.0,
        hourly_downtime_cost=10800.0,
    ),
)

ARCHETYPE_BY_KEY = {a.key: a for a in ARCHETYPES}

INDUSTRIES: tuple[str, ...] = (
    "Automotive",
    "Steel",
    "Chemical",
    "Cement",
    "Pharmaceutical",
    "Food Processing",
    "Mining",
    "Electronics",
    "FMCG",
    "Energy",
)

# One reference plant per supported industry.
PLANTS: tuple[dict[str, str], str] | tuple[dict[str, Any], ...] = (
    {"name": "Pune Powertrain Works", "industry": "Automotive", "location": "Pune, IN"},
    {"name": "Jamshedpur Hot Strip Mill", "industry": "Steel", "location": "Jamshedpur, IN"},
    {"name": "Rotterdam Specialty Chemicals", "industry": "Chemical", "location": "Rotterdam, NL"},
    {"name": "Gulbarga Cement Line 2", "industry": "Cement", "location": "Gulbarga, IN"},
    {"name": "Basel Sterile Manufacturing", "industry": "Pharmaceutical", "location": "Basel, CH"},
    {"name": "Cork Dairy Processing", "industry": "Food Processing", "location": "Cork, IE"},
    {"name": "Pilbara Iron Ore Concentrator", "industry": "Mining", "location": "Pilbara, AU"},
    {"name": "Penang SMT Campus", "industry": "Electronics", "location": "Penang, MY"},
    {"name": "Katowice Home Care Plant", "industry": "FMCG", "location": "Katowice, PL"},
    {"name": "Teesside Cogeneration", "industry": "Energy", "location": "Teesside, UK"},
)


def archetypes_for(industry: str) -> list[MachineArchetype]:
    return [a for a in ARCHETYPES if industry in a.industries]


# Spare-parts catalogue keyed by failure category. The Maintenance agent
# recommends from here rather than inventing part numbers.
SPARE_PARTS: tuple[dict[str, Any], ...] = (
    {"sku": "BRG-6314-C3", "name": "Deep-groove ball bearing 6314 C3", "machine_type": "*",
     "failure_category": "bearing_wear", "unit_cost": 340.0, "stock": 12, "lead_time_days": 3},
    {"sku": "BRG-22320-E", "name": "Spherical roller bearing 22320 E", "machine_type": "*",
     "failure_category": "bearing_wear", "unit_cost": 1180.0, "stock": 4, "lead_time_days": 9},
    {"sku": "SEAL-VR-90", "name": "Rotary shaft seal, Viton 90 mm", "machine_type": "*",
     "failure_category": "bearing_wear", "unit_cost": 78.0, "stock": 34, "lead_time_days": 2},
    {"sku": "LUB-EP2-18KG", "name": "EP2 lithium-complex grease, 18 kg", "machine_type": "*",
     "failure_category": "lubrication_failure", "unit_cost": 165.0, "stock": 22, "lead_time_days": 1},
    {"sku": "LUB-ISO220-20L", "name": "ISO VG220 gear oil, 20 L", "machine_type": "*",
     "failure_category": "lubrication_failure", "unit_cost": 210.0, "stock": 16, "lead_time_days": 2},
    {"sku": "LUB-PUMP-AK7", "name": "Automatic lubricator pump AK7", "machine_type": "*",
     "failure_category": "lubrication_failure", "unit_cost": 640.0, "stock": 5, "lead_time_days": 7},
    {"sku": "FAN-COOL-450", "name": "Motor cooling fan assembly, 450 mm", "machine_type": "*",
     "failure_category": "overheating", "unit_cost": 295.0, "stock": 8, "lead_time_days": 4},
    {"sku": "HEX-PLATE-40", "name": "Plate heat exchanger cartridge, 40 plates", "machine_type": "*",
     "failure_category": "overheating", "unit_cost": 1420.0, "stock": 3, "lead_time_days": 12},
    {"sku": "THERM-PT100", "name": "PT100 temperature probe, 6 mm", "machine_type": "*",
     "failure_category": "overheating", "unit_cost": 96.0, "stock": 40, "lead_time_days": 1},
    {"sku": "CPL-FLEX-160", "name": "Flexible jaw coupling insert, 160 mm", "machine_type": "*",
     "failure_category": "rotor_imbalance", "unit_cost": 220.0, "stock": 14, "lead_time_days": 3},
    {"sku": "BAL-KIT-STD", "name": "Field balancing weight kit", "machine_type": "*",
     "failure_category": "rotor_imbalance", "unit_cost": 480.0, "stock": 6, "lead_time_days": 5},
    {"sku": "CNT-3P-250A", "name": "Three-pole contactor, 250 A", "machine_type": "*",
     "failure_category": "electrical_fault", "unit_cost": 385.0, "stock": 9, "lead_time_days": 4},
    {"sku": "VFD-MOD-75K", "name": "VFD power module, 75 kW frame", "machine_type": "*",
     "failure_category": "electrical_fault", "unit_cost": 3250.0, "stock": 2, "lead_time_days": 15},
    {"sku": "CBL-MTR-4C95", "name": "Motor supply cable, 4C x 95 mm²", "machine_type": "*",
     "failure_category": "electrical_fault", "unit_cost": 42.0, "stock": 220, "lead_time_days": 2},
    {"sku": "FLT-INL-200", "name": "Inline strainer element, 200 micron", "machine_type": "*",
     "failure_category": "blockage_fouling", "unit_cost": 130.0, "stock": 26, "lead_time_days": 2},
    {"sku": "CIP-DESCALE-25L", "name": "CIP descaling solution, 25 L", "machine_type": "*",
     "failure_category": "blockage_fouling", "unit_cost": 185.0, "stock": 18, "lead_time_days": 3},
    {"sku": "VLV-SEAT-DN80", "name": "Valve seat and plug kit DN80", "machine_type": "*",
     "failure_category": "blockage_fouling", "unit_cost": 560.0, "stock": 7, "lead_time_days": 6},
)

# Technician skills required per failure category, with hourly labour rates.
SKILL_MATRIX: dict[str, dict[str, Any]] = {
    "bearing_wear": {
        "skill": "Mechanical Fitter — Level 3 (vibration certified)",
        "code": "mech_l3", "hourly_rate": 78.0, "base_hours": 4.5,
    },
    "overheating": {
        "skill": "Thermal Systems Technician",
        "code": "thermal", "hourly_rate": 72.0, "base_hours": 3.0,
    },
    "lubrication_failure": {
        "skill": "Lubrication Specialist",
        "code": "lube", "hourly_rate": 62.0, "base_hours": 2.0,
    },
    "rotor_imbalance": {
        "skill": "Rotating Equipment Specialist (field balancing)",
        "code": "rotating", "hourly_rate": 92.0, "base_hours": 5.0,
    },
    "electrical_fault": {
        "skill": "Industrial Electrician — HV certified",
        "code": "elec_hv", "hourly_rate": 88.0, "base_hours": 3.5,
    },
    "blockage_fouling": {
        "skill": "Process Technician",
        "code": "process", "hourly_rate": 58.0, "base_hours": 2.5,
    },
    "healthy": {
        "skill": "Condition Monitoring Analyst",
        "code": "cm", "hourly_rate": 70.0, "base_hours": 1.0,
    },
}
