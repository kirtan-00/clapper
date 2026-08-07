# Senchine AI

**Multi-agent predictive maintenance — including for the machines that have no sensors.**

Most of the installed base in heavy industry predates IoT. A 1998 gearbox has no
CAN bus, no Modbus register, no telemetry of any kind. Conventional predictive
maintenance platforms simply cannot see these assets, which is exactly where
unplanned downtime concentrates.

Senchine AI covers both: modern instrumented equipment through its own telemetry,
and legacy equipment through **EdgeSense Retrofit** — non-invasive external
devices whose readings are fused into a machine-health estimate with a calibrated
confidence score.

---

## Quick start

```bash
cd senchine
./run.sh
```

Open **http://localhost:8000** and sign in with `engineer@senchine.ai` / `senchine`.

First boot seeds 30 machines across 10 plants, trains the models (~20 s) and
primes the pipeline. Nothing else is required — no API key, no database server,
no build step.

```bash
./run.sh --test     # 169 tests, ~30 s
./run.sh --reset    # wipe database + models and start fresh
```

### Demo accounts

| Email | Role | Can do |
|---|---|---|
| `admin@senchine.ai` | admin | everything |
| `manager@senchine.ai` | manager | **approve work orders**, read the audit log |
| `engineer@senchine.ai` | engineer | inject scenarios, run analyses |
| `tech.mech@senchine.ai` | technician | acknowledge alerts, progress work orders |
| `viewer@senchine.ai` | viewer | read-only |

All share the password `senchine`.

---

## What it does

### Four agents, one pipeline

| Agent | Runs | Produces |
|---|---|---|
| **Monitoring** | every tick, every machine | health score, sensor status, anomaly score, fused feature vector |
| **Prediction** | only for machines Monitoring escalates | failure probability, remaining useful life, failure type, confidence, SHAP root cause |
| **Maintenance** | on every new prediction | priority, recommended action, technician skill, spare parts, downtime, cost, schedule |
| **AI Copilot** | on user request | grounded natural-language answers with citations |

Expensive stages are gated on cheap ones: Prediction and Maintenance run only for
machines Monitoring flags, so compute tracks the number of *degrading* machines
rather than the fleet size.

### EdgeSense Retrofit — the core innovation

Do not instrument the machine; instrument its neighbourhood. Eight device classes
(accelerometer, thermal camera, current clamp, power meter, microphone,
ultrasonic probe, industrial camera, environmental node) each observe the machine
indirectly. Every device/channel pair carries three multiplicative weights:

1. **Relevance** — how directly this modality observes this channel. A bolted
   accelerometer measures vibration almost directly (0.95); a microphone infers
   it from radiated sound (0.55).
2. **Distance attenuation** — `exp(-d / decay)`, per modality. Structure-borne
   vibration dies within a metre; a current clamp is galvanic and does not
   attenuate at all.
3. **Signal quality** — live sensor health, degraded by dropouts and faults.

Fused estimates ship with a confidence built from *coverage* (how much evidence
backs the channel) and *agreement* (do independent estimators concur). A single
noisy microphone at 6 m yields low confidence and the platform says so, rather
than presenting a guess as a measurement.

Measured separation: directly instrumented ≈ **0.87**, full retrofit kit ≈
**0.70**, sparse retrofit ≈ **0.23**, all-sensors-failed **0.00**.

### Diagnostic coverage

The platform also reports what it *cannot* see. Each machine's sensor kit is
intersected with each failure mode's signature to produce a detectability score,
and where coverage is short it names the single device that would most improve it
— turning a limitation into a costed recommendation.

---

## Architecture

```
Browser (vanilla JS, no build step, no CDN)
   │  REST + WebSocket
   ▼
FastAPI
   ├── Agent pipeline ── Monitoring → Prediction → Maintenance
   │                          │
   │                     AI Copilot ── hybrid retrieval ── Claude (optional)
   ├── ML layer (NumPy) ── VAE · multi-task MLP · Monte-Carlo Shapley · fusion
   ├── Guardrails ── redaction · safety screen · autonomy limits · grounding
   └── SQLite (WAL) ── fleet · telemetry · alerts · work orders · history · audit
```

Full design rationale, alternatives considered and trade-offs: **[ARCHITECTURE.md](ARCHITECTURE.md)**.
Scripted walkthrough: **[DEMO.md](DEMO.md)**.

### The AI layer

**Anomaly detection — variational autoencoder (NumPy, ~1.5k parameters).**
Trained only on healthy operation, which is the only data a plant reliably has.
It learns the *joint manifold* of healthy behaviour, so it flags "high vibration
at idle" while accepting "high vibration at full load" — something no fixed
threshold can do.

