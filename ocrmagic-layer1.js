(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = { runBaseOcrMagic: factory() };
  } else {
    root.runBaseOcrMagic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const AMBIGUOUS_DIGITS = new Set(['0','1','5','7']);
  const AMBIGUOUS_CHARS = new Set(['0','1','5','7','O','I','l','T','S']);

  function digitToLetter(digit, leftLetter){
    const isLeftLower = /[a-z]/.test(leftLetter);
    if(digit === '1') return isLeftLower ? 'l' : 'I';
    if(digit === '0') return isLeftLower ? 'o' : 'O';
    if(digit === '5') return isLeftLower ? 's' : 'S';
    if(digit === '7') return isLeftLower ? 't' : 'T';
    return digit;
  }

  function runBaseOcrMagic(raw=''){
    const source = String(raw ?? '');
    const reliable = [];
    const out = [];
    let changed = false;

    for(let i=0; i<source.length; i++){
      const ch = source[i];
      const isAmbiguous = AMBIGUOUS_CHARS.has(ch);
      const isAmbiguousDigit = AMBIGUOUS_DIGITS.has(ch);
      const leftIdx = i - 1;
      const leftIsSpace = leftIdx >= 0 ? source[leftIdx] === ' ' : false;
      const leftReliable = leftIdx >= 0 ? reliable[leftIdx] : false;
      const leftChar = leftIdx >= 0 ? out[leftIdx] : '';
      let nextChar = ch;
      let corrected = false;

      if(AMBIGUOUS_DIGITS.has(ch) && leftReliable && !leftIsSpace && /[A-Za-z]/.test(leftChar)){
        const replacement = digitToLetter(ch, leftChar);
        if(replacement !== ch){
          nextChar = replacement;
          changed = true;
          corrected = true;
        }
      }

      out.push(nextChar);
      reliable[i] = corrected ? true : (!isAmbiguousDigit);
    }

    const cleaned = out.join('');
    const rulesApplied = changed ? ['layer1-common-substitution'] : [];
    if(typeof globalThis !== 'undefined' && typeof globalThis.ocrMagicDebug === 'function'){
      globalThis.ocrMagicDebug({ event: 'ocrmagic.base', raw: source, cleaned });
    }
    return { cleaned, rulesApplied };
  }

  return runBaseOcrMagic;
});
