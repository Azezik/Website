(function(root){
  /**
   * @typedef {Object} TokenProvider
   * @property {(pageNum:number, pageObj?:Object|null, viewport?:Object|null, canvasEl?:HTMLCanvasElement|null)=>Promise<Array<Object>>} ensureDocumentLoaded
   * @property {(pageNum:number, options?:Object)=>Promise<Array<Object>>} getPageTokens
   * @property {(pageNum:number)=>Object|null} getPageViewport
   * @property {(pageNum:number)=>({pdfTokenCount?:number,tessTokenCount?:number}|null)} [getTokenSourceInfo]
   */

  /**
   * @typedef {Object} ProfileStore
   * @property {(username:string, docType:string, wizardId?:string, geometryId?:string|null)=>Object|null} loadProfile
   * @property {(username:string, docType:string, profile:Object, wizardId?:string, geometryId?:string|null)=>void} saveProfile
   * @property {(profile:Object|null)=>Object|null} migrateProfile
   */

  /**
   * @typedef {Object} RawStore
   * @property {(fileId:string, rec:Object)=>void} upsert
   * @property {(fileId:string)=>Array<Object>} getByFile
   * @property {(fileId:string)=>void} clearByFile
   */

  root.EngineContracts = root.EngineContracts || {};
})(typeof window !== 'undefined' ? window : globalThis);
