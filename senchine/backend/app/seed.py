"""Deterministic seed data.

Everything the platform serves is generated here and then read back from SQLite —
no view reads a hard-coded literal. The generator is seeded, so the fleet, the
history and the demo accounts are identical on every machine that runs it, which
is what makes a scripted walkthrough reproducible.

What gets built:
  * 10 plants, one per supported industry
  * ~30 machines drawn from 20 archetypes, ~40% of them legacy EdgeSense retrofits
  * a full sensor kit per machine (onboard telemetry or retrofit edge devices)
  * 8 user accounts spanning every role, with realistic skill sets
  * 2 years of maintenance history with costs, downtime and failure modes
  * a spare-parts catalogue
  * a knowledge corpus (machine dossiers, failure-mode references, SOPs, policy)
    that the Copilot's retrieval layer indexes
"""

from __future__ import annotations

import json
import random
import time
from typing import Any

from . import db
from .physics import FAILURE_DESCRIPTIONS
from .rag.store import index, upsert_document
from .security import hash_password
from .sim.profiles import (
    ARCHETYPES,
    EDGE_DEVICES,
    ONBOARD_DEVICES,
    PLANTS,
    SENSOR_KIND_SPEC,
    SKILL_MATRIX,
    SPARE_PARTS,
    archetypes_for,
)

SEED = 20260807
MACHINES_PER_PLANT = 3
RETROFIT_SHARE = 0.40

DEMO_PASSWORD = "senchine"

USERS: list[dict[str, Any]] = [
    {
        "email": "admin@senchine.ai", "name": "Priya Raghavan", "role": "admin",
        "skills": ["mech_l3", "elec_hv", "cm"], "phone": "+44 20 7946 0011",
        "shift": "A", "plant_index": None,
    },
    {
        "email": "manager@senchine.ai", "name": "Daniel Okonkwo", "role": "manager",
        "skills": ["cm"], "phone": "+44 20 7946 0022", "shift": "A", "plant_index": None,
    },
    {
        "email": "engineer@senchine.ai", "name": "Sofia Marchetti", "role": "engineer",
        "skills": ["mech_l3", "rotating", "cm"], "phone": "+44 20 7946 0033",
        "shift": "A", "plant_index": 0,
    },
    {
        "email": "reliability@senchine.ai", "name": "Kenji Nakamura", "role": "engineer",
        "skills": ["cm", "thermal", "process"], "phone": "+44 20 7946 0044",
        "shift": "B", "plant_index": 1,
    },
    {
        "email": "tech.mech@senchine.ai", "name": "Aarav Sharma", "role": "technician",
        "skills": ["mech_l3", "lube", "rotating"], "phone": "+44 20 7946 0055",
        "shift": "A", "plant_index": None,
    },
    {
        "email": "tech.elec@senchine.ai", "name": "Lucia Fernández", "role": "technician",
        "skills": ["elec_hv", "thermal"], "phone": "+44 20 7946 0066",
        "shift": "B", "plant_index": None,
    },
    {
        "email": "tech.process@senchine.ai", "name": "Tomasz Nowak", "role": "technician",
        "skills": ["process", "lube"], "phone": "+44 20 7946 0077",
        "shift": "C", "plant_index": None,
    },
    {
        "email": "viewer@senchine.ai", "name": "Grace Bennett", "role": "viewer",
        "skills": [], "phone": None, "shift": "A", "plant_index": None,
    },
]


def seed_all(force: bool = False) -> dict[str, Any]:
    """Populate an empty database. Idempotent unless `force` is set."""
    if db.is_seeded() and not force:
        return {"skipped": True, "reason": "database already seeded"}

    if force:
        _wipe()

    rng = random.Random(SEED)
    started = time.perf_counter()

    plant_ids = _seed_plants()
    user_ids = _seed_users(plant_ids)
    _seed_spare_parts()
    machines = _seed_machines(rng, plant_ids)
    sensor_count = _seed_sensors(rng, machines)
    history_count = _seed_history(rng, machines, user_ids)
    doc_count = _seed_documents(machines)

    index.build()

    return {
        "skipped": False,
        "plants": len(plant_ids),
        "users": len(user_ids),
        "machines": len(machines),
        "sensors": sensor_count,
        "maintenance_records": history_count,
        "documents": doc_count,
        "spare_parts": len(SPARE_PARTS),
        "seconds": round(time.perf_counter() - started, 2),
    }


