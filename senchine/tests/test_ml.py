"""ML layer: feature engineering, VAE, multi-task predictor, SHAP, fusion.

These are the tests that would catch the class of bug that actually hurt during
development: a feature computed one way at training time and another way at
inference. Several assertions below exist specifically to pin that down.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend.app.ml import detectability, fusion, training_data as td
from backend.app.ml.explain import explain_prediction, fleet_baseline
from backend.app.ml.features import (
    FEATURE_INDEX,
    HEALTHY_CREST_RATIO,
    N_FEATURES,
    build_vector,
    clean_window,
    missing_ratio,
    window_stats,
)
from backend.app.ml.mlp import FAILURE_CATEGORIES
from backend.app.ml.vae import VAE


# --------------------------------------------------------------------------
# Feature engineering
# --------------------------------------------------------------------------

class TestWindowCleaning:
    def test_drops_missing_samples(self):
        assert clean_window([1.0, None, 2.0, None, 3.0]) == pytest.approx([1.0, 2.0, 3.0])

    def test_all_missing_yields_empty(self):
        assert clean_window([None, None, None]) == []

    def test_median_filter_removes_single_sample_spike(self):
        values = [10.0] * 5 + [900.0] + [10.0] * 5
        cleaned = clean_window(values)
        assert max(cleaned) < 20.0, "impulse spike survived the median filter"

    def test_step_change_is_preserved(self):
        # A genuine step must survive — it is the signal, not noise.
        values = [10.0] * 6 + [40.0] * 6
        cleaned = clean_window(values)
        assert max(cleaned) > 35.0

    def test_non_finite_values_are_rejected(self):
        cleaned = clean_window([1.0, float("nan"), float("inf"), 2.0, 3.0])
        assert all(np.isfinite(v) for v in cleaned)

    def test_missing_ratio(self):
        assert missing_ratio([1.0, None, None, 4.0]) == 0.5
        assert missing_ratio([]) == 1.0


class TestWindowStats:
    def test_empty_window_is_safe(self):
        stats = window_stats([None, None])
        assert stats["n"] == 0 and stats["mean"] == 0.0

    def test_level_uses_recent_tail_not_whole_window(self):
        """The bug this pins: averaging level over the full window halves the
        apparent magnitude of a fault that developed recently."""
        values = [10.0] * 48 + [30.0] * 16
        stats = window_stats(values)
        assert stats["mean"] > 25.0, (
            "level statistics must reflect current state, not a long average"
        )

    def test_slope_uses_full_window(self):
        rising = list(np.linspace(10.0, 20.0, 64))
        assert window_stats(rising)["slope"] > 5.0
        assert window_stats([10.0] * 64)["slope"] == pytest.approx(0.0, abs=0.5)

    def test_full_window_dispersion_reported_separately(self):
        stats = window_stats(list(np.random.default_rng(0).normal(100, 5, 64)))
        assert stats["full_std"] > 0
        assert "full_mean" in stats


class TestFeatureVector:
    def test_shape_and_healthy_default(self):
        vec = build_vector({})
        assert vec.shape == (N_FEATURES,)
        # A machine with no signal must not look like a fault: every channel
        # sits at nominal, except vib_peak which sits at the healthy crest ratio.
        assert np.all(vec >= 1.0) and np.all(vec <= HEALTHY_CREST_RATIO + 1e-9)

    def test_temperature_rise_isolates_machine_heat(self):
        """A hot factory floor must not read as a developing fault."""
        cool = build_vector({
            "temp_c": {"value": 1.2, "nominal": 1.0},
            "ambient_c": {"value": 1.0, "nominal": 1.0},
        })
        hot_ambient = build_vector({
            "temp_c": {"value": 1.2, "nominal": 1.0},
            "ambient_c": {"value": 1.2, "nominal": 1.0},
        })
        assert (
            hot_ambient[FEATURE_INDEX["temp_rise"]] < cool[FEATURE_INDEX["temp_rise"]]
        )

    def test_values_are_clipped_to_plausible_range(self):
        wild = build_vector({"vib_rms": {"value": 9999.0, "nominal": 1.0}})
        assert wild[FEATURE_INDEX["vib_rms"]] <= 6.0

    def test_zero_nominal_does_not_divide_by_zero(self):
        vec = build_vector({"vib_rms": {"value": 5.0, "nominal": 0.0}})
        assert np.all(np.isfinite(vec))


class TestTrainServeConsistency:
    """The most valuable tests here: training and inference must agree."""

    def test_healthy_crest_constant_is_shared(self):
        rng = np.random.default_rng(0)
        vec = td.healthy_vector(rng, duty=1.0)
        ratio = vec[FEATURE_INDEX["vib_peak"]] / vec[FEATURE_INDEX["vib_rms"]]
        assert ratio == pytest.approx(HEALTHY_CREST_RATIO, rel=0.02)

    def test_duty_invariant_channels_read_as_nominal(self):
        """Channels that do not vary with load must sit at 1.0 on a healthy
        machine, or the deviation-based health score carries a permanent bias.

        Load-sensitive channels (vibration, temperature, current) legitimately
        sit above nominal at full duty — that is what the learned baseline is
        for, and it is asserted separately below.
        """
        rng = np.random.default_rng(7)
        vecs = np.array([td.healthy_vector(rng, duty=1.0) for _ in range(200)])
        mean = vecs.mean(axis=0)
        for name in ("vib_crest", "current_imbalance", "vib_trend",
                     "temp_trend", "ambient_c", "humidity_pct"):
            assert mean[FEATURE_INDEX[name]] == pytest.approx(1.0, abs=0.08), (
                f"{name} is biased away from nominal on healthy machines"
            )

    def test_load_sensitive_channels_track_duty(self):
        rng = np.random.default_rng(9)
        light = np.array([td.healthy_vector(rng, duty=0.45) for _ in range(120)]).mean(axis=0)
        heavy = np.array([td.healthy_vector(rng, duty=1.1) for _ in range(120)]).mean(axis=0)
        for name in ("vib_rms", "temp_c", "current_a", "power_kw"):
            assert heavy[FEATURE_INDEX[name]] > light[FEATURE_INDEX[name]], (
                f"{name} should rise with load — the VAE must learn this is normal"
            )

    def test_build_vector_default_matches_training_crest(self):
        """The no-signal fallback must use the shared crest constant."""
        vec = build_vector({})
        assert vec[FEATURE_INDEX["vib_peak"]] == pytest.approx(HEALTHY_CREST_RATIO)

    def test_trend_is_driven_by_rate_not_severity(self):
        """A saturated fault has a flat trend. Training must model that, or
        remaining life is over-estimated exactly when it matters."""
        rng = np.random.default_rng(1)
        base = td.healthy_vector(rng, 0.9)
        severe_flat = td.apply_signature(base, "bearing_wear", severity=0.9, rate=0.0)
        severe_fast = td.apply_signature(base, "bearing_wear", severity=0.9, rate=1.0)
        assert severe_flat[FEATURE_INDEX["vib_trend"]] < severe_fast[FEATURE_INDEX["vib_trend"]]
        # Level channels must be identical — only the trend differs.
        assert severe_flat[FEATURE_INDEX["vib_rms"]] == pytest.approx(
            severe_fast[FEATURE_INDEX["vib_rms"]])


# --------------------------------------------------------------------------
# Failure physics
# --------------------------------------------------------------------------

class TestFailurePhysics:
    def test_each_mode_has_a_distinct_signature(self):
        from backend.app.physics import FAILURE_SIGNATURES

        seen = set()
        for mode, signature in FAILURE_SIGNATURES.items():
            key = tuple(sorted(signature.items()))
            assert key not in seen, f"{mode} duplicates another mode's signature"
            seen.add(key)

    def test_signature_channels_all_exist(self):
        from backend.app.physics import FAILURE_SIGNATURES

        for mode, signature in FAILURE_SIGNATURES.items():
            for channel in signature:
                assert channel in FEATURE_INDEX, f"{mode} references unknown {channel}"

    def test_severity_increases_deviation_monotonically(self):
        rng = np.random.default_rng(2)
        base = td.healthy_vector(rng, 0.9)
        previous = 0.0
        for severity in (0.0, 0.25, 0.5, 0.75, 1.0):
            vec = td.apply_signature(base, "bearing_wear", severity, rate=0.5)
            deviation = float(vec[FEATURE_INDEX["vib_rms"]])
            assert deviation >= previous
            previous = deviation

    def test_rul_falls_as_severity_rises(self):
        rng = np.random.default_rng(3)
        early = td.severity_to_rul("bearing_wear", 0.2, rng, rate=0.5)
        late = td.severity_to_rul("bearing_wear", 0.9, rng, rate=0.5)
        assert late < early

    def test_rul_falls_as_rate_rises(self):
        rng = np.random.default_rng(4)
        slow = td.severity_to_rul("bearing_wear", 0.5, rng, rate=0.0)
        fast = td.severity_to_rul("bearing_wear", 0.5, rng, rate=1.0)
        assert fast < slow, "a faster-progressing fault must have less life left"

    def test_lubrication_progresses_faster_than_bearing_wear(self):
        rng = np.random.default_rng(5)
        bearing = np.mean([td.severity_to_rul("bearing_wear", 0.5, rng) for _ in range(50)])
        lube = np.mean([td.severity_to_rul("lubrication_failure", 0.5, rng) for _ in range(50)])
        assert lube < bearing


# --------------------------------------------------------------------------
# VAE
# --------------------------------------------------------------------------

class TestVAE:
    def test_rejects_wrong_shaped_training_data(self):
        with pytest.raises(ValueError):
            VAE().fit(np.zeros((10, 3)), epochs=1)

    def test_healthy_scores_below_faulty(self, trained_registry):
        rng = np.random.default_rng(11)
        healthy = [
            trained_registry.score_anomaly(td.healthy_vector(rng, rng.uniform(0.5, 1.05)))[
                "anomaly_score"]
            for _ in range(40)
        ]
        faulty = [
            trained_registry.score_anomaly(
                td.apply_signature(td.healthy_vector(rng, 0.9), "bearing_wear", 0.6, 0.5)
            )["anomaly_score"]
            for _ in range(40)
        ]
        assert np.mean(healthy) < 0.45
        assert np.mean(faulty) > np.mean(healthy) + 0.25

    def test_score_is_bounded(self, trained_registry):
        extreme = np.full(N_FEATURES, 6.0)
        score = trained_registry.score_anomaly(extreme)["anomaly_score"]
        assert 0.0 <= score <= 1.0

    def test_score_is_graded_not_binary(self, trained_registry):
        """A saturating score cannot distinguish 'degrading' from 'about to fail'."""
        rng = np.random.default_rng(13)
        base = td.healthy_vector(rng, 0.9)
        scores = [
            trained_registry.score_anomaly(
                td.apply_signature(base, "bearing_wear", s, 0.5))["anomaly_score"]
            for s in (0.15, 0.35, 0.6, 0.9)
        ]
        assert len(set(round(s, 2) for s in scores)) >= 3, f"score saturates: {scores}"
        assert scores == sorted(scores), "anomaly score must increase with severity"

    def test_round_trip_persistence(self, tmp_path):
        rng = np.random.default_rng(17)
        data = np.array([td.healthy_vector(rng, 0.9) for _ in range(120)])
        model = VAE()
        model.fit(data, epochs=15)
        sample = data[0]
        before = model.score(sample)["anomaly_score"]

        path = tmp_path / "vae.npz"
        model.save(path)
        reloaded = VAE.load(path)
        assert reloaded.score(sample)["anomaly_score"] == pytest.approx(before, rel=1e-6)


# --------------------------------------------------------------------------
# Multi-task predictor
# --------------------------------------------------------------------------

class TestPredictor:
    def test_reports_usable_accuracy(self, trained_registry):
        metrics = trained_registry.report["predictor"]
        assert metrics["accuracy"] > 0.85
        assert metrics["category_accuracy"] > 0.85
        assert metrics["f1"] > 0.80

    def test_outputs_are_in_range(self, trained_registry):
        rng = np.random.default_rng(19)
        for _ in range(25):
            vec = td.apply_signature(
                td.healthy_vector(rng, 0.9),
                str(rng.choice([c for c in FAILURE_CATEGORIES if c != "healthy"])),
                float(rng.uniform(0, 1)), float(rng.uniform(0, 1)),
            )
            out = trained_registry.predict(vec)
            assert 0.0 <= out["failure_probability"] <= 1.0
            assert 0.0 <= out["rul_hours"] <= 2000.0
            assert 0.0 <= out["confidence"] <= 1.0
            assert out["failure_category"] in FAILURE_CATEGORIES
            assert sum(out["category_probabilities"].values()) == pytest.approx(1.0, abs=1e-4)

    def test_healthy_machine_predicts_healthy(self, trained_registry):
        rng = np.random.default_rng(23)
        healthy = [
            trained_registry.predict(td.healthy_vector(rng, rng.uniform(0.5, 1.05)))
            for _ in range(30)
        ]
        assert sum(1 for h in healthy if h["failure_category"] == "healthy") >= 27
        assert np.mean([h["failure_probability"] for h in healthy]) < 0.2

    def test_probability_rises_with_severity(self, trained_registry):
        rng = np.random.default_rng(29)
        base = td.healthy_vector(rng, 0.9)
        probs = [
            trained_registry.predict(td.apply_signature(base, "overheating", s, 0.5))[
                "failure_probability"]
            for s in (0.1, 0.4, 0.7, 0.95)
        ]
        assert probs[0] < probs[-1]
        assert probs[-1] > 0.7

    def test_rul_shrinks_as_fault_develops(self, trained_registry):
        rng = np.random.default_rng(31)
        base = td.healthy_vector(rng, 0.9)
        early = trained_registry.predict(
            td.apply_signature(base, "overheating", 0.2, 0.5))["rul_hours"]
        late = trained_registry.predict(
            td.apply_signature(base, "overheating", 0.9, 0.8))["rul_hours"]
        assert late < early


# --------------------------------------------------------------------------
# Explainability
# --------------------------------------------------------------------------

class TestExplainability:
    def test_attributions_sum_to_prediction_gap(self, trained_registry):
        """Shapley efficiency: attributions must account for the whole gap."""
        rng = np.random.default_rng(37)
        vec = td.apply_signature(td.healthy_vector(rng, 0.9), "bearing_wear", 0.7, 0.5)
        result = explain_prediction(
            trained_registry.predictor.predict_prob, vec,
            trained_registry.baseline, top_k=N_FEATURES, n_permutations=140,
        )
        total = sum(c["shap_value"] for c in result["contributions"])
        gap = result["predicted_score"] - result["baseline_score"]
        assert total == pytest.approx(gap, abs=0.05)
        assert result["explanation_quality"] > 0.8

    @pytest.mark.parametrize(
        "mode,expected",
        [
            ("bearing_wear", {"vib_rms", "vib_peak", "vib_crest", "ultrasonic_db"}),
            ("overheating", {"temp_c", "temp_rise", "temp_trend"}),
            ("electrical_fault", {"current_a", "current_imbalance", "power_kw"}),
            ("blockage_fouling", {"pressure_bar", "power_kw", "current_a"}),
        ],
    )
    def test_attribution_identifies_the_causal_channel(
        self, trained_registry, mode, expected
    ):
        """The explanation must track the physical mechanism, not just the
        largest raw number."""
        rng = np.random.default_rng(41)
        vec = td.apply_signature(td.healthy_vector(rng, 0.9), mode, 0.75, 0.5)
        result = trained_registry.explain(vec, permutations=120)
        top_three = {c["feature"] for c in result["contributions"][:3]}
        assert top_three & expected, (
            f"{mode}: top attributions {top_three} miss the causal channels {expected}"
        )

    def test_baseline_is_robust_to_outliers(self):
        rng = np.random.default_rng(43)
        healthy = np.array([td.healthy_vector(rng, 0.9) for _ in range(100)])
        contaminated = np.vstack([healthy, np.full((8, N_FEATURES), 5.0)])
        baseline = fleet_baseline(contaminated)
        assert np.all(baseline < 2.0), "median baseline was dragged by outliers"

    def test_empty_input_returns_safe_baseline(self):
        assert fleet_baseline(np.empty((0, N_FEATURES))).shape == (N_FEATURES,)


# --------------------------------------------------------------------------
# EdgeSense fusion
# --------------------------------------------------------------------------

def _view(kind, ratio=1.0, distance=0.0, source="edge", status="ok", missing=0.0):
    return {
        "tag": f"T-{kind}", "kind": kind, "device": kind, "source": source,
        "distance_m": distance, "status": status, "missing": missing,
        "noisy": 0.0, "ratio": ratio,
    }


class TestFusion:
    def test_no_sensors_yields_zero_confidence(self):
        result = fusion.fuse([])
        assert result["confidence"] == 0.0
        assert result["channels"] == {}

    def test_direct_instrumentation_beats_retrofit(self):
        onboard = fusion.fuse([
            _view("vibration", 1.1, 0.0, "onboard"),
            _view("temperature", 1.0, 0.0, "onboard"),
            _view("current", 1.0, 0.0, "onboard"),
        ])
        retrofit = fusion.fuse([
            _view("vibration", 1.1, 0.4), _view("thermal", 1.0, 3.0),
            _view("current", 1.0, 7.5), _view("acoustic", 1.0, 2.4),
        ])
        assert onboard["confidence"] > retrofit["confidence"]
        assert retrofit["confidence"] > 0.45, "a full retrofit kit must still be usable"

    def test_distance_reduces_confidence(self):
        near = fusion.fuse([_view("vibration", 1.5, 0.3)])
        far = fusion.fuse([_view("vibration", 1.5, 6.0)])
        assert near["confidence"] > far["confidence"]

    def test_failed_sensors_collapse_confidence(self):
        result = fusion.fuse([_view("acoustic", 1.5, 3.0, status="fault")])
        assert result["confidence"] == 0.0

    def test_disagreement_reduces_confidence(self):
        agree = fusion.fuse([_view("vibration", 1.5, 0.4), _view("acoustic", 1.5, 2.0)])
        disagree = fusion.fuse([_view("vibration", 1.5, 0.4), _view("acoustic", 0.6, 2.0)])
        assert disagree["confidence"] < agree["confidence"]

    def test_more_corroboration_raises_confidence(self):
        one = fusion.fuse([_view("vibration", 1.3, 0.5)])
        two = fusion.fuse([_view("vibration", 1.3, 0.5), _view("acoustic", 1.3, 2.0)])
        assert two["channels"]["vib_rms"]["confidence"] >= one["channels"]["vib_rms"]["confidence"]

    def test_missing_data_reduces_confidence(self):
        clean = fusion.fuse([_view("vibration", 1.2, 0.4, missing=0.0)])
        gappy = fusion.fuse([_view("vibration", 1.2, 0.4, missing=0.6)])
        assert gappy["confidence"] < clean["confidence"]

    def test_confidence_is_always_bounded(self):
        huge = fusion.fuse([_view("vibration", 1.0, 0.0, "onboard")] * 25)
        assert 0.0 <= huge["confidence"] <= 1.0

    def test_confidence_bands_are_ordered(self):
        assert fusion.confidence_band(0.95) == "high"
        assert fusion.confidence_band(0.70) == "medium"
        assert fusion.confidence_band(0.50) == "low"
        assert fusion.confidence_band(0.10) == "insufficient"

    def test_contribution_weights_are_explainable(self):
        result = fusion.fuse([_view("vibration", 1.4, 0.5)])
        contribution = result["contributions"][0]
        for part in ("relevance", "attenuation", "quality", "weight"):
            assert part in contribution
        assert contribution["weight"] == pytest.approx(
            contribution["relevance"] * contribution["attenuation"] * contribution["quality"],
            rel=0.02,
        )


class TestDetectability:
    def test_full_kit_detects_everything_well(self):
        kinds = ["vibration", "thermal", "current", "power", "acoustic",
                 "ultrasonic", "pressure", "speed"]
        report = detectability.assess(kinds)
        assert report["overall"] > 0.85
        assert report["band"] == "good"

    def test_missing_ultrasonic_hurts_lubrication_detection(self):
        with_probe = detectability.mode_detectability(
            "lubrication_failure", ["vibration", "temperature", "ultrasonic"])
        without = detectability.mode_detectability(
            "lubrication_failure", ["vibration", "temperature"])
        assert without["score"] < with_probe["score"]
        assert "ultrasonic_db" in without["missing"]

    def test_missing_pressure_hurts_blockage_detection(self):
        report = detectability.mode_detectability(
            "blockage_fouling", ["vibration", "temperature", "current", "power"])
        assert "pressure_bar" in report["missing"]
        assert report["band"] in ("marginal", "poor")

    def test_recommends_the_highest_value_device(self):
        report = detectability.assess(["vibration", "temperature"])
        assert report["recommendation"] is not None
        assert report["recommendation"]["improvement"] > 0

    def test_no_sensors_detects_nothing(self):
        assert detectability.assess([])["overall"] == 0.0
