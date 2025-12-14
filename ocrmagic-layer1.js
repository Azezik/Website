(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = { runBaseOcrMagic: factory() };
  } else {
    root.runBaseOcrMagic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const AMBIGUOUS_DIGITS = new Set(['0','1','5','7']);

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
    const steps = [];
    let changed = false;

    for(let i=0; i<source.length; i++){
      const ch = source[i];
      const leftIdx = i - 1;
      const leftChar = leftIdx >= 0 ? source[leftIdx] : '';
      const leftOutChar = leftIdx >= 0 ? out[leftIdx] : '';
      const leftIsSpace = leftChar === ' ';
      const isLetter = /[A-Za-z]/.test(ch);
      const isDigit = /[0-9]/.test(ch);
      const isAmbiguousDigit = AMBIGUOUS_DIGITS.has(ch);
      let nextChar = ch;
      let corrected = false;
      let rulePath = '';

      if(!isLetter && !isDigit){
        rulePath = 'non-alnum';
        reliable[i] = true;
      } else if(!isAmbiguousDigit){
        rulePath = 'not-ambiguous-digit';
        reliable[i] = true;
      } else if(i === 0){
        rulePath = 'first-char-ambiguous-digit';
        reliable[i] = true;
      } else if(leftIsSpace){
        rulePath = 'left-space';
        reliable[i] = true;
      } else {
        const leftIsLetter = /[A-Za-z]/.test(leftOutChar);
        const leftIsDigit = /[0-9]/.test(leftOutChar);
        if(!leftIsLetter && !leftIsDigit){
          rulePath = 'left-non-alnum';
          reliable[i] = true;
        } else if(leftIsDigit){
          rulePath = 'left-digit';
          reliable[i] = true;
        } else if(leftIsLetter){
          const leftIsLower = leftOutChar === leftOutChar.toLowerCase();
          const leftIsWordStart = leftIdx === 0 || source[leftIdx - 1] === ' ';
          if(leftIsLower || leftIsWordStart){
            rulePath = 'left-letter-substitute';
            const replacement = digitToLetter(ch, leftOutChar);
            if(replacement !== ch){
              nextChar = replacement;
              changed = true;
              corrected = true;
            }
          } else {
            rulePath = 'left-letter-no-sub';
          }
          reliable[i] = true;
        }
      }

      out.push(nextChar);
      steps.push({
        index: i,
        char: ch,
        left: leftChar || null,
        leftOut: leftOutChar || null,
        rule: rulePath,
        substituted: corrected,
        output: nextChar
      });
    }

    const cleaned = out.join('');
    const rulesApplied = changed ? ['layer1-common-substitution'] : [];
    if(typeof globalThis !== 'undefined' && typeof globalThis.ocrMagicDebug === 'function'){
      globalThis.ocrMagicDebug({ event: 'ocrmagic.base', raw: source, cleaned, steps });
    }
    return { cleaned, rulesApplied, steps };
  }

  return runBaseOcrMagic;
});
