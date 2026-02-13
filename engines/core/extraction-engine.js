(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineExtraction = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  function createExtractionEngine(deps = {}){
    const { tokenProvider, profileStore, rawStore, compileEngine } = deps;

    async function orchestrate(input = {}){
      const {
        file,
        profile,
        wizardId,
        geometryId,
        runContext,
        ensureDocumentLoaded,
        prepareTokens,
        selectGeometry,
        extractAreaRows,
        extractStaticFields,
        buildPostCheck,
        extractLineItems,
        compile,
        logParity
      } = input;

      if(typeof ensureDocumentLoaded !== 'function'){
        throw new Error('ExtractionEngine.orchestrate requires ensureDocumentLoaded');
      }
      if(typeof prepareTokens !== 'function'){
        throw new Error('ExtractionEngine.orchestrate requires prepareTokens');
      }
      if(typeof extractStaticFields !== 'function'){
        throw new Error('ExtractionEngine.orchestrate requires extractStaticFields');
      }
      if(typeof buildPostCheck !== 'function'){
        throw new Error('ExtractionEngine.orchestrate requires buildPostCheck');
      }
      if(typeof extractLineItems !== 'function'){
        throw new Error('ExtractionEngine.orchestrate requires extractLineItems');
      }
      if(typeof compile !== 'function'){
        throw new Error('ExtractionEngine.orchestrate requires compile');
      }

      const prepared = await ensureDocumentLoaded({ file, profile, wizardId, geometryId, runContext, tokenProvider, profileStore, rawStore, compileEngine });
      if(!prepared) return { accepted: false, reason: 'document_not_prepared' };

      const tokenStats = await prepareTokens({ file, profile, wizardId, geometryId, runContext, prepared, tokenProvider, profileStore, rawStore, compileEngine });

      const geometrySelection = typeof selectGeometry === 'function'
        ? await selectGeometry({ file, profile, wizardId, geometryId, runContext, tokenStats, prepared, tokenProvider, profileStore, rawStore, compileEngine })
        : null;

      if(geometrySelection?.rejected){
        return {
          accepted: false,
          reason: geometrySelection.reason || 'geometry_selection_rejected',
          tokenStats,
          wizardId: geometrySelection.wizardId || wizardId,
          geometryId: geometrySelection.geometryId || geometryId
        };
      }

      const runProfile = geometrySelection?.profile || profile;
      const runWizardId = geometrySelection?.wizardId || wizardId;
      const runGeometryId = geometrySelection?.geometryId || geometryId;

      if(typeof extractAreaRows === 'function'){
        await extractAreaRows({ file, profile: runProfile, wizardId: runWizardId, geometryId: runGeometryId, runContext, tokenStats, prepared, tokenProvider, profileStore, rawStore, compileEngine });
      }

      await extractStaticFields({ file, profile: runProfile, wizardId: runWizardId, geometryId: runGeometryId, runContext, tokenStats, prepared, tokenProvider, profileStore, rawStore, compileEngine });

      const postCheck = await buildPostCheck({ file, profile: runProfile, wizardId: runWizardId, geometryId: runGeometryId, runContext, tokenStats, prepared, tokenProvider, profileStore, rawStore, compileEngine });
      if(!postCheck?.hasExtractedContent){
        return {
          accepted: false,
          reason: postCheck?.reason || 'no_extracted_content',
          tokenStats,
          postCheck,
          wizardId: runWizardId,
          geometryId: runGeometryId
        };
      }

      const lineItems = await extractLineItems({ file, profile: runProfile, wizardId: runWizardId, geometryId: runGeometryId, runContext, tokenStats, prepared, postCheck, tokenProvider, profileStore, rawStore, compileEngine });
      const compiled = await compile({ file, profile: runProfile, wizardId: runWizardId, geometryId: runGeometryId, runContext, tokenStats, prepared, postCheck, lineItems, tokenProvider, profileStore, rawStore, compileEngine });

      if(typeof logParity === 'function'){
        await logParity({ file, profile: runProfile, wizardId: runWizardId, geometryId: runGeometryId, runContext, tokenStats, postCheck, lineItems, compiled, tokenProvider, profileStore, rawStore, compileEngine });
      }

      return {
        accepted: true,
        reason: null,
        tokenStats,
        postCheck,
        lineItems,
        compiled,
        wizardId: runWizardId,
        geometryId: runGeometryId
      };
    }

    return { orchestrate };
  }

  return { createExtractionEngine };
});
