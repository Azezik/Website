'use strict';

const { runUploadAnalysis } = require('../vision/analysis/upload-analysis/upload-analysis-pipeline');

function buildPrecomputedStructuralMap({ tokens = [], viewport = null, page = 1, geometryId = null, imageData = null } = {}){
  const uploadedImageAnalysis = runUploadAnalysis({
    tokens,
    viewport,
    page,
    imageRef: geometryId ? { geometryId, page } : { page },
    analysisId: geometryId ? `${geometryId}_p${page}` : `p${page}`,
    imageData
  });

  return {
    schema: 'wrokitvision/precomputed-structural-map/v1',
    version: 1,
    generatedAt: uploadedImageAnalysis.generatedAt,
    geometryId: geometryId || null,
    page,
    uploadedImageAnalysis
  };
}

module.exports = {
  buildPrecomputedStructuralMap
};
