declare namespace __AdaptedExports {
  /** Exported memory */
  export const memory: WebAssembly.Memory;
  // Exported runtime interface
  export function __new(size: number, id: number): number;
  export function __pin(ptr: number): number;
  export function __unpin(ptr: number): void;
  export function __collect(): void;
  export const __rtti_base: number;
  /** assembly/index/Uint8Array_ID */
  export const Uint8Array_ID: {
    /** @type `u32` */
    get value(): number
  };
  /** assembly/index/Uint32Array_ID */
  export const Uint32Array_ID: {
    /** @type `u32` */
    get value(): number
  };
  /** assembly/index/Int32Array_ID */
  export const Int32Array_ID: {
    /** @type `u32` */
    get value(): number
  };
  /** assembly/index/Float64Array_ID */
  export const Float64Array_ID: {
    /** @type `u32` */
    get value(): number
  };
  /**
   * assembly/index/evaluateBsrelAllMessages
   * @param childOffsets `~lib/typedarray/Uint32Array`
   * @param children `~lib/typedarray/Uint32Array`
   * @param tipForNode `~lib/typedarray/Int32Array`
   * @param edgeForNode `~lib/typedarray/Int32Array`
   * @param nodeForEdge `~lib/typedarray/Uint32Array`
   * @param postorder `~lib/typedarray/Uint32Array`
   * @param preorder `~lib/typedarray/Uint32Array`
   * @param tipStates `~lib/typedarray/Uint8Array`
   * @param branchLengths `~lib/typedarray/Float64Array`
   * @param branchModels `~lib/typedarray/Uint32Array`
   * @param branchWeights `~lib/typedarray/Float64Array`
   * @param candidateBranches `~lib/typedarray/Uint32Array`
   * @param candidateLengths `~lib/typedarray/Float64Array`
   * @param candidateModels `~lib/typedarray/Uint32Array`
   * @param candidateWeights `~lib/typedarray/Float64Array`
   * @param neighborCount `~lib/typedarray/Uint32Array`
   * @param neighborIndex `~lib/typedarray/Uint32Array`
   * @param rDiagonal `~lib/typedarray/Float64Array`
   * @param rOffDiagonal `~lib/typedarray/Float64Array`
   * @param mu `~lib/typedarray/Float64Array`
   * @param equilibrium `~lib/typedarray/Float64Array`
   * @param siteCount `i32`
   * @param nodeCount `i32`
   * @param edgeCount `i32`
   * @param stateCount `i32`
   * @param maxNeighbors `i32`
   * @param root `i32`
   * @param poissonTerms `i32`
   * @param maxLambdaPerStep `f64`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function evaluateBsrelAllMessages(childOffsets: Uint32Array, children: Uint32Array, tipForNode: Int32Array, edgeForNode: Int32Array, nodeForEdge: Uint32Array, postorder: Uint32Array, preorder: Uint32Array, tipStates: Uint8Array, branchLengths: Float64Array, branchModels: Uint32Array, branchWeights: Float64Array, candidateBranches: Uint32Array, candidateLengths: Float64Array, candidateModels: Uint32Array, candidateWeights: Float64Array, neighborCount: Uint32Array, neighborIndex: Uint32Array, rDiagonal: Float64Array, rOffDiagonal: Float64Array, mu: Float64Array, equilibrium: Float64Array, siteCount: number, nodeCount: number, edgeCount: number, stateCount: number, maxNeighbors: number, root: number, poissonTerms: number, maxLambdaPerStep: number): Float64Array;
  /**
   * assembly/index/evaluateGlobalGammaAllMessages
   * @param childOffsets `~lib/typedarray/Uint32Array`
   * @param children `~lib/typedarray/Uint32Array`
   * @param tipForNode `~lib/typedarray/Int32Array`
   * @param edgeForNode `~lib/typedarray/Int32Array`
   * @param nodeForEdge `~lib/typedarray/Uint32Array`
   * @param postorder `~lib/typedarray/Uint32Array`
   * @param preorder `~lib/typedarray/Uint32Array`
   * @param tipStates `~lib/typedarray/Uint8Array`
   * @param branchLengths `~lib/typedarray/Float64Array`
   * @param omegaModels `~lib/typedarray/Uint32Array`
   * @param omegaWeights `~lib/typedarray/Float64Array`
   * @param positiveMask `~lib/typedarray/Uint8Array`
   * @param neutralModel `i32`
   * @param alphaValues `~lib/typedarray/Float64Array`
   * @param alphaWeights `~lib/typedarray/Float64Array`
   * @param neighborCount `~lib/typedarray/Uint32Array`
   * @param neighborIndex `~lib/typedarray/Uint32Array`
   * @param rDiagonal `~lib/typedarray/Float64Array`
   * @param rOffDiagonal `~lib/typedarray/Float64Array`
   * @param mu `~lib/typedarray/Float64Array`
   * @param equilibrium `~lib/typedarray/Float64Array`
   * @param siteCount `i32`
   * @param nodeCount `i32`
   * @param edgeCount `i32`
   * @param stateCount `i32`
   * @param maxNeighbors `i32`
   * @param root `i32`
   * @param poissonTerms `i32`
   * @param maxLambdaPerStep `f64`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function evaluateGlobalGammaAllMessages(childOffsets: Uint32Array, children: Uint32Array, tipForNode: Int32Array, edgeForNode: Int32Array, nodeForEdge: Uint32Array, postorder: Uint32Array, preorder: Uint32Array, tipStates: Uint8Array, branchLengths: Float64Array, omegaModels: Uint32Array, omegaWeights: Float64Array, positiveMask: Uint8Array, neutralModel: number, alphaValues: Float64Array, alphaWeights: Float64Array, neighborCount: Uint32Array, neighborIndex: Uint32Array, rDiagonal: Float64Array, rOffDiagonal: Float64Array, mu: Float64Array, equilibrium: Float64Array, siteCount: number, nodeCount: number, edgeCount: number, stateCount: number, maxNeighbors: number, root: number, poissonTerms: number, maxLambdaPerStep: number): Float64Array;
  /**
   * assembly/index/evaluateLikelihood
   * @param ops `~lib/typedarray/Uint32Array`
   * @param edgeLengths `~lib/typedarray/Float64Array`
   * @param tipStates `~lib/typedarray/Uint8Array`
   * @param gridModels `~lib/typedarray/Uint32Array`
   * @param neighborCount `~lib/typedarray/Uint32Array`
   * @param neighborIndex `~lib/typedarray/Uint32Array`
   * @param rDiagonal `~lib/typedarray/Float64Array`
   * @param rOffDiagonal `~lib/typedarray/Float64Array`
   * @param mu `~lib/typedarray/Float64Array`
   * @param equilibrium `~lib/typedarray/Float64Array`
   * @param siteCount `i32`
   * @param gridCount `i32`
   * @param classCount `i32`
   * @param stateCount `i32`
   * @param maxNeighbors `i32`
   * @param slotCount `i32`
   * @param rootSlot `i32`
   * @param poissonTerms `i32`
   * @param maxLambdaPerStep `f64`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function evaluateLikelihood(ops: Uint32Array, edgeLengths: Float64Array, tipStates: Uint8Array, gridModels: Uint32Array, neighborCount: Uint32Array, neighborIndex: Uint32Array, rDiagonal: Float64Array, rOffDiagonal: Float64Array, mu: Float64Array, equilibrium: Float64Array, siteCount: number, gridCount: number, classCount: number, stateCount: number, maxNeighbors: number, slotCount: number, rootSlot: number, poissonTerms: number, maxLambdaPerStep: number): Float64Array;
  /**
   * assembly/index/evaluateBranchMixtureLikelihood
   * @param ops `~lib/typedarray/Uint32Array`
   * @param edgeLengths `~lib/typedarray/Float64Array`
   * @param tipStates `~lib/typedarray/Uint8Array`
   * @param operatorOffsets `~lib/typedarray/Uint32Array`
   * @param componentModels `~lib/typedarray/Uint32Array`
   * @param componentWeights `~lib/typedarray/Float64Array`
   * @param operatorScales `~lib/typedarray/Float64Array`
   * @param collapseWeights `~lib/typedarray/Float64Array`
   * @param neighborCount `~lib/typedarray/Uint32Array`
   * @param neighborIndex `~lib/typedarray/Uint32Array`
   * @param rDiagonal `~lib/typedarray/Float64Array`
   * @param rOffDiagonal `~lib/typedarray/Float64Array`
   * @param mu `~lib/typedarray/Float64Array`
   * @param equilibrium `~lib/typedarray/Float64Array`
   * @param siteCount `i32`
   * @param gridCount `i32`
   * @param operatorsPerCategory `i32`
   * @param collapseMode `i32`
   * @param stateCount `i32`
   * @param maxNeighbors `i32`
   * @param slotCount `i32`
   * @param rootSlot `i32`
   * @param poissonTerms `i32`
   * @param maxLambdaPerStep `f64`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function evaluateBranchMixtureLikelihood(ops: Uint32Array, edgeLengths: Float64Array, tipStates: Uint8Array, operatorOffsets: Uint32Array, componentModels: Uint32Array, componentWeights: Float64Array, operatorScales: Float64Array, collapseWeights: Float64Array, neighborCount: Uint32Array, neighborIndex: Uint32Array, rDiagonal: Float64Array, rOffDiagonal: Float64Array, mu: Float64Array, equilibrium: Float64Array, siteCount: number, gridCount: number, operatorsPerCategory: number, collapseMode: number, stateCount: number, maxNeighbors: number, slotCount: number, rootSlot: number, poissonTerms: number, maxLambdaPerStep: number): Float64Array;
  /**
   * assembly/index/evaluateFlavorInterpolatedLikelihood
   * @param ops `~lib/typedarray/Uint32Array`
   * @param edgeLengths `~lib/typedarray/Float64Array`
   * @param tipStates `~lib/typedarray/Uint8Array`
   * @param operatorOffsets `~lib/typedarray/Uint32Array`
   * @param componentModels `~lib/typedarray/Uint32Array`
   * @param componentWeights `~lib/typedarray/Float64Array`
   * @param operatorScales `~lib/typedarray/Float64Array`
   * @param neighborCount `~lib/typedarray/Uint32Array`
   * @param neighborIndex `~lib/typedarray/Uint32Array`
   * @param rDiagonal `~lib/typedarray/Float64Array`
   * @param rOffDiagonal `~lib/typedarray/Float64Array`
   * @param mu `~lib/typedarray/Float64Array`
   * @param equilibrium `~lib/typedarray/Float64Array`
   * @param siteCount `i32`
   * @param categoryCount `i32`
   * @param alphaCount `i32`
   * @param stateCount `i32`
   * @param maxNeighbors `i32`
   * @param slotCount `i32`
   * @param rootSlot `i32`
   * @param poissonTerms `i32`
   * @param maxLambdaPerStep `f64`
   * @param timeStep `f64`
   * @param tablePoints `i32`
   * @param tableCap `i32`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function evaluateFlavorInterpolatedLikelihood(ops: Uint32Array, edgeLengths: Float64Array, tipStates: Uint8Array, operatorOffsets: Uint32Array, componentModels: Uint32Array, componentWeights: Float64Array, operatorScales: Float64Array, neighborCount: Uint32Array, neighborIndex: Uint32Array, rDiagonal: Float64Array, rOffDiagonal: Float64Array, mu: Float64Array, equilibrium: Float64Array, siteCount: number, categoryCount: number, alphaCount: number, stateCount: number, maxNeighbors: number, slotCount: number, rootSlot: number, poissonTerms: number, maxLambdaPerStep: number, timeStep: number, tablePoints: number, tableCap: number): Float64Array;
  /**
   * assembly/index/evaluateBranchMixtureLikelihoodDense
   * @param ops `~lib/typedarray/Uint32Array`
   * @param edgeLengths `~lib/typedarray/Float64Array`
   * @param tipStates `~lib/typedarray/Uint8Array`
   * @param operatorOffsets `~lib/typedarray/Uint32Array`
   * @param componentModels `~lib/typedarray/Uint32Array`
   * @param componentWeights `~lib/typedarray/Float64Array`
   * @param operatorScales `~lib/typedarray/Float64Array`
   * @param collapseWeights `~lib/typedarray/Float64Array`
   * @param neighborCount `~lib/typedarray/Uint32Array`
   * @param neighborIndex `~lib/typedarray/Uint32Array`
   * @param rDiagonal `~lib/typedarray/Float64Array`
   * @param rOffDiagonal `~lib/typedarray/Float64Array`
   * @param mu `~lib/typedarray/Float64Array`
   * @param equilibrium `~lib/typedarray/Float64Array`
   * @param siteCount `i32`
   * @param gridCount `i32`
   * @param operatorsPerCategory `i32`
   * @param collapseMode `i32`
   * @param stateCount `i32`
   * @param maxNeighbors `i32`
   * @param slotCount `i32`
   * @param rootSlot `i32`
   * @param poissonTerms `i32`
   * @param maxLambdaPerStep `f64`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function evaluateBranchMixtureLikelihoodDense(ops: Uint32Array, edgeLengths: Float64Array, tipStates: Uint8Array, operatorOffsets: Uint32Array, componentModels: Uint32Array, componentWeights: Float64Array, operatorScales: Float64Array, collapseWeights: Float64Array, neighborCount: Uint32Array, neighborIndex: Uint32Array, rDiagonal: Float64Array, rOffDiagonal: Float64Array, mu: Float64Array, equilibrium: Float64Array, siteCount: number, gridCount: number, operatorsPerCategory: number, collapseMode: number, stateCount: number, maxNeighbors: number, slotCount: number, rootSlot: number, poissonTerms: number, maxLambdaPerStep: number): Float64Array;
  /**
   * assembly/index/evaluateLikelihoodCached
   * @param mainOps `~lib/typedarray/Uint32Array`
   * @param cacheOps `~lib/typedarray/Uint32Array`
   * @param cacheDescriptors `~lib/typedarray/Uint32Array`
   * @param combinationModels `~lib/typedarray/Uint32Array`
   * @param combinationCategories `~lib/typedarray/Uint32Array`
   * @param cacheCategoryMap `~lib/typedarray/Uint32Array`
   * @param edgeLengths `~lib/typedarray/Float64Array`
   * @param tipStates `~lib/typedarray/Uint8Array`
   * @param gridModels `~lib/typedarray/Uint32Array`
   * @param neighborCount `~lib/typedarray/Uint32Array`
   * @param neighborIndex `~lib/typedarray/Uint32Array`
   * @param rDiagonal `~lib/typedarray/Float64Array`
   * @param rOffDiagonal `~lib/typedarray/Float64Array`
   * @param mu `~lib/typedarray/Float64Array`
   * @param equilibrium `~lib/typedarray/Float64Array`
   * @param siteCount `i32`
   * @param gridCount `i32`
   * @param classCount `i32`
   * @param stateCount `i32`
   * @param maxNeighbors `i32`
   * @param slotCount `i32`
   * @param rootSlot `i32`
   * @param cacheCount `i32`
   * @param cacheEntryCount `i32`
   * @param poissonTerms `i32`
   * @param maxLambdaPerStep `f64`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function evaluateLikelihoodCached(mainOps: Uint32Array, cacheOps: Uint32Array, cacheDescriptors: Uint32Array, combinationModels: Uint32Array, combinationCategories: Uint32Array, cacheCategoryMap: Uint32Array, edgeLengths: Float64Array, tipStates: Uint8Array, gridModels: Uint32Array, neighborCount: Uint32Array, neighborIndex: Uint32Array, rDiagonal: Float64Array, rOffDiagonal: Float64Array, mu: Float64Array, equilibrium: Float64Array, siteCount: number, gridCount: number, classCount: number, stateCount: number, maxNeighbors: number, slotCount: number, rootSlot: number, cacheCount: number, cacheEntryCount: number, poissonTerms: number, maxLambdaPerStep: number): Float64Array;
  /**
   * assembly/index/runWeightEM
   * @param categoryMajorConditionals `~lib/typedarray/Float64Array`
   * @param initialTheta `~lib/typedarray/Float64Array`
   * @param gridCount `i32`
   * @param siteCount `i32`
   * @param iterations `i32`
   * @param concentration `f64`
   * @param tolerance `f64`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function runWeightEM(categoryMajorConditionals: Float64Array, initialTheta: Float64Array, gridCount: number, siteCount: number, iterations: number, concentration: number, tolerance: number): Float64Array;
  /**
   * assembly/index/runGibbs
   * @param siteMajorConditionals `~lib/typedarray/Float64Array`
   * @param categories `~lib/typedarray/Float64Array`
   * @param gridCount `i32`
   * @param siteCount `i32`
   * @param parameterCount `i32`
   * @param iterations `i32`
   * @param burnin `i32`
   * @param concentration `f64`
   * @param seed `u32`
   * @param likelihoodCutoff `f64`
   * @param trackAllocations `bool`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function runGibbs(siteMajorConditionals: Float64Array, categories: Float64Array, gridCount: number, siteCount: number, parameterCount: number, iterations: number, burnin: number, concentration: number, seed: number, likelihoodCutoff: number, trackAllocations: boolean): Float64Array;
  /**
   * assembly/index/runGibbsRejection
   * @param categoryMajorConditionals `~lib/typedarray/Float64Array`
   * @param categories `~lib/typedarray/Float64Array`
   * @param gridCount `i32`
   * @param siteCount `i32`
   * @param parameterCount `i32`
   * @param iterations `i32`
   * @param burnin `i32`
   * @param concentration `f64`
   * @param seed `u32`
   * @param likelihoodCutoff `f64`
   * @param trackAllocations `bool`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function runGibbsRejection(categoryMajorConditionals: Float64Array, categories: Float64Array, gridCount: number, siteCount: number, parameterCount: number, iterations: number, burnin: number, concentration: number, seed: number, likelihoodCutoff: number, trackAllocations: boolean): Float64Array;
  /**
   * assembly/index/runFubarGibbsRejection
   * @param categoryMajorConditionals `~lib/typedarray/Float64Array`
   * @param categories `~lib/typedarray/Float64Array`
   * @param gridCount `i32`
   * @param siteCount `i32`
   * @param iterations `i32`
   * @param burnin `i32`
   * @param concentration `f64`
   * @param seed `u32`
   * @param trackAllocations `bool`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function runFubarGibbsRejection(categoryMajorConditionals: Float64Array, categories: Float64Array, gridCount: number, siteCount: number, iterations: number, burnin: number, concentration: number, seed: number, trackAllocations: boolean): Float64Array;
  /**
   * assembly/index/runGibbsSparse
   * @param conditionalValues `~lib/typedarray/Float64Array`
   * @param siteOffsets `~lib/typedarray/Uint32Array`
   * @param categoryIndices `~lib/typedarray/Uint32Array`
   * @param categories `~lib/typedarray/Float64Array`
   * @param gridCount `i32`
   * @param siteCount `i32`
   * @param parameterCount `i32`
   * @param iterations `i32`
   * @param burnin `i32`
   * @param concentration `f64`
   * @param seed `u32`
   * @param trackAllocations `bool`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function runGibbsSparse(conditionalValues: Float64Array, siteOffsets: Uint32Array, categoryIndices: Uint32Array, categories: Float64Array, gridCount: number, siteCount: number, parameterCount: number, iterations: number, burnin: number, concentration: number, seed: number, trackAllocations: boolean): Float64Array;
  /**
   * assembly/index/runCollapsedGibbs
   * @param siteMajorConditionals `~lib/typedarray/Float64Array`
   * @param categories `~lib/typedarray/Float64Array`
   * @param gridCount `i32`
   * @param siteCount `i32`
   * @param parameterCount `i32`
   * @param iterations `i32`
   * @param burnin `i32`
   * @param concentration `f64`
   * @param seed `u32`
   * @param trackAllocations `bool`
   * @returns `~lib/typedarray/Float64Array`
   */
  export function runCollapsedGibbs(siteMajorConditionals: Float64Array, categories: Float64Array, gridCount: number, siteCount: number, parameterCount: number, iterations: number, burnin: number, concentration: number, seed: number, trackAllocations: boolean): Float64Array;
  /**
   * assembly/index/getLastAllocations
   * @returns `~lib/typedarray/Uint32Array`
   */
  export function getLastAllocations(): Uint32Array;
}
/** Instantiates the compiled WebAssembly module with the given imports. */
export declare function instantiate(module: WebAssembly.Module, imports: {
  env: unknown,
}): Promise<typeof __AdaptedExports>;