def _wipe() -> None:
    with db.tx() as conn:
        for table in (
            "doc_chunks", "documents", "feedback", "audit_log", "agent_runs",
            "notifications", "maintenance_history", "work_orders", "alerts",
            "predictions", "health_snapshots", "readings", "sensors",
            "machines", "spare_parts", "plants", "users", "kv",
        ):
            conn.execute(f"DELETE FROM {table}")


# --- plants and users ------------------------------------------------------


def _seed_plants() -> list[int]:
    ids = []
    for plant in PLANTS:
        ids.append(
            db.execute(
                "INSERT INTO plants(name, industry, location) VALUES(?,?,?)",
                (plant["name"], plant["industry"], plant["location"]),
            )
        )
    return ids


def _seed_users(plant_ids: list[int]) -> dict[str, int]:
    ids: dict[str, int] = {}
    for user in USERS:
        password_hash, salt = hash_password(DEMO_PASSWORD)
        plant_id = (
            plant_ids[user["plant_index"]] if user["plant_index"] is not None else None
        )
        ids[user["email"]] = db.execute(
            "INSERT INTO users(email, name, password_hash, salt, role, skills, phone, "
            "shift, plant_id, active, created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?)",
            (
                user["email"], user["name"], password_hash, salt, user["role"],
                json.dumps(user["skills"]), user["phone"], user["shift"],
                plant_id, time.time(),
            ),
        )
    return ids


def _seed_spare_parts() -> None:
    db.execute_many(
        "INSERT INTO spare_parts(sku, name, machine_type, failure_category, "
        "unit_cost, stock, lead_time_days) VALUES(?,?,?,?,?,?,?)",
        [
            (
                p["sku"], p["name"], p["machine_type"], p["failure_category"],
                p["unit_cost"], p["stock"], p["lead_time_days"],
            )
            for p in SPARE_PARTS
        ],
    )


# --- machines and sensors --------------------------------------------------


def _seed_machines(rng: random.Random, plant_ids: list[int]) -> list[dict[str, Any]]:
    machines: list[dict[str, Any]] = []
    counter = 100

    for plant_id, plant in zip(plant_ids, PLANTS):
        candidates = archetypes_for(plant["industry"]) or list(ARCHETYPES)
        chosen = rng.sample(candidates, k=min(MACHINES_PER_PLANT, len(candidates)))
        # Pad from the full catalogue if the industry has few archetypes.
        while len(chosen) < MACHINES_PER_PLANT:
            extra = rng.choice(ARCHETYPES)
            if extra not in chosen:
                chosen.append(extra)

        for archetype in chosen:
            counter += 1
            code = f"M-{counter}"
            retrofit = rng.random() < RETROFIT_SHARE
            # Legacy assets are older by definition — that is why they lack
            # instrumentation in the first place.
            install_year = (
                rng.randint(1994, 2011) if retrofit else rng.randint(2015, 2023)
            )
            machine_id = db.execute(
                "INSERT INTO machines(plant_id, code, name, machine_type, industry, "
                "criticality, retrofit, manufacturer, model, install_year, "
                "rated_power_kw, line, status, notes) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    plant_id, code, archetype.name, archetype.key, plant["industry"],
                    archetype.criticality, int(retrofit),
                    rng.choice(archetype.manufacturers),
                    f"{rng.choice(['XR','TS','GP','HD'])}-{rng.randint(200, 980)}",
                    install_year, archetype.rated_power_kw,
                    f"Line {rng.randint(1, 4)}", "running",
                    archetype.description,
                ),
            )
            machines.append(
                {
                    "id": machine_id, "code": code, "name": archetype.name,
                    "archetype": archetype, "retrofit": retrofit,
                    "plant_id": plant_id, "plant": plant, "install_year": install_year,
                }
            )
    return machines


