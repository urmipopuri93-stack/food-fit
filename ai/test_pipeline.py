"""Run with: python -m unittest -v test_pipeline"""

import csv
from datetime import date, timedelta
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from allocation import allocate_kits
from api import app
from community_data import load_communities
from engine import map_features, recommend
from simulation import distance_km, simulate
from train_model import FEATURES, load_history, split_history, train_candidate

ROOT = Path(__file__).resolve().parent


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.communities = load_communities()

    def test_known_baseline(self):
        plan = recommend(self.communities, 1000)
        self.assertEqual([r["allocated_kits"] for r in plan["communities"]], [294, 294, 412])
        self.assertEqual([r["need_score"] for r in plan["communities"]], [80, 60, 56])
        for row in plan["communities"]:
            self.assertAlmostEqual(sum(f["score_points"] for f in row["score_factors"]), row["need_score"])

    def test_allocation_conservation_and_caps(self):
        generator = random.Random(42)
        for _ in range(500):
            weights = [generator.randint(0, 100) for _ in range(10)]
            caps = [generator.randint(0, 50) for _ in weights]
            inventory = generator.randint(0, 1000)
            allocations = allocate_kits(weights, inventory, caps)
            self.assertEqual(sum(allocations), min(inventory, sum(c for w, c in zip(weights, caps) if w > 0)))
            self.assertTrue(all(type(v) is int and 0 <= v <= cap for v, cap in zip(allocations, caps)))
        self.assertEqual(allocate_kits([9, 1], 100, [10, 100]), [10, 90])
        self.assertEqual(allocate_kits([], 100), [])

    def test_zero_scores_leave_inventory(self):
        communities = [{**row, **{key: 0 for key in FEATURES[1:]}} for row in self.communities]
        self.assertEqual(recommend(communities, 500)["unallocated_kits"], 500)

    def test_simulation_distances_and_inventory(self):
        self.assertAlmostEqual(distance_km(0, 0, 1, 0), 111.195, places=2)
        plan = recommend(self.communities, 1000)
        original = json.dumps(plan)
        near = simulate(plan["communities"], 1000, 32.7767, -96.797, 5)
        self.assertEqual([r["scenario_kits"] for r in near["communities"]], [0, 417, 583])
        self.assertEqual(near["population_in_radius"], 5000)
        self.assertIsNone(near["demand_comparison"])
        self.assertEqual(near["allocated_kits"] + near["unallocated_kits"], 1000)
        empty = simulate(plan["communities"], 1000, 0, 0, 1)
        self.assertEqual(empty["unallocated_kits"], 1000)
        wide = simulate(plan["communities"], 1000, 32.7767, -96.797, 20)
        self.assertEqual([r["scenario_kits"] for r in wide["communities"]], [294, 294, 412])
        self.assertEqual(json.dumps(plan), original)

    def test_map_metrics_and_ids(self):
        result = map_features(self.communities, "low_income_pct", 70)
        self.assertEqual({f["id"] for f in result["features"]}, {"sample-b", "sample-c"})
        feature = result["features"][0]
        self.assertEqual(feature["geometry"]["coordinates"], [-96.797, 32.8067])
        self.assertEqual(feature["properties"]["heat_weight"], 0.9)

    def test_model_requires_explicit_configuration(self):
        with self.assertRaises(ValueError):
            recommend(self.communities, 1000, mode="model")
        for inventory in [0, -1, 1.5, True]:
            with self.assertRaises(ValueError):
                recommend(self.communities, inventory)

    def test_terminal_flows(self):
        result = subprocess.run([sys.executable, str(ROOT / "main.py")],
                                input="hello\n0\n1000\ny\n2\n5\nn\n", text=True,
                                capture_output=True, check=True, cwd=ROOT)
        self.assertIn("Community A: 294 kits", result.stdout)
        self.assertIn("Scenario: 583 kits", result.stdout)
        result = subprocess.run([sys.executable, str(ROOT / "main.py"), "--kits", "500", "--no-interactive"],
                                text=True, capture_output=True, check=True, cwd=ROOT.parent)
        self.assertIn("Unallocated kits: 0", result.stdout)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"FOOD_DATA_PATH": str(ROOT / "communities.csv"),
                                                   "FOOD_DATA_LABEL": "fictional sample data", "FOOD_MODEL_PATH": ""})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.client = TestClient(app)

    def test_recommend_and_map(self):
        result = self.client.post("/recommend", json={"inventory_kits": 1000})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["allocated_kits"], 1000)
        result = self.client.get("/communities?metric=no_vehicle_pct&min_value=50")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(result.json()["features"]), 1)
        self.assertEqual(self.client.get("/docs").status_code, 200)
        demo = self.client.get("/")
        self.assertEqual(demo.status_code, 200)
        self.assertIn("Testing UI", demo.text)
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)

    def test_simulation(self):
        result = self.client.post("/simulate", json={"inventory_kits": 1000, "latitude": 32.7767,
                                                    "longitude": -96.797, "radius_km": 5})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["allocated_kits"], 1000)
        self.assertEqual(result.json()["population_in_radius"], 5000)

    def test_invalid_requests(self):
        for inventory in [0, -1, 1.5, True, "1000"]:
            self.assertEqual(self.client.post("/recommend", json={"inventory_kits": inventory}).status_code, 422)
        self.assertEqual(self.client.post("/recommend", json={"inventory_kits": 500, "mode": "model"}).status_code, 409)
        self.assertEqual(self.client.get("/communities?metric=unknown").status_code, 422)
        self.assertEqual(self.client.get("/communities?min_value=nan").status_code, 422)
        self.assertEqual(self.client.post("/simulate", json={"inventory_kits": 1000, "latitude": 91,
                                                          "longitude": 0, "radius_km": 5}).status_code, 422)


