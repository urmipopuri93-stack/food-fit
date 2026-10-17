"""Interactive terminal entry point. Run python main.py."""

import argparse
import json
from pathlib import Path

from community_data import DEFAULT_DATA, load_communities
from engine import recommend
from simulation import run_what_if


def read_inventory():
    while True:
        try:
            inventory = int(input("How many meal kits do you have? "))
            if inventory > 0:
                return inventory
            print("Enter a number greater than zero.")
        except ValueError:
            print("Enter a whole number, such as 500.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--data-label", default="fictional sample data")
    parser.add_argument("--mode", choices=["baseline", "model"], default="baseline")
    parser.add_argument("--model", type=Path)
    parser.add_argument("--week-start", help="Required in model mode; inventory covers this one week.")
    parser.add_argument("--kits", type=int, help="Skip the inventory prompt.")
    parser.add_argument("--output", type=Path, help="Optionally save recommendations as JSON.")
    parser.add_argument("--no-interactive", action="store_true", help="Skip the what-if prompts; requires --kits.")
    args = parser.parse_args()
    if args.no_interactive and args.kits is None:
        parser.error("--no-interactive requires --kits")
    try:
        communities = load_communities(args.data)
        inventory = args.kits if args.kits is not None else read_inventory()
        plan = recommend(communities, inventory, args.mode, args.model, args.week_start, args.data_label)
        print(f"\nDistribution plan for {inventory} meal kits ({plan['mode']}):")
        print(f"Data: {plan['data_label']}")
        for warning in plan["warnings"]:
            print(warning)
        for community in plan["communities"]:
            print(f"{community['name']}: {community['allocated_kits']} kits")
            print(f"  Need score: {community['need_score']:.1f}/100")
            for factor in community["score_factors"]:
                print(f"  {factor['label']}: {factor['percentage']:g}% ({factor['score_points']:g} manual score points)")
            print(f"  Population used for allocation: {community['population']:,}")
            if community["predicted_weekly_kits"] is not None:
                print(f"  Predicted weekly requests: {community['predicted_weekly_kits']:.1f} kits")
        print(f"Unallocated kits: {plan['unallocated_kits']}")
        if args.output:
            args.output.write_text(json.dumps(plan, indent=2), encoding="utf-8")
            print(f"Saved recommendations: {args.output}")
        if not args.no_interactive:
            run_what_if(plan["communities"], inventory)
    except (ValueError, OSError, ImportError) as error:
        parser.exit(1, f"Could not create plan: {error}\n")
    except (EOFError, KeyboardInterrupt):
        print("\nFinished.")


if __name__ == "__main__":
    main()
