(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.COMMON_SUBS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DIGIT_TO_LETTERS = {
    '0': ['O'],
    '1': ['I', 'l'],
    '5': ['S'],
    '7': ['T']
  };

  const LETTER_TO_DIGIT = {
    'O': '0',
    'I': '1',
    'l': '1',
    'S': '5',
    'T': '7'
  };

  const AMBIGUOUS_SET = new Set(['0', '1', '5', '7', 'O', 'I', 'l', 'S', 'T']);
  const AMBIGUOUS_DIGITS = new Set(['0', '1', '5', '7']);
  const AMBIGUOUS_LETTERS = new Set(['O', 'I', 'l', 'S', 'T']);

  function isAmbiguous(ch) {
    return AMBIGUOUS_SET.has(ch);
  }

  function isAmbiguousDigit(ch) {
    return AMBIGUOUS_DIGITS.has(ch);
  }

  function isAmbiguousLetter(ch) {
    return AMBIGUOUS_LETTERS.has(ch);
  }

  function digitToLetter(digit, leftContextChar = '') {
    if (!isAmbiguousDigit(digit)) return digit;
    const leftIsLower = /[a-z]/.test(leftContextChar || '');
    if (digit === '1') return leftIsLower ? 'l' : 'I';
    if (digit === '0') return leftIsLower ? 'o' : 'O';
    if (digit === '5') return leftIsLower ? 's' : 'S';
    if (digit === '7') return leftIsLower ? 't' : 'T';
    return digit;
  }

  function letterToDigit(letter) {
    return LETTER_TO_DIGIT[letter] ?? letter;
  }

  function isValidOcrMagicSubstitution(from, to) {
    if (from === to) return true;
    const allowed = new Set([
      '0->O', '0->o',
      '1->I', '1->l',
      '5->S', '5->s',
      '7->T', '7->t',
      'O->0', 'I->1', 'l->1',
      'S->5', 'T->7'
    ]);
    return allowed.has(`${from}->${to}`);
  }

  function stripToAlnum(text = '') {
    return String(text ?? '').replace(/[^A-Za-z0-9]/g, '');
  }

  function rehydrateAlnum(originalText = '', correctedAlnum = '') {
    const correctedArr = String(correctedAlnum ?? '').split('');
    let cursor = 0;
    const out = [];
    for (const ch of String(originalText ?? '')) {
      if (/[A-Za-z0-9]/.test(ch)) {
        out.push(cursor < correctedArr.length ? correctedArr[cursor] : ch);
        cursor += 1;
      } else {
        out.push(ch);
      }
    }
    return out.join('');
  }

  return {
    DIGIT_TO_LETTERS,
    LETTER_TO_DIGIT,
    AMBIGUOUS_SET,
    isAmbiguous,
    isAmbiguousDigit,
    isAmbiguousLetter,
    digitToLetter,
    letterToDigit,
    isValidOcrMagicSubstitution,
    stripToAlnum,
    rehydrateAlnum
  };
});
