/**
 * WFG3 Stages D–F  (Phase 3)
 *
 * Stage D: Boundary Graph Assembly
 * Stage E: Region Partition
 * Stage F: Region Grouping
 *
 * Depends on: wfg3-cv.js (window._WFG3_CV)
 * Extends:    window._WFG3_Stages  (adds stageD, stageE, stageF)
 */
(function (global) {
  'use strict';

  var CV = global._WFG3_CV;
  var Stages = global._WFG3_Stages;
  if (!CV) throw new Error('wfg3-stages-df.js requires wfg3-cv.js');
  if (!Stages) throw new Error('wfg3-stages-df.js requires wfg3-stages-ac.js');

  /**
   * Stage D contract: BoundaryGraph
   * {
   *   kind:      'wfg3-boundary-graph',
   *   adjacency: { tokenId → [tokenId] },
   *   chains:    [ { ids: [tokenId], ordered: boolean } ],
   *   loops:     [ { ids: [tokenId] } ],
   *   chainMask: Uint8Array (w*h, pixels on any chain = 255)
   * }
   *
   * Stage E contract: RegionPartition
   * {
   *   kind:        'wfg3-region-partition',
   *   width:       number,
   *   height:      number,
   *   labelMap:    Int32Array (w*h, every pixel labeled 1..regionCount),
   *   regionCount: number,
   *   stats:       { regionId → { area, bboxX, bboxY, bboxW, bboxH, cx, cy } },
   *   adjacency:   { regionId → Set<regionId> },
   *   boundaries:  Uint8Array (w*h, boundary pixels = 255)
   * }
   *
   * Stage F contract: GroupMap
   * {
   *   kind:       'wfg3-group-map',
   *   width:      number,
   *   height:     number,
   *   labelMap:   Int32Array (w*h, group labels),
   *   groupCount: number,
   *   groups:     { groupId → { regionIds, area, cx, cy, bboxX, bboxY, bboxW, bboxH } },
   *   boundaries: Uint8Array (w*h, group boundary pixels = 255)
   * }
   */

  /* ── Default config for Stages D–F ── */

  var DEFAULT_CONFIG_DF = Object.freeze({
    // Stage D
    graphNeighborRadius:   4,
    graphOrientationTolDeg: 35,
    graphSideDeltaETol:    25,
    chainMinLength:        3,

    // Stage E
    watershedFgFraction:   0.25,
    minRegionArea:         24,
    boundaryBoostWeight:   0.4,

    // Stage F
    groupMergeThreshold:   0.45,
    groupMinPerimeterRatio: 0.15
  });

  /* ==================================================================
   *  Stage D: Boundary Graph Assembly
   * ================================================================== */

  function stageD_boundaryGraph(tokens, evidence, cfg) {
    cfg = cfg || DEFAULT_CONFIG_DF;
    var W = evidence.width, H = evidence.height;
    var radius = cfg.graphNeighborRadius;
    var angleTolCos = Math.cos(cfg.graphOrientationTolDeg * Math.PI / 180);
    var sideTol = cfg.graphSideDeltaETol;

    // Spatial index: bin tokens by grid cell for fast neighbor lookup
    var cellSize = radius + 1;
    var gridW = Math.ceil(W / cellSize);
    var grid = {};
    for (var ti = 0; ti < tokens.length; ti++) {
      var t = tokens[ti];
      var gx = (t.x / cellSize) | 0;
      var gy = (t.y / cellSize) | 0;
      var key = gx + ',' + gy;
      if (!grid[key]) grid[key] = [];
      grid[key].push(t);
    }

    // Build adjacency
    var adjacency = {};
    for (var ai = 0; ai < tokens.length; ai++) adjacency[tokens[ai].id] = [];

    for (var bi = 0; bi < tokens.length; bi++) {
      var a = tokens[bi];
      var ax = (a.x / cellSize) | 0;
      var ay = (a.y / cellSize) | 0;

      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nk = (ax + dx) + ',' + (ay + dy);
          var cell = grid[nk];
          if (!cell) continue;
          for (var ci = 0; ci < cell.length; ci++) {
            var b = cell[ci];
            if (b.id <= a.id) continue; // undirected, avoid duplicates
            var ddx = b.x - a.x, ddy = b.y - a.y;
            if (Math.abs(ddx) > radius || Math.abs(ddy) > radius) continue;
            if (ddx * ddx + ddy * ddy > radius * radius) continue;

            // Orientation consistency: tangent dot product
            var dot = a.tangentX * b.tangentX + a.tangentY * b.tangentY;
            if (Math.abs(dot) < angleTolCos) continue;

            // Side consistency: left-left and right-right LAB distance
            var llDist = Math.sqrt(
              Math.pow(a.leftLab[0] - b.leftLab[0], 2) +
              Math.pow(a.leftLab[1] - b.leftLab[1], 2) +
              Math.pow(a.leftLab[2] - b.leftLab[2], 2)
            );
            var rrDist = Math.sqrt(
              Math.pow(a.rightLab[0] - b.rightLab[0], 2) +
              Math.pow(a.rightLab[1] - b.rightLab[1], 2) +
              Math.pow(a.rightLab[2] - b.rightLab[2], 2)
            );
            // If sides are flipped (boundary approached from opposite direction),
            // also check left-right and right-left
            var lrDist = Math.sqrt(
              Math.pow(a.leftLab[0] - b.rightLab[0], 2) +
              Math.pow(a.leftLab[1] - b.rightLab[1], 2) +
              Math.pow(a.leftLab[2] - b.rightLab[2], 2)
            );
            var rlDist = Math.sqrt(
              Math.pow(a.rightLab[0] - b.leftLab[0], 2) +
              Math.pow(a.rightLab[1] - b.leftLab[1], 2) +
              Math.pow(a.rightLab[2] - b.leftLab[2], 2)
            );
            var sameOK = llDist <= sideTol && rrDist <= sideTol;
            var flipOK = lrDist <= sideTol && rlDist <= sideTol;
            if (!sameOK && !flipOK) continue;

            adjacency[a.id].push(b.id);
            adjacency[b.id].push(a.id);
          }
        }
      }
    }

    // Find connected components via BFS
    var visited = {};
    var components = [];
    for (var vi = 0; vi < tokens.length; vi++) {
      var tid = tokens[vi].id;
      if (visited[tid]) continue;
      var comp = [];
      var queue = [tid];
      visited[tid] = true;
      while (queue.length > 0) {
        var cur = queue.shift();
        comp.push(cur);
        var neis = adjacency[cur];
        for (var ni = 0; ni < neis.length; ni++) {
          if (!visited[neis[ni]]) {
            visited[neis[ni]] = true;
            queue.push(neis[ni]);
          }
        }
      }
      if (comp.length >= cfg.chainMinLength) {
        components.push(comp);
      }
    }

    // Order each chain spatially for meaningful chain structure
    var tokenById = {};
    for (var oi = 0; oi < tokens.length; oi++) tokenById[tokens[oi].id] = tokens[oi];

    var chains = [];
    var loops = [];

    for (var ki = 0; ki < components.length; ki++) {
      var comp2 = components[ki];
      var ordered = _orderChain(comp2, adjacency, tokenById);

      // Detect loop: if the first and last token in the ordered chain are
      // connected and the component has no degree-1 nodes
      var isLoop = false;
      if (ordered.length >= 6) {
        var first = ordered[0], last = ordered[ordered.length - 1];
        var firstNeis = adjacency[first];
        if (firstNeis.indexOf(last) >= 0) {
          // Check if all nodes have degree >= 2
          var allDeg2 = true;
          for (var li = 0; li < ordered.length; li++) {
            var deg = 0;
            var tokNeis = adjacency[ordered[li]];
            for (var lj = 0; lj < tokNeis.length; lj++) {
              if (comp2.indexOf(tokNeis[lj]) >= 0) deg++;
            }
            if (deg < 2) { allDeg2 = false; break; }
          }
          isLoop = allDeg2;
        }
      }

      chains.push({ ids: ordered, ordered: true });
      if (isLoop) loops.push({ ids: ordered });
    }

    // Build chain mask for use by Stage E
    var chainMask = new Uint8Array(W * H);
    for (var mi = 0; mi < chains.length; mi++) {
      var ch = chains[mi].ids;
      for (var mj = 0; mj < ch.length; mj++) {
        var mt = tokenById[ch[mj]];
        if (mt) chainMask[mt.y * W + mt.x] = 255;
      }
    }

    return {
      kind: 'wfg3-boundary-graph',
      adjacency: adjacency,
      chains: chains,
      loops: loops,
      chainMask: chainMask
    };
  }

  /**
   * Order a component's token IDs along the boundary curve.
   * Uses greedy walk from an endpoint (degree-1 node) or arbitrary start.
   */
  function _orderChain(compIds, adjacency, tokenById) {
    var inComp = {};
    for (var i = 0; i < compIds.length; i++) inComp[compIds[i]] = true;

    // Find endpoint (degree 1 within component) or use first
    var start = compIds[0];
    for (var j = 0; j < compIds.length; j++) {
      var deg = 0;
      var neis = adjacency[compIds[j]];
      for (var k = 0; k < neis.length; k++) {
        if (inComp[neis[k]]) deg++;
      }
      if (deg === 1) { start = compIds[j]; break; }
    }

    // Greedy walk: always pick the nearest unvisited neighbor
    var ordered = [start];
    var used = {};
    used[start] = true;

    while (ordered.length < compIds.length) {
      var last = ordered[ordered.length - 1];
      var lastTok = tokenById[last];
      var best = -1, bestDist = Infinity;
      var neis2 = adjacency[last];
      for (var n = 0; n < neis2.length; n++) {
        var nid = neis2[n];
        if (!inComp[nid] || used[nid]) continue;
        var nt = tokenById[nid];
        var d = (nt.x - lastTok.x) * (nt.x - lastTok.x) +
                (nt.y - lastTok.y) * (nt.y - lastTok.y);
        if (d < bestDist) { bestDist = d; best = nid; }
      }
      if (best < 0) break; // disconnected fragment
      ordered.push(best);
      used[best] = true;
    }

    return ordered;
  }

  /* ==================================================================
   *  Stage E: Region Partition
   * ================================================================== */

  function stageE_regionPartition(surface, evidence, boundaryGraph, cfg) {
    cfg = cfg || DEFAULT_CONFIG_DF;
    var W = surface.width, H = surface.height, N = W * H;

    // ── 1. Build enhanced boundary map ──
    // Combine edgeBinary with boundary graph chain mask.
    // Tokens that survived into chains are stronger evidence than
    // isolated edge pixels, so boost them.
    var edgeBin = evidence.edgeBinary;
    var chainMask = boundaryGraph.chainMask;
    var boostW = cfg.boundaryBoostWeight;

    // Weighted edge: edge + chain boost → gradient for watershed
    var edgeStrength = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var e = edgeBin[i] > 0 ? 1.0 : 0.0;
      var c = chainMask[i] > 0 ? boostW : 0.0;
      edgeStrength[i] = Math.min(1.0, e + c);
    }

    // ── 2. Distance transform on inverted edge map ──
    var invEdge = new Uint8Array(N);
    for (var j = 0; j < N; j++) invEdge[j] = edgeStrength[j] > 0.5 ? 0 : 255;

    // Morphological open to clean noise
    invEdge = CV.morphOpen(invEdge, W, H, 1);

    var dist = CV.distanceTransform(invEdge, W, H);

    // ── 3. Find sure foreground (peaks of distance transform) ──
    var maxDist = 0;
    for (var d = 0; d < N; d++) if (dist[d] > maxDist) maxDist = dist[d];
    var fgThresh = maxDist * cfg.watershedFgFraction;
    if (fgThresh < 2) fgThresh = 2;

    var sureFg = new Uint8Array(N);
    for (var f = 0; f < N; f++) sureFg[f] = dist[f] > fgThresh ? 255 : 0;

    // ── 4. Markers from connected components of sure foreground ──
    var cc = CV.connectedComponents(sureFg, W, H);
    var markers = new Int32Array(N);
    for (var m = 0; m < N; m++) markers[m] = cc.labels[m]; // 0 = unknown, 1+ = seed

    // ── 5. Build gradient for watershed priority ──
    // Use edge strength + normalized gradient magnitude
    var gradMag = evidence.gradMag;
    var maxGrad = 0;
    for (var g = 0; g < N; g++) if (gradMag[g] > maxGrad) maxGrad = gradMag[g];
    var gradScale = maxGrad > 0 ? 128.0 / maxGrad : 0;

    var wsGradient = new Float32Array(N);
    for (var w = 0; w < N; w++) {
      wsGradient[w] = edgeStrength[w] * 127 + gradMag[w] * gradScale;
    }

    // ── 6. Watershed ──
    var wsLabels = CV.watershed(markers, wsGradient, W, H);

    // ── 7. Assign boundary pixels (-1) to nearest region ──
    var labels = new Int32Array(N);
    for (var b = 0; b < N; b++) {
      labels[b] = wsLabels[b] > 0 ? wsLabels[b] : 0;
    }
    // Iterative neighbor voting for unassigned pixels
    var dx4 = [1, -1, 0, 0], dy4 = [0, 0, 1, -1];
    var changed = true;
    var maxIter = 20;
    while (changed && maxIter-- > 0) {
      changed = false;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var idx = y * W + x;
          if (labels[idx] > 0) continue;
          // Find most common neighbor label
          var counts = {};
          for (var nd = 0; nd < 4; nd++) {
            var nx = x + dx4[nd], ny = y + dy4[nd];
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            var nl = labels[ny * W + nx];
            if (nl > 0) counts[nl] = (counts[nl] || 0) + 1;
          }
          var best = 0, bestC = 0;
          for (var k in counts) {
            if (counts[k] > bestC) { bestC = counts[k]; best = +k; }
          }
          if (best > 0) { labels[idx] = best; changed = true; }
        }
      }
    }

    // ── 8. Merge tiny regions ──
    var regionAreas = {};
    for (var ra = 0; ra < N; ra++) {
      var rl = labels[ra];
      regionAreas[rl] = (regionAreas[rl] || 0) + 1;
    }
    var minArea = cfg.minRegionArea;
    for (var rl2 in regionAreas) {
      if (+rl2 <= 0 || regionAreas[rl2] >= minArea) continue;
      // Find majority neighbor for this tiny region
      var nCounts = {};
      for (var my = 0; my < H; my++) {
        for (var mx = 0; mx < W; mx++) {
          if (labels[my * W + mx] !== +rl2) continue;
          for (var md = 0; md < 4; md++) {
            var mnx = mx + dx4[md], mny = my + dy4[md];
            if (mnx < 0 || mnx >= W || mny < 0 || mny >= H) continue;
            var mnl = labels[mny * W + mnx];
            if (mnl > 0 && mnl !== +rl2) nCounts[mnl] = (nCounts[mnl] || 0) + 1;
          }
        }
      }
      var target = 0, targetC = 0;
      for (var nk in nCounts) {
        if (nCounts[nk] > targetC) { targetC = nCounts[nk]; target = +nk; }
      }
      if (target > 0) {
        for (var mr = 0; mr < N; mr++) {
          if (labels[mr] === +rl2) labels[mr] = target;
        }
      }
    }

    // ── 9. Relabel sequentially ──
    var uniq = {};
    for (var sq = 0; sq < N; sq++) uniq[labels[sq]] = true;
    var sortedLabels = Object.keys(uniq).map(Number).sort(function(a,b){ return a-b; });
    var remap = {};
    var nextId = 1;
    for (var si = 0; si < sortedLabels.length; si++) {
      if (sortedLabels[si] <= 0) { remap[sortedLabels[si]] = 0; continue; }
      remap[sortedLabels[si]] = nextId++;
    }
    var regionCount = nextId - 1;
    for (var rl3 = 0; rl3 < N; rl3++) labels[rl3] = remap[labels[rl3]] || 1;

    // ── 10. Compute region stats and adjacency ──
    var stats = {};
    var adj = {};
    for (var ri = 1; ri <= regionCount; ri++) {
      stats[ri] = { area: 0, minX: W, minY: H, maxX: 0, maxY: 0, sumX: 0, sumY: 0 };
      adj[ri] = {};
    }

    for (var sy = 0; sy < H; sy++) {
      for (var sx = 0; sx < W; sx++) {
        var sl = labels[sy * W + sx];
        if (sl <= 0) continue;
        var st = stats[sl];
        st.area++;
        st.sumX += sx; st.sumY += sy;
        if (sx < st.minX) st.minX = sx;
        if (sx > st.maxX) st.maxX = sx;
        if (sy < st.minY) st.minY = sy;
        if (sy > st.maxY) st.maxY = sy;

        // Check right and down for adjacency
        if (sx + 1 < W) {
          var rn = labels[sy * W + sx + 1];
          if (rn > 0 && rn !== sl) { adj[sl][rn] = true; adj[rn][sl] = true; }
        }
        if (sy + 1 < H) {
          var dn = labels[(sy + 1) * W + sx];
          if (dn > 0 && dn !== sl) { adj[sl][dn] = true; adj[dn][sl] = true; }
        }
      }
    }

    var finalStats = {};
    for (var fs = 1; fs <= regionCount; fs++) {
      var s = stats[fs];
      if (s.area === 0) continue;
      finalStats[fs] = {
        area: s.area,
        bboxX: s.minX, bboxY: s.minY,
        bboxW: s.maxX - s.minX + 1, bboxH: s.maxY - s.minY + 1,
        cx: s.sumX / s.area, cy: s.sumY / s.area
      };
    }
    var finalAdj = {};
    for (var fa in adj) finalAdj[fa] = Object.keys(adj[fa]).map(Number);

    // ── 11. Compute boundary pixel mask ──
    var boundaries = new Uint8Array(N);
    for (var by2 = 0; by2 < H; by2++) {
      for (var bx = 0; bx < W; bx++) {
        var bl = labels[by2 * W + bx];
        for (var bd = 0; bd < 4; bd++) {
          var bnx = bx + dx4[bd], bny = by2 + dy4[bd];
          if (bnx < 0 || bnx >= W || bny < 0 || bny >= H) continue;
          if (labels[bny * W + bnx] !== bl) { boundaries[by2 * W + bx] = 255; break; }
        }
      }
    }

    return {
      kind: 'wfg3-region-partition',
      width: W, height: H,
      labelMap: labels,
      regionCount: regionCount,
      stats: finalStats,
      adjacency: finalAdj,
      boundaries: boundaries
    };
  }

  /* ==================================================================
   *  Stage F: Region Grouping
   * ================================================================== */

  function stageF_regionGrouping(partition, surface, cfg) {
    cfg = cfg || DEFAULT_CONFIG_DF;
    var W = partition.width, H = partition.height, N = W * H;
    var labels = partition.labelMap;
    var adj = partition.adjacency;
    var stats = partition.stats;
    var regionCount = partition.regionCount;
    var threshold = cfg.groupMergeThreshold;
    var minPerimRatio = cfg.groupMinPerimeterRatio;

    // ── Compute mean LAB per region ──
    var hasLab = !!(surface.lab);
    var regionLab = {};
    if (hasLab) {
      var L = surface.lab.L, la = surface.lab.a, lb = surface.lab.b;
      var sums = {};
      for (var ri = 1; ri <= regionCount; ri++) sums[ri] = { L: 0, a: 0, b: 0, n: 0 };
      for (var pi = 0; pi < N; pi++) {
        var rl = labels[pi];
        if (rl > 0 && sums[rl]) { sums[rl].L += L[pi]; sums[rl].a += la[pi]; sums[rl].b += lb[pi]; sums[rl].n++; }
      }
      for (var ri2 = 1; ri2 <= regionCount; ri2++) {
        var s = sums[ri2];
        if (s.n > 0) regionLab[ri2] = { L: s.L / s.n, a: s.a / s.n, b: s.b / s.n };
        else regionLab[ri2] = { L: 50, a: 0, b: 0 };
      }
    }

    // ── Compute shared boundary lengths between adjacent regions ──
    var sharedLen = {};
    for (var sy = 0; sy < H; sy++) {
      for (var sx = 0; sx < W; sx++) {
        var sl = labels[sy * W + sx];
        if (sl <= 0) continue;
        // Right neighbor
        if (sx + 1 < W) {
          var rn = labels[sy * W + sx + 1];
          if (rn > 0 && rn !== sl) {
            var pk = Math.min(sl, rn) + ',' + Math.max(sl, rn);
            sharedLen[pk] = (sharedLen[pk] || 0) + 1;
          }
        }
        // Down neighbor
        if (sy + 1 < H) {
          var dn = labels[(sy + 1) * W + sx];
          if (dn > 0 && dn !== sl) {
            var pk2 = Math.min(sl, dn) + ',' + Math.max(sl, dn);
            sharedLen[pk2] = (sharedLen[pk2] || 0) + 1;
          }
        }
      }
    }

    // ── Compute perimeter per region ──
    var perimeter = {};
    for (var pr = 1; pr <= regionCount; pr++) perimeter[pr] = 0;
    var dx4 = [1, -1, 0, 0], dy4 = [0, 0, 1, -1];
    for (var py = 0; py < H; py++) {
      for (var px = 0; px < W; px++) {
        var pl = labels[py * W + px];
        if (pl <= 0) continue;
        for (var pd = 0; pd < 4; pd++) {
          var pnx = px + dx4[pd], pny = py + dy4[pd];
          if (pnx < 0 || pnx >= W || pny < 0 || pny >= H || labels[pny * W + pnx] !== pl) {
            perimeter[pl]++;
          }
        }
      }
    }

    // ── Score adjacent pairs for merge ──
    var mergeScores = [];
    for (var pk3 in sharedLen) {
      var parts = pk3.split(',');
      var a = +parts[0], b = +parts[1];
      var sLen = sharedLen[pk3];
      var perimA = perimeter[a] || 1;
      var perimB = perimeter[b] || 1;
      var minPerim = Math.min(perimA, perimB);

      // Signal 1: shared boundary ratio (how much of the smaller region's
      // perimeter is shared with the other)
      var boundaryRatio = sLen / minPerim;
      if (boundaryRatio < minPerimRatio) continue; // too little contact

      // Signal 2: color similarity (LAB delta between region means)
      var colorSim = 0;
      if (hasLab && regionLab[a] && regionLab[b]) {
        var dL = regionLab[a].L - regionLab[b].L;
        var da = regionLab[a].a - regionLab[b].a;
        var db = regionLab[a].b - regionLab[b].b;
        var de = Math.sqrt(dL * dL + da * da + db * db);
        colorSim = Math.max(0, 1 - de / 60); // 0 at ΔE=60, 1 at ΔE=0
      } else {
        colorSim = 0.5; // no color info, neutral
      }

      // Signal 3: area ratio bonus (small fragments get a merge boost)
      var areaA = stats[a] ? stats[a].area : 1;
      var areaB = stats[b] ? stats[b].area : 1;
      var areaRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB);
      var fragmentBonus = areaRatio < 0.1 ? 0.2 : 0;

      var score = boundaryRatio * 0.40 + colorSim * 0.45 + fragmentBonus + 0.15 * areaRatio;
      mergeScores.push({ a: a, b: b, score: score, boundaryRatio: boundaryRatio, colorSim: colorSim });
    }

    // ── Union-Find merge above threshold ──
    var parent = {};
    for (var uf = 1; uf <= regionCount; uf++) parent[uf] = uf;
    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function union(x, y) {
      x = find(x); y = find(y);
      if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
    }

    // Sort by score descending and merge greedily
    mergeScores.sort(function(a, b) { return b.score - a.score; });
    for (var ms = 0; ms < mergeScores.length; ms++) {
      if (mergeScores[ms].score < threshold) break;
      union(mergeScores[ms].a, mergeScores[ms].b);
    }

    // ── Build group labels ──
    var groupRemap = {};
    var nextGroup = 1;
    var groupLabelMap = new Int32Array(N);
    for (var gl = 0; gl < N; gl++) {
      var rl4 = labels[gl];
      if (rl4 <= 0) { groupLabelMap[gl] = 0; continue; }
      var root = find(rl4);
      if (!groupRemap[root]) groupRemap[root] = nextGroup++;
      groupLabelMap[gl] = groupRemap[root];
    }
    var groupCount = nextGroup - 1;

    // ── Group stats ──
    var groups = {};
    var groupRegions = {};
    for (var gr = 1; gr <= regionCount; gr++) {
      var gRoot = find(gr);
      var gId = groupRemap[gRoot];
      if (!gId) continue;
      if (!groupRegions[gId]) groupRegions[gId] = [];
      groupRegions[gId].push(gr);
    }

    for (var gid in groupRegions) {
      var rids = groupRegions[gid];
      var totalArea = 0, sumX = 0, sumY = 0;
      var gMinX = W, gMinY = H, gMaxX = 0, gMaxY = 0;
      for (var gri = 0; gri < rids.length; gri++) {
        var rs = stats[rids[gri]];
        if (!rs) continue;
        totalArea += rs.area;
        sumX += rs.cx * rs.area;
        sumY += rs.cy * rs.area;
        if (rs.bboxX < gMinX) gMinX = rs.bboxX;
        if (rs.bboxY < gMinY) gMinY = rs.bboxY;
        if (rs.bboxX + rs.bboxW > gMaxX) gMaxX = rs.bboxX + rs.bboxW;
        if (rs.bboxY + rs.bboxH > gMaxY) gMaxY = rs.bboxY + rs.bboxH;
      }
      groups[gid] = {
        regionIds: rids,
        area: totalArea,
        cx: totalArea > 0 ? sumX / totalArea : 0,
        cy: totalArea > 0 ? sumY / totalArea : 0,
        bboxX: gMinX, bboxY: gMinY,
        bboxW: gMaxX - gMinX, bboxH: gMaxY - gMinY
      };
    }

    // ── Group boundaries ──
    var groupBounds = new Uint8Array(N);
    for (var gby = 0; gby < H; gby++) {
      for (var gbx = 0; gbx < W; gbx++) {
        var gbl = groupLabelMap[gby * W + gbx];
        for (var gbd = 0; gbd < 4; gbd++) {
          var gnx = gbx + dx4[gbd], gny = gby + dy4[gbd];
          if (gnx < 0 || gnx >= W || gny < 0 || gny >= H) continue;
          if (groupLabelMap[gny * W + gnx] !== gbl) { groupBounds[gby * W + gbx] = 255; break; }
        }
      }
    }

    return {
      kind: 'wfg3-group-map',
      width: W, height: H,
      labelMap: groupLabelMap,
      groupCount: groupCount,
      groups: groups,
      boundaries: groupBounds,
      _mergeScores: mergeScores // exposed for debug
    };
  }

  /* ── Extend public API ── */

  Stages.DEFAULT_CONFIG_DF = DEFAULT_CONFIG_DF;
  Stages.stageD = stageD_boundaryGraph;
  Stages.stageE = stageE_regionPartition;
  Stages.stageF = stageF_regionGrouping;

})(typeof window !== 'undefined' ? window : globalThis);
