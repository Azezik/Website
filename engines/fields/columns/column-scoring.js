(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineColumnScoring = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  function computeTrimmedAverage(counts){
    if(!Array.isArray(counts) || !counts.length) return null;
    if(counts.length < 3){
      const sum = counts.reduce((acc, val) => acc + val, 0);
      return counts.length ? sum / counts.length : null;
    }
    const sorted = counts.slice().sort((a,b)=>a-b);
    const trimmed = sorted.slice(1, sorted.length - 1);
    if(!trimmed.length){
      const sum = counts.reduce((acc, val) => acc + val, 0);
      return counts.length ? sum / counts.length : null;
    }
    const sum = trimmed.reduce((acc, val) => acc + val, 0);
    return trimmed.length ? sum / trimmed.length : null;
  }

  function pickRowTarget(counts, fallback){
    if(!Array.isArray(counts) || !counts.length) return fallback;
    const trimmed = computeTrimmedAverage(counts);
    if(Number.isFinite(trimmed) && trimmed > 0){
      return Math.round(trimmed);
    }
    const sum = counts.reduce((acc, val) => acc + val, 0);
    const avg = counts.length ? sum / counts.length : null;
    if(Number.isFinite(avg) && avg > 0){
      return Math.round(avg);
    }
    return fallback;
  }

  function pruneRowsBySupport(rows, target){
    if(!Array.isArray(rows) || rows.length <= target) return rows;
    const buckets = new Map();
    rows.forEach((row, idx) => {
      const support = row.__columnHits || 0;
      if(!buckets.has(support)) buckets.set(support, []);
      buckets.get(support).push({ row, idx });
    });
    const toDrop = new Set();
    let remaining = rows.length;
    const supportLevels = Array.from(buckets.keys()).sort((a,b)=>a-b);
    for(const level of supportLevels){
      const entries = buckets.get(level);
      entries.sort((a,b)=>{
        const aTokens = a.row.__totalTokens || 0;
        const bTokens = b.row.__totalTokens || 0;
        if(aTokens !== bTokens) return aTokens - bTokens;
        const aAnchor = a.row.__anchorTokens || 0;
        const bAnchor = b.row.__anchorTokens || 0;
        if(aAnchor !== bAnchor) return aAnchor - bAnchor;
        return b.idx - a.idx;
      });
      for(const entry of entries){
        if(remaining <= target) break;
        toDrop.add(entry.idx);
        remaining--;
      }
      if(remaining <= target) break;
    }
    if(remaining > target){
      for(let i=rows.length-1; i>=0 && remaining>target; i--){
        if(!toDrop.has(i)){
          toDrop.add(i);
          remaining--;
        }
      }
    }
    return rows.filter((row, idx) => !toDrop.has(idx));
  }

  function applyQuantityUnitAmountConsistency(row){
    if(!row || typeof row !== 'object') return row;
    if(row.quantity) row.quantity = row.quantity.replace(/[^0-9.-]/g,'');
    if(row.unit_price){
      const num=parseFloat(row.unit_price.replace(/[^0-9.-]/g,''));
      row.unit_price = Number.isFinite(num) ? num.toFixed(2) : '';
    }
    if(row.amount){
      const num=parseFloat(row.amount.replace(/[^0-9.-]/g,''));
      row.amount = Number.isFinite(num) ? num.toFixed(2) : '';
    }
    if(!row.amount && row.quantity && row.unit_price){
      const q=parseFloat(row.quantity), u=parseFloat(row.unit_price);
      if(Number.isFinite(q) && Number.isFinite(u)) row.amount=(q*u).toFixed(2);
    }
    return row;
  }

  return {
    computeTrimmedAverage,
    pickRowTarget,
    pruneRowsBySupport,
    applyQuantityUnitAmountConsistency
  };
});
