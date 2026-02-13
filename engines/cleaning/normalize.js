(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineCleaningNormalize = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  function collapseAdjacentDuplicates(str){
    if(!str) return '';
    let out = str;
    const re = /(\b[\w#&.-]+(?:\s+[\w#&.-]+)*)\s+\1\b/gi;
    let prev;
    do {
      prev = out;
      out = out.replace(re, '$1');
    } while(out !== prev);
    return out;
  }

  return {
    collapseAdjacentDuplicates
  };
});
