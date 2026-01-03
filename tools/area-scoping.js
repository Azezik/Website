(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory(require('./static-field-mode.js'));
  } else {
    root.AreaScoping = factory(root.StaticFieldMode);
  }
})(typeof self !== 'undefined' ? self : this, function(StaticFieldMode){
  const tokensInBox = StaticFieldMode?.tokensInBox || function(tokens=[], box){
    if(!box) return tokens || [];
    return (tokens || []).filter(t => t && t.page === box.page && (t.x + t.w/2) >= box.x && (t.x + t.w/2) <= box.x + box.w && (t.y + t.h/2) >= box.y && (t.y + t.h/2) <= box.y + box.h);
  };

  function isExplicitSubordinate(field){
    if(!field) return false;
    const isArea = !!(field.isArea || field.fieldType === 'areabox');
    if(isArea) return false;
    if(field.isSubordinate === true) return true;
    if(field.areaRelativeBox) return true;
    return false;
  }

  function scopeTokensForField(field, tokens, areaBox){
    if(!isExplicitSubordinate(field) || !areaBox) return tokens || [];
    return tokensInBox(tokens, areaBox, { minOverlap: 0 });
  }

  return { isExplicitSubordinate, scopeTokensForField };
});
