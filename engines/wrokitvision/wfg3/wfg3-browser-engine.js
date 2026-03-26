(function(global){
  'use strict';

  var wfg2 = global.WrokitFeatureGraph2 || null;

  function requireWfg2(){
    if(!wfg2){
      throw new Error('WFG3 browser adapter requires WrokitFeatureGraph2 to be loaded first.');
    }
    return wfg2;
  }

  function copyParams(params){
    return requireWfg2().copyParams(params || requireWfg2().DEFAULT_PARAMS);
  }

  function withMeta(graph){
    if(!graph || typeof graph !== 'object') return graph;
    var out = graph;
    out.engine = 'wfg3';
    if(!out.meta || typeof out.meta !== 'object') out.meta = {};
    out.meta.engine = 'wfg3';
    out.meta.engineLabel = 'WFG3';
    return out;
  }

  var WFG3 = {
    ENGINE_KEY: 'wfg3',
    ENGINE_LABEL: 'WFG3',
    DEFAULT_PARAMS: null,

    copyParams: function(params){
      return copyParams(params);
    },

    normalizeVisualInput: function(input, opts){
      return requireWfg2().normalizeVisualInput(input, opts);
    },

    generateFeatureGraph: function(normalizedSurface, params){
      var p = copyParams(params || WFG3.DEFAULT_PARAMS || requireWfg2().DEFAULT_PARAMS);
      var graph = requireWfg2().generateFeatureGraph(normalizedSurface, p);
      return withMeta(graph);
    },

    adaptParametersFromFeedback: function(params, feedback){
      return requireWfg2().adaptParametersFromFeedback(params, feedback);
    },

    computeGroupedGraph: function(partResult, opts){
      return requireWfg2().computeGroupedGraph(partResult, opts);
    },

    buildGroupedLabelMap: function(partitionLabelMap, groupedGraph, nodes){
      return requireWfg2().buildGroupedLabelMap(partitionLabelMap, groupedGraph, nodes);
    },

    computeSharedBoundaries: function(groupedLabelMap, width, height){
      return requireWfg2().computeSharedBoundaries(groupedLabelMap, width, height);
    },

    createAttemptStore: function(storage){
      return requireWfg2().createAttemptStore(storage);
    },

    createPresetStore: function(storage){
      return requireWfg2().createPresetStore(storage);
    }
  };

  WFG3.DEFAULT_PARAMS = copyParams(requireWfg2().DEFAULT_PARAMS);

  global.WrokitFeatureGraph3 = WFG3;
})(window);
