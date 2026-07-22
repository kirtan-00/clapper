# Clapper — Real-Usage & Willingness-to-Pay Validation Plan

**Product:** Clapper — free phone-first PWA that logs takes on set and exports continuity/TCR sheets, CSV, and a Premiere-ready timeline (FCP7 XML). Live at https://clapboard.duckdns.org
**Maker:** Kirtan (creative director / filmmaker, Ahmedabad; runs CrayWingz)
**State:** Free, Google sign-in, server-authoritative quotas (5 Script Mode, 5 Premiere-XML export, 5 CSV export). Analytics `events` table already logs `app_open / roll / cut / script_use / export / cap_hit` with `?ref` tagging. `is_pro` flag exists server-side, unused.
**Date:** 2026-07-16

The two questions this plan answers:
1. How do we get Clapper used *for real* on sets — not vanity signups — and get feedback?
2. Will the market pay, who, and how much — a real WTP test, not a guess?

The whole plan is built to exploit one advantage you already shipped: **the `events` table is your validation instrument.** You do not need to ask people if they used it. You can see `roll`/`cut`/`export`/`cap_hit` per user in SQL. Design every experiment so its result lands as a row in that table.

---

## Guiding principle: instrument first, recruit second

Before recruiting anyone, make sure you can answer "did this specific person actually shoot with it?" from the DB. You already can. So the funnel you measure is:

- **Signup** = profile row created.
- **Activation** = a real shoot logged. Concrete definition: **≥1 session with ≥8 `cut` events AND ≥1 `export`, where the project is not a demo/Treeland/example pack.** (8 cuts ≈ a real setup with coverage, not a two-tap kick-the-tyres.)
- **Retention** = **a 2nd distinct shoot day** (a second cluster of `roll`/`cut` on a different calendar date, same user). This is the single most important number in the whole plan. One shoot is curiosity; two shoots is a habit forming.
- **WTP intent** = a `cap_hit` event followed by a click on a "Get Pro" CTA (see Part B).

Add one lightweight thing to your reporting even if you add nothing to the app: a saved SQL query / tiny dashboard that lists, per user email: signup date, # shoot days, total cuts, total exports, cap_hits, `?ref` source. Look at it daily during the test window. That list *is* your design-partner pipeline and your WTP pipeline.

---

## PART A — Getting it into real hands (ranked by leverage)

### A1. Dogfood on your own CrayWingz shoots — highest leverage, do it first (this week)

You are the ideal design partner: you shoot ads, you cut them in Premiere, you feel the pain. Nothing you do to recruit strangers matters if the tool doesn't survive your own next shoot.

**Instrument it:**
- Use Clapper as the *primary* take log on the next 2 CrayWingz shoots — no parallel paper sheet as a crutch (keep paper only as a silent backup you check against afterwards).
- After each shoot, take the exported FCP7 XML into the *actual* Premiere edit and confirm relink works on real footage from that shoot (you already fixed clipExt/relink on 2026-07-14 — this is the field re-test).
- Log every friction point in one running note: where did you tap wrong, where did the timer/hero read wrong, what did the DIT/editor ask for that isn't there.
- Have whoever cuts the ad tell you, in minutes, how much faster the XML-with-markers made the assembly vs. eyeballing. **Write that number down.** It is the seed of your entire WTP argument for editors.

**Word-of-mouth is the channel, and it's already lit.** Film crews are a closed, high-trust network — the 1st AD who sees you run ROLL on your phone will ask what it is. On set, when someone asks, do the 20-second demo and text them the link *there, on set*. Tag those signups with `?ref=onset` so you can tell in-network referrals from cold internet later.

### A2. A 5–15 crew "design-partner beta" — the core recruiting motion (Week 1–2)

You want a *small* number of *real* crews, not a big number of tourists. 5–15 is right. Rank the recruiting sources by conversion-to-real-usage:

**Tier 1 — warm, local, will actually shoot (do these first):**
- **Your own network of ADs, DITs, and script sups in Ahmedabad/Mumbai.** DM or call 10–15 people you've worked with. Highest yield because they trust you and they have shoots on the calendar this month.
- **A film school production class in Ahmedabad/Gujarat (e.g. an NID / local film-and-TV program or a private film institute).** Students shoot constantly, on phones, with no budget for ScriptE, and a professor can put it in front of 30 students at once. This is the single densest source of real, repeated on-set usage. Offer to do a free 30-minute guest session ("how pros log continuity, and a free tool to do it").

