# Architecture

Design decisions, the alternatives considered, and the trade-offs accepted.

---

## 1. Layer separation

The brief asks for a clear boundary between the AI solution layer, enterprise
systems, and third-party services. The codebase enforces it by dependency
direction — each layer imports only downwards.

```
┌── Presentation ──────────────────────────────────────────────┐
│  frontend/  vanilla JS ES modules, no build step, no CDN      │
└───────────────────────┬──────────────────────────────────────┘
                        │ REST + WebSocket (JWT)
┌── API ────────────────┴──────────────────────────────────────┐
│  routers/  auth · fleet · workflow · insights                 │
│  security.py (authn/authz)   guardrails.py (safety)           │
└───────────────────────┬──────────────────────────────────────┘
┌── AI solution ────────┴──────────────────────────────────────┐
│  agents/     Monitoring → Prediction → Maintenance            │
│              AI Copilot (retrieval-grounded)                  │
│  ml/         VAE · multi-task MLP · Shapley · fusion          │
│  rag/        BM25 index + hybrid retriever                    │
│  llm/        Claude client + deterministic composer           │
└───────────────────────┬──────────────────────────────────────┘
┌── Enterprise data ────┴──────────────────────────────────────┐
│  db.py       fleet · telemetry · alerts · work orders ·       │
│              maintenance history · notifications · audit      │
│  physics.py  shared failure physics (single source of truth)  │
└───────────────────────┬──────────────────────────────────────┘
┌── External / simulated ┴─────────────────────────────────────┐
│  sim/        IoT gateway stand-in (MQTT/OPC-UA boundary)      │
│  Anthropic API (optional, isolated behind llm/client.py)      │
└──────────────────────────────────────────────────────────────┘
```

**What this buys.** Swapping the simulator for a real MQTT broker touches
`sim/` only. Swapping the VAE for a hosted model touches `ml/registry.py` only.
Removing Claude entirely leaves a working product, because the Copilot's fallback
is a first-class path rather than an error handler.

---

## 2. The canonical feature vector

Every model consumes one 16-dimensional, machine-agnostic vector where **1.0
means healthy nominal**.

**Why.** A cement kiln and a tablet press expose completely different tags. Two
options existed:

| Option | Verdict |
|---|---|
| A model per machine type | Rejected — 20 archetypes means 20 training sets and 20 retraining cycles; onboarding an industry becomes an ML project |
| One model on a canonical vector | **Chosen** — adding a machine type is a data entry in `sim/profiles.py`; the model generalises unchanged |

**The trade-off.** Machine-specific signals that do not map onto a canonical
channel are lost. For a fleet-wide platform that is the right trade: coverage
beats per-asset fidelity, and the fidelity is recoverable later by adding
channels (append-only, with a model version bump).

**The hazard this creates**, and the one that produced the most real bugs during
development: any feature computed differently at training time versus inference
time silently destroys accuracy. Three instances were found and fixed:

1. `vib_crest` normalised by 1.41 (sinusoid crest) at inference but set to 1.0 in
   training — put healthy machines 7σ off-manifold, so the whole fleet read as
   anomalous. Fixed by sharing one `HEALTHY_CREST_RATIO` constant.
2. `current_imbalance` required two current sensors, which no machine has — the
   most decisive electrical-fault signal was always zero in the field. Fixed with
   a single-sensor estimator based on excess within-window variance.
3. Trend channels were trained as proportional to damage *level*, but physically
   measure *rate of change*. A saturated fault has a flat trend, so remaining
   life was over-estimated exactly when it mattered. Fixed by making severity and
   rate independent inputs.

Each is now pinned by a test in `tests/test_ml.py::TestTrainServeConsistency`.

---

## 3. Anomaly detection: why a VAE

| Option | Verdict |
|---|---|
| Fixed thresholds | Rejected — single-channel only; constant false alarms across a fleet running at different duty points |
| Supervised classifier | Rejected — needs labelled failures, which plants do not have. This is the central obstacle, not a prototype artefact |
| Isolation Forest / One-Class SVM | Considered — competitive, but gives no per-feature reconstruction error to localise the deviation |
| **Variational autoencoder** | **Chosen** — trains on healthy data only, learns the joint manifold, and its per-feature reconstruction error localises which channel left the envelope |

