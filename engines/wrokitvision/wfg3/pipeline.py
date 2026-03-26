from __future__ import annotations

from .stage_a_normalize import run_stage_a_normalization
from .stage_b_boundary_evidence import run_stage_b_boundary_evidence
from .stage_c_boundary_tokens import run_stage_c_boundary_tokens
from .stage_d_boundary_graph import run_stage_d_boundary_graph
from .stage_e_region_partition import run_stage_e_region_partition
from .stage_f_region_grouping import run_stage_f_region_grouping
from .stage_g_structure_graph import run_stage_g_structure_graph
from .stage_h_debug_viz import run_stage_h_debug_outputs
from .types import WFG3Config, WFG3Result


def run_wfg3(image_path: str, debug_output_dir: str, config: WFG3Config | None = None) -> WFG3Result:
    cfg = config or WFG3Config()

    normalized = run_stage_a_normalization(image_path, cfg)
    evidence = run_stage_b_boundary_evidence(normalized, cfg)
    tokens = run_stage_c_boundary_tokens(normalized, evidence, cfg)
    graph = run_stage_d_boundary_graph(tokens, cfg)
    partition = run_stage_e_region_partition(normalized, evidence, cfg)
    groups = run_stage_f_region_grouping(partition, cfg)
    sgraph = run_stage_g_structure_graph(groups)
    debug = run_stage_h_debug_outputs(debug_output_dir, normalized, evidence, tokens, graph, partition, groups, sgraph)

    return WFG3Result(
        normalized_surface=normalized,
        boundary_evidence=evidence,
        boundary_tokens=tokens,
        boundary_graph=graph,
        region_partition=partition,
        group_map=groups,
        structure_graph=sgraph,
        debug=debug,
    )
