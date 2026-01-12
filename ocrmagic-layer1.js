(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const COMMON_SUBS = require('./common-subs.js');
    module.exports = factory(COMMON_SUBS);
  } else {
    root.OCRMagicLayer1 = factory(root.COMMON_SUBS);
  }
})(typeof self !== 'undefined' ? self : this, function (COMMON_SUBS) {
  if (!COMMON_SUBS) {
    throw new Error('COMMON_SUBS module is required for OCRMagic Layer 1.');
  }

  const isAlnum = (ch) => /[A-Za-z0-9]/.test(ch);
  const CONFUSION_PAIRS = new Set(['O0', '0O', 'I1', '1I', 'l1', '1l', 'S5', '5S', 'T7', '7T']);

  function station1_layer1Adjacency(raw = '') {
    const source = String(raw ?? '');
    const commonSubMatches = [];
    const commonSubPairs = [];
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (COMMON_SUBS.isAmbiguous(ch)) {
        commonSubMatches.push({ index: i, char: ch });
      }
      if (i < source.length - 1) {
        const pair = ch + source[i + 1];
        if (CONFUSION_PAIRS.has(pair)) {
          commonSubPairs.push({ index: i, pair });
        }
      }
    }
    const commonSubDetected = commonSubMatches.length > 0 || commonSubPairs.length > 0;
    const chars = Array.from(source).map((ch) => ({ char: ch, reliable: false }));
    const layer1Flags = [];
    const layer1Edits = [];
    let changed = false;
    let progress = true;

    while (progress) {
      progress = false;
      for (let i = 0; i < chars.length; i++) {
        const entry = chars[i];
        const ch = entry.char;
        const ambiguous = COMMON_SUBS.isAmbiguous(ch);

        if (!isAlnum(ch)) {
          entry.reliable = true;
          continue;
        }

        if (!ambiguous) {
          entry.reliable = true;
          continue;
        }

        if (i === 0) {
          entry.reliable = true;
          continue;
        }

        const left = chars[i - 1];
        const leftChar = left?.char ?? '';
        const leftIsSpace = leftChar === ' ';
        const leftIsAlnum = isAlnum(leftChar);

        if (leftIsSpace) {
          entry.reliable = true;
          continue;
        }

        if (!leftIsAlnum) {
          entry.reliable = true;
          continue;
        }

        const leftAmbiguous = COMMON_SUBS.isAmbiguous(leftChar);
        const leftReliable = left?.reliable || !leftAmbiguous;
        if (!leftReliable) {
          continue;
        }

        if (/[0-9]/.test(leftChar)) {
          entry.reliable = true;
          continue;
        }

        layer1Flags.push(i);

        if (COMMON_SUBS.isAmbiguousDigit(ch)) {
          const replacement = COMMON_SUBS.digitToLetter(ch, leftChar);
          if (replacement !== ch && COMMON_SUBS.isValidOcrMagicSubstitution(ch, replacement)) {
            entry.char = replacement;
            layer1Edits.push({ index: i, from: ch, to: replacement });
            changed = true;
            progress = true;
          }
        }

        entry.reliable = true;
      }
    }

    const l1Text = chars.map((c) => c.char).join('');
    const rulesApplied = changed ? ['layer1-common-substitution'] : [];

    if (typeof globalThis !== 'undefined' && typeof globalThis.ocrMagicDebug === 'function') {
      globalThis.ocrMagicDebug({ event: 'ocrmagic.base', raw: source, cleaned: l1Text });
    }

    return {
      l1Text,
      cleaned: l1Text,
      layer1Flags: Array.from(new Set(layer1Flags)),
      layer1Edits,
      commonSubDetected,
      commonSubMatches,
      commonSubPairs,
      rulesApplied
    };
  }

  function runBaseOcrMagic(raw = '') {
    const result = station1_layer1Adjacency(raw);
    return {
      cleaned: result.cleaned,
      rulesApplied: result.rulesApplied,
      layer1Edits: result.layer1Edits,
      commonSubDetected: result.commonSubDetected,
      commonSubMatches: result.commonSubMatches,
      commonSubPairs: result.commonSubPairs
    };
  }

  const api = { station1_layer1Adjacency, runBaseOcrMagic };
  if (typeof self !== 'undefined') {
    self.runBaseOcrMagic = api.runBaseOcrMagic;
    self.station1_layer1Adjacency = api.station1_layer1Adjacency;
  }
  return api;
});