**Tier 2 — online communities where the target actually hangs out:**
- **IG DMs to working script supervisors and 1st ADs.** Search hashtags/geo (#scriptsupervisor, #1stAD, #onset, Mumbai/India film tags), find people posting from sets, send the exact ask below. Personal, one at a time — 10 good DMs beat 200 blasts.
- **Filmmaker Discords & FB groups** (r/Filmmakers-adjacent Discords, Indian filmmaking FB groups, script supervisor groups). *Value-first* posting only — you already flagged the Reddit r/Filmmakers value-first launch. Don't drop a link cold; post the continuity-sheet template or the "jam-cam time-of-day TC" doctrine as a genuinely useful thing, tool mentioned once at the end.
- **r/Filmmakers / r/editors** — your planned launch. Lead with the editor angle in r/editors (the XML export is the hook there), continuity angle in r/Filmmakers.

**The exact ask (design partner):**
> "I built a free phone app that logs takes on set and spits out a continuity sheet, a CSV, and a Premiere-ready timeline you can drop straight into your edit. I'm looking for 10 crews to use it on ONE real shoot and tell me where it breaks. No cost, no catch — I need honest feedback more than I need users. If you've got a shoot in the next 2 weeks, can you run it on that and give me 15 minutes after? I'll owe you one."

Why this ask works: it's specific ("one real shoot"), it's honest ("where it breaks"), it costs them nothing, it has a clear time box, and it asks for a shoot they *already have* rather than manufacturing usage.

**Design-partner commitment mechanics:** get a soft yes tied to a *specific dated shoot* ("you said the 22nd, right?"). Put those dates in your calendar. The day before, send a one-line nudge with the link. The day after, send the 15-minute feedback request while it's fresh. Un-nudged design partners evaporate.

### A3. What "used it for real" looks like — the measurement contract

| Stage | Definition (from `events`) | Target in 2-week window |
|---|---|---|
| Signup | profile row | 25–40 |
| Activation | ≥1 real shoot: ≥8 `cut` + ≥1 `export`, non-demo project | 8–12 |
| Retention | 2nd distinct shoot day, same user | 3–5 |
| Deep use | used Script Mode OR hit a cap | 3–6 |

The retention number is the one that tells you if this is a product or a toy. **If people log one shoot and never come back, no pricing test will save it — fix the product before testing WTP.**

**Events to lean on (already tracked):** `app_open` (curiosity), `roll`/`cut` (real logging — count `cut`s per session to distinguish real shoots from taps), `export` (they got value out), `script_use` (they tried the AI breakdown), `cap_hit` (they wanted *more* — the golden WTP signal). Make sure `?ref` tagging is consistently appended to every recruiting link (`?ref=onset`, `?ref=filmschool`, `?ref=reddit`, `?ref=igdm`) so you can see which channel produced *real usage*, not just clicks.

### A4. The feedback loop — make it near-zero-friction

- The app already has a **"Send feedback" mailto** button. That's your qualitative channel. But mailto is high-friction on mobile — most people won't. So **don't rely on it as the primary loop.** Use it as a catch-all and drive real feedback through the 15-minute post-shoot conversation (call/DM voice note) you already committed to in the ask.
- **Trigger-based outreach.** Once a day, look at the DB. The moment a user crosses activation (real shoot logged), DM them: "Saw you ran a shoot on Clapper — how'd it hold up? Anything break?" People respond to a human who noticed. This converts silent users into feedback and into referrals.
- **`cap_hit` is a feedback trigger too.** When someone hits a quota cap, that's a person telling you they want more. Reach out (or, better, show the in-app offer — Part B5).
- Keep a single **CHANGELOG / "you asked, we shipped"** note you can send back to a design partner when their request ships. Closing the loop turns a one-time tester into an evangelist inside the crew network.

---

## PART B — Willingness-to-Pay validation (the core ask)

### B1. Rank the segments by ability × willingness to pay

| Segment | Ability to pay | Willingness | Why | Verdict |
|---|---|---|---|---|
| **Video editors** (the person who imports the XML) | Medium–High | **High** | The XML→Premiere export saves *quantifiable* hours per project on assembly/finding selects. Time = money, and they buy tools (already pay for plugins). This is your sharpest ROI story. | **Primary WTP target** |
| **Production houses / ad agencies (per-project)** | **High** | Medium–High | They bill clients; a ₹500–₹2,000 tool that de-risks a shoot day is a rounding error on a project budget. They can expense it. Decision-maker is a producer/line producer. | **Primary paid-pilot target** |
| **Script supervisors (prosumer)** | Medium | Medium–High | This is their core job tool; ScriptE/MovieSlate prove sups *do* pay for continuity software. But there are fewer of them and many use paper. | **Secondary / prosumer tier** |
| **Film schools (site license)** | Medium (institutional budget) | Medium | Slow sales cycle, but one sale = 30–100 seats and recurring cohorts. Great for reach + testimonials, weaker for fast revenue signal. | **Slow-burn / distribution** |
| **1st ADs, DITs, students** | Low | Low–Medium | Value the tool but won't personally pay much; students are broke. Great for *usage and word-of-mouth*, poor for revenue. | **Keep free — they're the top of funnel** |

**Read:** Editors have the cleanest ROI story (test them first). Production houses have the deepest pockets and give the strongest *behavioral* signal (a paid pilot). Script sups are the natural prosumer subscriber. Students/ADs stay on the free tier forever and feed the network.

### B2. Concrete WTP test methods (each with how-to and the signal to read)

#### B2a. Fake-door pricing page (the fastest, run it FIRST)
Build a single static "Clapper Pro" page: lists Pro benefits (unlimited Script Mode, unlimited XML/CSV exports, maybe multi-cam offset wizard, team projects), shows a **price**, and one button: **"Get Pro"** (or "Notify me when Pro launches"). Clicking → an email-capture field + a one-line "what would you pay for?" text box. Nothing is actually built or charged.
- **How to run:** link to it from the app's cap-hit moment and the exports screen. Show a real number (test ₹399/mo or ₹1,499/yr in India; $9/mo globally — see B4).
- **Signal to read:** click-through rate on "Get Pro" among people who *saw* it, especially among users who already activated. **>10–15% of activated users clicking = real intent.** Emails captured = your pre-sell list. The free-text answers tell you the packaging and the price ceiling. A/B two prices across the `?ref` split if traffic allows.
- **Why first:** zero build, measures *revealed* interest (a click), and it seeds a waitlist you can pre-sell to in B2d.

#### B2b. Direct pricing interviews with pros (do 8–10, in parallel with the beta)
Get on a call/voice note with editors, sups, and a producer or two. Don't pitch — diagnose. Exact questions:
1. "Walk me through how you log/track takes today — what do you actually use?" (paper, MovieSlate, notes app, nothing)
2. "What does that cost you — in money, and in time when you're cutting or finding a take later?"
3. "Last shoot — what went wrong with continuity or finding a take? What did it cost?" (surface the pain, concretely)
4. "If a tool made [their #3 pain] disappear, what would make it a no-brainer to pay for — and what's 'too cheap to be trustworthy' vs. 'too expensive'?"
5. "Who signs off on buying a tool like this — you, or a producer?" (finds the real buyer)
6. "If I charged for the Premiere export, would you pay per project, per month, or expense it to the production?" (tests packaging)
- **Signal:** listen for an *unprompted* number and an *unprompted* pain. If you have to lead them to a price, WTP is weak. If an editor says "honestly I'd pay ₹500 a shoot if it saved me an evening," that's gold — write the exact quote down.

#### B2c. Van Westendorp Price Sensitivity Meter (run inside the pricing page or a short form)
Ask the 4 questions, tailored to Clapper. Frame it around "Clapper Pro — unlimited exports + Script Mode + team features":
1. **Too expensive:** "At what monthly price would Clapper Pro be *so expensive* you wouldn't consider it?"
2. **Too cheap:** "At what price would it be *so cheap* you'd question whether it actually works / is maintained?"
3. **Getting expensive (but worth considering):** "At what price does it start to feel expensive, but you'd still think about it because it saves you time?"
4. **A bargain:** "At what price would Clapper Pro be *such a good deal* you'd sign up right away?"
- **How to run:** needs ~20–30 responses to be meaningful — pool your beta crews + interview subjects + pricing-page visitors. Run one India-currency version (₹) and one global version ($) separately; don't mix currencies.
- **Signal:** plot the curves; the acceptable range sits between "too cheap" and "too expensive," optimal near the "bargain/getting-expensive" cross. Use it to *set the test price range*, not the final price.

#### B2d. Soft pre-sell / paid pilot — the STRONGEST signal (the one that actually matters)
Talk is cheap; a card charge is not. Offer a **production house a small paid pilot: one shoot, Clapper Pro unlocked, ₹2,000–₹5,000 flat** (or a per-seat pilot for a script sup at ₹499). "I'll set you up, unlock everything, and support you live on the shoot day. If it doesn't earn its keep, I'll refund it."
- **How to run:** you already have `is_pro` server-side — flip it manually for the pilot account, no billing build needed. Collect the money over UPI/Razorpay link.
- **Signal:** **anyone who actually pays — even ₹499 — is worth more than 100 "yeah I'd pay" survey answers.** One paid pilot converts WTP from opinion to fact. Target 1–2 paid pilots in the 2-week window; even *one* is a strong continue signal.

#### B2e. Usage-gated conversion — turn the cap into the WTP probe (you already built this)
The quotas (5 Script Mode / 5 export / 5 CSV) are not just abuse protection — they're a **natural willingness-to-pay experiment.** Someone who burns 5 exports is a heavy, activated user by definition. The moment they hit `cap_hit`:
- Show an in-context offer: *"You've used your 5 free exports — you're clearly running real shoots. Clapper Pro gives you unlimited exports + Script Mode. [Get Pro] / [Tell me what you'd pay]."*
- This is the fake-door (B2a) fired at the highest-intent possible moment.
- **Signal:** conversion (or click) rate *at the cap* is the cleanest WTP number you'll get — it's measured on people who already got enough value to exhaust the free tier. Track `cap_hit → CTA click` as an explicit funnel. **A high cap-hit-to-click rate is the green light to build billing.**

### B3. Priority order of the WTP tests
1. **B2e cap-hit offer + B2a fake-door** (combined; near-zero build; fires at peak intent) — *start immediately.*
2. **B2b interviews** (qualitative why + the buyer) — *parallel, Week 1.*
3. **B2d paid pilot** (the fact, not the opinion) — *Week 2, aimed at a production house you dogfood-partner with.*
4. **B2c Van Westendorp** (to calibrate the price range) — *Week 2, once you have a response pool.*

### B4. Price points & packaging to TEST (hypotheses, not final)

Anchors from comparable prosumer on-set apps (global): **Shot Lister Pro $15.99/mo or $99.99/yr; MovieSlate Script Dept $9.99/mo (~$120/yr); ScriptE** is the desktop market leader at a much higher, quote-based/desktop price. So a $9–$16/mo prosumer subscription is *market-normal* globally. India must be priced far lower in absolute terms (but per-project to production houses can hold value).

Three packaging hypotheses to test:

**H1 — Prosumer per-seat subscription (script sups, editors, solo filmmakers)**
- India: **₹299–₹499/mo or ₹1,999–₹2,999/yr.**
- Global: **$9–$12/mo or $79–$99/yr.**
- Includes: unlimited Script Mode + unlimited XML/CSV exports + (v2) multi-cam offset wizard.
- Best tested via B2a/B2e/B2c.

**H2 — Per-project / per-shoot (production houses, ad agencies)**
- India: **₹500–₹2,000 per project** (a project = a shoot or a job).
- Global: **$15–$40 per project.**
- Rationale: matches how production budgets actually work — expensed per job, no subscription commitment, decision is trivial against a shoot-day budget. This is likely the **easiest yes from an agency** and the best fit for the paid pilot (B2d).

**H3 — Team / studio & film-school site license**
- Studio/agency team: **₹15,000–₹40,000/yr** (India) / **$500–$1,500/yr** (global) for a shared team workspace + multi-user projects.
- Film-school site license: **₹25,000–₹75,000/yr** (India) per program / **$1,000–$3,000/yr** (global) for a cohort (30–100 seats), renewable yearly.
- Rationale: institutions buy seats, not subscriptions; one sale = many users + testimonials + a captive pipeline of grads who already know the tool.

Test H1 + H2 now (they're where fast signal lives). H3 is a slower, relationship sale — plant it with the film-school class in Part A, harvest later.

### B5. Kill / continue criteria (be specific)

**BUILD THE PAID TIER if, in the 2-week window, you see any TWO of:**
- **≥1 real paid pilot** completes and the buyer says they'd do it again (B2d) — this alone is nearly sufficient.
- **≥10–15% of activated users click "Get Pro"** at the cap-hit / pricing page (B2a/B2e).
- **≥3 of 8–10 interviewees give an unprompted, specific price** they'd pay, and name a real recurring pain.
- **Retention ≥3–5 users hit a 2nd shoot day** (proves the product is sticky enough that a subscription can retain).

**KEEP IT FREE / RETHINK if:**
- Activation is fine but **retention is near zero** (people log one shoot, never return) → product problem, *not* a pricing problem. Fix stickiness (v2 features: multi-cam sync, Resolve EDL, cloud project sync) before charging.
- **Cap-hit-to-click is <5%** and interviews produce only polite "sure, maybe" with no numbers → market treats it as a nice free utility, not a paid tool. Keep free, use it as a CrayWingz/portfolio credibility asset and a lead magnet, revisit only if a specific segment (editors) shows outsized pull.
- **Nobody hits the cap at all** → either too few real users (go back to Part A) or the free tier is too generous to ever create a paying moment (tighten caps and re-run).

**The single sharpest tie-breaker:** did *anyone actually pay money* (B2d)? One real charge outweighs the entire survey stack.

---

## PART C — 2-week concrete action sequence

### Week 1 — instrument, dogfood, recruit, listen

**Day 1 (today)**
- Write the saved SQL / mini-view: per-user email, signup date, shoot-days, total cuts, total exports, cap_hits, `?ref`. This is your daily cockpit.
- Confirm `?ref` tagging works; mint your recruiting links: `?ref=onset`, `?ref=filmschool`, `?ref=reddit`, `?ref=igdm`, `?ref=discord`.
- Draft the fake-door "Clapper Pro" page copy + the cap-hit offer copy (don't build billing — just the page + email capture + free-text "what would you pay").

**Day 2**
- Lock Clapper as primary take log for your next CrayWingz shoot (A1). Line up paper as silent backup.
- Send 10–15 warm DMs/calls to ADs/DITs/sups in your network with the A2 ask. Get soft yeses tied to *specific shoot dates.*

**Day 3**
- Contact 1 film-school production class (offer the free 30-min guest session). Aim to get on their calendar within the fortnight.
- Post value-first in 1 filmmaker Discord + 1 FB group (the continuity template or jam-cam TC doctrine, tool mentioned once).

**Day 4–5**
- Ship the fake-door page + wire the cap-hit in-app offer to point at it (B2a + B2e). This is the highest-ROI build in the plan.
- Book 8–10 pricing interviews (editors, sups, 1 producer) for Week 1–2.

**Day 6–7 (first weekend shoot window — most shoots are weekends)**
- Run your own CrayWingz shoot on Clapper. Take the XML into the real Premiere edit; get the editor's minutes-saved number.
- Nudge every design partner with a shoot this weekend the day before; collect their post-shoot feedback the day after.
- Daily: check the cockpit. DM every user who crosses activation.

### Week 2 — probe willingness to pay, get the one real charge

**Day 8–9**
- Run the pricing interviews. Capture verbatim price quotes and named pains. Identify the real buyer per segment.
- Read the fake-door + cap-hit data so far: who clicked "Get Pro"? Which `?ref` produced *real usage* vs. just clicks?

**Day 10**
- Send the Van Westendorp 4-question form to your response pool (beta crews + interviewees + pricing-page emails). Separate ₹ and $ versions.

**Day 11–12**
- **Pitch the paid pilot (B2d)** to the warmest production house / agency contact — ideally one whose shoot you can support live. Aim to actually collect ₹2,000–₹5,000 via UPI/Razorpay and flip their `is_pro`. Even one is the strongest possible signal.
- Run the film-school guest session if scheduled; watch students activate live (dense real-usage burst).

**Day 13**
- Second weekend shoot window: measure *retention* — how many Week-1 users came back for a 2nd shoot day? This number decides more than any survey.

**Day 14 — decide**
- Pull the cockpit + all WTP inputs together. Score against the B5 kill/continue criteria.
- Outcome A (continue): pick the winning packaging (likely H2 per-project for houses + H1 subscription for prosumers), build minimal billing (Razorpay + flip `is_pro`), pre-sell the fake-door email list.
- Outcome B (retention weak): freeze pricing work, ship the stickiness feature the beta most asked for, re-run activation → retention before touching WTP again.

---

## One-line summary of the instrument advantage
You already built the measurement rig: server-side quotas create the paying *moment*, and the `events` table lets you watch real on-set usage and cap-hits per user in SQL. This plan is just: point real crews at the app, watch the table, fire an offer at the cap, and try to collect one real charge. Everything else is noise.

**Sources (pricing anchors):** [Shot Lister App Store](https://apps.apple.com/us/app/shot-lister/id529436218) · [Shot Lister Pro pricing](https://profilmmakerapps.com/app/shot-lister/) · [MovieSlate Script Dept](https://www.movie-slate.com/Script_Dept) · [MovieSlate Pro features](https://www.movie-slate.com/MovieSlate_PRO_Features) · [ScriptE Systems](https://www.scriptesystems.com/)
