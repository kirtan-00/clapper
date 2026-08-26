# Pricing Psychology for Clapper: Director Mode + Podcast Mode

Research pass for the two-audience pricing model. INR, India-primary. Current draft under review: Rs 699 for 1 project credit, Rs 1,999 for 5 credits, Rs 999/month for 2 projects plus 10 hours of podcast recording. Free tier: 2 projects, once, ever, unlimited CSV export only.

A note on method before the findings: a lot of what shows up when you search "pricing psychology" is SEO content written by pricing-tool vendors, restating each other's numbers with no traceable study behind them. I checked the primary sources where I could and flag the rest as unverified. Where a claim is repeated across five blog posts with no citation, that is not five sources, it is one unsourced claim copied five times.

---

## 1. Tier count and the decoy effect

**What the original research actually shows.** The decoy effect (asymmetric dominance) comes from Huber, Payne, and Puto, Journal of Consumer Research, 1982. It is real and it is one of the more replicated findings in choice theory: adding a third option that is fully dominated by option B but only partially dominated by option A pulls preference toward B. [Wikipedia: Decoy effect](https://en.wikipedia.org/wiki/Decoy_effect)

**Where it breaks.** The effect was built and mostly confirmed in lab settings using numeric, tabular comparisons. Field and applied replications are much shakier. Frederick and colleagues, and Yang and Lynn, found the effect largely disappears once you move to realistic purchase scenarios or graphical (rather than numeric-table) presentation, which is exactly the format of a SaaS pricing page. A 2021 pre-registered replication of Ariely and Wallsten's decoy work found effects that were inconsistent in direction and trivial in size in one study, and present but much smaller than the original in another. [Comprehensive Results in Social Psychology, 2021](https://www.tandfonline.com/doi/full/10.1080/23743603.2021.1878340), [ScienceDirect, salience and risk aversion](https://www.sciencedirect.com/science/article/abs/pii/S1567422323001199)

**Confidence: medium-low that a deliberately engineered decoy tier will do anything measurable for Clapper.** The mechanism is real in principle, weak in the wild, and the specific claims floating around marketing blogs ("decoy tiers lift conversion up to 30%," "premium-first ordering makes people 85% more likely to pick mid-tier") could not be traced to a primary source in this search pass. Treat those numbers as unverified. Do not build the pricing table around manufacturing a decoy.

**Tier count itself.** A frequently cited "study of 110 SaaS products" claims 4 tiers outperforms 3. I pulled the underlying page directly: it reports correlations (4-tier products have higher freemium adoption) with no disclosed methodology, no causal test, and an obvious confound, developer-tool companies run more tiers AND more freemium regardless of tier count, so category explains the pattern better than tier count does. This is not evidence that adding a tier causes better outcomes. [SaaS Research Lab](https://saasresearchlab.com/blog/4-tiers-pricing)

What is genuinely well-evidenced, separately from decoy theory, is that a highlighted "recommended" middle option reliably draws attention and choice, that's a straightforward anchoring/framing effect, not a decoy effect, and it does not require a sacrificial bad option to work.

**Implication for Clapper:** you do not have one ladder of 3-4 comparable options anyway, you have two audiences with two different meters. The decoy/tier-count literature mostly assumes a single buyer comparing options side by side. Skip trying to engineer a classic decoy. Do use a visually highlighted "recommended" tier per audience path, that part is solid.

---

## 2. Caps versus "unlimited"

**The owner's instinct has a real argument behind it, but it is thinner than it sounds.** I could not find a rigorous, causal study that isolates "capped plan" language against "unlimited" language and measures conversion. What exists is adjacent literature:

- Price fairness research (published, peer-reviewed) shows that when a price or its terms feel arbitrary, unpredictable, or capable of a nasty surprise, trust and willingness to pay both drop. [Oxford, Journal of Consumer Research: "Painful Prices: The Moral Harm Model of Price Fairness"](https://academic.oup.com/jcr/advance-article/doi/10.1093/jcr/ucaf045/8195730)
- "Unlimited" plans remove the anxiety of an unplanned overage bill, that is the actual psychological appeal, not the number itself. A hard, visible, stated cap removes a *different* anxiety, the fear of hidden fine print ("unlimited" that turns out to mean "fair use, we will throttle you if we feel like it").

So the real comparison is not "cap vs unlimited," it is "predictable stated number vs unpredictable enforcement," whichever label sits on top. A hard cap of "5 project credits" that is exactly 5 and never surprises anyone can score just as well on trust as "unlimited," because both are predictable. What kills trust is a cap that is quietly enforced without being shown, or an "unlimited" that has an undisclosed asterisk.

**Confidence: low-medium**, mostly reasoned from adjacent fairness research rather than a study built for this exact question. I want to flag one more thing from general pricing science that is well-established but that I did not re-verify with a fresh search this pass: the goal-gradient effect (people accelerate effort/spending as they approach a visible finish line, well known from Kivetz, Urminsky and Zheng's loyalty-card research) predicts that a visible progress meter toward a stated cap ("3 of 5 credits used") can itself drive upgrade behavior, arguably better than invisible unlimited usage ever could, because unlimited gives you nothing to approach. Flagging this as recalled, not freshly verified today.

**Is there evidence removing "unlimited" hurts conversion?** Not that I could find, verified or unverified. That specific claim seems to be absent from the search results entirely, which itself is informative, it is not a well-documented risk, it is closer to received wisdom.

**Implication for Clapper:** the no-unlimited rule is defensible, but only if execution matches it, every cap needs to be a stated number with a visible meter, never "fair use." That is the part the psychology actually supports.

---

## 3. The non-refilling free tier

This is the one I would argue with hardest.

Standard freemium either resets monthly (predictable trickle, keeps the user opening the app) or runs as a time-boxed trial (predictable expiry, forces a decision fast). Clapper's model is neither: 2 projects, once, forever, then nothing, indefinitely, unless you pay. Functionally this is a trial wearing a "free forever" costume.

**What the research says about activation.** The industry-standard framing (repeated across freemium/PLG commentary, not a single controlled study but a consistent operating finding) is that the real fight in freemium is "activated vs. never-activated," meaning the free tier's job is to get someone through a real, meaningful use of the product. A 2-project grant does that job fine, it is generous enough to prove the product works on a real shoot or a real episode. [Ordway Labs, freemium vs trial](https://ordwaylabs.com/blog/free-trial-vs-saas-acquisition/)

**Where it goes wrong, by Clapper's own logic, not a cited study.** You told me the product's real usage shape is "a shoot happens, then nothing for weeks." That is the crux of the problem: a non-refilling free grant and a bursty, gap-filled usage pattern are a bad structural match. Picture the actual sequence: someone burns both free projects in their first month, likes the tool, then has no shoot for six weeks. When the next shoot arrives, the tool they liked is now a locked paywall they have to clear before they can even test it again on the new job, at the exact moment they are busiest and least likely to stop and evaluate a purchase. A monthly-reset or slow-trickle free tier would instead let them open the app on shoot day, use it, and only hit the wall on their *third* concurrent project or their *sixth* month, a much better place to ask for money because the habit is already formed.

There is a second cost: word of mouth. A script supervisor who recommends Clapper to a colleague on set is doing your acquisition for free. If her own account is already spent, she is recommending a tool she can no longer touch, which is a weaker recommendation than "I'm using this right now, look."

**Honest caveat:** I did not find a study that directly proves "non-refilling free tiers underperform recurring ones" in a controlled way. This is a coherent structural argument built from your own stated usage pattern, not a citation. But it is a strong enough argument that I would not ship the current version without at least testing an alternative.

**What I'd actually propose, concretely:** keep the grant small (do not reward abuse), but make it recur slowly and be tied to dormancy, e.g., one additional free project credit after 4 to 6 months of account inactivity, or on return after a gap. That preserves "heavy users must pay" (anyone doing back-to-back projects blows through it fast and never sees a refill) while fixing the specific failure mode of a bursty-work user going permanently cold.

---

## 4. Mixing two pricing meters in one product

Per-project credits for filmmakers and per-hour subscription minutes for podcasters are not the same unit, and putting them on one comparison table invites a kind of confusion that is worse than ordinary decision fatigue: the visitor tries to convert one metric into the other in their head ("so is a project worth more or less than an hour of recording?") and that comparison has no real answer, because they are not fungible.

**Segmentation is the standard fix, and it is reasonably well supported as design practice.** Persona-based landing paths, either separate pages or a toggle/tab switch at the top of one page, are common in SaaS pricing design specifically to avoid showing an irrelevant metric to a visitor. Webflow's site-plans-vs-workspace-plans tab split is the usually-cited example. [Growigami, SaaS pricing page patterns](https://growigami.com/blog/saas-pricing-pages)

**On classic "choice paralysis":** worth being honest that this effect is weaker in the academic record than pop psychology suggests. The famous Iyengar and Lepper jam study (fewer choices sell more jam) has not held up well under later scrutiny, a meta-analysis by Chernev, Böckenholt, and Goodman (2015, not searched fresh this pass, flagging as recalled) found the average choice-overload effect across many replications is close to zero and depends heavily on how complex the choice set is and how expert the chooser is. So "too many tiers causes paralysis" is often overstated. What genuinely happens with Clapper's two meters is not paralysis from too many options, it is comprehension failure from incompatible units on the same page, a different and arguably more serious problem, since a confused visitor doesn't hesitate, they just leave without understanding what they'd be buying.

**Implication for Clapper:** two clean entry paths, "For Film Crews" and "For Podcasters," each showing exactly one meter, no shared table. If someone is genuinely both, let them see both paths clearly labeled rather than merging the metrics.

---

## 5. INR price points specifically

**Charm pricing (999 vs 1,000, 1,999 vs 2,000) is real and reasonably well-established**, it is the left-digit effect: buyers anchor on the leftmost digit, so 999 reads as "900-something" and 1,000 reads as "1,000-and-up" even though the gap is one rupee. This is one of the more solidly replicated findings in pricing science generally, though most of the underlying data is US retail, not India-specific or SaaS-specific. In India the charm-pricing convention is culturally reinforced independently (Rs 99 stores, Rs 999 fashion racks), so it likely transfers, but I don't have India-specific magnitude data. [Shiprocket Checkout, charm pricing](https://checkout.shiprocket.in/blog/charm-pricing/)

At Rs 999/month, Clapper's top self-serve price sits right at that boundary already, which is the psychologically correct side of it. Do not let it drift to Rs 1,000+ for a rounding-convenience reason.

**GST.** SaaS in India carries 18% GST. For a GST-registered business buyer, that is a reclaimable input credit and barely registers in the decision. For an individual or unregistered small production outfit, and a lot of Clapper's actual buyers, freelance script supervisors, indie directors, solo podcasters, fit that description, the 18% is a real added cost that shows up as sticker shock at checkout if it is bolted on at the last step. [PayProGlobal, India SaaS tax](https://payproglobal.com/saas-sales-tax/india/)

The general finding in partitioned-pricing research (consumers react worse to a price that grows at checkout than to a higher price shown up front) is well established in the literature, though I'm citing it from general knowledge rather than a source pulled this session, flagging as recalled, not freshly verified. It is consistent enough with retail experience that I'm comfortable recommending it directionally.

**Implication for Clapper:** show Rs 699 / Rs 1,999 / Rs 999 as GST-inclusive, all-in numbers, on the self-serve tiers where individuals are buying. Reserve GST-exclusive, itemized pricing for the enterprise/contact-us flow, where the buyer is a registered company that expects and reclaims it, that is the B2B convention they'll actually recognize as competent invoicing, not a red flag.

**Dollar vs rupee pricing for international interest:** industry commentary (not a controlled study) suggests Indian buyers respond worse to dollar-denominated pricing even at an equivalent rupee value, and that INR-first pricing pages convert better domestically. This is consultant opinion repeated across a couple of sources, not measured research, treat as directionally useful, low confidence. [productgrowth.in](https://productgrowth.in/insights/saas/saas-pricing-rupee-vs-dollar/)

---

## 6. "Contact us" enterprise

**Fully hidden pricing with nothing else is a real, commonly flagged problem**, when a page says only "Contact us" with no anchor at all, buyers read that as either "you can't afford this" or "this is disorganized," and it depresses the pool of leads who bother reaching out. One source in this search claimed hidden pricing converts "1.7x fewer visitors to pipeline," I could not verify that number's origin, flag it as unverified, but the underlying direction, that a bare contact-us CTA underperforms a contact-us CTA with a visible starting anchor, is a widely repeated and plausible finding even without a clean citation. [Smith.ai, pricing on site](https://smith.ai/blog/should-i-list-prices-on-my-website)

**What is well-evidenced, from a completely different and much more solid body of work:** anchoring itself. The classic Tversky and Kahneman anchoring heuristic, any visible number shifts subsequent value judgment even when the number is arbitrary, is one of the most replicated effects in behavioral economics. So the actionable move is not "hide the price" or "show the price," it is "show a credible floor number even on the tier you gate behind a conversation."

**Implication for Clapper:** the top tier is legitimate as contact-us, multi-crew studio rollouts genuinely need custom scoping, this isn't just theater. But don't leave it as a bare "Contact us." Show a starting anchor ("Studio plans start around Rs X,XXX/month") so a solo user self-selects out immediately and a line producer or production house self-selects in. Name it for the buyer, not the abstraction, "Studio / Production House," not "Enterprise." What belongs inside it: multi-seat rollout across a crew, volume project credits, GST-registered company invoicing with POs, priority support, and if you build it later, white-label export.

---

## 7. Subscription versus one-off for bursty, project-shaped work

I could not find a rigorous academic study comparing credit-pack and subscription performance specifically for bursty creative-project usage. What exists is applied/vendor commentary on billing model trade-offs (cash flow, forecasting difficulty with unpredictable credit redemption) and general subscription-churn research. [Flexprice, credit vs usage pricing](https://flexprice.io/blog/credit-based-pricing-vs-usage-based-pricing)

**What is solid and directly relevant: pause-over-cancel behavior.** An applied industry report (Recurly-style annual subscription study, not peer-reviewed academic work, but a large real-world dataset) found 38% of consumers prefer pausing a subscription to cancelling it, and that offering a pause option increased pause usage by 337%, with three out of four of those pausers returning within months. [Recurly / cited via DesignRush summary, churn reduction](https://www.designrush.com/agency/mobile-app-design-development/trends/how-to-reduce-churn-rate-in-subscription-based-apps)

**The core logical argument, built from Clapper's own stated shape, not a citation:** subscription billing assumes recurring use. Director Mode does not have recurring use, it has bursts separated by dead weeks. A director who subscribes at Rs 999/month for one shoot and then has no work for two months is either paying for nothing (resentment, a well-documented driver of subscription cancellation broadly) or cancels immediately after the shoot and has to re-decide and re-subscribe for the next one, adding friction at the exact moment, on set, under time pressure, when friction is worst tolerated. A non-expiring credit pack fits the honest shape of that work: pay when there's a job, use it, walk away with no clock running.

Podcast Mode is the opposite case, a weekly show is genuinely recurring, so a subscription is the correct meter there. This is the single clearest, best-supported finding in this whole research pass: the two audiences don't just prefer different metrics, they have structurally different usage rhythms that make one metric wrong for each of them respectively. The current draft mostly gets this right (credits for filmmakers, subscription for podcasters), the one thing to check is the Rs 999/month podcast plan folding in "2 projects" alongside "10 hours", that smuggles a project-count cap into what should be a purely time-based recurring product, worth simplifying to one meter (hours) for that tier specifically.

---

## 8. Discount depth for the credit pack

**Practitioner consensus (repeated across several independent bundling-psychology sources, not a single controlled study, but consistent enough to treat as decent applied evidence) puts the "worth it" threshold at roughly 10-20% off**, below that, a bundle doesn't feel like a deal. There's also a documented ceiling: discounts north of about 40% start triggering suspicion, "was the regular price ever real," rather than excitement. [SureCart, bundle pricing](https://surecart.com/blog/product-bundle-pricing-strategies/)

**Run the current draft's numbers:** 5 credits at the single-credit price of Rs 699 would cost Rs 3,495. The pack is priced at Rs 1,999. That's a 42.8% discount off the per-unit rate, past the ceiling where practitioners say suspicion starts to outweigh appeal. This is a concrete, checkable finding, not a vague one: the pack as currently priced risks reading as "the Rs 699 single-credit price is padded to make the bundle look good," which undercuts trust in both numbers at once.

**Implication for Clapper:** narrow the gap. Either raise the 5-pack price toward roughly Rs 2,300 to Rs 2,450 (lands around 30-34% off, inside the credible range) or lower the single-credit price. I'd raise the pack price rather than cut the single-credit price, since 699 is doing useful charm-pricing work at the low end and is likely the more visible, most-compared number.

---

## Five decisions, and the psychology behind each

**1. Split the pricing page by persona, not by plan.** Two entry paths, "For Film Crews" and "For Podcasters," each showing only its own meter (project credits vs recording hours), no shared comparison table. *Psychology:* mixing incompatible units causes comprehension failure, not classic choice paralysis (that effect is weaker than folklore suggests), and comprehension failure loses a visitor outright rather than just slowing them down. *Risk if wrong:* a user who does both film and podcast work has to consciously pick a lane or view both paths, a small extra click, low downside.

**2. Re-price the 5-credit pack to stay under the ~40% discount ceiling.** Move it to roughly Rs 2,300 to Rs 2,450, or hold the price and cut the pack to 4 credits. *Psychology:* discount-depth research (multiple independent, if non-academic, sources) puts the credible bundle range at 10 to 20%, with trust breaking down past ~40% off; the current draft's 42.8% effective discount sits past that line. *Risk if wrong:* if this India-prosumer audience simply doesn't have that suspicion threshold, this leaves a small amount of margin on the table, low-cost mistake either way.

**3. Replace the one-time, non-refilling free tier with a slow, dormancy-triggered trickle** (e.g., one additional free project credit after 4 to 6 months of inactivity, or on a clear return-after-gap signal), instead of a permanent dead end after 2 projects. *Psychology:* the product's own usage pattern is bursty with weeks-long gaps; a true dead end forces a paywall decision at the exact moment a returning user is busiest and least receptive, and kills the free-tier's second job, being a live thing a happy user can still point a colleague to. This is a structural argument built from Clapper's stated usage shape, not a cited study, flagged accordingly. *Risk if wrong:* if the owner is right that any refill invites abuse, mitigate by keeping the trickle small and slow, one project every several months is not a loophole a heavy user can live on.

**4. Keep every cap a stated, visible number, never "unlimited," and never vague "fair use" language**, paired with a live usage meter ("3 of 5 credits used") rather than a wall discovered only when hit. *Psychology:* fairness research shows unpredictability, not the existence of a limit, is what damages trust; a clearly stated cap with a visible meter can score as well as unlimited on predictability while still doing the job of making heavy users pay. This is the one place the owner's instinct is better supported than the "unlimited always converts better" claim floating in pricing folklore, which itself turned up no verifiable evidence. *Risk if wrong:* power users benchmarking against unlimited competitor tools may bounce off the visible ceiling regardless of how well it's presented.

**5. Show GST-inclusive, all-in prices on the two self-serve tiers (Rs 699, Rs 1,999 or adjusted, Rs 999/month), and only switch to GST-exclusive, itemized pricing inside the contact-us enterprise flow.** *Psychology:* partitioned pricing (a price that grows at checkout) creates friction and reads as untrustworthy for individual buyers, while GST-registered companies expect and reclaim the tax and read exclusive, itemized pricing as competent B2B practice, not a warning sign. *Risk if wrong:* a self-serve buyer who later negotiates into the enterprise tier might notice the pricing convention shift and read it as inconsistency; keep the transition explained in any sales conversation.

---

## The constraint I'd push back on hardest

The non-refilling free tier. The no-unlimited rule turns out to be more defensible than I expected walking in, the fairness literature actually supports a stated, visible cap over vague unlimited language, so I'd keep that one largely as designed, just enforce it with visible meters. The free-tier design is the one that fights the product's own stated usage pattern: bursty work with weeks-long gaps is exactly the shape that a permanent, non-refilling grant handles worst, because the paywall lands at the moment of return, not the moment of first use. I don't have a controlled study proving this costs conversions, but the logic follows directly from what you told me about how film crews actually work, and it's cheap to test: a small, slow, dormancy-triggered refill costs almost nothing in free-tier abuse risk while removing the dead-end failure mode entirely.
