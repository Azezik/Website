(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.selectionFirst = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  return function selectionFirst(tokens, cleanFn){
    const raw = tokens.map(t => t.text).join(' ').trim();
    const cleaned = cleanFn ? cleanFn(tokens) : null;
    const val = cleaned && (cleaned.value || cleaned.raw) ? (cleaned.value || cleaned.raw) : '';
    return { raw, value: val || raw, cleanedOk: !!val, cleaned };
  };
});