The VAE captures *combinations*: high vibration is normal at full load and
abnormal at idle. A threshold cannot express that. Being unsupervised, it also
flags genuinely novel behaviour no classifier was trained on.

**Implementation.** ~1.5k parameters, hand-derived backpropagation in NumPy. No
torch wheel to install, the maths is auditable in a code walkthrough, and the
fleet baseline trains in about a second. The cost is that adding a layer means
deriving gradients by hand — acceptable at this scale, and the boundary is behind
`registry.py` if it ever isn't.

**Score calibration.** Raw reconstruction error is uninterpretable, so scores are
mapped through percentiles of the healthy training distribution (p50 → 0.08,
p95 → 0.45, p99.9 → 0.70, soft tail above). Square roots are applied to recon and
KL terms deliberately: squared error grows quadratically with deviation and
saturates the score while a fault is still early; the root makes it a distance
that keeps resolving across the whole degradation trajectory.

---

## 4. Prediction: one network, three heads

Failure probability, remaining useful life and failure type share a trunk.

**Why not three models.** The three questions read the same degradation
signature, so a shared trunk learns that representation once — cheaper and more
accurate at this data volume. More importantly it keeps the answers *mutually
consistent*: a model that says "98% failure probability" and "1 400 hours
remaining" is worse than useless on a maintenance floor.

**RUL as a forecast, not a lookup.** RUL depends on damage level *and*
progression rate. The same 60%-worn bearing has months left if stable and days if
accelerating. Modelling only level makes RUL a restatement of severity.

**Confidence is layered.** The model's own decisiveness is multiplied by evidence
quality from the fusion layer, then adjusted by trend corroboration and
attribution quality. The model does not know how good its inputs were; the
Prediction agent does, and propagates it. A prediction can be highly certain in
the model and still carry low confidence because the inputs were weak — the UI
shows both.

---

## 5. Explainability: Monte-Carlo Shapley

| Option | Verdict |
|---|---|
| Top deviating feature | Rejected — ignores the model entirely; blames ambient humidity in a damp factory |
| Permutation importance | Rejected — global, not per-prediction |
| Exact Shapley | Rejected — 2¹⁶ coalitions per prediction |
| **Sampled Shapley** | **Chosen** — unbiased, converges fast on a smooth model, and every sampled coalition evaluates in one batched matmul |

The whole explanation costs a single matrix multiply and lands in ~3 ms, which is
what makes it affordable on *every* prediction rather than an opt-in button. The
attribution residual is reported rather than hidden, so a poorly-converged
explanation is visible.

The narrated root cause is **templated from the numbers, not generated**. It
appears on work orders, so it must be reproducible and impossible to hallucinate.
The Copilot may paraphrase it; this remains the authoritative version.

---

## 6. Retrieval: BM25, not embeddings

Maintenance questions are dominated by exact identifiers — machine codes
(`M-102`), part SKUs (`BRG-6314-C3`), failure-mode names, standards. Lexical
retrieval is *better* than dense retrieval at exactly those, needs no embedding
model, no vector store and no per-query API cost, and rebuilds in milliseconds.

For this corpus size and query shape it is the right tool, not a compromise. Two
additions on top of textbook BM25: title field boosting, and decisive exact-match
boosting for identifiers.

**Hybrid by necessity.** A Copilot for a live plant cannot answer from documents
alone. "Why is M-102 critical?" is answered by this second's telemetry;
"what does bearing spalling look like?" is answered by the corpus. Two channels,
merged, both producing citations.

The tokenizer excludes `/` from tokens — a lesson from a real bug where
"lockout/tagout" became one token and no search for "lockout" could find the
safety procedure.

---

## 7. Human oversight

The autonomy boundary is enforced server-side in `guardrails.py`, not by hiding
UI buttons. The Maintenance agent may schedule autonomously only when *all* hold:

* estimated cost ≤ 2 500
* estimated downtime ≤ 4 h
* asset is not business-critical
* model confidence ≥ 60%
* priority is not P1

Anything else is created as `pending_approval` and routed to a planner. The bar
is deliberately conservative: an autonomous system that schedules downtime on a
critical asset off a low-confidence prediction destroys trust the first time it
is wrong, and trust is the actual adoption constraint for this category.

