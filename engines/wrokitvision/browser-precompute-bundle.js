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

  // ── detect-region-proposals.js ────────────────────────────────────────────
  function detectConnectedVisualProposals({ imageData, viewport, idFactory }){
    if(!imageData?.gray || !imageData.width || !imageData.height || !viewport?.width || !viewport?.height) return [];
    const width = Number(imageData.width) || 0;
    const height = Number(imageData.height) || 0;
    if(width <= 2 || height <= 2) return [];
    const gray = imageData.gray;
    let sum = 0;
    for(let i = 0; i < gray.length; i++) sum += gray[i];
    const mean = sum / Math.max(1, gray.length);
    const threshold = Math.max(22, Math.min(220, Math.round(mean * 0.82)));
    const mask = new Uint8Array(width * height);
    for(let i = 0; i < gray.length; i++){ mask[i] = gray[i] <= threshold ? 1 : 0; }
    const visited = new Uint8Array(width * height);
    const minArea = Math.max(100, Math.floor((width * height) * 0.0012));
    const maxArea = Math.floor((width * height) * 0.75);
    const sx = viewport.width / width;
    const sy = viewport.height / height;
    const proposals = [];
    for(let y = 0; y < height; y++){
      for(let x = 0; x < width; x++){
        const start = y * width + x;
        if(mask[start] !== 1 || visited[start]) continue;
        const q = [start];
        visited[start] = 1;
        let head = 0;
        let area = 0;
        let x0 = x, y0 = y, x1 = x, y1 = y;
        while(head < q.length){
          const idx = q[head++];
          const cx = idx % width;
          const cy = (idx / width) | 0;
          area += 1;
          if(cx < x0) x0 = cx; if(cy < y0) y0 = cy; if(cx > x1) x1 = cx; if(cy > y1) y1 = cy;
          const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
          for(const ni of neighbors){
            if(ni < 0 || ni >= mask.length || visited[ni] || mask[ni] !== 1) continue;
            const nx = ni % width; const ny = (ni / width) | 0;
            if(Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
            visited[ni] = 1; q.push(ni);
          }
        }
        if(area < minArea || area > maxArea) continue;
        const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
        if(bw < 10 || bh < 10) continue;
        proposals.push(createStructuralRegionNode({
          id: idFactory('region'),
          geometry: { bbox: { x: x0 * sx, y: y0 * sy, w: bw * sx, h: bh * sy } },
          confidence: 0.58,
          provenance: { stage: 'region-proposals', detector: 'connected-components-threshold', sourceType: 'visual' },
          features: { source: 'visual-connected-components', pixelArea: area, imageThreshold: threshold },
          surfaceTypeCandidate: 'visual_component',
          textDensity: 0
        }));
      }
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
