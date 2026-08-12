/** One workgroup lane per possible DNA codon; inactive stop-codon lanes are masked. */
export const GPU_STATE_COUNT = 64;
export const GPU_WORKGROUP_SIZE = 64;
export const GPU_MAX_SLOTS = 24;

export function likelihoodShader(): string {
  return /* wgsl */ `
struct Parameters {
  site_offset: u32,
  site_count: u32,
  total_site_count: u32,
  grid_count: u32,

  class_count: u32,
  op_count: u32,
  state_count: u32,
  max_neighbors: u32,

  slot_count: u32,
  root_slot: u32,
  poisson_terms: u32,
  tip_count: u32,

  ops_offset: u32,
  edges_offset: u32,
  neighbor_count_offset: u32,
  neighbor_index_offset: u32,

  equilibrium_offset: u32,
  grid_models_offset: u32,
  diagonal_offset: u32,
  rates_offset: u32,

  mu_offset: u32,
  model_count: u32,
  _padding0: u32,
  _padding1: u32,

  max_lambda_per_step: f32,
  _padding2: f32,
  _padding3: f32,
  _padding4: f32,
}

@group(0) @binding(0) var<uniform> parameters: Parameters;
@group(0) @binding(1) var<storage, read> metadata: array<u32>;
@group(0) @binding(2) var<storage, read> model_data: array<u32>;
@group(0) @binding(3) var<storage, read> packed_tips: array<u32>;
@group(0) @binding(4) var<storage, read_write> output: array<f32>;

var<workgroup> likelihood: array<f32, ${GPU_MAX_SLOTS * GPU_WORKGROUP_SIZE}>;
var<workgroup> log_scale: array<f32, ${GPU_MAX_SLOTS}>;
var<workgroup> transition_a: array<f32, ${GPU_WORKGROUP_SIZE}>;
var<workgroup> transition_b: array<f32, ${GPU_WORKGROUP_SIZE}>;
var<workgroup> transition_sum: array<f32, ${GPU_WORKGROUP_SIZE}>;
var<workgroup> reduction: array<f32, ${GPU_WORKGROUP_SIZE}>;

fn model_f32(offset: u32) -> f32 {
  return bitcast<f32>(model_data[offset]);
}

fn metadata_f32(offset: u32) -> f32 {
  return bitcast<f32>(metadata[offset]);
}

fn tip_state(tip: u32, local_site: u32) -> u32 {
  let linear = tip * parameters.site_count + local_site;
  let word = packed_tips[linear >> 2u];
  return (word >> ((linear & 3u) << 3u)) & 255u;
}

fn propagate(slot: u32, branch_length: f32, model: u32, state: u32) {
  if (branch_length == 0.0) {
    workgroupBarrier();
    return;
  }
  let valid_state = state < parameters.state_count;
  let value_offset = slot * ${GPU_WORKGROUP_SIZE}u;
  let lambda = model_f32(parameters.mu_offset + model) * branch_length;
  let adaptive = parameters.poisson_terms == 0u;
  let segment_limit = select(parameters.max_lambda_per_step, min(parameters.max_lambda_per_step, 64.0), adaptive);
  let steps = max(1u, u32(ceil(lambda / segment_limit)));
  let step_lambda = lambda / f32(steps);
  let diagonal_offset = parameters.diagonal_offset + model * parameters.state_count;
  let model_rate_offset = parameters.rates_offset + model * parameters.state_count * parameters.max_neighbors;

  for (var segment = 0u; segment < steps; segment += 1u) {
    let initial = select(0.0, likelihood[value_offset + state], valid_state);
    let initial_weight = exp(-step_lambda);
    transition_a[state] = initial;
    transition_sum[state] = initial_weight * initial;
    workgroupBarrier();

    var weight = initial_weight;
    var cumulative_weight = initial_weight;
    let maximum_terms = select(parameters.poisson_terms, 256u, adaptive);
    for (var term = 1u; term <= maximum_terms; term += 1u) {
      var next_value = 0.0;
      if (valid_state) {
        next_value = model_f32(diagonal_offset + state) * transition_a[state];
        let count = metadata[parameters.neighbor_count_offset + state];
        let topology_offset = state * parameters.max_neighbors;
        let rate_offset = model_rate_offset + topology_offset;
        for (var neighbor = 0u; neighbor < count; neighbor += 1u) {
          let neighbor_state = metadata[parameters.neighbor_index_offset + topology_offset + neighbor];
          next_value += model_f32(rate_offset + neighbor) * transition_a[neighbor_state];
        }
      }
      transition_b[state] = next_value;
      workgroupBarrier();
      weight *= step_lambda / f32(term);
      cumulative_weight += weight;
      transition_sum[state] += weight * transition_b[state];
      transition_a[state] = transition_b[state];
      workgroupBarrier();
      if (adaptive && f32(term) > step_lambda && 1.0 - cumulative_weight <= 1e-6) { break; }
    }
    if (valid_state) {
      likelihood[value_offset + state] = transition_sum[state];
    }
    workgroupBarrier();
  }
}

fn reduce_sum(state: u32) -> f32 {
  workgroupBarrier();
  var stride = ${GPU_WORKGROUP_SIZE / 2}u;
  loop {
    if (state < stride) {
      reduction[state] += reduction[state + stride];
    }
    workgroupBarrier();
    if (stride == 1u) { break; }
    stride >>= 1u;
  }
  return reduction[0];
}

@compute @workgroup_size(${GPU_WORKGROUP_SIZE}, 1, 1)
fn main(
  @builtin(local_invocation_id) local_id: vec3<u32>,
  @builtin(workgroup_id) group_id: vec3<u32>,
) {
  let state = local_id.x;
  let local_site = group_id.x;
  let category = group_id.y;
  if (local_site >= parameters.site_count || category >= parameters.grid_count) { return; }
  let valid_state = state < parameters.state_count;

  for (var operation = 0u; operation < parameters.op_count; operation += 1u) {
    let offset = parameters.ops_offset + operation * 4u;
    let opcode = metadata[offset];
    let a = metadata[offset + 1u];
    let b = metadata[offset + 2u];
    let payload = metadata[offset + 3u];
    if (opcode == 0u) {
      let observed = tip_state(payload, local_site);
      var compatible = observed == 255u || observed == state;
      if (observed != 255u && (observed & 128u) != 0u && state < 32u) {
        compatible = ((observed & 15u) & (1u << state)) != 0u;
      }
      likelihood[a * ${GPU_WORKGROUP_SIZE}u + state] = select(0.0, 1.0, valid_state && compatible);
      if (state == 0u) { log_scale[a] = 0.0; }
      workgroupBarrier();
    } else if (opcode == 1u) {
      let model = model_data[parameters.grid_models_offset + category * parameters.class_count + b];
      propagate(a, metadata_f32(parameters.edges_offset + payload), model, state);
    } else if (opcode == 2u) {
      let a_offset = a * ${GPU_WORKGROUP_SIZE}u;
      let b_offset = b * ${GPU_WORKGROUP_SIZE}u;
      let product = select(0.0, likelihood[a_offset + state] * likelihood[b_offset + state], valid_state);
      if (valid_state) { likelihood[a_offset + state] = product; }
      reduction[state] = product;
      if (state == 0u) { log_scale[a] += log_scale[b]; }
      let sum = reduce_sum(state);
      if (valid_state && sum > 0.0) { likelihood[a_offset + state] /= sum; }
      if (state == 0u) {
        log_scale[a] = select(-3.402823466e38, log_scale[a] + log(sum), sum > 0.0);
      }
      workgroupBarrier();
    }
  }

  let root_offset = parameters.root_slot * ${GPU_WORKGROUP_SIZE}u;
  if (valid_state) {
    reduction[state] = likelihood[root_offset + state] * metadata_f32(parameters.equilibrium_offset + state);
  } else {
    reduction[state] = 0.0;
  }
  let root_sum = reduce_sum(state);
  if (state == 0u) {
    let result = select(-3.402823466e38, log_scale[parameters.root_slot] + log(root_sum), root_sum > 0.0);
    output[category * parameters.site_count + local_site] = result;
  }
}
`;
}
