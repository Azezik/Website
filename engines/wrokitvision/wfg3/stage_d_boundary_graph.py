from __future__ import annotations

import math

from .types import BoundaryGraph, BoundaryToken, WFG3Config


def _dot(a: tuple[float, float], b: tuple[float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _angle_ok(a: BoundaryToken, b: BoundaryToken, tol_deg: float) -> bool:
    cos_min = math.cos(math.radians(tol_deg))
    return abs(_dot(a.tangent, b.tangent)) >= cos_min


def _side_ok(a: BoundaryToken, b: BoundaryToken, tol: float) -> bool:
    ll = math.dist(a.left_lab, b.left_lab)
    rr = math.dist(a.right_lab, b.right_lab)
    return ll <= tol and rr <= tol


def run_stage_d_boundary_graph(tokens: list[BoundaryToken], config: WFG3Config) -> BoundaryGraph:
    adjacency: dict[int, list[int]] = {t.token_id: [] for t in tokens}
    by_row: dict[int, list[BoundaryToken]] = {}
    for t in tokens:
        by_row.setdefault(t.y, []).append(t)

    r = config.graph_neighbor_radius
    for t in tokens:
        neighbors: list[BoundaryToken] = []
        for yy in range(t.y - r, t.y + r + 1):
            neighbors.extend(by_row.get(yy, []))

        for n in neighbors:
            if n.token_id == t.token_id:
                continue
            if abs(n.x - t.x) > r or abs(n.y - t.y) > r:
                continue
            if not _angle_ok(t, n, config.graph_orientation_tol_deg):
                continue
            if not _side_ok(t, n, config.graph_side_deltae_tol):
                continue
            adjacency[t.token_id].append(n.token_id)

        adjacency[t.token_id] = sorted(set(adjacency[t.token_id]))

    visited: set[int] = set()
    chains: list[list[int]] = []

    for t in tokens:
        tid = t.token_id
        if tid in visited:
            continue
        stack = [tid]
        comp: list[int] = []
        while stack:
            cur = stack.pop()
            if cur in visited:
                continue
            visited.add(cur)
            comp.append(cur)
            stack.extend(adjacency[cur])
        chains.append(sorted(comp))

    loops: list[list[int]] = []
    for c in chains:
        if len(c) < 4:
            continue
        deg1 = all(len(adjacency[n]) >= 2 for n in c)
        if deg1:
            loops.append(c)

    return BoundaryGraph(adjacency=adjacency, chains=chains, loops=loops)
