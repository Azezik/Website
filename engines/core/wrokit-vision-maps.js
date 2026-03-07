(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WrokitVisionMaps = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  function clamp01(v){ return Math.max(0, Math.min(1, Number(v) || 0)); }

  function normToken(tok, viewport){
    const width = Math.max(1, Number(viewport?.width || viewport?.w) || 1);
    const height = Math.max(1, Number(viewport?.height || viewport?.h) || 1);
    const x = Number(tok?.x) || 0;
    const y = Number(tok?.y) || 0;
    const w = Math.max(0, Number(tok?.w) || 0);
    const h = Math.max(0, Number(tok?.h) || 0);
    return {
      text: String(tok?.text || ''),
      x, y, w, h,
      cx: x + (w / 2),
      cy: y + (h / 2),
      nx: clamp01(x / width),
      ny: clamp01(y / height),
      nw: clamp01(w / width),
      nh: clamp01(h / height),
      ncx: clamp01((x + w / 2) / width),
      ncy: clamp01((y + h / 2) / height)
    };
  }

  function buildTextMap(tokens, viewport){
    const nodes = (Array.isArray(tokens) ? tokens : [])
      .map(tok => normToken(tok, viewport))
      .filter(tok => !!tok.text.trim());

    const sorted = nodes.slice().sort((a,b)=> (a.cy - b.cy) || (a.cx - b.cx));
    const edges = [];
    for(let i=0;i<sorted.length;i++){
      const a = sorted[i];
      for(let j=i+1;j<Math.min(sorted.length, i + 18);j++){
        const b = sorted[j];
        const dx = b.ncx - a.ncx;
        const dy = b.ncy - a.ncy;
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        if(ady <= 0.015 && adx <= 0.35){
          edges.push({ from:i, to:j, type:'same_line', dx, dy, dist: Math.hypot(dx,dy) });
        } else if(adx <= 0.06 && ady <= 0.2){
          edges.push({ from:i, to:j, type:'vertical_near', dx, dy, dist: Math.hypot(dx,dy) });
        } else if(adx <= 0.25 && ady <= 0.12){
          edges.push({ from:i, to:j, type:'near', dx, dy, dist: Math.hypot(dx,dy) });
        }
      }
    }

    return {
      version: 1,
      nodeCount: sorted.length,
      edgeCount: edges.length,
      nodes: sorted,
      edges
    };
  }

  function buildTextInfluenceMask(textMap){
    const nodes = textMap?.nodes || [];
    return {
      version: 1,
      boxes: nodes.map(n => ({ x:n.x, y:n.y, w:n.w, h:n.h, weight:1 }))
    };
  }

  function scoreTextOverlap(feature, textMask){
    const boxes = textMask?.boxes || [];
    if(!boxes.length) return 0;
    const fx0 = feature.x;
    const fy0 = feature.y;
    const fx1 = fx0 + feature.w;
    const fy1 = fy0 + feature.h;
    let overlapArea = 0;
    const area = Math.max(1, feature.w * feature.h);
    for(const b of boxes){
      const ox = Math.max(0, Math.min(fx1, b.x + b.w) - Math.max(fx0, b.x));
      const oy = Math.max(0, Math.min(fy1, b.y + b.h) - Math.max(fy0, b.y));
      overlapArea += ox * oy;
    }
    return Math.max(0, Math.min(1, overlapArea / area));
  }

  function estimateBackground(textMap){
    const nodes = textMap?.nodes || [];
    if(!nodes.length){
      return { confidence: 0.25, occupiedRatio: 0 };
    }
    const occupied = nodes.reduce((sum, n)=> sum + (n.nw * n.nh), 0);
    const occupiedRatio = Math.max(0, Math.min(1, occupied));
    return {
      confidence: Math.max(0.3, 1 - occupiedRatio),
      occupiedRatio
    };
  }

  /* ── Spatial clustering (DBSCAN-style) ──────────────────────────── */

  function boxEdgeDist(a, b){
    // Minimum edge-to-edge distance between two bounding boxes
    const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
    const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
    return Math.hypot(dx, dy);
  }

  function dbscanCluster(items, eps, minPts){
    // items: [{x,y,w,h,...}]  uses edge-to-edge box distance
    const n = items.length;
    const labels = new Int16Array(n).fill(-2); // -2 = unvisited
    let clusterId = 0;
    for(let i = 0; i < n; i++){
      if(labels[i] !== -2) continue;
      const neighbors = rangeQuery(items, i, eps);
      if(neighbors.length < minPts){ labels[i] = -1; continue; } // noise
      labels[i] = clusterId;
      const seed = neighbors.slice();
      for(let s = 0; s < seed.length; s++){
        const q = seed[s];
        if(labels[q] === -1) labels[q] = clusterId; // border point
        if(labels[q] !== -2) continue;
        labels[q] = clusterId;
        const qn = rangeQuery(items, q, eps);
        if(qn.length >= minPts){
          for(const r of qn){ if(!seed.includes(r)) seed.push(r); }
        }
      }
      clusterId++;
    }
    return { labels, clusterCount: clusterId };
  }

  function rangeQuery(items, idx, eps){
    const p = items[idx];
    const result = [];
    for(let j = 0; j < items.length; j++){
      if(j === idx) continue;
      if(boxEdgeDist(p, items[j]) <= eps) result.push(j);
    }
    return result;
  }

  function boundingBox(items){
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for(const t of items){
      x0 = Math.min(x0, t.x);
      y0 = Math.min(y0, t.y);
      x1 = Math.max(x1, t.x + t.w);
      y1 = Math.max(y1, t.y + t.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function boxContains(outer, inner){
    return inner.x >= outer.x - 1 && inner.y >= outer.y - 1
      && (inner.x + inner.w) <= (outer.x + outer.w + 1)
      && (inner.y + inner.h) <= (outer.y + outer.h + 1);
  }

  function boxGap(a, b){
    // signed gap: positive = separated, negative = overlapping
    const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
    const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
    return { gapX, gapY };
  }

  /* ── Region-based structural graph ─────────────────────────────── */

  function buildStructuralGraph(tokens, viewport, textMap){
    const vpW = Math.max(1, Number(viewport?.width || viewport?.w) || 1);
    const vpH = Math.max(1, Number(viewport?.height || viewport?.h) || 1);
    const normalized = (Array.isArray(tokens) ? tokens : [])
      .map(tok => normToken(tok, viewport)).filter(n => n.text);
    const textMask = buildTextInfluenceMask(textMap || buildTextMap(tokens, viewport));

    if(!normalized.length){
      return {
        version: 2, background: estimateBackground(textMap), textMask,
        nodeCount: 0, edgeCount: 0, nodes: [], edges: []
      };
    }

    // ── Step 1: Compute adaptive epsilon from median token dimensions ──
    const heights = normalized.map(t => t.h).sort((a,b) => a - b);
    const widths  = normalized.map(t => t.w).sort((a,b) => a - b);
    const medH = heights[Math.floor(heights.length / 2)] || 12;
    const medW = widths[Math.floor(widths.length / 2)] || 40;
    // eps ~ 2x median line height: tokens within ~2 line heights cluster together
    const eps = Math.max(medH * 2.5, medW * 0.8, 15);

    // ── Step 2: DBSCAN cluster tokens into blocks ──
    const { labels, clusterCount } = dbscanCluster(normalized, eps, 2);

    // Collect clusters
    const clusters = new Array(clusterCount).fill(null).map(() => []);
    const noise = [];
    for(let i = 0; i < normalized.length; i++){
      if(labels[i] >= 0) clusters[labels[i]].push(normalized[i]);
      else noise.push(normalized[i]);
    }

    // ── Step 3: Build block-level nodes (leaf regions) ──
    const blockNodes = [];
    for(let c = 0; c < clusters.length; c++){
      const toks = clusters[c];
      if(!toks.length) continue;
      const box = boundingBox(toks);
      // Skip tiny regions (< 0.15% of viewport area)
      if((box.w * box.h) < (vpW * vpH * 0.0015)) continue;
      const textOverlapScore = scoreTextOverlap(box, textMask);
      blockNodes.push({
        id: `block_${blockNodes.length}`,
        type: 'block',
        ...box,
        cx: box.x + box.w / 2,
        cy: box.y + box.h / 2,
        tokenCount: toks.length,
        orientation: box.w >= box.h ? 'horizontal' : 'vertical',
        contrastScore: Math.max(0.2, Math.min(1, toks.length / 6)),
        textOverlapScore,
        stabilityScore: Math.max(0.05, 1 - (textOverlapScore * 0.65)),
        depth: 0
      });
    }

    // ── Step 4: Merge nearby blocks into section regions (second tier) ──
    // Use a larger epsilon to group blocks into sections
    const sectionEps = eps * 3;
    const sectionClustering = blockNodes.length >= 2
      ? dbscanCluster(blockNodes, sectionEps, 2)
      : { labels: new Int16Array(blockNodes.length).fill(-1), clusterCount: 0 };

    const sectionNodes = [];
    for(let s = 0; s < sectionClustering.clusterCount; s++){
      const memberBlocks = [];
      for(let i = 0; i < blockNodes.length; i++){
        if(sectionClustering.labels[i] === s) memberBlocks.push(blockNodes[i]);
      }
      if(memberBlocks.length < 2) continue; // single-block sections not useful
      const box = boundingBox(memberBlocks);
      // Skip sections that are essentially the whole page (>85% area)
      if((box.w * box.h) > (vpW * vpH * 0.85)) continue;
      const textOverlapScore = scoreTextOverlap(box, textMask);
      const totalTokens = memberBlocks.reduce((s, b) => s + b.tokenCount, 0);
      sectionNodes.push({
        id: `section_${sectionNodes.length}`,
        type: 'section',
        ...box,
        cx: box.x + box.w / 2,
        cy: box.y + box.h / 2,
        tokenCount: totalTokens,
        childBlockCount: memberBlocks.length,
        orientation: box.w >= box.h ? 'horizontal' : 'vertical',
        contrastScore: Math.max(0.2, Math.min(1, totalTokens / 12)),
        textOverlapScore,
        stabilityScore: Math.max(0.05, 1 - (textOverlapScore * 0.65)),
        depth: 1,
        _memberBlockIds: memberBlocks.map(b => b.id)
      });
    }

    // ── Step 5: Assemble all region nodes ──
    const allNodes = [...sectionNodes, ...blockNodes];

    // ── Step 6: Build typed edges ──
    const edges = [];

    // 6a: Containment edges — section contains block
    for(const sec of sectionNodes){
      for(const bid of sec._memberBlockIds){
        edges.push({ from: sec.id, to: bid, type: 'contains', dist: 0 });
      }
    }

    // 6b: Adjacency edges between sibling blocks (blocks within same section or nearby)
    for(let i = 0; i < blockNodes.length; i++){
      const a = blockNodes[i];
      // Find nearest neighbor in each cardinal direction (up to 2 per direction)
      let bestUp = null, bestDown = null, bestLeft = null, bestRight = null;
      let dUp = Infinity, dDown = Infinity, dLeft = Infinity, dRight = Infinity;

      for(let j = 0; j < blockNodes.length; j++){
        if(i === j) continue;
        const b = blockNodes[j];
        const { gapX, gapY } = boxGap(a, b);

        // Horizontal overlap → vertically adjacent
        if(gapX < 0){
          const vDist = Math.abs(b.cy - a.cy);
          if(b.cy < a.cy && vDist < dUp){ dUp = vDist; bestUp = b; }
          if(b.cy > a.cy && vDist < dDown){ dDown = vDist; bestDown = b; }
        }
        // Vertical overlap → horizontally adjacent
        if(gapY < 0){
          const hDist = Math.abs(b.cx - a.cx);
          if(b.cx < a.cx && hDist < dLeft){ dLeft = hDist; bestLeft = b; }
          if(b.cx > a.cx && hDist < dRight){ dRight = hDist; bestRight = b; }
        }
      }

      // Only add each adjacency once (from lower id → higher id)
      for(const [neighbor, adjType] of [
        [bestUp, 'adjacent_v'], [bestDown, 'adjacent_v'],
        [bestLeft, 'adjacent_h'], [bestRight, 'adjacent_h']
      ]){
        if(!neighbor) continue;
        const fromId = a.id < neighbor.id ? a.id : neighbor.id;
        const toId = a.id < neighbor.id ? neighbor.id : a.id;
        const already = edges.some(e => e.from === fromId && e.to === toId && e.type === adjType);
        if(!already){
          const dx = (neighbor.cx - a.cx) / vpW;
          const dy = (neighbor.cy - a.cy) / vpH;
          edges.push({ from: fromId, to: toId, type: adjType, dx, dy, dist: Math.hypot(dx, dy) });
        }
      }
    }

    // 6c: Adjacency edges between sections
    for(let i = 0; i < sectionNodes.length; i++){
      const a = sectionNodes[i];
      for(let j = i + 1; j < sectionNodes.length; j++){
        const b = sectionNodes[j];
        const { gapX, gapY } = boxGap(a, b);
        const adjType = (gapX < 0) ? 'adjacent_v' : (gapY < 0) ? 'adjacent_h' : null;
        if(!adjType) continue;
        const dx = (b.cx - a.cx) / vpW;
        const dy = (b.cy - a.cy) / vpH;
        edges.push({ from: a.id, to: b.id, type: adjType, dx, dy, dist: Math.hypot(dx, dy) });
      }
    }

    // Clean up internal helper fields
    for(const n of sectionNodes) delete n._memberBlockIds;

    return {
      version: 2,
      background: estimateBackground(textMap),
      textMask,
      nodeCount: allNodes.length,
      edgeCount: edges.length,
      nodes: allNodes,
      edges
    };
  }

  function intersectArea(a, b){
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ox * oy;
  }

  function captureFieldNeighborhood(fieldBox, textMap, structuralGraph){
    if(!fieldBox) return { textNeighbors: [], structuralNeighbors: [] };
    const textNeighbors = (textMap?.nodes || [])
      .filter(n => intersectArea(fieldBox, { x:n.x, y:n.y, w:n.w, h:n.h }) > 0)
      .slice(0, 28)
      .map(n => ({ text: n.text, dx: n.ncx - ((fieldBox.x + fieldBox.w/2) / Math.max(1, fieldBox.x + fieldBox.w)), dy: n.ncy }));

    const structuralNeighbors = (structuralGraph?.nodes || [])
      .map(n => ({
        id: n.id,
        type: n.type,
        cx: n.cx,
        cy: n.cy,
        distance: Math.abs((n.cx || 0) - (fieldBox.x + fieldBox.w/2)) + Math.abs((n.cy || 0) - (fieldBox.y + fieldBox.h/2)),
        stabilityScore: n.stabilityScore,
        textOverlapScore: n.textOverlapScore
      }))
      .sort((a,b)=> a.distance - b.distance)
      .slice(0, 10);

    return { textNeighbors, structuralNeighbors };
  }

  function summarizeTextMap(textMap){
    const nodes = textMap?.nodes || [];
    return {
      version: 1,
      nodeCount: nodes.length,
      sample: nodes.slice(0, 40).map(n => ({ text:n.text, x:n.nx, y:n.ny, w:n.nw, h:n.nh }))
    };
  }

  return {
    buildTextMap,
    buildTextInfluenceMask,
    buildStructuralGraph,
    captureFieldNeighborhood,
    summarizeTextMap
  };
});
