'use strict';

const { createTextTokenNode, ensureBBox } = require('../../types');

function normalizeText(text){
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function ingestOcrTokens(tokens = [], { idFactory, page = 1 } = {}){
  return (Array.isArray(tokens) ? tokens : [])
    .filter(tok => tok && String(tok.text || '').trim())
    .map(tok => {
      const bbox = ensureBBox(tok);
      return createTextTokenNode({
        id: idFactory('txt_tok'),
        geometry: { bbox },
        confidence: Number(tok.confidence ?? tok.ocrConfidence ?? 0.75),
        provenance: {
          stage: 'text-detection',
          detector: 'ocr-ingest',
          page,
          sourceTokenId: tok.id || null
        },
        text: tok.text,
        normalizedText: normalizeText(tok.text),
        ocr: {
          alternatives: Array.isArray(tok.alternatives) ? tok.alternatives : [],
          language: tok.language || null
        },
        features: {
          charCount: normalizeText(tok.text).length,
          aspectRatio: bbox.h ? bbox.w / bbox.h : 0
        }
      });
    });
}

module.exports = {
  ingestOcrTokens
};