class TrainingTests(unittest.TestCase):
    def test_full_training_prediction_and_api(self):
        # Temporary synthetic observations test plumbing, not real accuracy.
        temporary = tempfile.TemporaryDirectory(prefix=".foodbank-test-", dir=ROOT)
        folder = Path(temporary.name).resolve()
        self.assertEqual(folder.parent, ROOT)
        try:
            history = folder / "history.csv"
            fields = ["area_id", "week_start", *FEATURES, "meal_kits_requested"]
            with history.open("w", newline="") as file:
                writer = csv.DictWriter(file, fieldnames=fields)
                writer.writeheader()
                for week in range(10):
                    for area in range(6):
                        values = [str(area), str(date(2025, 1, 6) + timedelta(weeks=week)),
                                  1000 + area * 500, 20 + area * 10, 30 + area * 8, 10 + area * 5, 50 + area * 20 + week]
                        writer.writerow(dict(zip(fields, values)))
            records = load_history(history)
            train, test, _ = split_history(records)
            self.assertLess(max(r["week"] for r in train), min(r["week"] for r in test))
            path = folder / "candidate.joblib"
            report = train_candidate(history, path)
            self.assertEqual((report["training_rows"], report["test_rows"]), (48, 12))
            self.assertGreaterEqual(report["model_mae_kits_per_area_week"], 0)
            plan = recommend(load_communities(), 10000, "model", path, "2025-04-07")
            self.assertGreater(plan["unallocated_kits"], 0)
            self.assertTrue(all(row["allocated_kits"] <= row["allocation_cap"] for row in plan["communities"]))
            scenario = simulate(plan["communities"], 10000, 32.7767, -96.797, 5)
            self.assertEqual(scenario["allocated_kits"] + scenario["unallocated_kits"], 10000)
            self.assertIsNotNone(scenario["demand_comparison"])
            self.assertAlmostEqual(scenario["demand_comparison"]["baseline_estimated_unmet_kits"], 0)
            self.assertGreater(scenario["demand_comparison"]["scenario_estimated_unmet_kits"], 0)
            with patch.dict(os.environ, {"FOOD_MODEL_PATH": str(path), "FOOD_DATA_PATH": str(ROOT / "communities.csv")}):
                client = TestClient(app)
                result = client.post("/recommend", json={"inventory_kits": 1000, "mode": "model", "week_start": "2025-04-07"})
                self.assertEqual(result.status_code, 200)
                self.assertIsNotNone(result.json()["communities"][0]["predicted_weekly_kits"])
                self.assertEqual(client.post("/recommend", json={"inventory_kits": 1000, "mode": "model"}).status_code, 422)
        finally:
            # Verified above: this generated temporary directory is inside ROOT.
            temporary.cleanup()

    def test_empty_training_template(self):
        with self.assertRaisesRegex(ValueError, "No historical records"):
            load_history(ROOT / "historical_demand_template.csv")


if __name__ == "__main__":
    unittest.main()
