/**
 * WrokitVision Browser Precompute Bundle
 *
 * Exposes window.WrokitVisionPrecompute = { buildPrecomputedStructuralMap }
 * so the engine can use the typed structural-mapping pipeline in the browser.
 *
 * All analysis modules are inlined in dependency order.  No external deps.
 * Must be loaded BEFORE engines/core/wrokit-vision-engine.js.
 */
(function(root){
  'use strict';

  // ── types/index.js ─────────────────────────────────────────────────────────
  function clamp01(value){
    const n = Number(value);
    if(!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }
  function ensureBBox(bbox){
    const x = Number(bbox?.x) || 0;
    const y = Number(bbox?.y) || 0;
    const w = Math.max(0, Number(bbox?.w) || 0);
    const h = Math.max(0, Number(bbox?.h) || 0);
    return { x, y, w, h };
  }
  function toPolygonFromBox(bbox){
    const b = ensureBBox(bbox);
    return [
      { x: b.x,       y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x,       y: b.y + b.h }
    ];
  }
  function createScoreBreakdown({ total, components, notes } = {}){
    return {
      total: Number(total) || 0,
      components: Array.isArray(components) ? components : [],
      notes: Array.isArray(notes) ? notes : []
    };
  }
  function createGraphEdge({ edgeId, sourceNodeId, targetNodeId, edgeType, weight, rationale, provenance } = {}){
    return {
      edgeId: edgeId || null,
      sourceNodeId: sourceNodeId || null,
      targetNodeId: targetNodeId || null,
      edgeType: edgeType || 'unknown',
      weight: clamp01(weight),
      rationale: rationale || createScoreBreakdown(),
      provenance: provenance || { stage: 'unknown' }
    };
  }
  function createStructuralRegionNode({ id, geometry, confidence, provenance, features, surfaceTypeCandidate, textDensity, orientation } = {}){
    const bbox = ensureBBox(geometry?.bbox || geometry);
    return {
      id,
      nodeType: 'structural_region',
      geometry: {
        bbox,
        polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
        contour: Array.isArray(geometry?.contour) ? geometry.contour : null,
        hull: Array.isArray(geometry?.hull) ? geometry.hull : null,
        rotatedRect: geometry?.rotatedRect || null,
        orientation: Number(orientation) || Number(geometry?.orientation) || 0
      },
      confidence: clamp01(confidence),
      provenance: provenance || { stage: 'region-proposals' },
      features: features || {},
      surfaceTypeCandidate: surfaceTypeCandidate || 'unknown',
      textDensity: clamp01(textDensity)
    };
  }
  function createTextTokenNode({ id, geometry, confidence, provenance, text, normalizedText, ocr, features, parentLineId, parentBlockId } = {}){
    const bbox = ensureBBox(geometry?.bbox || geometry);
    return {
      id,
      nodeType: 'text_token',
      text: String(text || ''),
      normalizedText: String(normalizedText || text || '').trim(),
      geometry: {
        bbox,
        polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
        orientation: Number(geometry?.orientation) || 0
      },
      confidence: clamp01(confidence),
      provenance: provenance || { stage: 'text-detection' },
      ocr: ocr || {},
      features: features || {},
      parentLineId: parentLineId || null,
      parentBlockId: parentBlockId || null
    };
  }
  function createTextLineNode({ id, geometry, confidence, provenance, tokenIds, text, normalizedText, features, parentBlockId } = {}){
    const bbox = ensureBBox(geometry?.bbox || geometry);
    return {
      id,
      nodeType: 'text_line',
      tokenIds: Array.isArray(tokenIds) ? tokenIds : [],
      text: String(text || ''),
      normalizedText: String(normalizedText || text || '').trim(),
      geometry: {
        bbox,
        polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
        orientation: Number(geometry?.orientation) || 0
      },
      confidence: clamp01(confidence),
      provenance: provenance || { stage: 'text-grouping' },
      features: features || {},
      parentBlockId: parentBlockId || null
    };
  }
  function createTextBlockNode({ id, geometry, confidence, provenance, lineIds, tokenIds, text, normalizedText, features } = {}){
    const bbox = ensureBBox(geometry?.bbox || geometry);
    return {
      id,
      nodeType: 'text_block',
      lineIds: Array.isArray(lineIds) ? lineIds : [],
      tokenIds: Array.isArray(tokenIds) ? tokenIds : [],
      text: String(text || ''),
      normalizedText: String(normalizedText || text || '').trim(),
      geometry: {
        bbox,
        polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
        orientation: Number(geometry?.orientation) || 0
      },
      confidence: clamp01(confidence),
      provenance: provenance || { stage: 'text-grouping' },
      features: features || {}
    };
  }
  function createSurfaceCandidate({ id, geometry, confidence, provenance, surfaceType, features, supportingRegionIds } = {}){
    const bbox = ensureBBox(geometry?.bbox || geometry);
    return {
      id,
      nodeType: 'surface_candidate',
      geometry: {
        bbox,
        polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
        orientation: Number(geometry?.orientation) || 0
      },
      confidence: clamp01(confidence),
      provenance: provenance || { stage: 'surface-candidates' },
      surfaceType: surfaceType || 'unknown',
      features: features || {},
      supportingRegionIds: Array.isArray(supportingRegionIds) ? supportingRegionIds : []
    };
  }
  function createUploadedImageAnalysis({ analysisId, imageRef, viewport, regionNodes, regionGraph, textTokens, textLines, textBlocks, textGraph, surfaceCandidates, debugArtifacts, version } = {}){
    return {
      schema: 'wrokitvision/uploaded-image-analysis/v1',
      version: Number(version) || 1,
      analysisId: analysisId || null,
      generatedAt: Date.now(),
      imageRef: imageRef || null,
      viewport: viewport || null,
      regionNodes: Array.isArray(regionNodes) ? regionNodes : [],
      regionGraph: regionGraph || { nodes: [], edges: [] },
      textTokens: Array.isArray(textTokens) ? textTokens : [],
      textLines: Array.isArray(textLines) ? textLines : [],
      textBlocks: Array.isArray(textBlocks) ? textBlocks : [],
      textGraph: textGraph || { nodes: [], edges: [] },
      surfaceCandidates: Array.isArray(surfaceCandidates) ? surfaceCandidates : [],
      debugArtifacts: debugArtifacts || {}
    };
  }

  // ── ingest-ocr-tokens.js ───────────────────────────────────────────────────
  function normalizeText(text){
    return String(text || '').replace(/\s+/g, ' ').trim();
  }
  function ingestOcrTokens(tokens, { idFactory, page = 1 } = {}){
    return (Array.isArray(tokens) ? tokens : [])
      .filter(tok => tok && String(tok.text || '').trim())
      .map(tok => {
        const bbox = ensureBBox(tok);
        return createTextTokenNode({
          id: idFactory('txt_tok'),
          geometry: { bbox, contour: rectContourFromBbox(bbox), hull: rectContourFromBbox(bbox), rotatedRect: rotatedRectFromBbox(bbox) },
          confidence: Number(tok.confidence ?? tok.ocrConfidence ?? 0.75),
          provenance: { stage: 'text-detection', detector: 'ocr-ingest', page, sourceTokenId: tok.id || null },
          text: tok.text,
          normalizedText: normalizeText(tok.text),
          ocr: { alternatives: Array.isArray(tok.alternatives) ? tok.alternatives : [], language: tok.language || null },
          features: { charCount: normalizeText(tok.text).length, aspectRatio: bbox.h ? bbox.w / bbox.h : 0 }
        });
      });
  }

  // ── group-text-lines.js ────────────────────────────────────────────────────
  function unionBbox(items){
    if(!items.length) return ensureBBox({});
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for(const item of items){
      const b = ensureBBox(item.geometry?.bbox || item);
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }
  function groupTextLines(textTokens, { idFactory } = {}){
    const sorted = (Array.isArray(textTokens) ? textTokens : []).slice().sort((a, b) => {
      const ay = a.geometry?.bbox?.y || 0;
      const by = b.geometry?.bbox?.y || 0;
      if(Math.abs(ay - by) > 6) return ay - by;
      return (a.geometry?.bbox?.x || 0) - (b.geometry?.bbox?.x || 0);
    });
    const lines = [];
    for(const token of sorted){
      const box = token.geometry?.bbox || {};
      const cy = box.y + (box.h / 2);
      const line = lines.find(c => Math.abs(cy - c.cy) <= Math.max(6, box.h * 0.7));
      if(line){ line.tokens.push(token); line.cy = (line.cy + cy) / 2; }
      else { lines.push({ cy, tokens: [token] }); }
    }
    return lines.map(({ tokens }) => {
      const tokenIds = tokens.map(tok => tok.id);
      const text = tokens.slice().sort((a, b) => (a.geometry?.bbox?.x || 0) - (b.geometry?.bbox?.x || 0)).map(tok => tok.text).join(' ').replace(/\s+/g, ' ').trim();
      const lineNode = createTextLineNode({
        id: idFactory('txt_line'),
        geometry: { bbox: unionBbox(tokens) },
        confidence: tokens.reduce((sum, tok) => sum + (Number(tok.confidence) || 0), 0) / Math.max(1, tokens.length),
        provenance: { stage: 'text-grouping', detector: 'line-band-grouping' },
        tokenIds,
        text,
        normalizedText: text.toLowerCase(),
        features: { tokenCount: tokenIds.length }
      });
      for(const tok of tokens){ tok.parentLineId = lineNode.id; }
      return lineNode;
    });
  }

  // ── group-text-blocks.js ───────────────────────────────────────────────────
  function groupTextBlocks(textLines, textTokens, { idFactory } = {}){
    const sorted = (Array.isArray(textLines) ? textLines : []).slice().sort((a, b) => (a.geometry?.bbox?.y || 0) - (b.geometry?.bbox?.y || 0));
    const blocks = [];
    for(const line of sorted){
      const box = line.geometry?.bbox || {};
      const candidate = blocks.find(block => {
        const b = block.bbox;
        const verticalGap = Math.max(0, box.y - (b.y + b.h));
        const overlapX = Math.max(0, Math.min(box.x + box.w, b.x + b.w) - Math.max(box.x, b.x));
        return verticalGap <= Math.max(14, box.h * 1.25) && overlapX >= Math.min(box.w, b.w) * 0.25;
      });
      if(candidate){ candidate.lines.push(line); candidate.bbox = unionBbox(candidate.lines.map(l => l.geometry.bbox)); }
      else { blocks.push({ lines: [line], bbox: line.geometry?.bbox || {} }); }
    }
    return blocks.map(({ lines }) => {
      const lineIds = lines.map(l => l.id);
      const tokenIds = lines.flatMap(l => l.tokenIds || []);
      const text = lines.map(l => l.text).join('\n').trim();
      const block = createTextBlockNode({
        id: idFactory('txt_block'),
        geometry: { bbox: unionBbox(lines.map(l => l.geometry?.bbox || {})) },
        confidence: lines.reduce((sum, l) => sum + (Number(l.confidence) || 0), 0) / Math.max(1, lines.length),
        provenance: { stage: 'text-grouping', detector: 'block-stacking' },
        lineIds,
        tokenIds,
        text,
        normalizedText: text.toLowerCase(),
        features: { lineCount: lineIds.length, tokenCount: tokenIds.length }
      });
      for(const line of lines){ line.parentBlockId = block.id; }
      for(const token of (Array.isArray(textTokens) ? textTokens : [])){
        if(token.parentLineId && lineIds.includes(token.parentLineId)){ token.parentBlockId = block.id; }
      }
      return block;
    });
  }

  // ── geometry helpers (from detect-region-proposals.js) ─────────────────────
  function rectContourFromBbox(bbox){
    bbox = bbox || {};
    const x = Number(bbox.x) || 0;
    const y = Number(bbox.y) || 0;
    const w = Math.max(0, Number(bbox.w) || 0);
    const h = Math.max(0, Number(bbox.h) || 0);
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
  function rotatedRectFromBbox(bbox){
    bbox = bbox || {};
    const x = Number(bbox.x) || 0;
    const y = Number(bbox.y) || 0;
    const w = Math.max(0, Number(bbox.w) || 0);
    const h = Math.max(0, Number(bbox.h) || 0);
    return { center: { x: x + (w / 2), y: y + (h / 2) }, size: { w, h }, angleDeg: 0 };
  }
  function crossProduct(o, a, b){
    return ((a.x - o.x) * (b.y - o.y)) - ((a.y - o.y) * (b.x - o.x));
  }
  function convexHull(points){
    if(!Array.isArray(points) || points.length < 3) return points || [];
    const unique = [];
    const seen = new Set();
    for(const p of points){
      if(!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const key = `${Math.round(p.x * 10)}:${Math.round(p.y * 10)}`;
      if(seen.has(key)) continue;
      seen.add(key);
      unique.push({ x: p.x, y: p.y });
    }
    if(unique.length < 3) return unique;
    unique.sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const lower = [];
    for(const p of unique){
      while(lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for(let i = unique.length - 1; i >= 0; i--){
      const p = unique[i];
      while(upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  // ── atomic-visual-segmentation.js (inlined) ──────────────────────────────
  function clampInt(value, min, max){ return Math.max(min, Math.min(max, value)); }

  function resolveRgbChannels(imageData, expectedLength){
    if(!imageData || expectedLength <= 0) return null;
    const r = imageData.r;
    const g = imageData.g;
    const b = imageData.b;
    if(r?.length === expectedLength && g?.length === expectedLength && b?.length === expectedLength) return { r, g, b };
    const rgba = imageData.rgba || imageData.data;
    if(!rgba || rgba.length < expectedLength * 4) return null;
    const rr = new Uint8Array(expectedLength);
    const gg = new Uint8Array(expectedLength);
    const bb = new Uint8Array(expectedLength);
    for(let i = 0, j = 0; i < expectedLength; i++, j += 4){
      rr[i] = rgba[j] || 0;
      gg[i] = rgba[j + 1] || 0;
      bb[i] = rgba[j + 2] || 0;
    }
    return { r: rr, g: gg, b: bb };
  }

  function sobelStrength(gray, width, height){
    const out = new Uint16Array(width * height);
    for(let y = 1; y < height - 1; y++){
      for(let x = 1; x < width - 1; x++){
        const i = y * width + x;
        const gx = -gray[i-width-1] - 2 * gray[i-1] - gray[i+width-1]
                 + gray[i-width+1] + 2 * gray[i+1] + gray[i+width+1];
        const gy = -gray[i-width-1] - 2 * gray[i-width] - gray[i-width+1]
                 + gray[i+width-1] + 2 * gray[i+width] + gray[i+width+1];
        out[i] = Math.min(1020, Math.round(Math.sqrt((gx * gx) + (gy * gy))));
      }
    }
    return out;
  }

  function localVariance(gray, width, height){
    const variance = new Uint16Array(width * height);
    for(let y = 1; y < height - 1; y++){
      for(let x = 1; x < width - 1; x++){
        const i = y * width + x;
        let sum = 0;
        let sumSq = 0;
        for(let oy = -1; oy <= 1; oy++){
          for(let ox = -1; ox <= 1; ox++){
            const v = gray[(y + oy) * width + (x + ox)];
            sum += v;
            sumSq += v * v;
          }
        }
        const mean = sum / 9;
        const varVal = (sumSq / 9) - (mean * mean);
        variance[i] = clampInt(Math.round(Math.sqrt(Math.max(0, varVal)) * 4), 0, 255);
      }
    }
    return variance;
  }

  function colorGradient(rgb, width, height){
    if(!rgb) return null;
    const out = new Uint16Array(width * height);
    for(let y = 1; y < height - 1; y++){
      for(let x = 1; x < width - 1; x++){
        const i = y * width + x;
        var maxGrad = 0;
        var channels = [rgb.r, rgb.g, rgb.b];
        for(var ci = 0; ci < channels.length; ci++){
          var ch = channels[ci];
          var gx = -ch[i-width-1] - 2*ch[i-1] - ch[i+width-1]
                   + ch[i-width+1] + 2*ch[i+1] + ch[i+width+1];
          var gy = -ch[i-width-1] - 2*ch[i-width] - ch[i-width+1]
                   + ch[i+width-1] + 2*ch[i+width] + ch[i+width+1];
          var grad = Math.sqrt((gx * gx) + (gy * gy));
          if(grad > maxGrad) maxGrad = grad;
        }
        out[i] = Math.min(1020, Math.round(maxGrad));
      }
    }
    return out;
  }

  function buildBoundaryEvidence({ gray, rgb, width, height }){
    const edge = sobelStrength(gray, width, height);
    const variance = localVariance(gray, width, height);
    const color = colorGradient(rgb, width, height);
    const evidence = new Uint8Array(width * height);
    for(let i = 0; i < evidence.length; i++){
      const edgeNorm = edge[i] / 1020;
      const colorNorm = color ? color[i] / 1020 : 0;
      const varNorm = variance[i] / 255;
      evidence[i] = clampInt(Math.round((edgeNorm * 0.44 + colorNorm * 0.42 + varNorm * 0.14) * 255), 0, 255);
    }
    return evidence;
  }

  function chooseAtomicSeeds(boundaryEvidence, width, height){
    const seeds = [];
    const stride = clampInt(Math.round(Math.sqrt((width * height) / 3200)), 4, 9);
    for(let sy = 0; sy < height; sy += stride){
      for(let sx = 0; sx < width; sx += stride){
        let bestIdx = (sy * width) + sx;
        let bestScore = 999;
        const yMax = Math.min(height, sy + stride);
        const xMax = Math.min(width, sx + stride);
        for(let y = sy; y < yMax; y++){
          for(let x = sx; x < xMax; x++){
            const idx = (y * width) + x;
            const score = boundaryEvidence[idx];
            if(score < bestScore){ bestScore = score; bestIdx = idx; }
          }
        }
        seeds.push(bestIdx);
      }
    }
    return Array.from(new Set(seeds));
  }

  function buildAtomicRegions({ gray, rgb, width, height }){
    const boundaryEvidence = buildBoundaryEvidence({ gray, rgb, width, height });
    const labels = new Int32Array(width * height);
    labels.fill(-1);
    const seeds = chooseAtomicSeeds(boundaryEvidence, width, height);
    const buckets = Array.from({ length: 256 }, () => []);
    for(let regionId = 0; regionId < seeds.length; regionId++){
      const idx = seeds[regionId];
      labels[idx] = regionId;
      buckets[boundaryEvidence[idx]].push(idx);
    }
    const hardBarrier = 155;
    for(let score = 0; score < buckets.length; score++){
      const queue = buckets[score];
      for(let qi = 0; qi < queue.length; qi++){
        const idx = queue[qi];
        const rid = labels[idx];
        if(rid < 0) continue;
        const x = idx % width;
        const y = (idx / width) | 0;
        const nbrs = [idx - 1, idx + 1, idx - width, idx + width];
        for(const ni of nbrs){
          const nx = ni % width;
          const ny = (ni / width) | 0;
          if(nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          if(Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
          if(labels[ni] !== -1) continue;
          const link = Math.max(boundaryEvidence[idx], boundaryEvidence[ni]);
          if(link >= hardBarrier) continue;
          labels[ni] = rid;
          buckets[link].push(ni);
        }
      }
    }
    for(let i = 0; i < labels.length; i++){
      if(labels[i] !== -1) continue;
      const x = i % width;
      const y = (i / width) | 0;
      const nbrs = [i - 1, i + 1, i - width, i + width];
      let assigned = -1;
      for(const ni of nbrs){
        const nx = ni % width;
        const ny = (ni / width) | 0;
        if(nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if(Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        if(labels[ni] >= 0){ assigned = labels[ni]; break; }
      }
      labels[i] = assigned >= 0 ? assigned : 0;
    }
    const regions = [];
    for(let i = 0; i < seeds.length; i++){
      regions.push({ id: i, area: 0, sumGray: 0, sumR: 0, sumG: 0, sumB: 0, x0: width, y0: height, x1: 0, y1: 0 });
    }
    for(let i = 0; i < labels.length; i++){
      const rid = labels[i];
      const x = i % width;
      const y = (i / width) | 0;
      const r = regions[rid];
      r.area += 1;
      r.sumGray += gray[i];
      r.sumR += rgb ? rgb.r[i] : gray[i];
      r.sumG += rgb ? rgb.g[i] : gray[i];
      r.sumB += rgb ? rgb.b[i] : gray[i];
      if(x < r.x0) r.x0 = x;
      if(y < r.y0) r.y0 = y;
      if(x > r.x1) r.x1 = x;
      if(y > r.y1) r.y1 = y;
    }
    return { labels, regions, boundaryEvidence };
  }

  function mergeAtomicRegions({ labels, regions, boundaryEvidence, width, height }){
    const adjacency = new Map();
    const keyOf = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    for(let y = 0; y < height; y++){
      for(let x = 0; x < width; x++){
        const idx = y * width + x;
        const a = labels[idx];
        if(x + 1 < width){
          const b = labels[idx + 1];
          if(a !== b){
            const k = keyOf(a, b);
            const rec = adjacency.get(k) || { a: Math.min(a,b), b: Math.max(a,b), border: 0, edge: 0 };
            rec.border += 1;
            rec.edge += Math.max(boundaryEvidence[idx], boundaryEvidence[idx + 1]);
            adjacency.set(k, rec);
          }
        }
        if(y + 1 < height){
          const b = labels[idx + width];
          if(a !== b){
            const k = keyOf(a, b);
            const rec = adjacency.get(k) || { a: Math.min(a,b), b: Math.max(a,b), border: 0, edge: 0 };
            rec.border += 1;
            rec.edge += Math.max(boundaryEvidence[idx], boundaryEvidence[idx + width]);
            adjacency.set(k, rec);
          }
        }
      }
    }
    const parent = Int32Array.from({ length: regions.length }, (_, i) => i);
    const find = (x) => { while(parent[x] !== x){ parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if(ra !== rb) parent[rb] = ra; };
    for(const rec of adjacency.values()){
      const ra = regions[rec.a];
      const rb = regions[rec.b];
      if(!ra || !rb || !ra.area || !rb.area) continue;
      const edgeMean = rec.edge / Math.max(1, rec.border);
      const grayDelta = Math.abs((ra.sumGray / ra.area) - (rb.sumGray / rb.area));
      const colorDelta = Math.hypot(
        (ra.sumR / ra.area) - (rb.sumR / rb.area),
        (ra.sumG / ra.area) - (rb.sumG / rb.area),
        (ra.sumB / ra.area) - (rb.sumB / rb.area)
      );
      const mergeScore = (edgeMean * 0.25) + (grayDelta * 0.15) + (colorDelta * 0.60);
      if(mergeScore <= 28) union(rec.a, rec.b);
    }
    const merged = new Map();
    for(let rid = 0; rid < regions.length; rid++){
      const region = regions[rid];
      if(!region.area) continue;
      const root = find(rid);
      const agg = merged.get(root) || { area: 0, x0: width, y0: height, x1: 0, y1: 0, atomicCount: 0, rootIds: [] };
      agg.area += region.area;
      agg.atomicCount += 1;
      agg.rootIds.push(rid);
      if(region.x0 < agg.x0) agg.x0 = region.x0;
      if(region.y0 < agg.y0) agg.y0 = region.y0;
      if(region.x1 > agg.x1) agg.x1 = region.x1;
      if(region.y1 > agg.y1) agg.y1 = region.y1;
      merged.set(root, agg);
    }
    return { mergedRegions: Array.from(merged.values()), parent, find };
  }

  function extractRegionContour(labels, mergedRootIds, width, height, sx, sy){
    const idSet = new Set(mergedRootIds);
    const borderPixels = [];
    const x0 = Math.max(0, Math.floor(mergedRootIds._x0 || 0));
    const y0 = Math.max(0, Math.floor(mergedRootIds._y0 || 0));
    const x1 = Math.min(width - 1, Math.ceil(mergedRootIds._x1 || width - 1));
    const y1 = Math.min(height - 1, Math.ceil(mergedRootIds._y1 || height - 1));
    for(let y = y0; y <= y1; y++){
      for(let x = x0; x <= x1; x++){
        const idx = y * width + x;
        if(!idSet.has(labels[idx])) continue;
        let isBorder = false;
        if(x === 0 || x === width - 1 || y === 0 || y === height - 1){ isBorder = true; }
        else {
          const nbrs = [idx - 1, idx + 1, idx - width, idx + width];
          for(const ni of nbrs){ if(!idSet.has(labels[ni])){ isBorder = true; break; } }
        }
        if(isBorder) borderPixels.push({ x: x * sx, y: y * sy });
      }
    }
    if(borderPixels.length < 3) return null;
    let cx = 0, cy = 0;
    for(const p of borderPixels){ cx += p.x; cy += p.y; }
    cx /= borderPixels.length; cy /= borderPixels.length;
    const NUM_BINS = 36;
    const bins = new Array(NUM_BINS).fill(null);
    for(const p of borderPixels){
      const angle = Math.atan2(p.y - cy, p.x - cx);
      const bin = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * NUM_BINS) % NUM_BINS;
      const dist = Math.hypot(p.x - cx, p.y - cy);
      if(!bins[bin] || dist > bins[bin].dist) bins[bin] = { x: p.x, y: p.y, dist };
    }
    const contour = bins.filter(Boolean).map(b => ({ x: b.x, y: b.y }));
    return contour.length >= 3 ? contour : null;
  }

  function orientedRectFromContour(contour, fallbackBbox){
    if(!Array.isArray(contour) || contour.length < 3) return rotatedRectFromBbox(fallbackBbox);
    let mx = 0, my = 0;
    for(const p of contour){ mx += p.x; my += p.y; }
    mx /= contour.length; my /= contour.length;
    let xx = 0, yy = 0, xy = 0;
    for(const p of contour){
      const dx = p.x - mx; const dy = p.y - my;
      xx += dx * dx; yy += dy * dy; xy += dx * dy;
    }
    xx /= contour.length; yy /= contour.length; xy /= contour.length;
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    const cosA = Math.cos(angle); const sinA = Math.sin(angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for(const p of contour){
      const dx = p.x - mx; const dy = p.y - my;
      const u = (dx * cosA) + (dy * sinA); const v = (-dx * sinA) + (dy * cosA);
      if(u < minU) minU = u; if(u > maxU) maxU = u;
      if(v < minV) minV = v; if(v > maxV) maxV = v;
    }
    return { center: { x: mx, y: my }, size: { w: Math.max(1, maxU - minU), h: Math.max(1, maxV - minV) }, angleDeg: angle * (180 / Math.PI) };
  }

  function buildAtomicVisualSegments({ imageData }){
    if(!imageData?.gray || !imageData.width || !imageData.height) return null;
    const width = Number(imageData.width) || 0;
    const height = Number(imageData.height) || 0;
    if(width <= 2 || height <= 2) return null;
    const gray = imageData.gray;
    const rgb = resolveRgbChannels(imageData, gray.length);
    const atomic = buildAtomicRegions({ gray, rgb, width, height });
    const mergeResult = mergeAtomicRegions({ ...atomic, width, height });
    return {
      width, height,
      atomicCount: atomic.regions.length,
      mergedRegions: mergeResult.mergedRegions,
      labels: atomic.labels,
      parent: mergeResult.parent,
      find: mergeResult.find
    };
  }

  // ── detect-region-proposals.js ────────────────────────────────────────────
  function detectConnectedVisualProposals({ imageData, viewport, idFactory }){
    if(!imageData?.gray || !imageData.width || !imageData.height || !viewport?.width || !viewport?.height) return [];
    const width = Number(imageData.width) || 0;
    const height = Number(imageData.height) || 0;
    if(width <= 2 || height <= 2) return [];
    const minArea = Math.max(100, Math.floor((width * height) * 0.0012));
    const maxArea = Math.floor((width * height) * 0.75);
    const sx = viewport.width / width;
    const sy = viewport.height / height;
    const proposals = [];
    const segmented = buildAtomicVisualSegments({ imageData });
    if(!segmented) return proposals;
    for(const merged of segmented.mergedRegions){
      const area = merged.area;
      if(area < minArea || area > maxArea) continue;
      const bw = merged.x1 - merged.x0 + 1;
      const bh = merged.y1 - merged.y0 + 1;
      if(bw < 10 || bh < 10) continue;
      const bbox = { x: merged.x0 * sx, y: merged.y0 * sy, w: bw * sx, h: bh * sy };

      // Extract real contour from the label map when available
      let contour = null;
      if(segmented.labels && merged.rootIds && segmented.find){
        const mergedIdSet = new Set();
        for(const rid of merged.rootIds) mergedIdSet.add(segmented.find(rid));
        mergedIdSet._x0 = merged.x0; mergedIdSet._y0 = merged.y0;
        mergedIdSet._x1 = merged.x1; mergedIdSet._y1 = merged.y1;
        contour = extractRegionContour(segmented.labels, mergedIdSet, width, height, sx, sy);
      }
      const fallbackContour = rectContourFromBbox(bbox);
      const resolvedContour = (contour && contour.length >= 3) ? contour : fallbackContour;
      const hull = convexHull(resolvedContour);
      const rotatedRect = (contour && contour.length >= 3) ? orientedRectFromContour(contour, bbox) : rotatedRectFromBbox(bbox);

      proposals.push(createStructuralRegionNode({
        id: idFactory('region'),
        geometry: { bbox, contour: resolvedContour, hull: hull.length >= 3 ? hull : fallbackContour, rotatedRect },
        confidence: 0.62,
        provenance: { stage: 'region-proposals', detector: 'atomic-region-merge', sourceType: 'visual' },
        features: {
          source: 'visual-atomic-region-merge',
          pixelArea: area,
          atomicRegionCount: merged.atomicCount,
          atomicSeedCount: segmented.atomicCount,
          boundaryFirst: true,
          hasRealContour: !!(contour && contour.length >= 3)
        },
        surfaceTypeCandidate: 'visual_component',
        textDensity: 0
      }));
    }
    return proposals;
  }
  function detectRegionProposals({ textLines = [], viewport, idFactory, imageData = null } = {}){
    const regions = [];
    for(const line of textLines){
      const box = ensureBBox(line.geometry?.bbox || {});
      const padX = Math.max(4, box.h * 0.5);
      const padY = Math.max(2, box.h * 0.25);
      regions.push(createStructuralRegionNode({
        id: idFactory('region'),
        geometry: { bbox: { x: box.x - padX, y: box.y - padY, w: box.w + (padX * 2), h: box.h + (padY * 2) }, contour: rectContourFromBbox({ x: box.x - padX, y: box.y - padY, w: box.w + (padX * 2), h: box.h + (padY * 2) }), hull: rectContourFromBbox({ x: box.x - padX, y: box.y - padY, w: box.w + (padX * 2), h: box.h + (padY * 2) }), rotatedRect: rotatedRectFromBbox({ x: box.x - padX, y: box.y - padY, w: box.w + (padX * 2), h: box.h + (padY * 2) }) },
        confidence: line.confidence,
        provenance: { stage: 'region-proposals', detector: 'line-envelope', sourceType: 'ocr', sourceLineId: line.id },
        features: { sourceLineId: line.id, sourceTokenCount: line.tokenIds?.length || 0 },
        surfaceTypeCandidate: 'text_strip',
        textDensity: 1
      }));
    }
    if(textLines.length){
      const pageTextBounds = unionBbox(textLines.map(l => l.geometry?.bbox || {}));
      regions.push(createStructuralRegionNode({
        id: idFactory('region'),
        geometry: { bbox: pageTextBounds, contour: rectContourFromBbox(pageTextBounds), hull: rectContourFromBbox(pageTextBounds), rotatedRect: rotatedRectFromBbox(pageTextBounds) },
        confidence: 0.65,
        provenance: { stage: 'region-proposals', detector: 'text-hull', sourceType: 'ocr' },
        features: { aggregatedLineCount: textLines.length },
        surfaceTypeCandidate: 'text_cluster',
        textDensity: 0.85
      }));
    }
    regions.push(...detectConnectedVisualProposals({ imageData, viewport, idFactory }));
    if(viewport?.width && viewport?.height){
      regions.push(createStructuralRegionNode({
        id: idFactory('region'),
        geometry: { bbox: { x: 0, y: 0, w: viewport.width, h: viewport.height }, contour: rectContourFromBbox({ x: 0, y: 0, w: viewport.width, h: viewport.height }), hull: rectContourFromBbox({ x: 0, y: 0, w: viewport.width, h: viewport.height }), rotatedRect: rotatedRectFromBbox({ x: 0, y: 0, w: viewport.width, h: viewport.height }) },
        confidence: 0.45,
        provenance: { stage: 'region-proposals', detector: 'page-frame', sourceType: 'layout' },
        features: { viewportArea: viewport.width * viewport.height },
        surfaceTypeCandidate: 'page_surface',
        textDensity: textLines.length ? 0.3 : 0
      }));
    }
    return regions;
  }

  // ── compute-region-features.js ────────────────────────────────────────────
  function overlapRatio(a, b){
    const ax1 = a.x + a.w; const ay1 = a.y + a.h;
    const bx1 = b.x + b.w; const by1 = b.y + b.h;
    const ox = Math.max(0, Math.min(ax1, bx1) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(ay1, by1) - Math.max(a.y, b.y));
    return (ox * oy) / Math.max(1, a.w * a.h);
  }
  function computeRegionFeatures(regionNodes, textTokens){
    return (Array.isArray(regionNodes) ? regionNodes : []).map(region => {
      const box = ensureBBox(region.geometry?.bbox || {});
      const inside = (Array.isArray(textTokens) ? textTokens : []).filter(tok => overlapRatio(box, ensureBBox(tok.geometry?.bbox || {})) >= 0.2);
      const edgeDensityProxy = Math.min(1, inside.length / Math.max(1, (box.w * box.h) / 4000));
      const textDensity = Math.min(1, inside.length / Math.max(1, (box.w * box.h) / 2500));
      return {
        ...region,
        textDensity,
        features: {
          ...region.features,
          area: box.w * box.h,
          tokenCount: inside.length,
          averageTokenConfidence: inside.reduce((s, tok) => s + (Number(tok.confidence) || 0), 0) / Math.max(1, inside.length),
          edgeDensityProxy,
          textureProxy: Math.max(0, 1 - Math.abs((box.w / Math.max(1, box.h)) - 1) * 0.2)
        }
      };
    });
  }

  // ── build-region-graph.js ─────────────────────────────────────────────────
  function boxDistance(a, b){
    return Math.hypot((a.x + a.w / 2) - (b.x + b.w / 2), (a.y + a.h / 2) - (b.y + b.h / 2));
  }
  function contains(a, b){
    return a.x <= b.x && a.y <= b.y && (a.x + a.w) >= (b.x + b.w) && (a.y + a.h) >= (b.y + b.h);
  }
  function buildRegionGraph(regionNodes, { idFactory } = {}){
    const edges = [];
    const nodes = Array.isArray(regionNodes) ? regionNodes : [];
    for(let i = 0; i < nodes.length; i++){
      for(let j = i + 1; j < nodes.length; j++){
        const a = nodes[i]; const b = nodes[j];
        const boxA = ensureBBox(a.geometry?.bbox || {}); const boxB = ensureBBox(b.geometry?.bbox || {});
        const proximity = Math.max(0, 1 - (boxDistance(boxA, boxB) / 800));
        if(proximity > 0.1){
          edges.push(createGraphEdge({ edgeId: idFactory('edge_region'), sourceNodeId: a.id, targetNodeId: b.id, edgeType: 'spatial_proximity', weight: proximity, rationale: createScoreBreakdown({ total: proximity, components: [{ key: 'distance', value: proximity }] }), provenance: { stage: 'region-graph' } }));
        }
        if(contains(boxA, boxB) || contains(boxB, boxA)){
          edges.push(createGraphEdge({ edgeId: idFactory('edge_region'), sourceNodeId: contains(boxA, boxB) ? a.id : b.id, targetNodeId: contains(boxA, boxB) ? b.id : a.id, edgeType: 'contains', weight: 0.95, rationale: createScoreBreakdown({ total: 0.95, notes: ['region containment relationship'] }), provenance: { stage: 'region-graph' } }));
        }
      }
    }
    return { nodes, edges };
  }

  // ── build-text-graph.js ───────────────────────────────────────────────────
  function boxCenter(box){ return { x: box.x + (box.w / 2), y: box.y + (box.h / 2) }; }
  function buildTextGraph({ textTokens = [], textLines = [], textBlocks = [], idFactory } = {}){
    const edges = [];
    for(const token of textTokens){
      if(token.parentLineId){ edges.push(createGraphEdge({ edgeId: idFactory('edge_text'), sourceNodeId: token.id, targetNodeId: token.parentLineId, edgeType: 'token_to_line', weight: 1, rationale: createScoreBreakdown({ total: 1 }), provenance: { stage: 'text-graph' } })); }
    }
    for(const line of textLines){
      if(line.parentBlockId){ edges.push(createGraphEdge({ edgeId: idFactory('edge_text'), sourceNodeId: line.id, targetNodeId: line.parentBlockId, edgeType: 'line_to_block', weight: 1, rationale: createScoreBreakdown({ total: 1 }), provenance: { stage: 'text-graph' } })); }
    }
    for(let i = 0; i < textLines.length; i++){
      for(let j = i + 1; j < textLines.length; j++){
        const a = textLines[i]; const b = textLines[j];
        const ca = boxCenter(ensureBBox(a.geometry?.bbox || {})); const cb = boxCenter(ensureBBox(b.geometry?.bbox || {}));
        const dy = Math.abs(ca.y - cb.y); const dx = Math.abs(ca.x - cb.x);
        if(dy < 20 && dx < 400){
          const w = Math.max(0, 1 - (dx / 400));
          edges.push(createGraphEdge({ edgeId: idFactory('edge_text'), sourceNodeId: a.id, targetNodeId: b.id, edgeType: 'line_horizontal_neighbor', weight: w, rationale: createScoreBreakdown({ total: w, components: [{ key: 'dx', value: dx }] }), provenance: { stage: 'text-graph' } }));
        }
      }
    }
    return { nodes: [...textTokens, ...textLines, ...textBlocks], edges };
  }

  // ── detect-surface-candidates.js ──────────────────────────────────────────
  function detectSurfaceCandidates(regionNodes, { idFactory } = {}){
    return (Array.isArray(regionNodes) ? regionNodes : [])
      .map(region => {
        const box = ensureBBox(region.geometry?.bbox || {});
        const area = box.w * box.h;
        const isLarge = area > 40000;
        const textDensity = Number(region.textDensity) || 0;
        const isPanel = isLarge && textDensity < 0.35;
        const surfaceType = textDensity > 0.55 ? 'text_dense_surface' : 'region_surface';
        const confidence = Math.max(0.25, Math.min(0.95, (Number(region.confidence) || 0.5) * 0.8 + (isLarge ? 0.15 : 0)));
        return createSurfaceCandidate({ id: idFactory('surface'), geometry: { bbox: box }, confidence, provenance: { stage: 'surface-candidates', detector: 'region-surface-heuristic', sourceRegionId: region.id }, surfaceType, features: { regionArea: area, textDensity, panelLike: isPanel }, supportingRegionIds: [region.id] });
      })
      .filter(c => c.features.regionArea > 2000);
  }

  // ── upload-analysis-pipeline.js ───────────────────────────────────────────
  function createIdFactory(seed){
    let index = 0;
    return function next(prefix){ index += 1; return `${seed}_${prefix}_${index}`; };
  }
  function runUploadAnalysis({ tokens = [], viewport = null, page = 1, imageRef = null, analysisId = null, imageData = null } = {}){
    const resolvedViewport = viewport ? { width: Number(viewport.width || viewport.w || 0), height: Number(viewport.height || viewport.h || 0) } : null;
    const idFactory = createIdFactory(analysisId || `p${page}`);
    const textTokens = ingestOcrTokens(tokens, { idFactory, page });
    const textLines = groupTextLines(textTokens, { idFactory });
    const textBlocks = groupTextBlocks(textLines, textTokens, { idFactory });
    const proposalRegions = detectRegionProposals({ textLines, viewport: resolvedViewport, idFactory, imageData });
    const regionNodes = computeRegionFeatures(proposalRegions, textTokens);
    const regionGraph = buildRegionGraph(regionNodes, { idFactory });
    const textGraph = buildTextGraph({ textTokens, textLines, textBlocks, idFactory });
    const surfaceCandidates = detectSurfaceCandidates(regionNodes, { idFactory });
    return createUploadedImageAnalysis({
      analysisId: analysisId || `uploaded_${page}_${Date.now()}`,
      imageRef,
      viewport: resolvedViewport,
      regionNodes,
      regionGraph,
      textTokens,
      textLines,
      textBlocks,
      textGraph,
      surfaceCandidates,
      debugArtifacts: {},
      version: 1
    });
  }

  // ── precompute-orchestrator.js ────────────────────────────────────────────
  function buildPrecomputedStructuralMap({ tokens = [], viewport = null, page = 1, geometryId = null, imageData = null } = {}){
    const uploadedImageAnalysis = runUploadAnalysis({
      tokens,
      viewport,
      page,
      imageRef: geometryId ? { geometryId, page } : { page },
      analysisId: geometryId ? `${geometryId}_p${page}` : `p${page}`,
      imageData
    });
    return {
      schema: 'wrokitvision/precomputed-structural-map/v1',
      version: 1,
      generatedAt: uploadedImageAnalysis.generatedAt,
      geometryId: geometryId || null,
      page,
      uploadedImageAnalysis
    };
  }

  // ── expose global ──────────────────────────────────────────────────────────
  root.WrokitVisionPrecompute = { buildPrecomputedStructuralMap };

})(typeof self !== 'undefined' ? self : this);