**Prediction — multi-task MLP with three heads.** Failure probability, remaining
useful life and failure type share one trunk, so the three answers stay mutually
consistent. Measured on held-out synthetic data: **96% accuracy, 0.95 F1, 99.7%
failure-type accuracy, ±106 h RUL error**.

**Explainability — Monte-Carlo Shapley.** Every prediction carries attributions
that sum to the gap between it and the fleet baseline (efficiency is asserted in
the test suite). Sorting features by deviation is not an explanation; it ignores
the model and blames ambient humidity because the factory is damp.

**Copilot — hybrid retrieval, then generation.** Live structured state (exact SQL
against current records) plus BM25 over manuals, SOPs and failure-mode
references. With `ANTHROPIC_API_KEY` set it answers with Claude; without one, a
deterministic composer answers from the *same* evidence. Both paths pass through
identical guardrails, so safety never depends on which one served the request.

### Guardrails

* **Redaction** — credentials, keys and contact details stripped from all outbound text.
* **Safety screen** — bypassing an interlock, disabling a trip, skipping
  lockout/tagout, or working live is refused structurally, with the safe
  alternative offered. Screened on the *question* and again on the *answer*.
* **Autonomy limits** — the Maintenance agent may schedule autonomously only
  below 2 500 cost, below 4 h downtime, on a non-critical asset, above 60%
  confidence, and never at P1. Everything else lands as `pending_approval`.
* **Grounding** — an answer with no citation is labelled unverified. Figures that
  cannot be traced to retrieved evidence are flagged to the user.

### Cost engineering

| Control | Effect |
|---|---|
| Prompt caching | Stable system prefix cached; volatile content after the breakpoint |
| `effort: low` | The Copilot summarises evidence; it does not need deep reasoning |
| Retrieval, not stuffing | Cost scales with the question, not the fleet |
| Response cache | Identical questions inside a TTL are free |
| Escalation gating | Prediction/Maintenance skip healthy machines |
| BM25 retrieval | No embedding model, no vector store, no per-query API cost |
| NumPy models | No GPU, no torch; whole fleet trains in ~15 s |

---

## Testing

```
169 tests, ~30 s, no network required

tests/test_ml.py       57  features, VAE, predictor, Shapley, fusion, detectability
tests/test_api.py      44  auth, authorization, fleet, workflow, analytics, simulation
tests/test_agents.py   68  agents, guardrails, retrieval, Copilot, end-to-end
```

The end-to-end test exercises the whole product claim through the real pipeline:
inject a fault → monitoring detects it → alert raised → work order drafted with
parts, skill, cost and schedule → **critical asset blocked from auto-scheduling**
→ responsible person notified → manager approves → work completed → history
written, alert closed → machine health recovers → decisions present in the audit
log.

Several tests exist specifically to pin down train/serve consistency — a feature
computed one way during training and another way at inference was the single
largest source of real defects during development.

---

## Configuration

Everything has a working default; copy `.env.example` to `.env` to change any of it.

| Variable | Default | Purpose |
|---|---|---|
| `SENCHINE_DB` | `./senchine.db` | SQLite path |
| `SENCHINE_PORT` | `8000` | HTTP port |
| `SENCHINE_JWT_SECRET` | random per boot | Set to keep sessions across restarts |
| `SENCHINE_TICK_SECONDS` | `2.0` | Sensor sampling interval |
| `SENCHINE_PIPELINE_EVERY` | `3` | Run heavy agents every N ticks |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables Claude-powered Copilot answers |
| `SENCHINE_LLM_MODEL` | `claude-opus-5` | Model for the Copilot |
| `SENCHINE_LLM_EFFORT` | `low` | Reasoning effort |

---

## Honest limitations

* **Models are trained on physics-based synthetic degradation**, not this site's
  history. They must be re-fitted on real failure records before production use.
  This is stated on every prediction in the UI, not buried here.
* **Failure-type accuracy depends on sensor coverage.** Bearing wear and
  lubrication failure are adjacent modes separated mainly by ultrasonic emission;
  on a machine without an ultrasonic probe — or a retrofit where that channel is
  the most attenuated — the two are sometimes confused. The detectability report
  surfaces exactly this rather than hiding it.
* **Avoided-cost figures are model estimates**, derived from predicted
  probability and each asset's hourly downtime cost. They are a planning aid and
  are labelled as such everywhere they appear.
* **The IoT gateway is simulated.** The simulator stands in for MQTT/OPC-UA with
  a faithful physical model, including dropouts, stuck sensors and EMI noise, but
  a production deployment replaces it with a real broker.
* **Single-process design.** SQLite in WAL mode and an in-process pipeline suit
  one plant comfortably. Multi-site scale needs a broker, a time-series store and
  horizontally scaled agents — see the roadmap in ARCHITECTURE.md.
