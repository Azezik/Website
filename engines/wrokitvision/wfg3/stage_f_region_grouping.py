from __future__ import annotations

import cv2
import numpy as np

from .types import GroupMap, RegionPartition, WFG3Config


def _region_adjacency(region_labels: np.ndarray, nregions: int) -> dict[int, set[int]]:
    h, w = region_labels.shape
    adj = {i: set() for i in range(nregions)}
    for y in range(h - 1):
        a = region_labels[y, :]
        b = region_labels[y + 1, :]
        diff = a != b
        for ra, rb in zip(a[diff].tolist(), b[diff].tolist()):
            adj[ra].add(rb)
            adj[rb].add(ra)
    for x in range(w - 1):
        a = region_labels[:, x]
        b = region_labels[:, x + 1]
        diff = a != b
        for ra, rb in zip(a[diff].tolist(), b[diff].tolist()):
            adj[ra].add(rb)
            adj[rb].add(ra)
    return adj


def run_stage_f_region_grouping(partition: RegionPartition, config: WFG3Config) -> GroupMap:
    labels = partition.labels
    nregions = partition.region_count
    adjacency = _region_adjacency(labels, nregions)

    # Region graph clustering driven by adjacency density + perimeter coherence.
    region_density = {r: len(neis) for r, neis in adjacency.items()}
    seeds = [r for r in range(nregions) if region_density[r] >= 2]
    assigned = {r: -1 for r in range(nregions)}

    gid = 0
    for seed in seeds:
        if assigned[seed] >= 0:
            continue
        cluster = set([seed])
        frontier = [seed]
        while frontier:
            cur = frontier.pop()
            for n in sorted(adjacency[cur]):
                if n in cluster:
                    continue
                if abs(region_density[n] - region_density[cur]) > 5:
                    continue
                cluster.add(n)
                frontier.append(n)

        mask = np.isin(labels, list(cluster)).astype(np.uint8) * 255
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        area = float(mask.sum() / 255.0)
        perimeter = float(sum(cv2.arcLength(c, True) for c in contours))
        coherence = area / (perimeter + 1e-6)
        if coherence < config.grouping_coherence_threshold and len(cluster) > 1:
            continue

        for r in cluster:
            assigned[r] = gid
        gid += 1

    for r in range(nregions):
        if assigned[r] == -1:
            assigned[r] = gid
            gid += 1

    group_labels = np.zeros_like(labels, dtype=np.int32)
    for r in range(nregions):
        group_labels[labels == r] = assigned[r]

    groups: dict[int, dict[str, float]] = {}
    for g in range(gid):
        mask = group_labels == g
        ys, xs = np.where(mask)
        if len(xs) == 0:
            continue
        groups[g] = {
            "region_count": float(len(set(labels[mask].tolist()))),
            "area": float(len(xs)),
            "centroid_x": float(xs.mean()),
            "centroid_y": float(ys.mean()),
        }

    return GroupMap(labels=group_labels, group_count=gid, groups=groups)
