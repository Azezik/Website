from __future__ import annotations

import math

import cv2
import numpy as np

from .types import GroupMap, StructureGraph


def _group_masks(group_map: GroupMap) -> dict[int, np.ndarray]:
    return {gid: (group_map.labels == gid).astype(np.uint8) for gid in range(group_map.group_count)}


def run_stage_g_structure_graph(group_map: GroupMap) -> StructureGraph:
    masks = _group_masks(group_map)
    nodes: dict[int, dict[str, float]] = {}
    for gid, m in masks.items():
        ys, xs = np.where(m > 0)
        if len(xs) == 0:
            continue
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        nodes[gid] = {
            "area": float(len(xs)),
            "centroid_x": float(xs.mean()),
            "centroid_y": float(ys.mean()),
            "bbox_x": float(x0),
            "bbox_y": float(y0),
            "bbox_w": float(x1 - x0 + 1),
            "bbox_h": float(y1 - y0 + 1),
        }

    edges: list[dict[str, float | int | str]] = []
    gids = sorted(nodes)

    # Adjacency and containment.
    kernel = np.ones((3, 3), np.uint8)
    for i, a in enumerate(gids):
        ma = masks[a]
        dil_a = cv2.dilate(ma, kernel, iterations=1)
        for b in gids[i + 1 :]:
            mb = masks[b]
            touch = np.logical_and(dil_a > 0, mb > 0).any()
            if touch:
                edges.append({"src": a, "dst": b, "type": "adjacent"})

            inter = float(np.logical_and(ma > 0, mb > 0).sum())
            if inter > 0:
                # Should rarely happen after full partition, but keep deterministic handling.
                frac_a = inter / (ma.sum() + 1e-6)
                frac_b = inter / (mb.sum() + 1e-6)
                if frac_a > 0.9 or frac_b > 0.9:
                    edges.append({"src": a, "dst": b, "type": "containment"})

    # Alignment, support, repetition.
    for i, a in enumerate(gids):
        na = nodes[a]
        for b in gids[i + 1 :]:
            nb = nodes[b]
            if abs(na["centroid_y"] - nb["centroid_y"]) < 8:
                edges.append({"src": a, "dst": b, "type": "alignment_horizontal"})
            if abs(na["centroid_x"] - nb["centroid_x"]) < 8:
                edges.append({"src": a, "dst": b, "type": "alignment_vertical"})

            # Support: b below a and x-overlap.
            xa0, xa1 = na["bbox_x"], na["bbox_x"] + na["bbox_w"]
            xb0, xb1 = nb["bbox_x"], nb["bbox_x"] + nb["bbox_w"]
            overlap = max(0.0, min(xa1, xb1) - max(xa0, xb0))
            if overlap > 0 and nb["centroid_y"] > na["centroid_y"]:
                if abs((nb["bbox_y"]) - (na["bbox_y"] + na["bbox_h"])) < 20:
                    edges.append({"src": a, "dst": b, "type": "support"})

            wa, ha = na["bbox_w"], na["bbox_h"]
            wb, hb = nb["bbox_w"], nb["bbox_h"]
            size_ratio = max(wa * ha, wb * hb) / (min(wa * ha, wb * hb) + 1e-6)
            dist = math.hypot(na["centroid_x"] - nb["centroid_x"], na["centroid_y"] - nb["centroid_y"])
            if size_ratio < 1.25 and dist < 220:
                edges.append({"src": a, "dst": b, "type": "repetition"})

    return StructureGraph(nodes=nodes, edges=edges)
