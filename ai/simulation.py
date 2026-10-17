"""Geographic what-if simulation; sample coordinates are fictional community centers."""

from math import asin, cos, isfinite, radians, sin, sqrt
from allocation import allocate_kits


def distance_km(latitude_a, longitude_a, latitude_b, longitude_b):
    """Straight-line distance along the Earth's surface, not driving distance."""
    lat_a, lat_b = radians(latitude_a), radians(latitude_b)
    lat_delta = lat_b - lat_a
    lon_delta = radians(longitude_b - longitude_a)
    value = sin(lat_delta / 2) ** 2 + cos(lat_a) * cos(lat_b) * sin(lon_delta / 2) ** 2
    return 6371 * 2 * asin(sqrt(min(1, max(0, value))))


def simulate(communities, inventory, latitude, longitude, radius_km):
    if not isinstance(inventory, int) or isinstance(inventory, bool) or inventory <= 0:
        raise ValueError("Inventory must be a positive whole number.")
    if not isfinite(latitude) or not -90 <= latitude <= 90:
        raise ValueError("Latitude must be between -90 and 90.")
    if not isfinite(longitude) or not -180 <= longitude <= 180:
        raise ValueError("Longitude must be between -180 and 180.")
    if not isfinite(radius_km) or radius_km <= 0:
        raise ValueError("Radius must be a positive number.")

    results = []
    for community in communities:
        distance = distance_km(latitude, longitude, community["latitude"], community["longitude"])
        results.append({
            "area_id": community["area_id"],
            "name": community["name"],
            "distance_km": distance,
            "in_radius": distance <= radius_km,
            "population": community["population"],
            "weight": community["allocation_weight"],
            "cap": community.get("allocation_cap", inventory),
            "baseline_kits": community["allocated_kits"],
            "predicted_weekly_kits": community.get("predicted_weekly_kits"),
            "scenario_kits": 0,
        })

    eligible = [row for row in results if row["in_radius"] and row["weight"] > 0]
    amounts = allocate_kits([row["weight"] for row in eligible], inventory,
                            [row["cap"] for row in eligible])
    for row, amount in zip(eligible, amounts):
        row["scenario_kits"] = amount
    for row in results:
        row["change_kits"] = row["scenario_kits"] - row["baseline_kits"]

    demand = None
    if results and all(row["predicted_weekly_kits"] is not None for row in results):
        total_requests = sum(row["predicted_weekly_kits"] for row in results)
        baseline_unmet = sum(max(0, row["predicted_weekly_kits"] - row["baseline_kits"]) for row in results)
        scenario_unmet = sum(max(0, row["predicted_weekly_kits"] - row["scenario_kits"]) for row in results)
        demand = {
            "predicted_total_weekly_requests": total_requests,
            "baseline_estimated_unmet_kits": baseline_unmet,
            "scenario_estimated_unmet_kits": scenario_unmet,
            "change_in_estimated_unmet_kits": scenario_unmet - baseline_unmet,
            "note": "Positive change means more predicted requests left unmet than under the baseline allocation; not a causal food-insecurity estimate.",
        }

    return {
        "communities": results,
        "population_in_radius": sum(row["population"] for row in results if row["in_radius"]),
        "unallocated_kits": inventory - sum(row["scenario_kits"] for row in results),
        "allocated_kits": sum(row["scenario_kits"] for row in results),
        "demand_comparison": demand,
        "assumptions": [
            "All inventory is dispatched from a single location, replacing the baseline plan.",
            "Coverage uses straight-line distance to community centers, not travel routes or actual attendance.",
            "Population in radius counts whole areas whose centers are in range; it is not people served.",
            "No causal change in food insecurity is predicted.",
        ],
    }


def read_number(prompt, minimum, maximum):
    while True:
        try:
            value = float(input(prompt))
            if isfinite(value) and minimum <= value <= maximum:
                return value
        except ValueError:
            pass
        print(f"Enter a number from {minimum:g} to {maximum:g}.")


def run_what_if(communities, inventory):
    while True:
        answer = input("\nRun a mobile foodbank what-if? (y/n): ").strip().lower()
        if answer in ("n", "no"):
            return
        if answer not in ("y", "yes"):
            print("Enter y or n.")
            continue

        print("Choose a community center for the foodbank, or enter custom coordinates:")
        for index, community in enumerate(communities, start=1):
            print(f"{index}. {community['name']}")
        print("0. Custom latitude and longitude")
        while True:
            try:
                choice = int(input("Location number: "))
                if 0 <= choice <= len(communities):
                    break
            except ValueError:
                pass
            print("Enter one of the location numbers shown above.")

        if choice == 0:
            latitude = read_number("Latitude: ", -90, 90)
            longitude = read_number("Longitude: ", -180, 180)
        else:
            location = communities[choice - 1]
            latitude, longitude = location["latitude"], location["longitude"]
        radius = read_number("Service radius in kilometers (e.g. 5): ", 0.001, 20040)
        result = simulate(communities, inventory, latitude, longitude, radius)

        print(f"\nWhat-if: all {inventory} kits dispatched from this single location.")
        print("This replaces the baseline plan; it does not add extra inventory.")
        print("Coverage uses community centers and straight-line distances.")
        for row in result["communities"]:
            status = "inside radius" if row["in_radius"] else "outside radius"
            change = row["scenario_kits"] - row["baseline_kits"]
            print(f"{row['name']}: {row['distance_km']:.2f} km, {status}")
            print(f"  Baseline: {row['baseline_kits']} kits -> Scenario: {row['scenario_kits']} kits ({change:+d})")
        print(f"Population in communities whose centers are inside radius: {result['population_in_radius']:,}")
        print(f"Unallocated kits: {result['unallocated_kits']}")
        if result["demand_comparison"] is not None:
            demand = result["demand_comparison"]
            print(f"Baseline estimated unmet requests: {demand['baseline_estimated_unmet_kits']:.1f} kits")
            print(f"Scenario estimated unmet requests: {demand['scenario_estimated_unmet_kits']:.1f} kits")
            print(demand["note"])
        print("Center-in-radius is a rough coverage proxy, not a count of people served.")
        print("Allocations keep the plan's demand caps when using model mode.")
        print("No actual turnout, travel routes, or reduction in food insecurity is predicted.")
