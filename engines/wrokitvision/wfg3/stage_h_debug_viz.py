from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .types import (
    BoundaryEvidence,
    BoundaryGraph,
    BoundaryToken,
    DebugArtifacts,
    GroupMap,
    NormalizedSurface,
    RegionPartition,
    StructureGraph,
)
from .utils import colorize_labels, ensure_dir


def _draw_tokens(base: np.ndarray, tokens: list[BoundaryToken], stride: int = 8) -> np.ndarray:
    out = base.copy()
    for i, t in enumerate(tokens):
        if i % stride != 0:
            continue
        x, y = t.x, t.y
        dx = int(round(t.tangent[0] * 6))
        dy = int(round(t.tangent[1] * 6))
        nx = int(round(t.normal[0] * 4))
        ny = int(round(t.normal[1] * 4))
        cv2.line(out, (x - dx, y - dy), (x + dx, y + dy), (255, 200, 0), 1)
        cv2.arrowedLine(out, (x, y), (x + nx, y + ny), (0, 255, 0), 1, tipLength=0.3)
    return out


def _draw_graph(base: np.ndarray, tokens: list[BoundaryToken], graph: BoundaryGraph, stride: int = 12) -> np.ndarray:
    out = base.copy()
    token_idx = {t.token_id: t for t in tokens}
    for a, neis in graph.adjacency.items():
        if a % stride != 0:
            continue
        ta = token_idx[a]
        for b in neis:
            if b < a:
                continue
            tb = token_idx[b]
            cv2.line(out, (ta.x, ta.y), (tb.x, tb.y), (255, 0, 255), 1)
    return out


def _draw_structure(base: np.ndarray, sgraph: StructureGraph) -> np.ndarray:
    out = base.copy()
    for gid, n in sgraph.nodes.items():
        x = int(n["centroid_x"])
        y = int(n["centroid_y"])
        cv2.circle(out, (x, y), 4, (0, 255, 255), -1)
        cv2.putText(out, str(gid), (x + 4, y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1)
    for e in sgraph.edges:
        a, b = int(e["src"]), int(e["dst"])
        if a not in sgraph.nodes or b not in sgraph.nodes:
            continue
        ax, ay = int(sgraph.nodes[a]["centroid_x"]), int(sgraph.nodes[a]["centroid_y"])
        bx, by = int(sgraph.nodes[b]["centroid_x"]), int(sgraph.nodes[b]["centroid_y"])
        color = (50, 150, 255)
        cv2.line(out, (ax, ay), (bx, by), color, 1)
    return out


def run_stage_h_debug_outputs(
    output_dir: str,
    surface: NormalizedSurface,
    evidence: BoundaryEvidence,
    tokens: list[BoundaryToken],
    graph: BoundaryGraph,
    partition: RegionPartition,
    groups: GroupMap,
    sgraph: StructureGraph,
) -> DebugArtifacts:
    out_dir = ensure_dir(output_dir)

    overlays: dict[str, np.ndarray] = {}
    paths: dict[str, str] = {}

    overlays["normalized"] = surface.bgr
    overlays["edge_map"] = cv2.cvtColor(evidence.edge_binary, cv2.COLOR_GRAY2BGR)
    overlays["boundary_tokens"] = _draw_tokens(surface.bgr, tokens)
    overlays["boundary_graph"] = _draw_graph(surface.bgr, tokens, graph)
    overlays["region_map"] = colorize_labels(partition.labels, partition.region_count)
    overlays["group_map"] = colorize_labels(groups.labels, groups.group_count)
    overlays["structure_graph"] = _draw_structure(surface.bgr, sgraph)

    for key, img in overlays.items():
        p = Path(out_dir) / f"{key}.png"
        cv2.imwrite(str(p), img)
        paths[key] = str(p)

    return DebugArtifacts(overlays=overlays, paths=paths)
