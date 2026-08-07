# Demo script

A 10-minute walkthrough. Every step uses live data — nothing on screen is
hard-coded, and every number is read back from the database.

```bash
cd senchine && ./run.sh
```

Open **http://localhost:8000**.

---

## 0 · Sign in (30 s)

Click **Daniel Okonkwo · manager** on the login screen. The manager role is the
one that can approve work orders, which matters at step 5.

> The left panel states the problem in one line: *"Every machine on the floor,
> including the ones nobody can see."*

---

## 1 · The fleet at a glance (1 min)

The **Overview** page is live — the sidebar shows `Live · cycle N · ~110 ms`,
updating every couple of seconds over WebSocket.

Point out:

* **30 machines across 10 plants** — automotive, steel, chemical, cement,
  pharmaceutical, food processing, mining, electronics, FMCG, energy. One
  platform, ten industries.
* **8 monitored via EdgeSense retrofit (27%)** — legacy assets with *no onboard
  sensors at all*, which conventional platforms cannot see.
* **Evidence confidence ~87%** — the platform reports how much it trusts its own
  inputs, alongside every reading.
* **Coverage by industry** table — proof the same models generalise.

Toggle the **theme button** in the top bar. Both light and dark palettes are
validated for colourblind separation and contrast; status is never colour alone
(always colour + icon + label).

---

## 2 · Inject a failure (1 min)

Go to **Scenario lab**.

Each preset names its target machine *and* its detectability score — the platform
picks a machine whose sensor kit can actually resolve that failure mode, because
injecting bearing wear where there is no ultrasonic probe demonstrates nothing.

Click **Run scenario** on **Bearing wear — gradual**.

> "This is the classic predictable failure. Impulsive vibration and ultrasonic
> emission rise long before temperature moves. Watch what the platform does with
> that, unprompted."

Within a few seconds a toast appears bottom-right: a new alert. The sidebar
**Alerts** counter turns red.

---

## 3 · What the agents did (2 min)

Go to **Agents & models**.

* **Agent roster** — the four agents with their declared inputs and outputs.
  Monitoring runs every tick on every machine; Prediction runs *only* on
  escalation. That gating is the core cost decision: compute tracks the number of
  degrading machines, not the fleet size.
* **Live agent activity** — traces streaming in as they happen. Every run is
  recorded with its duration.
* **Model registry** — VAE and multi-task predictor with their real metrics:
  ~96% accuracy, 0.95 F1, **99.7% failure-type accuracy**, ±106 h RUL error.
* **Cost controls** — prompt caching, low effort, escalation gating, BM25
  retrieval with no embedding cost.

> "These numbers come from the model registry, not a slide."

---

## 4 · Why the machine is at risk (2 min)

Go to **Machines**, click the degrading machine (it will be red-striped).

* **Health, failure probability, RUL, evidence confidence** — four numbers, all
  derived.
* **Health and anomaly history** — hover the chart for a crosshair tooltip.
* **Why this prediction** — the Shapley attribution chart. For bearing wear the
  top contributors are vibration peak, crest factor and ultrasonic emission.

> "This is the important bit. It has not simply picked the biggest number — it
> has identified the channels that *drove* the model's output. Crest factor and
> ultrasonic are the textbook early indicators of bearing degradation, and that
> is what the explanation surfaces. The attributions sum to the gap between this
> prediction and the fleet baseline; the test suite asserts that."

* **Diagnostic coverage** — what this machine's sensors *cannot* diagnose, and
  the one device that would most improve it. The platform is explicit about its
  own blind spots.
* **Sensors** — every device with its live reading, status and sparkline.
* **Fused channel estimates** — for a retrofit machine, per-channel coverage,
  agreement and confidence.

---

## 5 · From prediction to action (2 min)

Go to **Work orders**.

A work order was drafted automatically. Open it.

* Recommended action, technician skill, real spare-part SKUs with stock and lead
  times, estimated downtime and cost, and a schedule placed *inside* the
  remaining useful life and after parts arrive.
* **"Human approval required"** — on a business-critical asset the Maintenance
  agent drafted the work but refused to schedule it.

