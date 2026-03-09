(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WrokitVisionEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const MapTools = (typeof self !== 'undefined' ? self : this).WrokitVisionMaps || null;
  const Precompute = (function(){
    try {
      if(typeof require === 'function'){
        return require('../wrokitvision/precompute/precompute-orchestrator.js');
      }
    } catch(_err){
      return null;
    }
    return (typeof self !== 'undefined' ? self : this).WrokitVisionPrecompute || null;
  })();
  const PrecomputedCompat = (function(){
    try {
      if(typeof require === 'function'){
        return require('../wrokitvision/compat/precomputed-map-adapter.js');
      }
    } catch(_err){
      return null;
    }
    return (typeof self !== 'undefined' ? self : this).WrokitVisionPrecomputedCompat || null;
  })();
  const SelectionAssociation = (function(){
    try {
      if(typeof require === 'function'){
        return require('../wrokitvision/selection/selection-association');
      }
    } catch(_err){
      return null;
    }
    return (typeof self !== 'undefined' ? self : this).WrokitVisionFieldPipeline?.SelectionAssociation || null;
  })();
  const LocalRelevance = (function(){
    try {
      if(typeof require === 'function'){
        return require('../wrokitvision/resolution/local-relevance');
      }
    } catch(_err){
      return null;
    }
    return (typeof self !== 'undefined' ? self : this).WrokitVisionFieldPipeline?.LocalRelevance || null;
  })();
  const LocalSubgraph = (function(){
    try {
      if(typeof require === 'function'){
        return require('../wrokitvision/resolution/local-subgraph');
      }
    } catch(_err){
      return null;
    }
    return (typeof self !== 'undefined' ? self : this).WrokitVisionFieldPipeline?.LocalSubgraph || null;
  })();
  const LocalStructure = (function(){
    try {
      if(typeof require === 'function'){
        return require('../wrokitvision/resolution/local-structure');
      }
    } catch(_err){
      return null;
    }
    return (typeof self !== 'undefined' ? self : this).WrokitVisionFieldPipeline?.LocalStructure || null;
  })();
  const LocalFrame = (function(){
    try {
      if(typeof require === 'function'){
        return require('../wrokitvision/geometry/local-frame');
      }
    } catch(_err){
      return null;
    }
    return (typeof self !== 'undefined' ? self : this).WrokitVisionFieldPipeline?.LocalFrame || null;
  })();

  const FieldMatcher = (function(){
    try {
      if(typeof require === 'function'){
        return require('../wrokitvision/matching/field-matcher');
      }
    } catch(_err){
      return null;
    }
    return (typeof self !== 'undefined' ? self : this).WrokitVisionFieldPipeline?.FieldMatcher || null;
  })();
  const FieldSignature = (function(){
    try {
      if(typeof require === 'function'){
        return require('../wrokitvision/signatures/field-signature');
      }
    } catch(_err){
      return null;
    }
    return (typeof self !== 'undefined' ? self : this).WrokitVisionFieldPipeline?.FieldSignature || null;
  })();

  const LABEL_HINTS = {
    store_name: ['vendor','seller','company','store','business'],
    department: ['department','division'],
    invoice_number: ['invoice #','invoice no','invoice number','inv #'],
    invoice_date: ['invoice date','issued','date'],
    salesperson: ['salesperson','sales rep','rep'],
    customer_name: ['sold to','bill to','customer'],
    customer_address: ['address','bill to','sold to'],
    subtotal_amount: ['subtotal'],
    discounts_amount: ['discount'],
    tax_amount: ['tax','hst','gst','vat','pst'],
    invoice_total: ['grand total','amount due','balance due','total']
  };

  const MAGIC_HINT = {
    ANY: 'any',
    TEXT: 'text',
    NUMERIC: 'numeric',
    DATE: 'date'
  };

  function cleanText(text){
    return String(text || '').replace(/\s+/g, ' ').replace(/[#:]+$/g, '').trim();
  }

  function dedupeRepeats(text){
    return String(text || '').replace(/\b(.+?)\s+\1\b/gi, '$1').trim();
  }

  function resolveFieldTypeHint(fieldSpec){
    const rawMagic = String(fieldSpec?.magicDataType || fieldSpec?.magicType || '').toLowerCase();
    const key = String(fieldSpec?.fieldKey || '').toLowerCase();
    if(rawMagic.includes('date') || key.includes('date')) return MAGIC_HINT.DATE;
    if(rawMagic.includes('text')) return MAGIC_HINT.TEXT;
    if(rawMagic.includes('num') || rawMagic.includes('money') || rawMagic.includes('currency')) return MAGIC_HINT.NUMERIC;
    if(/\b(?:invoice_number|quantity|qty|amount|subtotal|total|tax|discount|price|unit_price|invoice_total)\b/.test(key)) return MAGIC_HINT.NUMERIC;
    return MAGIC_HINT.ANY;
  }

  function applySubstitutions(text, map){
    return String(text || '').split('').map(ch => {
      const mapped = map[ch] ?? map[ch.toUpperCase()] ?? null;
      return mapped || ch;
    }).join('');
  }

  function normalizeNumericValue(raw){
    const original = String(raw || '');
    let next = original.trim();
    const corrections = [];
    const hasParensNegative = /^\(.*\)$/.test(next);
    if(hasParensNegative){
      next = `-${next.slice(1, -1)}`;
      corrections.push('parens-negative');
    }
    const digitized = applySubstitutions(next, { O:'0', Q:'0', D:'0', I:'1', L:'1', '|':'1', S:'5', B:'8', Z:'2' });
    if(digitized !== next){
      next = digitized;
      corrections.push('ocr-digit-substitution');
    }
    const numericChunks = next.match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
    if(numericChunks.length){
      numericChunks.sort((a,b)=> b.replace(/\D/g, '').length - a.replace(/\D/g, '').length);
      next = numericChunks[0];
      corrections.push('numeric-chunk-select');
    }
    const stripped = next.replace(/[^\d.,\-]/g, '');
    if(stripped !== next){
      next = stripped;
      corrections.push('numeric-strip');
    }
    if((next.match(/-/g) || []).length > 1){
      next = `${next.startsWith('-') ? '-' : ''}${next.replace(/-/g, '')}`;
      corrections.push('minus-collapse');
    }
    const negative = next.startsWith('-') ? '-' : '';
    let body = next.replace(/-/g, '').replace(/,/g, '');
    const dotIdx = body.indexOf('.');
    if(dotIdx >= 0){
      body = `${body.slice(0, dotIdx + 1)}${body.slice(dotIdx + 1).replace(/\./g, '')}`;
    }
    next = `${negative}${body}`;
    return { value: next.trim(), corrections };
  }

  function normalizeDateValue(raw){
    const original = String(raw || '').trim();
    let cleaned = applySubstitutions(original, { O:'0', I:'1', L:'1', S:'5', B:'8' }).replace(/[^\dA-Za-z/\-. ,]/g, '');
    const corrections = cleaned !== original ? ['date-ocr-substitution'] : [];
    const hit = cleaned.match(/\b\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}\b/);
    if(hit){
      cleaned = hit[0];
      corrections.push('date-chunk-select');
    }
    return { value: cleaned.trim(), corrections };
  }

  function applyTypeAwareCleaning(value, fieldSpec){
    const cleaned = dedupeRepeats(cleanText(value));
    const kind = resolveFieldTypeHint(fieldSpec);
    if(kind === MAGIC_HINT.NUMERIC){
      const numeric = normalizeNumericValue(cleaned);
      return { value: numeric.value || cleaned, correctionsApplied: numeric.corrections };
    }
    if(kind === MAGIC_HINT.DATE){
      const date = normalizeDateValue(cleaned);
      return { value: date.value || cleaned, correctionsApplied: date.corrections };
    }
    return { value: cleaned, correctionsApplied: [] };
  }

  function expandBox(base, pad){
    return {
      x: base.x - pad,
      y: base.y - pad,
      w: base.w + (pad * 2),
      h: base.h + (pad * 2),
      page: base.page
    };
  }

  function tokensInBox(tokens, box, minOverlap = 0.25){
    if(!Array.isArray(tokens) || !box) return [];
    return tokens.filter(tok => {
      const x0 = tok.x || 0;
      const y0 = tok.y || 0;
      const x1 = x0 + (tok.w || 0);
      const y1 = y0 + (tok.h || 0);
      const ox = Math.max(0, Math.min(box.x + box.w, x1) - Math.max(box.x, x0));
      const oy = Math.max(0, Math.min(box.y + box.h, y1) - Math.max(box.y, y0));
      const overlap = ox * oy;
      const area = Math.max(1, (tok.w || 0) * (tok.h || 0));
      return (overlap / area) >= minOverlap;
    });
  }

  function lineBandThreshold(tok){
    return Math.max(5, (tok?.h || 10) * 0.65);
  }

  function groupByLines(tokens){
    const sorted = (tokens || []).slice().sort((a,b)=> (a.y - b.y) || (a.x - b.x));
    const lines = [];
    for(const tok of sorted){
      const cy = (tok.y || 0) + ((tok.h || 0) / 2);
      let target = lines.find(line => Math.abs(cy - line.cy) <= lineBandThreshold(tok));
      if(!target){
        target = { cy, tokens: [] };
        lines.push(target);
      }
      target.tokens.push(tok);
      target.cy = (target.cy * (target.tokens.length - 1) + cy) / target.tokens.length;
    }
    return lines.map(line => {
      line.tokens.sort((a,b)=> (a.x || 0) - (b.x || 0));
      line.text = dedupeRepeats(cleanText(line.tokens.map(t => t.text || '').join(' ')));
      return line;
    });
  }

  function parseMoney(text){
    const m = String(text || '').match(/-?\$?\s*\d[\d,]*(?:\.\d{2})?/);
    if(!m) return null;
    return Number(m[0].replace(/[^\d.-]/g, ''));
  }

  function looksDate(text){
    return /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b[a-z]{3,9}\s+\d{1,2},\s*\d{4}\b/i.test(text || '');
  }

  function scoreFieldFormat(fieldKey, text){
    const t = String(text || '');
    if(!t) return 0;
    if(fieldKey === 'invoice_number'){
      return /[a-z0-9][a-z0-9\-_/\.]{2,}/i.test(t) && !looksDate(t) ? 1 : 0;
    }
    if(fieldKey === 'invoice_date') return looksDate(t) ? 1 : 0;
    if(/total|subtotal|tax|discount/.test(fieldKey || '')) return parseMoney(t) !== null ? 1 : 0;
    if(fieldKey === 'quantity') return /^\s*\d+(?:\.\d+)?\s*$/.test(t) ? 1 : 0;
    return 0.4;
  }

  function buildCandidate(fieldSpec, line, centerX, centerY){
    const fieldKey = fieldSpec?.fieldKey || '';
    const hints = LABEL_HINTS[fieldKey] || [];
    const lower = String(line?.text || '').toLowerCase();
    const cx = line.tokens.reduce((sum, tok)=> sum + ((tok.x || 0) + ((tok.w || 0) / 2)), 0) / Math.max(1, line.tokens.length);
    const cy = line.cy || centerY;
    const distance = Math.abs(cx - centerX) + Math.abs(cy - centerY);

    let score = 0;
    if(hints.some(h => lower.includes(h))) score += 1.1;
    score += scoreFieldFormat(fieldKey, line.text);
    score += Math.max(0, 1 - (distance / 550));

    return {
      text: line.text,
      raw: line.text,
      tokens: line.tokens,
      cx,
      cy,
      score
    };
  }

  function resolveFallback(fieldSpec, candidates, boxPx){
    if(candidates.length){
      const winner = candidates[0];
      const cleaned = applyTypeAwareCleaning(winner.text, fieldSpec);
      return {
        value: cleaned.value,
        raw: winner.raw,
        confidence: Math.max(0.2, Math.min(0.55, winner.score / 2.5)),
        boxPx,
        tokens: winner.tokens,
        method: 'wrokit-vision-fallback',
        engine: 'wrokit_vision',
        correctionsApplied: cleaned.correctionsApplied || [],
        lowConfidence: true
      };
    }
    return {
      value: '',
      raw: '',
      confidence: 0.1,
      boxPx,
      tokens: [],
      method: 'wrokit-vision-empty-fallback',
      engine: 'wrokit_vision',
      lowConfidence: true
    };
  }

  function resolvePrecomputedArtifact({ precomputedStructuralMap, profile, geometryId, page, fieldSpec }){
    const resolvedPage = Number(page || fieldSpec?.page || 1);

    if(precomputedStructuralMap?.uploadedImageAnalysis){
      if(precomputedStructuralMap.page == null || Number(precomputedStructuralMap.page) === resolvedPage){
        return precomputedStructuralMap;
      }
      return null;
    }

    const fieldCfgArtifact = fieldSpec?.wrokitVisionConfig?.precomputedStructuralMap;
    if(fieldCfgArtifact?.uploadedImageAnalysis){
      if(fieldCfgArtifact.page == null || Number(fieldCfgArtifact.page) === resolvedPage){
        return fieldCfgArtifact;
      }
      return null;
    }

    const resolvedGeometryId = geometryId || profile?.geometryId || null;
    const artifacts = profile?.wrokitVision?.geometryArtifacts || {};
    const artifact = artifacts?.[resolvedGeometryId]?.precomputedStructuralMap;
    if(artifact?.uploadedImageAnalysis && artifact.page != null && Number(artifact.page) === resolvedPage){
      return artifact;
    }
    return null;
  }

  function buildMaps(tokens, viewport, imageData, precomputedStructuralMap){
    if(precomputedStructuralMap?.uploadedImageAnalysis && PrecomputedCompat?.adaptPrecomputedStructuralMapToLegacyMaps){
      return PrecomputedCompat.adaptPrecomputedStructuralMapToLegacyMaps(precomputedStructuralMap, tokens || [], viewport || null);
    }
    if(!MapTools) return { textMap: null, structuralGraph: null };
    const textMap = MapTools.buildTextMap(tokens || [], viewport || null);
    // Pass imageData (optional) so buildStructuralGraph can also build the
    // visual region layer when pixel data is available.
    const structuralGraph = MapTools.buildStructuralGraph(
      tokens || [], viewport || null, textMap, imageData || null
    );
    return { textMap, structuralGraph };
  }

  function structuralBoost(line, structuralGraph){
    const nodes = structuralGraph?.nodes || [];
    if(!nodes.length) return 0;
    const lx = line.tokens.reduce((sum, tok)=> sum + ((tok.x || 0) + ((tok.w || 0) / 2)), 0) / Math.max(1, line.tokens.length);
    const ly = line.cy || 0;
    let nearest = Infinity;
    let stability = 0;
    for(const n of nodes){
      const d = Math.abs((n.cx || 0) - lx) + Math.abs((n.cy || 0) - ly);
      if(d < nearest){
        nearest = d;
        stability = Number(n.stabilityScore) || 0;
      }
    }
    if(!Number.isFinite(nearest)) return 0;
    return Math.max(0, Math.min(0.45, (stability * 0.35) + Math.max(0, 0.2 - (nearest / 2200))));
  }

  function extractScalar({ fieldSpec, tokens, boxPx, viewport, runtimeMaps, profile, geometryId, precomputedStructuralMap }){
    if(!boxPx){
      return { value: '', raw: '', confidence: 0.1, boxPx: null, tokens: [], method:'wrokit-vision-no-box', engine:'wrokit_vision', lowConfidence:true };
    }
    const centerX = boxPx.x + (boxPx.w / 2);
    const centerY = boxPx.y + (boxPx.h / 2);
    const pads = [0, 4, 8, 12, 16];
    let lastCandidates = [];
    let lastScope = boxPx;

    const canonicalPrecomputed = resolvePrecomputedArtifact({
      precomputedStructuralMap: precomputedStructuralMap || runtimeMaps?.precomputedStructuralMap,
      profile,
      geometryId,
      page: fieldSpec?.page,
      fieldSpec
    });
    const mapBundle = runtimeMaps || buildMaps(
      tokens || [],
      viewport || fieldSpec?.wrokitVisionConfig?.viewport || null,
      null,
      canonicalPrecomputed
    );
    const fieldCfg = fieldSpec?.wrokitVisionConfig || null;
    const profileCfg = (profile?.fields || []).find(f => f?.fieldKey === fieldSpec?.fieldKey)?.wrokitVisionConfig || null;
    const cfg = fieldCfg || profileCfg;
    const neighborhood = cfg?.neighborhoods || null;

    const fieldSignature = cfg?.fieldSignature || cfg?.selectionResolution?.fieldSignature || null;
    if(FieldMatcher?.matchFieldSignature && fieldSignature && canonicalPrecomputed){
      const matchResult = FieldMatcher.matchFieldSignature({
        fieldKey: fieldSpec?.fieldKey || null,
        fieldSignature,
        canonicalPrecomputed
      });
      const selected = matchResult?.selectedCandidate || null;
      if(selected){
        const chosen = (selected.extractedValueCandidates || [])[0] || null;
        const selectedLine = selected.lineRef || null;
        const cleaned = applyTypeAwareCleaning(chosen?.text || selectedLine?.text || '', fieldSpec);
        return {
          value: cleaned.value,
          raw: chosen?.text || selectedLine?.text || '',
          confidence: Math.max(0.2, Math.min(0.98, Number(matchResult?.confidence) || 0)),
          boxPx: (selectedLine?.geometry?.bbox || boxPx),
          tokens: (tokens || []).filter(tok => (selectedLine?.tokenIds || []).includes(tok?.id)),
          method: 'wrokit-vision-field-signature-match',
          engine: 'wrokit_vision',
          geometryId: geometryId || profile?.geometryId || null,
          correctionsApplied: cleaned.correctionsApplied || [],
          lowConfidence: (Number(matchResult?.confidence) || 0) < 0.5,
          matching: matchResult
        };
      }
    }

    for(const pad of pads){
      const scope = pad ? expandBox(boxPx, pad) : boxPx;
      lastScope = scope;
      const scoped = tokensInBox(tokens || [], scope, 0.25);
      const lines = groupByLines(scoped).filter(line => !!line.text);

      // ── Visual region context boost ──────────────────────────────────────
      // When the configured field had a recorded visual region context (primary
      // region properties + relative position), compare it to the region the
      // current bbox scope falls in.  Similarity across three signals gives a
      // small confidence boost — the boost is uniform across all candidates in
      // this scope (it reflects bbox placement, not line content).
      let vrBoost = 0;
      const savedVrc = neighborhood?.visualRegionContext;
      if(MapTools?.locateBboxInVisualRegions && savedVrc?.primary
          && mapBundle?.structuralGraph?.visualRegionLayer?.regions?.length){
        const curCtx = MapTools.locateBboxInVisualRegions(scope, mapBundle.structuralGraph.visualRegionLayer);
        if(curCtx?.primary){
          const sv = savedVrc.primary;
          const cu = curCtx.primary;
          // Luminance similarity: same brightness surface
          const lumSim  = 1 - Math.abs(sv.meanLuminance - cu.meanLuminance);
          // Area-fraction similarity: region is roughly the same size on page
          const areaSim = Math.max(0, 1 - Math.abs(sv.areaFraction - cu.areaFraction) * 4);
          // Relative-position similarity within region (where the bbox sits)
          const posSim  = (savedVrc.relativePos && curCtx.relativePos)
            ? Math.max(0, 1 - (
                Math.abs(savedVrc.relativePos.rx - curCtx.relativePos.rx) +
                Math.abs(savedVrc.relativePos.ry - curCtx.relativePos.ry)
              ) * 2)
            : 0.5;
          vrBoost = lumSim * areaSim * posSim * 0.18;
        }
      }

      const ranked = lines
        .map(line => {
          const cand = buildCandidate(fieldSpec, line, centerX, centerY);
          cand.score += structuralBoost(line, mapBundle?.structuralGraph);
          cand.score += vrBoost;
          if(neighborhood?.textNeighbors?.length){
            const lower = String(cand.text || '').toLowerCase();
            if(neighborhood.textNeighbors.some(n => lower.includes(String(n?.text || '').toLowerCase()))){
              cand.score += 0.16;
            }
          }
          return cand;
        })
        .sort((a,b)=> b.score - a.score);
      lastCandidates = ranked;
      if(ranked[0]){
        const winner = ranked[0];
        const confidence = Math.max(0.2, Math.min(0.96, winner.score / 2.4));
        if(confidence >= 0.64){
          const cleaned = applyTypeAwareCleaning(winner.text, fieldSpec);
          return {
            value: cleaned.value,
            raw: winner.raw,
            confidence,
            boxPx: scope,
            tokens: winner.tokens,
            method: pad ? 'wrokit-vision-micro-expansion' : 'wrokit-vision-in-box',
            engine: 'wrokit_vision',
            geometryId: geometryId || profile?.geometryId || null,
            correctionsApplied: cleaned.correctionsApplied || [],
            lowConfidence: false
          };
        }
      }
    }

    return resolveFallback(fieldSpec, lastCandidates, lastScope);
  }

  function registerField({ step, normBox, page, rawBox, viewport, tokens, profile, geometryId, imageData, precomputedStructuralMap }){
    // imageData: optional { gray: Uint8Array, width, height } — when provided,
    // the visual region layer is built and the field's neighbourhood will include
    // visualRegionContext (region membership + relative position).
    const canonicalPrecomputed = resolvePrecomputedArtifact({
      precomputedStructuralMap,
      profile,
      geometryId,
      page,
      fieldSpec: step
    });
    const maps = buildMaps(tokens || [], viewport || null, imageData || null, canonicalPrecomputed);
    const neighborhoods = (MapTools && rawBox)
      ? MapTools.captureFieldNeighborhood(rawBox, maps.textMap, maps.structuralGraph)
      : { textNeighbors: [], structuralNeighbors: [], visualRegionContext: null };

    const selectionSeed = (SelectionAssociation?.resolveSeed && rawBox)
      ? SelectionAssociation.resolveSeed({
          selection: { bbox: rawBox },
          viewport: viewport || null,
          page,
          fieldMeta: { fieldKey: step?.fieldKey || null },
          precomputedStructuralMap: canonicalPrecomputed
        })
      : null;

    const selectionAssociation = (SelectionAssociation?.associateSelection && selectionSeed && canonicalPrecomputed)
      ? SelectionAssociation.associateSelection({
          selectionSeed,
          canonicalPrecomputed
        })
      : null;

    const localRelevance = (LocalRelevance?.scoreLocalRelevance && selectionAssociation && canonicalPrecomputed)
      ? LocalRelevance.scoreLocalRelevance({
          canonicalPrecomputed,
          selectionSeed: selectionAssociation.selectionSeed,
          selectionContext: selectionAssociation.selectionContext
        })
      : null;

    const resolvedLocalSubgraph = (LocalSubgraph?.resolveLocalSubgraph && selectionAssociation && localRelevance && canonicalPrecomputed)
      ? LocalSubgraph.resolveLocalSubgraph({
          canonicalPrecomputed,
          associationResult: selectionAssociation,
          relevanceResult: localRelevance
        })
      : null;

    const localStructure = (LocalStructure?.reconstructLocalStructure && resolvedLocalSubgraph)
      ? LocalStructure.reconstructLocalStructure({
          resolvedLocalSubgraph
        })
      : null;

    const localCoordinateFrame = (LocalFrame?.estimateLocalCoordinateFrame && resolvedLocalSubgraph && localStructure)
      ? LocalFrame.estimateLocalCoordinateFrame({
          resolvedLocalSubgraph,
          localStructure
        })
      : null;

    const fieldSignature = (FieldSignature?.buildFieldSignature && resolvedLocalSubgraph && localStructure && localCoordinateFrame)
      ? FieldSignature.buildFieldSignature({
          fieldMeta: { fieldKey: step?.fieldKey || null, fieldType: step?.fieldType || null },
          selectionSeed: selectionAssociation?.selectionSeed || null,
          resolvedLocalSubgraph,
          localStructure,
          localCoordinateFrame
        })
      : null;

    return {
      schema: 'wrokit_vision/v1',
      method: 'bbox-first-micro-expansion',
      fieldKey: step?.fieldKey || null,
      labelHints: LABEL_HINTS[step?.fieldKey] || [],
      page,
      geometryId: geometryId || profile?.geometryId || null,
      bbox: {
        x0: normBox?.x0n,
        y0: normBox?.y0n,
        x1: (normBox?.x0n || 0) + (normBox?.wN || 0),
        y1: (normBox?.y0n || 0) + (normBox?.hN || 0)
      },
      viewport: viewport ? { width: viewport.width || viewport.w || 0, height: viewport.height || viewport.h || 0 } : null,
      rawBox: rawBox ? { x: rawBox.x, y: rawBox.y, w: rawBox.w, h: rawBox.h } : null,
      neighborhoods,
      selectionResolution: resolvedLocalSubgraph
        ? {
            version: 1,
            source: 'typed-canonical-precomputed',
            selectionSeed: resolvedLocalSubgraph.selectionSeed,
            selectionContext: resolvedLocalSubgraph.selectionContext,
            relevanceScores: resolvedLocalSubgraph.relevanceScores,
            retainedNodeIds: resolvedLocalSubgraph.relevanceScores.filter(s => s.retained).map(s => s.nodeId),
            rejectedNodeIds: resolvedLocalSubgraph.rejectedNodeIds,
            resolvedLocalSubgraph,
            localStructure,
            localCoordinateFrame,
            fieldSignature
          }
        : null,
      fieldSignature,
      mapStats: {
        textNodes: maps.textMap?.nodeCount || 0,
        structuralNodes: maps.structuralGraph?.nodeCount || 0
      },
      precomputedStructuralMapRef: canonicalPrecomputed
        ? {
            schema: canonicalPrecomputed.schema || null,
            version: canonicalPrecomputed.version || null,
            geometryId: canonicalPrecomputed.geometryId || null,
            page: canonicalPrecomputed.page || page || null,
            generatedAt: canonicalPrecomputed.generatedAt || null
          }
        : null
    };
  }

  function createSeedArtifacts({ tokens, viewport, page = 1, geometryId = null, imageData = null }){
    const precomputedStructuralMap = Precompute?.buildPrecomputedStructuralMap
      ? Precompute.buildPrecomputedStructuralMap({
          tokens: tokens || [],
          viewport: viewport || null,
          page,
          geometryId,
          imageData: imageData || null
        })
      : null;
    const maps = buildMaps(tokens || [], viewport || null, null, precomputedStructuralMap);
    const summary = MapTools?.summarizeTextMap ? MapTools.summarizeTextMap(maps.textMap) : null;
    return {
      generatedAt: Date.now(),
      profileVersion: 11,
      seedStructuralGraph: maps.structuralGraph || null,
      seedTextGraphSummary: summary || null,
      precomputedStructuralMap
    };
  }

  return {
    registerField,
    extractScalar,
    buildMaps,
    createSeedArtifacts
  };
});