def _seed_sensors(rng: random.Random, machines: list[dict[str, Any]]) -> int:
    total = 0
    for machine in machines:
        archetype = machine["archetype"]
        retrofit = machine["retrofit"]
        specs = archetype.edge if retrofit else archetype.onboard
        devices = EDGE_DEVICES if retrofit else ONBOARD_DEVICES
        source = "edge" if retrofit else "onboard"

        # Retrofit kits are scaled to the archetype so an edge estimate of, say,
        # current is on the right physical scale for a 3 MW mill vs a 12 kW placer.
        scale_reference = {
            spec.kind: spec.nominal for spec in archetype.onboard
        }

        for order, spec in enumerate(specs, start=1):
            kind_spec = SENSOR_KIND_SPEC.get(spec.kind, {"unit": "", "warn": 1.3,
                                                         "crit": 1.6, "noise": 0.03})
            nominal = spec.nominal
            if retrofit and spec.kind in scale_reference:
                nominal = scale_reference[spec.kind]
            elif retrofit and spec.kind == "thermal" and "temperature" in scale_reference:
                # A thermal camera reads surface temperature, which sits below the
                # embedded bearing probe it stands in for.
                nominal = scale_reference["temperature"] * 0.88

            tag = f"{machine['code']}-{spec.kind.upper()[:4]}{order}"
            db.execute(
                "INSERT INTO sensors(machine_id, tag, kind, unit, source, device, "
                "placement, distance_m, nominal, warn_high, crit_high, noise_sigma, "
                "status, last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    machine["id"], tag, spec.kind, kind_spec["unit"], source,
                    devices.get(spec.kind, spec.kind), spec.placement,
                    spec.distance_m if retrofit else 0.0,
                    round(nominal, 4),
                    round(nominal * kind_spec["warn"], 4),
                    round(nominal * kind_spec["crit"], 4),
                    kind_spec["noise"] * rng.uniform(0.85, 1.25),
                    "ok", None,
                ),
            )
            total += 1
    return total


# --- history ---------------------------------------------------------------

HISTORY_TEMPLATES: dict[str, list[str]] = {
    "preventive": [
        "Scheduled 2000-hour service: lubricant change, filter replacement, fastener torque check",
        "Quarterly condition-monitoring survey with vibration spectrum capture",
        "Annual thermographic survey of motor and starter panel",
        "Planned belt and coupling inspection with alignment verification",
    ],
    "corrective": [
        "Replaced drive-end bearing following elevated vibration",
        "Rewound motor after insulation resistance test failure",
        "Replaced worn coupling insert and re-aligned drive train",
        "Cleared blocked strainer and cleaned flow path internals",
        "Replaced failed cooling fan assembly",
    ],
    "predictive": [
        "Bearing replaced ahead of predicted failure — flagged by condition monitoring",
        "Lubrication circuit purged and recharged on predictive alert",
        "Field balancing performed after imbalance trend detected",
        "Contactor replaced after phase imbalance trend crossed threshold",
    ],
    "inspection": [
        "Routine visual inspection — no defects found",
        "Borescope inspection of internals, wear within limits",
        "Statutory pressure-vessel inspection completed",
    ],
}

TECHNICIANS = [
    "Aarav Sharma", "Lucia Fernández", "Tomasz Nowak",
    "Sofia Marchetti", "Kenji Nakamura",
]


def _seed_history(
    rng: random.Random, machines: list[dict[str, Any]], user_ids: dict[str, int]
) -> int:
    now = time.time()
    total = 0

    for machine in machines:
        archetype = machine["archetype"]
        # Older assets have accumulated more history.
        age_years = max(1, 2026 - machine["install_year"])
        record_count = rng.randint(5, 9) + min(4, age_years // 6)

        for _ in range(record_count):
            days_ago = rng.uniform(3, 730)
            ts = now - days_ago * 86400
            kind = rng.choices(
                ["preventive", "corrective", "predictive", "inspection"],
                weights=[0.40, 0.22, 0.20, 0.18],
            )[0]
            description = rng.choice(HISTORY_TEMPLATES[kind])

            failure_mode = None
            if kind in ("corrective", "predictive"):
                failure_mode = rng.choice(archetype.likely_failures)

            base_hours = {
                "preventive": 3.0, "corrective": 9.0,
                "predictive": 4.5, "inspection": 1.5,
            }[kind]
            size_factor = min(3.0, max(0.6, (archetype.rated_power_kw / 150.0) ** 0.32))
            downtime = round(base_hours * size_factor * rng.uniform(0.7, 1.5), 2)

            skill = SKILL_MATRIX.get(failure_mode or "healthy", SKILL_MATRIX["healthy"])
            labour = skill["hourly_rate"] * downtime * 1.4
            parts_cost = (
                rng.uniform(120, 3600) if kind in ("corrective", "predictive") else
                rng.uniform(40, 420)
            )
            production = archetype.hourly_downtime_cost * downtime * (
                1.0 if kind == "corrective" else 0.45
            )
            cost = round(labour + parts_cost + production, 2)

            db.execute(
                "INSERT INTO maintenance_history(machine_id, work_order_id, ts, kind, "
                "description, downtime_hours, cost, technician, parts_json, outcome, "
                "failure_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    machine["id"], None, ts, kind, description, downtime, cost,
                    rng.choice(TECHNICIANS), json.dumps([]),
                    "completed" if rng.random() > 0.06 else "partial",
                    failure_mode,
                ),
            )
            total += 1
    return total


