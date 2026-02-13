(function(root){
  function createSkinV2TokenProvider(deps){
    const {
      ensureDocumentLoaded,
      ensurePdfTokens,
      ensureTesseractTokens,
      getPageViewport,
      getTokenSourceInfo
    } = deps || {};

    return {
      ensureDocumentLoaded(pageNum, pageObj, viewport, canvasEl){
        return ensureDocumentLoaded ? ensureDocumentLoaded(pageNum, pageObj, viewport, canvasEl) : Promise.resolve([]);
      },
      getPageTokens(pageNum, options = {}){
        const source = options?.source === 'tesseract' ? 'tesseract' : 'pdfjs';
        if(source === 'tesseract'){
          return ensureTesseractTokens ? ensureTesseractTokens(pageNum, options?.canvasEl || null) : Promise.resolve([]);
        }
        return ensurePdfTokens ? ensurePdfTokens(pageNum, options?.pageObj || null, options?.viewport || null, options?.canvasEl || null) : Promise.resolve([]);
      },
      getPageViewport(pageNum){
        return getPageViewport ? getPageViewport(pageNum) : null;
      },
      getTokenSourceInfo(pageNum){
        return getTokenSourceInfo ? getTokenSourceInfo(pageNum) : null;
      }
    };
  }

  root.SkinV2TokenProviderAdapter = { createSkinV2TokenProvider };
})(typeof window !== 'undefined' ? window : globalThis);
