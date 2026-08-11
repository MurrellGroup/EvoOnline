export async function instantiate(module, imports = {}) {
  const adaptedImports = {
    env: Object.assign(Object.create(globalThis), imports.env || {}, {
      abort(message, fileName, lineNumber, columnNumber) {
        // ~lib/builtins/abort(~lib/string/String | null?, ~lib/string/String | null?, u32?, u32?) => void
        message = __liftString(message >>> 0);
        fileName = __liftString(fileName >>> 0);
        lineNumber = lineNumber >>> 0;
        columnNumber = columnNumber >>> 0;
        (() => {
          // @external.js
          throw Error(`${message} in ${fileName}:${lineNumber}:${columnNumber}`);
        })();
      },
    }),
  };
  const { exports } = await WebAssembly.instantiate(module, adaptedImports);
  const memory = exports.memory || imports.env.memory;
  const adaptedExports = Object.setPrototypeOf({
    Uint8Array_ID: {
      // assembly/index/Uint8Array_ID: u32
      valueOf() { return this.value; },
      get value() {
        return exports.Uint8Array_ID.value >>> 0;
      }
    },
    Uint32Array_ID: {
      // assembly/index/Uint32Array_ID: u32
      valueOf() { return this.value; },
      get value() {
        return exports.Uint32Array_ID.value >>> 0;
      }
    },
    Int32Array_ID: {
      // assembly/index/Int32Array_ID: u32
      valueOf() { return this.value; },
      get value() {
        return exports.Int32Array_ID.value >>> 0;
      }
    },
    Float64Array_ID: {
      // assembly/index/Float64Array_ID: u32
      valueOf() { return this.value; },
      get value() {
        return exports.Float64Array_ID.value >>> 0;
      }
    },
    evaluateBsrelAllMessages(childOffsets, children, tipForNode, edgeForNode, nodeForEdge, postorder, preorder, tipStates, branchLengths, branchModels, branchWeights, candidateBranches, candidateLengths, candidateModels, candidateWeights, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, nodeCount, edgeCount, stateCount, maxNeighbors, root, poissonTerms, maxLambdaPerStep) {
      // assembly/index/evaluateBsrelAllMessages(~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Int32Array, ~lib/typedarray/Int32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint8Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, i32, i32, f64) => ~lib/typedarray/Float64Array
      childOffsets = __retain(__lowerTypedArray(Uint32Array, 5, 2, childOffsets) || __notnull());
      children = __retain(__lowerTypedArray(Uint32Array, 5, 2, children) || __notnull());
      tipForNode = __retain(__lowerTypedArray(Int32Array, 6, 2, tipForNode) || __notnull());
      edgeForNode = __retain(__lowerTypedArray(Int32Array, 6, 2, edgeForNode) || __notnull());
      nodeForEdge = __retain(__lowerTypedArray(Uint32Array, 5, 2, nodeForEdge) || __notnull());
      postorder = __retain(__lowerTypedArray(Uint32Array, 5, 2, postorder) || __notnull());
      preorder = __retain(__lowerTypedArray(Uint32Array, 5, 2, preorder) || __notnull());
      tipStates = __retain(__lowerTypedArray(Uint8Array, 4, 0, tipStates) || __notnull());
      branchLengths = __retain(__lowerTypedArray(Float64Array, 7, 3, branchLengths) || __notnull());
      branchModels = __retain(__lowerTypedArray(Uint32Array, 5, 2, branchModels) || __notnull());
      branchWeights = __retain(__lowerTypedArray(Float64Array, 7, 3, branchWeights) || __notnull());
      candidateBranches = __retain(__lowerTypedArray(Uint32Array, 5, 2, candidateBranches) || __notnull());
      candidateLengths = __retain(__lowerTypedArray(Float64Array, 7, 3, candidateLengths) || __notnull());
      candidateModels = __retain(__lowerTypedArray(Uint32Array, 5, 2, candidateModels) || __notnull());
      candidateWeights = __retain(__lowerTypedArray(Float64Array, 7, 3, candidateWeights) || __notnull());
      neighborCount = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborCount) || __notnull());
      neighborIndex = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborIndex) || __notnull());
      rDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rDiagonal) || __notnull());
      rOffDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rOffDiagonal) || __notnull());
      mu = __retain(__lowerTypedArray(Float64Array, 7, 3, mu) || __notnull());
      equilibrium = __lowerTypedArray(Float64Array, 7, 3, equilibrium) || __notnull();
      try {
        return __liftTypedArray(Float64Array, exports.evaluateBsrelAllMessages(childOffsets, children, tipForNode, edgeForNode, nodeForEdge, postorder, preorder, tipStates, branchLengths, branchModels, branchWeights, candidateBranches, candidateLengths, candidateModels, candidateWeights, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, nodeCount, edgeCount, stateCount, maxNeighbors, root, poissonTerms, maxLambdaPerStep) >>> 0);
      } finally {
        __release(childOffsets);
        __release(children);
        __release(tipForNode);
        __release(edgeForNode);
        __release(nodeForEdge);
        __release(postorder);
        __release(preorder);
        __release(tipStates);
        __release(branchLengths);
        __release(branchModels);
        __release(branchWeights);
        __release(candidateBranches);
        __release(candidateLengths);
        __release(candidateModels);
        __release(candidateWeights);
        __release(neighborCount);
        __release(neighborIndex);
        __release(rDiagonal);
        __release(rOffDiagonal);
        __release(mu);
      }
    },
    evaluateGlobalGammaAllMessages(childOffsets, children, tipForNode, edgeForNode, nodeForEdge, postorder, preorder, tipStates, branchLengths, omegaModels, omegaWeights, positiveMask, neutralModel, alphaValues, alphaWeights, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, nodeCount, edgeCount, stateCount, maxNeighbors, root, poissonTerms, maxLambdaPerStep) {
      // assembly/index/evaluateGlobalGammaAllMessages(~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Int32Array, ~lib/typedarray/Int32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint8Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint8Array, i32, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, i32, i32, f64) => ~lib/typedarray/Float64Array
      childOffsets = __retain(__lowerTypedArray(Uint32Array, 5, 2, childOffsets) || __notnull());
      children = __retain(__lowerTypedArray(Uint32Array, 5, 2, children) || __notnull());
      tipForNode = __retain(__lowerTypedArray(Int32Array, 6, 2, tipForNode) || __notnull());
      edgeForNode = __retain(__lowerTypedArray(Int32Array, 6, 2, edgeForNode) || __notnull());
      nodeForEdge = __retain(__lowerTypedArray(Uint32Array, 5, 2, nodeForEdge) || __notnull());
      postorder = __retain(__lowerTypedArray(Uint32Array, 5, 2, postorder) || __notnull());
      preorder = __retain(__lowerTypedArray(Uint32Array, 5, 2, preorder) || __notnull());
      tipStates = __retain(__lowerTypedArray(Uint8Array, 4, 0, tipStates) || __notnull());
      branchLengths = __retain(__lowerTypedArray(Float64Array, 7, 3, branchLengths) || __notnull());
      omegaModels = __retain(__lowerTypedArray(Uint32Array, 5, 2, omegaModels) || __notnull());
      omegaWeights = __retain(__lowerTypedArray(Float64Array, 7, 3, omegaWeights) || __notnull());
      positiveMask = __retain(__lowerTypedArray(Uint8Array, 4, 0, positiveMask) || __notnull());
      alphaValues = __retain(__lowerTypedArray(Float64Array, 7, 3, alphaValues) || __notnull());
      alphaWeights = __retain(__lowerTypedArray(Float64Array, 7, 3, alphaWeights) || __notnull());
      neighborCount = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborCount) || __notnull());
      neighborIndex = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborIndex) || __notnull());
      rDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rDiagonal) || __notnull());
      rOffDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rOffDiagonal) || __notnull());
      mu = __retain(__lowerTypedArray(Float64Array, 7, 3, mu) || __notnull());
      equilibrium = __lowerTypedArray(Float64Array, 7, 3, equilibrium) || __notnull();
      try {
        return __liftTypedArray(Float64Array, exports.evaluateGlobalGammaAllMessages(childOffsets, children, tipForNode, edgeForNode, nodeForEdge, postorder, preorder, tipStates, branchLengths, omegaModels, omegaWeights, positiveMask, neutralModel, alphaValues, alphaWeights, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, nodeCount, edgeCount, stateCount, maxNeighbors, root, poissonTerms, maxLambdaPerStep) >>> 0);
      } finally {
        __release(childOffsets);
        __release(children);
        __release(tipForNode);
        __release(edgeForNode);
        __release(nodeForEdge);
        __release(postorder);
        __release(preorder);
        __release(tipStates);
        __release(branchLengths);
        __release(omegaModels);
        __release(omegaWeights);
        __release(positiveMask);
        __release(alphaValues);
        __release(alphaWeights);
        __release(neighborCount);
        __release(neighborIndex);
        __release(rDiagonal);
        __release(rOffDiagonal);
        __release(mu);
      }
    },
    evaluateLikelihood(ops, edgeLengths, tipStates, gridModels, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, gridCount, classCount, stateCount, maxNeighbors, slotCount, rootSlot, poissonTerms, maxLambdaPerStep) {
      // assembly/index/evaluateLikelihood(~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint8Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, i32, i32, i32, f64) => ~lib/typedarray/Float64Array
      ops = __retain(__lowerTypedArray(Uint32Array, 5, 2, ops) || __notnull());
      edgeLengths = __retain(__lowerTypedArray(Float64Array, 7, 3, edgeLengths) || __notnull());
      tipStates = __retain(__lowerTypedArray(Uint8Array, 4, 0, tipStates) || __notnull());
      gridModels = __retain(__lowerTypedArray(Uint32Array, 5, 2, gridModels) || __notnull());
      neighborCount = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborCount) || __notnull());
      neighborIndex = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborIndex) || __notnull());
      rDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rDiagonal) || __notnull());
      rOffDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rOffDiagonal) || __notnull());
      mu = __retain(__lowerTypedArray(Float64Array, 7, 3, mu) || __notnull());
      equilibrium = __lowerTypedArray(Float64Array, 7, 3, equilibrium) || __notnull();
      try {
        return __liftTypedArray(Float64Array, exports.evaluateLikelihood(ops, edgeLengths, tipStates, gridModels, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, gridCount, classCount, stateCount, maxNeighbors, slotCount, rootSlot, poissonTerms, maxLambdaPerStep) >>> 0);
      } finally {
        __release(ops);
        __release(edgeLengths);
        __release(tipStates);
        __release(gridModels);
        __release(neighborCount);
        __release(neighborIndex);
        __release(rDiagonal);
        __release(rOffDiagonal);
        __release(mu);
      }
    },
    evaluateBranchMixtureLikelihood(ops, edgeLengths, tipStates, operatorOffsets, componentModels, componentWeights, operatorScales, collapseWeights, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, gridCount, operatorsPerCategory, collapseMode, stateCount, maxNeighbors, slotCount, rootSlot, poissonTerms, maxLambdaPerStep) {
      // assembly/index/evaluateBranchMixtureLikelihood(~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint8Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, i32, i32, i32, i32, f64) => ~lib/typedarray/Float64Array
      ops = __retain(__lowerTypedArray(Uint32Array, 5, 2, ops) || __notnull());
      edgeLengths = __retain(__lowerTypedArray(Float64Array, 7, 3, edgeLengths) || __notnull());
      tipStates = __retain(__lowerTypedArray(Uint8Array, 4, 0, tipStates) || __notnull());
      operatorOffsets = __retain(__lowerTypedArray(Uint32Array, 5, 2, operatorOffsets) || __notnull());
      componentModels = __retain(__lowerTypedArray(Uint32Array, 5, 2, componentModels) || __notnull());
      componentWeights = __retain(__lowerTypedArray(Float64Array, 7, 3, componentWeights) || __notnull());
      operatorScales = __retain(__lowerTypedArray(Float64Array, 7, 3, operatorScales) || __notnull());
      collapseWeights = __retain(__lowerTypedArray(Float64Array, 7, 3, collapseWeights) || __notnull());
      neighborCount = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborCount) || __notnull());
      neighborIndex = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborIndex) || __notnull());
      rDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rDiagonal) || __notnull());
      rOffDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rOffDiagonal) || __notnull());
      mu = __retain(__lowerTypedArray(Float64Array, 7, 3, mu) || __notnull());
      equilibrium = __lowerTypedArray(Float64Array, 7, 3, equilibrium) || __notnull();
      try {
        return __liftTypedArray(Float64Array, exports.evaluateBranchMixtureLikelihood(ops, edgeLengths, tipStates, operatorOffsets, componentModels, componentWeights, operatorScales, collapseWeights, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, gridCount, operatorsPerCategory, collapseMode, stateCount, maxNeighbors, slotCount, rootSlot, poissonTerms, maxLambdaPerStep) >>> 0);
      } finally {
        __release(ops);
        __release(edgeLengths);
        __release(tipStates);
        __release(operatorOffsets);
        __release(componentModels);
        __release(componentWeights);
        __release(operatorScales);
        __release(collapseWeights);
        __release(neighborCount);
        __release(neighborIndex);
        __release(rDiagonal);
        __release(rOffDiagonal);
        __release(mu);
      }
    },
    evaluateFlavorInterpolatedLikelihood(ops, edgeLengths, tipStates, operatorOffsets, componentModels, componentWeights, operatorScales, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, categoryCount, alphaCount, stateCount, maxNeighbors, slotCount, rootSlot, poissonTerms, maxLambdaPerStep, timeStep, tablePoints, tableCap) {
      // assembly/index/evaluateFlavorInterpolatedLikelihood(~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint8Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, i32, i32, i32, f64, f64, i32, i32) => ~lib/typedarray/Float64Array
      ops = __retain(__lowerTypedArray(Uint32Array, 5, 2, ops) || __notnull());
      edgeLengths = __retain(__lowerTypedArray(Float64Array, 7, 3, edgeLengths) || __notnull());
      tipStates = __retain(__lowerTypedArray(Uint8Array, 4, 0, tipStates) || __notnull());
      operatorOffsets = __retain(__lowerTypedArray(Uint32Array, 5, 2, operatorOffsets) || __notnull());
      componentModels = __retain(__lowerTypedArray(Uint32Array, 5, 2, componentModels) || __notnull());
      componentWeights = __retain(__lowerTypedArray(Float64Array, 7, 3, componentWeights) || __notnull());
      operatorScales = __retain(__lowerTypedArray(Float64Array, 7, 3, operatorScales) || __notnull());
      neighborCount = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborCount) || __notnull());
      neighborIndex = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborIndex) || __notnull());
      rDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rDiagonal) || __notnull());
      rOffDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rOffDiagonal) || __notnull());
      mu = __retain(__lowerTypedArray(Float64Array, 7, 3, mu) || __notnull());
      equilibrium = __lowerTypedArray(Float64Array, 7, 3, equilibrium) || __notnull();
      try {
        return __liftTypedArray(Float64Array, exports.evaluateFlavorInterpolatedLikelihood(ops, edgeLengths, tipStates, operatorOffsets, componentModels, componentWeights, operatorScales, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, categoryCount, alphaCount, stateCount, maxNeighbors, slotCount, rootSlot, poissonTerms, maxLambdaPerStep, timeStep, tablePoints, tableCap) >>> 0);
      } finally {
        __release(ops);
        __release(edgeLengths);
        __release(tipStates);
        __release(operatorOffsets);
        __release(componentModels);
        __release(componentWeights);
        __release(operatorScales);
        __release(neighborCount);
        __release(neighborIndex);
        __release(rDiagonal);
        __release(rOffDiagonal);
        __release(mu);
      }
    },
    evaluateBranchMixtureLikelihoodDense(ops, edgeLengths, tipStates, operatorOffsets, componentModels, componentWeights, operatorScales, collapseWeights, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, gridCount, operatorsPerCategory, collapseMode, stateCount, maxNeighbors, slotCount, rootSlot, poissonTerms, maxLambdaPerStep) {
      // assembly/index/evaluateBranchMixtureLikelihoodDense(~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint8Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, i32, i32, i32, i32, f64) => ~lib/typedarray/Float64Array
      ops = __retain(__lowerTypedArray(Uint32Array, 5, 2, ops) || __notnull());
      edgeLengths = __retain(__lowerTypedArray(Float64Array, 7, 3, edgeLengths) || __notnull());
      tipStates = __retain(__lowerTypedArray(Uint8Array, 4, 0, tipStates) || __notnull());
      operatorOffsets = __retain(__lowerTypedArray(Uint32Array, 5, 2, operatorOffsets) || __notnull());
      componentModels = __retain(__lowerTypedArray(Uint32Array, 5, 2, componentModels) || __notnull());
      componentWeights = __retain(__lowerTypedArray(Float64Array, 7, 3, componentWeights) || __notnull());
      operatorScales = __retain(__lowerTypedArray(Float64Array, 7, 3, operatorScales) || __notnull());
      collapseWeights = __retain(__lowerTypedArray(Float64Array, 7, 3, collapseWeights) || __notnull());
      neighborCount = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborCount) || __notnull());
      neighborIndex = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborIndex) || __notnull());
      rDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rDiagonal) || __notnull());
      rOffDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rOffDiagonal) || __notnull());
      mu = __retain(__lowerTypedArray(Float64Array, 7, 3, mu) || __notnull());
      equilibrium = __lowerTypedArray(Float64Array, 7, 3, equilibrium) || __notnull();
      try {
        return __liftTypedArray(Float64Array, exports.evaluateBranchMixtureLikelihoodDense(ops, edgeLengths, tipStates, operatorOffsets, componentModels, componentWeights, operatorScales, collapseWeights, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, gridCount, operatorsPerCategory, collapseMode, stateCount, maxNeighbors, slotCount, rootSlot, poissonTerms, maxLambdaPerStep) >>> 0);
      } finally {
        __release(ops);
        __release(edgeLengths);
        __release(tipStates);
        __release(operatorOffsets);
        __release(componentModels);
        __release(componentWeights);
        __release(operatorScales);
        __release(collapseWeights);
        __release(neighborCount);
        __release(neighborIndex);
        __release(rDiagonal);
        __release(rOffDiagonal);
        __release(mu);
      }
    },
    evaluateLikelihoodCached(mainOps, cacheOps, cacheDescriptors, combinationModels, combinationCategories, cacheCategoryMap, edgeLengths, tipStates, gridModels, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, gridCount, classCount, stateCount, maxNeighbors, slotCount, rootSlot, cacheCount, cacheEntryCount, poissonTerms, maxLambdaPerStep) {
      // assembly/index/evaluateLikelihoodCached(~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Uint8Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, f64) => ~lib/typedarray/Float64Array
      mainOps = __retain(__lowerTypedArray(Uint32Array, 5, 2, mainOps) || __notnull());
      cacheOps = __retain(__lowerTypedArray(Uint32Array, 5, 2, cacheOps) || __notnull());
      cacheDescriptors = __retain(__lowerTypedArray(Uint32Array, 5, 2, cacheDescriptors) || __notnull());
      combinationModels = __retain(__lowerTypedArray(Uint32Array, 5, 2, combinationModels) || __notnull());
      combinationCategories = __retain(__lowerTypedArray(Uint32Array, 5, 2, combinationCategories) || __notnull());
      cacheCategoryMap = __retain(__lowerTypedArray(Uint32Array, 5, 2, cacheCategoryMap) || __notnull());
      edgeLengths = __retain(__lowerTypedArray(Float64Array, 7, 3, edgeLengths) || __notnull());
      tipStates = __retain(__lowerTypedArray(Uint8Array, 4, 0, tipStates) || __notnull());
      gridModels = __retain(__lowerTypedArray(Uint32Array, 5, 2, gridModels) || __notnull());
      neighborCount = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborCount) || __notnull());
      neighborIndex = __retain(__lowerTypedArray(Uint32Array, 5, 2, neighborIndex) || __notnull());
      rDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rDiagonal) || __notnull());
      rOffDiagonal = __retain(__lowerTypedArray(Float64Array, 7, 3, rOffDiagonal) || __notnull());
      mu = __retain(__lowerTypedArray(Float64Array, 7, 3, mu) || __notnull());
      equilibrium = __lowerTypedArray(Float64Array, 7, 3, equilibrium) || __notnull();
      try {
        return __liftTypedArray(Float64Array, exports.evaluateLikelihoodCached(mainOps, cacheOps, cacheDescriptors, combinationModels, combinationCategories, cacheCategoryMap, edgeLengths, tipStates, gridModels, neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, equilibrium, siteCount, gridCount, classCount, stateCount, maxNeighbors, slotCount, rootSlot, cacheCount, cacheEntryCount, poissonTerms, maxLambdaPerStep) >>> 0);
      } finally {
        __release(mainOps);
        __release(cacheOps);
        __release(cacheDescriptors);
        __release(combinationModels);
        __release(combinationCategories);
        __release(cacheCategoryMap);
        __release(edgeLengths);
        __release(tipStates);
        __release(gridModels);
        __release(neighborCount);
        __release(neighborIndex);
        __release(rDiagonal);
        __release(rOffDiagonal);
        __release(mu);
      }
    },
    runWeightEM(categoryMajorConditionals, initialTheta, gridCount, siteCount, iterations, concentration, tolerance) {
      // assembly/index/runWeightEM(~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, f64, f64) => ~lib/typedarray/Float64Array
      categoryMajorConditionals = __retain(__lowerTypedArray(Float64Array, 7, 3, categoryMajorConditionals) || __notnull());
      initialTheta = __lowerTypedArray(Float64Array, 7, 3, initialTheta) || __notnull();
      try {
        return __liftTypedArray(Float64Array, exports.runWeightEM(categoryMajorConditionals, initialTheta, gridCount, siteCount, iterations, concentration, tolerance) >>> 0);
      } finally {
        __release(categoryMajorConditionals);
      }
    },
    runGibbs(siteMajorConditionals, categories, gridCount, siteCount, parameterCount, iterations, burnin, concentration, seed, likelihoodCutoff, trackAllocations) {
      // assembly/index/runGibbs(~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, f64, u32, f64, bool) => ~lib/typedarray/Float64Array
      siteMajorConditionals = __retain(__lowerTypedArray(Float64Array, 7, 3, siteMajorConditionals) || __notnull());
      categories = __lowerTypedArray(Float64Array, 7, 3, categories) || __notnull();
      trackAllocations = trackAllocations ? 1 : 0;
      try {
        return __liftTypedArray(Float64Array, exports.runGibbs(siteMajorConditionals, categories, gridCount, siteCount, parameterCount, iterations, burnin, concentration, seed, likelihoodCutoff, trackAllocations) >>> 0);
      } finally {
        __release(siteMajorConditionals);
      }
    },
    runGibbsRejection(categoryMajorConditionals, categories, gridCount, siteCount, parameterCount, iterations, burnin, concentration, seed, likelihoodCutoff, trackAllocations) {
      // assembly/index/runGibbsRejection(~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, f64, u32, f64, bool) => ~lib/typedarray/Float64Array
      categoryMajorConditionals = __retain(__lowerTypedArray(Float64Array, 7, 3, categoryMajorConditionals) || __notnull());
      categories = __lowerTypedArray(Float64Array, 7, 3, categories) || __notnull();
      trackAllocations = trackAllocations ? 1 : 0;
      try {
        return __liftTypedArray(Float64Array, exports.runGibbsRejection(categoryMajorConditionals, categories, gridCount, siteCount, parameterCount, iterations, burnin, concentration, seed, likelihoodCutoff, trackAllocations) >>> 0);
      } finally {
        __release(categoryMajorConditionals);
      }
    },
    runFubarGibbsRejection(categoryMajorConditionals, categories, gridCount, siteCount, iterations, burnin, concentration, seed, trackAllocations) {
      // assembly/index/runFubarGibbsRejection(~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, f64, u32, bool) => ~lib/typedarray/Float64Array
      categoryMajorConditionals = __retain(__lowerTypedArray(Float64Array, 7, 3, categoryMajorConditionals) || __notnull());
      categories = __lowerTypedArray(Float64Array, 7, 3, categories) || __notnull();
      trackAllocations = trackAllocations ? 1 : 0;
      try {
        return __liftTypedArray(Float64Array, exports.runFubarGibbsRejection(categoryMajorConditionals, categories, gridCount, siteCount, iterations, burnin, concentration, seed, trackAllocations) >>> 0);
      } finally {
        __release(categoryMajorConditionals);
      }
    },
    runGibbsSparse(conditionalValues, siteOffsets, categoryIndices, categories, gridCount, siteCount, parameterCount, iterations, burnin, concentration, seed, trackAllocations) {
      // assembly/index/runGibbsSparse(~lib/typedarray/Float64Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Uint32Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, f64, u32, bool) => ~lib/typedarray/Float64Array
      conditionalValues = __retain(__lowerTypedArray(Float64Array, 7, 3, conditionalValues) || __notnull());
      siteOffsets = __retain(__lowerTypedArray(Uint32Array, 5, 2, siteOffsets) || __notnull());
      categoryIndices = __retain(__lowerTypedArray(Uint32Array, 5, 2, categoryIndices) || __notnull());
      categories = __lowerTypedArray(Float64Array, 7, 3, categories) || __notnull();
      trackAllocations = trackAllocations ? 1 : 0;
      try {
        return __liftTypedArray(Float64Array, exports.runGibbsSparse(conditionalValues, siteOffsets, categoryIndices, categories, gridCount, siteCount, parameterCount, iterations, burnin, concentration, seed, trackAllocations) >>> 0);
      } finally {
        __release(conditionalValues);
        __release(siteOffsets);
        __release(categoryIndices);
      }
    },
    runCollapsedGibbs(siteMajorConditionals, categories, gridCount, siteCount, parameterCount, iterations, burnin, concentration, seed, trackAllocations) {
      // assembly/index/runCollapsedGibbs(~lib/typedarray/Float64Array, ~lib/typedarray/Float64Array, i32, i32, i32, i32, i32, f64, u32, bool) => ~lib/typedarray/Float64Array
      siteMajorConditionals = __retain(__lowerTypedArray(Float64Array, 7, 3, siteMajorConditionals) || __notnull());
      categories = __lowerTypedArray(Float64Array, 7, 3, categories) || __notnull();
      trackAllocations = trackAllocations ? 1 : 0;
      try {
        return __liftTypedArray(Float64Array, exports.runCollapsedGibbs(siteMajorConditionals, categories, gridCount, siteCount, parameterCount, iterations, burnin, concentration, seed, trackAllocations) >>> 0);
      } finally {
        __release(siteMajorConditionals);
      }
    },
    getLastAllocations() {
      // assembly/index/getLastAllocations() => ~lib/typedarray/Uint32Array
      return __liftTypedArray(Uint32Array, exports.getLastAllocations() >>> 0);
    },
  }, exports);
  function __liftString(pointer) {
    if (!pointer) return null;
    const
      end = pointer + new Uint32Array(memory.buffer)[pointer - 4 >>> 2] >>> 1,
      memoryU16 = new Uint16Array(memory.buffer);
    let
      start = pointer >>> 1,
      string = "";
    while (end - start > 1024) string += String.fromCharCode(...memoryU16.subarray(start, start += 1024));
    return string + String.fromCharCode(...memoryU16.subarray(start, end));
  }
  function __liftTypedArray(constructor, pointer) {
    if (!pointer) return null;
    return new constructor(
      memory.buffer,
      __getU32(pointer + 4),
      __dataview.getUint32(pointer + 8, true) / constructor.BYTES_PER_ELEMENT
    ).slice();
  }
  function __lowerTypedArray(constructor, id, align, values) {
    if (values == null) return 0;
    const
      length = values.length,
      buffer = exports.__pin(exports.__new(length << align, 1)) >>> 0,
      header = exports.__new(12, id) >>> 0;
    __setU32(header + 0, buffer);
    __dataview.setUint32(header + 4, buffer, true);
    __dataview.setUint32(header + 8, length << align, true);
    new constructor(memory.buffer, buffer, length).set(values);
    exports.__unpin(buffer);
    return header;
  }
  const refcounts = new Map();
  function __retain(pointer) {
    if (pointer) {
      const refcount = refcounts.get(pointer);
      if (refcount) refcounts.set(pointer, refcount + 1);
      else refcounts.set(exports.__pin(pointer), 1);
    }
    return pointer;
  }
  function __release(pointer) {
    if (pointer) {
      const refcount = refcounts.get(pointer);
      if (refcount === 1) exports.__unpin(pointer), refcounts.delete(pointer);
      else if (refcount) refcounts.set(pointer, refcount - 1);
      else throw Error(`invalid refcount '${refcount}' for reference '${pointer}'`);
    }
  }
  function __notnull() {
    throw TypeError("value must not be null");
  }
  let __dataview = new DataView(memory.buffer);
  function __setU32(pointer, value) {
    try {
      __dataview.setUint32(pointer, value, true);
    } catch {
      __dataview = new DataView(memory.buffer);
      __dataview.setUint32(pointer, value, true);
    }
  }
  function __getU32(pointer) {
    try {
      return __dataview.getUint32(pointer, true);
    } catch {
      __dataview = new DataView(memory.buffer);
      return __dataview.getUint32(pointer, true);
    }
  }
  return adaptedExports;
}
