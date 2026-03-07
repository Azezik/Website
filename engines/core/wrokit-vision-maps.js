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

  function buildStructuralGraph(tokens, viewport, textMap){
    const normalized = (Array.isArray(tokens) ? tokens : []).map(tok => normToken(tok, viewport)).filter(n => n.text);
    const textMask = buildTextInfluenceMask(textMap || buildTextMap(tokens, viewport));
    const nodes = [];

    const sorted = normalized.slice().sort((a,b)=> (a.cy - b.cy) || (a.cx - b.cx));
    const lineBands = [];
    for(const tok of sorted){
      let band = lineBands.find(b => Math.abs(tok.cy - b.cy) <= Math.max(5, tok.h * 0.75));
      if(!band){
        band = { cy: tok.cy, tokens: [] };
        lineBands.push(band);
      }
      band.tokens.push(tok);
      band.cy = (band.cy * (band.tokens.length - 1) + tok.cy) / band.tokens.length;
    }

    lineBands.forEach((band, idx) => {
      const xs = band.tokens.map(t => t.x);
      const ys = band.tokens.map(t => t.y);
      const xe = band.tokens.map(t => t.x + t.w);
      const ye = band.tokens.map(t => t.y + t.h);
      const box = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xe) - Math.min(...xs),
        h: Math.max(...ye) - Math.min(...ys)
      };
      const textOverlapScore = scoreTextOverlap(box, textMask);
      nodes.push({
        id: `band_${idx}`,
        type: 'band',
        ...box,
        cx: box.x + box.w/2,
        cy: box.y + box.h/2,
        orientation: box.w >= box.h ? 'horizontal' : 'vertical',
        contrastScore: Math.max(0.2, Math.min(1, band.tokens.length / 6)),
        textOverlapScore,
        stabilityScore: Math.max(0.05, 1 - (textOverlapScore * 0.65))
      });
    });

    const edges = [];
    for(let i=0;i<nodes.length;i++){
      const a = nodes[i];
      for(let j=i+1;j<nodes.length;j++){
        const b = nodes[j];
        const dx = (b.cx - a.cx) / Math.max(1, Number(viewport?.width || viewport?.w) || 1);
        const dy = (b.cy - a.cy) / Math.max(1, Number(viewport?.height || viewport?.h) || 1);
        const dist = Math.hypot(dx, dy);
        if(dist <= 0.4){
          edges.push({ from: a.id, to: b.id, dx, dy, dist });
        }
      }
    }

    return {
      version: 1,
      background: estimateBackground(textMap),
      textMask,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes,
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
