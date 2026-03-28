from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass(frozen=True)
class WFG3Config:
    max_dim: int = 1400
    denoise_mode: str = "bilateral"  # bilateral|gaussian
    canny_low: int = 60
    canny_high: int = 160
    sobel_ksize: int = 3
    lab_delta_threshold: float = 12.0
    morph_kernel: int = 3
    token_step: int = 2
    token_side_sample_px: int = 2
    token_confidence_deltae_scale: float = 40.0
    token_seeding_mode: str = "global_stride"  # global_stride | uniform_scaffold
    token_min_confidence: float = 0.05
    scaffold_spacing_px: int = 12
    scaffold_staggered: bool = True
    scaffold_evidence_gate_min: float = 0.04
    scaffold_snap_radius: int = 4
    scaffold_snap_enabled: bool = True
    scaffold_max_tokens: int = 25000
    scaffold_min_spacing: int = 5
    graph_neighbor_radius: int = 3
    graph_orientation_tol_deg: float = 30.0
    graph_side_deltae_tol: float = 20.0
    watershed_compactness: float = 0.001
    min_region_area: int = 16
    grouping_density_radius: int = 35
    grouping_coherence_threshold: float = 0.55


@dataclass
class NormalizedSurface:
    source_path: str
    bgr: np.ndarray
    rgb: np.ndarray
    lab: np.ndarray
    gray: np.ndarray
    width: int
    height: int
    scale_from_original: float


@dataclass
class BoundaryEvidence:
    edge_binary: np.ndarray
    edge_weighted: np.ndarray
    grad_x: np.ndarray
    grad_y: np.ndarray
    grad_mag: np.ndarray
    lab_delta: np.ndarray
    contours: list[np.ndarray]


@dataclass
class BoundaryToken:
    token_id: int
    x: int
    y: int
    tangent: tuple[float, float]
    normal: tuple[float, float]
    left_lab: tuple[float, float, float]
    right_lab: tuple[float, float, float]
    delta_e: float
    confidence: float


@dataclass
class BoundaryGraph:
    adjacency: dict[int, list[int]]
    chains: list[list[int]]
    loops: list[list[int]]


@dataclass
class RegionPartition:
    labels: np.ndarray
    region_count: int
    stats: dict[int, dict[str, Any]]


@dataclass
class GroupMap:
    labels: np.ndarray
    group_count: int
    groups: dict[int, dict[str, Any]]


@dataclass
class StructureGraph:
    nodes: dict[int, dict[str, Any]]
    edges: list[dict[str, Any]]


@dataclass
class DebugArtifacts:
    overlays: dict[str, np.ndarray] = field(default_factory=dict)
    paths: dict[str, str] = field(default_factory=dict)


@dataclass
class WFG3Result:
    normalized_surface: NormalizedSurface
    boundary_evidence: BoundaryEvidence
    boundary_tokens: list[BoundaryToken]
    boundary_graph: BoundaryGraph
    region_partition: RegionPartition
    group_map: GroupMap
    structure_graph: StructureGraph
    debug: DebugArtifacts
