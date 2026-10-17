"""Whole-kit allocation shared by the recommendation and simulation engines."""

from math import isfinite


def allocate_kits(weights, inventory, caps=None):
    if type(inventory) is not int or inventory < 0:
        raise ValueError("Inventory must be a nonnegative whole number.")
    if any(not isfinite(weight) or weight < 0 for weight in weights):
        raise ValueError("Allocation weights must be finite and nonnegative.")
    if caps is None:
        caps = [inventory] * len(weights)
    if len(caps) != len(weights) or any(type(cap) is not int or cap < 0 for cap in caps):
        raise ValueError("Each allocation cap must be a nonnegative whole number.")
    result = [0] * len(weights)
    remaining = inventory
    active = [i for i, weight in enumerate(weights) if weight > 0 and caps[i] > 0]
    while active and remaining:
        total = sum(weights[i] for i in active)
        shares = {i: remaining * weights[i] / total for i in active}
        saturated = [i for i in active if shares[i] >= caps[i] - result[i]]
        if saturated:
            for i in saturated:
                amount = caps[i] - result[i]
                result[i] += amount
                remaining -= amount
            active = [i for i in active if i not in saturated]
            continue
        for i in active:
            amount = int(shares[i])
            result[i] += amount
            remaining -= amount
        order = sorted(active, key=lambda i: shares[i] - int(shares[i]), reverse=True)
        for i in order[:remaining]:
            result[i] += 1
        remaining = 0
    return result