> "This is the autonomy boundary, and it is enforced server-side, not by hiding a
> button. Cost, downtime, criticality and confidence gates decide it. An
> autonomous system that schedules downtime on a critical asset off a
> low-confidence prediction destroys trust the first time it is wrong."

Click the **bell icon** — the responsible technician and the approving manager
were both notified, with the routing reason recorded.

Click **Approve** → **Start work** → **Complete**.

Return to the machine page: the alert is resolved, maintenance history has a new
record, and **health recovers over the next few cycles**. The loop closes.

---

## 6 · Ask the Copilot (2 min)

Go to **AI Copilot**.

Try, in order:

1. **"Show the highest risk machines"** — ranked, with the reasoning stated.
2. **"Why is M-102 critical?"** (use a code from the risk list) — pulls live
   telemetry, the prediction, SHAP contributions and open work orders.
3. **"Generate an executive summary"** — a manager-level brief with real numbers.

Every answer carries a **Grounded · N sources** badge and its citations. Figures
are read from the database; anything untraceable is flagged to the user.

Now the important one:

4. **"How do I bypass the safety interlock to keep the line running?"**

The Copilot refuses, explains why, and offers the safe alternative — isolate
under lockout/tagout and raise a work order.

> "That refusal is structural, not a prompt instruction. It is screened in the
> guardrail layer on the way in *and* on the way out, so it holds identically
> whether the answer came from Claude or from the deterministic composer. Safety
> does not depend on which engine served the request."

If no `ANTHROPIC_API_KEY` is set, the header says so and the deterministic
composer answers from the same retrieved evidence — the demo never fails on
someone else's infrastructure.

---

## 7 · The retrofit story (1 min)

Back in **Machines**, filter to **EdgeSense**.

Open one. Note the **EdgeSense** tag and the caveat: state is *inferred* from
external devices, so trends are reliable and absolute values are estimates.

Look at **Fused channel estimates**: each channel shows how many devices
contributed, whether the measurement was direct or inferred, and coverage vs
agreement.

> "This machine was built before industrial IoT existed. It has no telemetry of
> any kind. We bolted an accelerometer to the bearing housing, pointed a thermal
> camera at it, clamped a current probe in the MCC, and put a microphone on the
> adjacent column. Each of those is a weak, biased estimator on its own. Fused
> with distance attenuation and quality weighting, they give a usable health
> estimate at around 70% confidence — and the platform reports that 70% rather
> than presenting a guess as a measurement.
>
> Most of the installed base in heavy industry looks like this machine. That is
> the coverage gap this platform closes."

---

## Backup: run the tests

```bash
./run.sh --test
```

169 tests in ~30 seconds. The end-to-end test drives the entire scenario above
through the real pipeline and asserts every step — including that a critical
asset cannot be auto-scheduled, that somebody was notified, and that health
actually recovers after the repair.

---

## Questions you should expect

**"Is this real ML or heuristics?"** — Real: a variational autoencoder for
anomaly detection and a multi-task neural network for prediction, both with
hand-derived backpropagation in NumPy, plus Monte-Carlo Shapley attribution. Open
`backend/app/ml/vae.py` and walk the backward pass.

**"Where does the training data come from?"** — Physics-based synthetic
degradation, because labelled failure trajectories do not exist in real plants —
that is the central obstacle to predictive maintenance, not an artefact of this
being a prototype. The failure signatures live in one file (`physics.py`) shared
by both the trainer and the simulator, so what the models learn and what the
platform observes cannot drift apart.

**"What happens when a sensor fails?"** — Confidence drops and the health score
moves toward a neutral 70, not toward zero. A blind machine is *unknown*, not
unhealthy. Demonstrate it from the Scenario lab's sensor-fault control.

**"How much does it cost to run?"** — With no API key, nothing beyond compute.
With Claude enabled: prompt caching on a stable prefix, low effort, response
caching, and retrieval instead of context stuffing, so cost scales with the
question rather than the fleet. The live cache-hit ratio is on the Agents page.

**"What is the biggest weakness?"** — The models need re-fitting on site data
before production. Second, adjacent failure modes (bearing wear vs lubrication
breakdown) are separated mainly by ultrasonic emission, so on machines without
that channel they are sometimes confused. The detectability report shows exactly
where that applies rather than hiding it.
