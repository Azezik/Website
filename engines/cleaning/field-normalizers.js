(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineFieldNormalizers = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  function normalizeMoney(raw){
    if(!raw) return '';
    const sign = /-/.test(raw) ? '-' : '';
    const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g,'');
    const num = parseFloat(cleaned);
    if(isNaN(num)) return '';
    const abs = Math.abs(num).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return sign + abs;
  }

  function normalizeDate(raw){
    if(!raw) return '';
    const txt = raw.trim().replace(/(\d)(st|nd|rd|th)/gi, '$1');
    const months = {
      jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
    };
    let y,m,d;
    let match;
    if((match = txt.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/))){
      y = +match[1]; m = +match[2]; d = +match[3];
    } else if((match = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))){
      const a = +match[1], b = +match[2];
      if(a > 12){ d = a; m = b; } else { m = a; d = b; }
      y = +match[3];
    } else if((match = txt.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/))){
      m = months[match[1].slice(0,3).toLowerCase()] || 0;
      d = +match[2];
      y = +match[3];
    }
    if(!y || !m || !d) return '';
    const pad = n => n.toString().padStart(2,'0');
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  return {
    normalizeMoney,
    normalizeDate
  };
});