# --- knowledge corpus ------------------------------------------------------


def _seed_documents(machines: list[dict[str, Any]]) -> int:
    count = 0

    # 1. Per-machine dossier — the record the Copilot cites for asset questions.
    for machine in machines:
        archetype = machine["archetype"]
        instrumentation = (
            "This asset has no onboard instrumentation. It is monitored through the "
            "EdgeSense retrofit kit: external devices mounted around the machine "
            "(accelerometer, thermal camera, current clamp, power meter, microphone "
            "array, ultrasonic probe, machine-vision camera and an environmental "
            "node). Machine state is estimated by sensor fusion and published with a "
            "confidence score. Absolute values are estimates; trends are reliable."
            if machine["retrofit"]
            else
            "This asset carries onboard IoT instrumentation reporting vibration, "
            "temperature, current, power and process variables directly from the "
            "machine's own control system."
        )

        body = f"""Asset dossier for {machine['code']} — {archetype.name}

{machine['code']} is a {archetype.name} installed at {machine['plant']['name']} in {machine['plant']['location']}, operating in the {machine['plant']['industry']} sector. {archetype.description} The asset was commissioned in {machine['install_year']} and is rated at {archetype.rated_power_kw} kW. It is classified as {archetype.criticality} criticality.

Instrumentation. {instrumentation}

Duty and reliability. The machine runs a {archetype.duty_profile} duty profile. Mean time between failures for this archetype is approximately {archetype.mtbf_hours:.0f} operating hours. Unplanned downtime on this asset is costed at {archetype.hourly_downtime_cost:,.0f} per hour, which includes lost production, expedited labour and secondary damage.

Dominant failure modes. Field experience with this archetype shows the following modes dominate: {', '.join(m.replace('_', ' ') for m in archetype.likely_failures)}. Condition monitoring on this asset is weighted toward the signals that lead these modes.

Maintenance strategy. Preventive servicing follows the manufacturer's schedule. Predictive intervention is triggered by the Senchine Monitoring and Prediction agents when the failure probability and asset criticality justify planned downtime ahead of failure."""

        upsert_document(
            kind="manual", title=f"{machine['code']} — {archetype.name} asset dossier",
            body=body, source=f"Asset register / {machine['plant']['name']}",
            machine_id=machine["id"],
        )
        count += 1

    # 2. Failure-mode reference.
    for mode, description in FAILURE_DESCRIPTIONS.items():
        skill = SKILL_MATRIX.get(mode, SKILL_MATRIX["healthy"])
        parts = [p for p in SPARE_PARTS if p["failure_category"] == mode]
        parts_text = (
            "Typical parts required: "
            + "; ".join(f"{p['sku']} ({p['name']}, {p['unit_cost']:,.0f})" for p in parts)
            if parts else "No dedicated parts catalogue entry."
        )
        body = f"""Failure mode reference: {mode.replace('_', ' ').title()}

Description. {description}

Detection. The Senchine Prediction agent classifies this mode from the canonical 16-channel feature vector produced by the Monitoring agent. SHAP attribution identifies which channels drove the classification, so the diagnosis can be verified against the physical evidence rather than accepted on trust.

Skill required. {skill['skill']} (skill code {skill['code']}), charged at {skill['hourly_rate']:.0f} per hour with a typical base intervention time of {skill['base_hours']} hours before asset-size scaling.

{parts_text}

Safety. All intervention on this failure mode requires the asset to be isolated under lockout/tagout before work begins. Protective trips and interlocks must never be bypassed, raised or suppressed to keep an asset running — a repeated trip is evidence of a genuine fault and must be investigated as one."""

        upsert_document(
            kind="failure_mode",
            title=f"Failure mode reference — {mode.replace('_', ' ').title()}",
            body=body, source="Senchine reliability knowledge base",
        )
        count += 1

    # 3. Standard operating procedures.
    sops = [
        (
            "SOP-01 Vibration analysis and bearing replacement",
            """SOP-01 Vibration analysis and bearing replacement

Scope. Applies to any rotating asset where the Prediction agent has classified bearing wear with a failure probability at or above 40%.

Procedure. 1. Capture a full vibration spectrum at the drive-end and non-drive-end bearing housings while the machine is at normal duty. 2. Compare the 1x, 2x and bearing-defect frequency bands against the asset baseline held in the condition-monitoring record. 3. Confirm the diagnosis against the ultrasonic trend — bearing degradation raises ultrasonic emission before it raises temperature. 4. Raise or confirm the work order and secure the spare bearing set and seals. 5. Isolate the asset under lockout/tagout. 6. Withdraw the rotor or open the bearing housing per the manufacturer's manual. 7. Inspect the removed bearing and photograph the failure surface for the maintenance record. 8. Fit the replacement bearing using induction heating — never flame heating, and never hammer the inner race. 9. Renew shaft seals. 10. Verify shaft alignment with a laser alignment tool before recommissioning. 11. Capture a post-repair vibration spectrum and store it as the new baseline.

Acceptance. Overall vibration velocity must return to within 15% of the commissioning baseline, and the bearing-defect frequency bands must be clear.

Hold points. Steps 5 and 11 are mandatory hold points requiring supervisor sign-off.""",
        ),
        (
            "SOP-02 Lubrication failure response",
            """SOP-02 Lubrication failure response

Scope. Applies where ultrasonic emission has risen above the healthy envelope and the Prediction agent has classified lubrication failure.

Urgency. Lubrication failures progress faster than any other mode tracked by the platform. A machine classified with lubrication failure at high severity may have only hours of useful life. Treat these as priority interventions regardless of the absolute failure probability.

Procedure. 1. Sample the lubricant and test for viscosity, water content and particle count. 2. Check the automatic lubricator reservoir level and verify the delivery rate against the design setting. 3. Inspect seals and breathers for ingress paths. 4. Isolate the asset under lockout/tagout. 5. Drain, flush and recharge the lubrication circuit with the specified grade. 6. Replace filters and breathers. 7. Restore and verify delivery rate. 8. Re-run the ultrasonic survey and confirm the emission has returned to baseline.

Root cause. A lubrication failure that recurs on the same asset within twelve months indicates an unresolved root cause — most commonly a failed lubricator, a contaminated supply, or a seal allowing ingress. Escalate to reliability engineering rather than repeating the intervention.""",
        ),
        (
            "SOP-03 EdgeSense retrofit installation and commissioning",
            """SOP-03 EdgeSense retrofit installation and commissioning

Scope. Bringing a legacy asset with no onboard instrumentation into predictive coverage.

Device placement. Accelerometer: magnetic or stud mount directly on the drive-end bearing housing, as close to the load zone as access permits. Mounting distance from the fault source drives estimate confidence, so prioritise proximity over convenience. Thermal camera: unobstructed line of sight to the machine body, within 4 m. Current clamp: on the motor supply cable inside the MCC panel — this is a galvanic connection and is unaffected by distance. Power meter: at the feeder breaker. Microphone array: on adjacent structure, within 3 m, away from other noise sources. Ultrasonic probe: aimed at the gearbox seam or bearing housing, within 2 m. Environmental node: at zone centre.

Commissioning. 1. Record the exact mounting distance for every device in the asset register — the fusion layer weights each contribution by distance, so an inaccurate figure produces an inaccurate confidence. 2. Run the asset at normal duty for at least one hour to establish a healthy baseline. 3. Verify the platform reports a fusion confidence of at least 0.60. Below that, coverage is insufficient for actionable prediction: add devices or reduce mounting distances.

Interpretation. Values from a retrofitted asset are fused estimates, not direct measurements. Trends and relative change are reliable; treat absolute values as indicative. The platform labels every retrofitted asset accordingly.""",
        ),
        (
            "SOP-04 Alert triage and escalation",
            """SOP-04 Alert triage and escalation

Scope. Handling alerts raised by the Senchine Maintenance agent.

Priority. P1 alerts require acknowledgement within 1 hour and an intervention decision within 4 hours. P2 requires acknowledgement within one shift. P3 and P4 are handled in the next planning cycle.

Triage. 1. Open the alert and read the root-cause analysis and the SHAP contributions. 2. Check the evidence confidence. On a retrofitted asset with confidence below 0.60, verify with a manual inspection before committing to downtime. 3. Check the trend panel — a consistent multi-snapshot decline is far stronger evidence than a single-frame spike. 4. Acknowledge the alert, which assigns you as owner. 5. Approve, reschedule or reject the associated work order.

False positives. Where an alert is judged incorrect, record it through the feedback control on the alert. Feedback is retained against the prediction and reviewed when the models are re-fitted. Do not simply close incorrect alerts without feedback — an unrecorded false positive will recur.

Escalation. Any P1 alert unacknowledged after 4 hours escalates automatically to plant management.""",
        ),
        (
            "POL-01 AI autonomy and human oversight policy",
            """POL-01 AI autonomy and human oversight policy

Principle. The Senchine agents propose; accountable humans dispose. No agent may authorise a shutdown, commit spend or approve work on a critical asset.

Autonomous limits. The Maintenance agent may schedule a work order without human approval only when all of the following hold: estimated cost at or below 2,500; estimated downtime at or below 4 hours; the asset is not classified business-critical; model confidence is at or above 60%; and the priority is not P1. Any work order failing one or more of these tests is created with status pending_approval and routed to a planner.

Explainability. Every prediction is published with SHAP attributions, a narrated root cause, a calibrated confidence and an explicit statement of limitations. A prediction that cannot be explained must not be acted on.

Safety boundary. No agent and no assistant may recommend bypassing, disabling, overriding or defeating an interlock, guard, emergency stop, protective trip or alarm; recommend working on live or running equipment; recommend skipping lockout/tagout; or recommend raising a protective setpoint to prevent a trip recurring. These recommendations are blocked structurally in the guardrail layer rather than left to model behaviour.

Data protection. Operational data is confidential. Outbound text from the assistant is redacted for credentials, API keys and personal contact details. Every authorisation decision and every state change is written to an append-only audit log.

Model provenance. The current models are trained on physics-based synthetic degradation profiles. They must be re-fitted on site-specific historical failure records before production deployment, and this limitation is stated on every prediction.""",
        ),
        (
            "REF-01 Reading health, anomaly and confidence scores",
            """REF-01 Reading health, anomaly and confidence scores

Health score (0-100). A composite of how far the machine's monitored channels deviate from their healthy envelope and how anomalous its overall state is. Bands: 80-100 healthy, 62-79 watch, 42-61 degraded, below 42 critical. The score is pulled toward a neutral 70 when evidence confidence is low — with weak evidence the platform genuinely does not know, and says so rather than guessing.

Anomaly score (0-1). Produced by a variational autoencoder trained only on healthy operation. It measures how far the current state sits from the learned healthy manifold, calibrated against the percentiles of the training distribution. Roughly 0.45 marks the edge of the healthy envelope and 0.70 is outside anything seen in healthy operation. Because it is unsupervised it will flag genuinely novel behaviour that no failure classifier was trained on.

Evidence confidence (0-1). How much the sensor evidence can be trusted, combining coverage (how much total evidence weight backs each channel), agreement (whether independent sensors concur) and live sensor health. Bands: 0.85+ high, 0.65-0.84 medium, 0.40-0.64 low, below 0.40 insufficient. Directly instrumented assets typically sit above 0.85; a well-installed retrofit kit reaches 0.65-0.75.

Model confidence. Distinct from evidence confidence. It combines the classifier's own decisiveness, the quality of the evidence it was given, whether a consistent trend corroborates it, and the quality of the SHAP attribution. A prediction can be highly certain in the model and still carry low confidence because the inputs were weak.""",
        ),
    ]

    for title, body in sops:
        kind = "policy" if title.startswith(("POL", "REF")) else "sop"
        upsert_document(
            kind=kind, title=title, body=body,
            source="Senchine operating procedures",
        )
        count += 1

    return count