**The feedback loop.** Rejecting a work order or flagging a false positive writes
a `feedback` row against the specific prediction, suppresses the alert so it stops
re-firing, and surfaces in the analytics view as a false-positive rate. That is
the training signal for the next refit — the mechanism by which the system adapts
rather than repeating a mistake an engineer already corrected.

---

## 8. Data architecture

**SQLite in WAL mode**, one process-wide connection behind a re-entrant lock.

**Why.** The workload is one FastAPI process with a background pipeline. A
connection pool adds complexity without buying anything, and a server-based
database adds an operational dependency to a prototype that must start with one
command.

**Hot path / cold path.** Sensor readings go to an in-memory ring buffer *and*
SQLite. Agents read the ring buffer (microseconds, no I/O on the real-time path);
SQLite keeps the durable trace for history, audit and replay. Raw readings are
retention-trimmed to the most recent N per sensor — the analytical value lives in
the derived snapshots, not the raw samples.

**Level vs trend time bases.** Level statistics use the recent tail of the
window; slope uses the whole window. Sharing one time base means a fault that
developed in the last minute reads at roughly half its true magnitude — the
platform under-reports severity precisely while a fault is developing.

---

## 9. Real-time delivery

Topic-based WebSocket fan-out (`fleet`, `machine:<id>`, `alerts`, `agents`,
`user:<id>`). A browser watching one machine does not receive telemetry for the
other twenty-nine. Slow sockets have their oldest frame dropped rather than
blocking the pipeline — a lagging client still converges on current state.

The pipeline runs on a worker thread via `asyncio.to_thread`, so publishes
originate off the event loop. The hub captures the loop at startup and marshals
onto it with `run_coroutine_threadsafe`. (`asyncio.get_running_loop()` raises on
a worker thread — the first version of this silently dropped *every* realtime
event while appearing to work.)

---

## 10. Roadmap

**Now (this prototype).** One plant, 30 assets, simulated gateway, synthetic
training. Proves the agent pipeline, EdgeSense fusion, explainability and the
approval workflow end to end.

**0–3 months — one real production line.**
Replace the simulator with an MQTT/OPC-UA gateway. Re-fit models on the site's
own maintenance records. Integrate a real CMMS (SAP PM, Maximo, Fiix) so work
orders land in the system planners already use. Measure the baseline: current
unplanned downtime hours and cost per line.

**3–6 months — plant-wide.**
Move telemetry to a time-series store (TimescaleDB) and keep SQLite/Postgres for
transactional state. Horizontally scale the Monitoring agent by asset shard.
Per-asset threshold personalisation from accumulated feedback. Target: a
measurable shift in planned-vs-reactive ratio, which is the leading indicator of
adoption.

**6–12 months — multi-site.**
Federated model training across plants so a failure mode learned at one site
improves predictions at another without moving raw operational data. Mobile
technician app with offline work-order completion. Spare-parts optimisation
driven by fleet-wide RUL forecasts.

**Success is measured by** predictive accuracy on the site's own failures,
reduction in unplanned downtime hours, planned-vs-reactive ratio, alert
acknowledgement latency, and false-positive rate from the feedback loop — all of
which the platform already instruments.

---

## 11. Trade-offs accepted

| Decision | Gained | Cost |
|---|---|---|
| NumPy models | Zero heavy dependencies, auditable maths, ~15 s training | Manual gradients; no GPU path |
| SQLite | One-command start, no services | Single-writer; needs replacing at multi-site scale |
| Vanilla JS frontend | No build step, no CDN, no supply chain | No component ecosystem; more hand-written DOM code |
| BM25 retrieval | No embedding cost, exact identifier matching | Weaker on paraphrase than dense retrieval |
| Synthetic training data | Labelled failure trajectories that do not otherwise exist | Must be re-fitted on real data before production |
| Simulated IoT gateway | Reproducible demo, injectable failure scenarios | Not a real broker integration |
| Conservative autonomy limits | Trust; no surprise downtime | More human approvals than strictly necessary |
| One canonical feature vector | Ten industries on one model | Machine-specific signals outside the 16 channels are lost |
