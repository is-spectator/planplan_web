export type AiProvider = 'qwen' | 'openrouter';

export interface AiModelProfile {
  readonly id: string;
  readonly supportsResponseFormat: boolean;
  readonly syntheticOnly: boolean;
  readonly providerOnly?: readonly string[];
  readonly reasoning?: Readonly<{ enabled: false }>;
}

const standardProfile: AiModelProfile = Object.freeze({ id: 'standard-v1', supportsResponseFormat: true, syntheticOnly: false });
const baiduProfile: AiModelProfile = Object.freeze({ ...standardProfile, id: 'baidu-v1', providerOnly: Object.freeze(['baidu']) });
const lightningProfile: AiModelProfile = Object.freeze({ id: 'nvidia-lightning-free-v1', supportsResponseFormat: false, syntheticOnly: true, providerOnly: Object.freeze(['nvidia']), reasoning: Object.freeze({ enabled: false }) });
const superVlProfile: AiModelProfile = Object.freeze({ id: 'nvidia-super-vl-free-v1', supportsResponseFormat: true, syntheticOnly: true, providerOnly: Object.freeze(['nvidia']), reasoning: Object.freeze({ enabled: false }) });

/** Reviewed free endpoint capabilities; these NVIDIA endpoints forbid personal/confidential data. */
export function aiModelProfile(provider: AiProvider, model: string): AiModelProfile {
  if (provider !== 'openrouter') return standardProfile;
  // Treat spelling variants as the same restricted model at the application boundary.
  // Do not rewrite existing model/request bytes or generalize this to paid NVIDIA models.
  const canonical = model.trim().toLowerCase();
  if (canonical === 'nvidia/nemotron-3.5-lightning:free') return lightningProfile;
  if (canonical === 'nvidia/nemotron-3.5-super-vl:free') return superVlProfile;
  return model.startsWith('baidu/') ? baiduProfile : standardProfile;
}

export function assertOutputModeSupported(provider: AiProvider, model: string, mode: 'compact' | 'strict'): void {
  if (mode === 'strict' && !aiModelProfile(provider, model).supportsResponseFormat) {
    throw new Error(`Model ${model} does not support strict structured output; choose compact explicitly for synthetic evaluation`);
  }
}

/** No environment override: only dedicated synthetic runners may construct these adapters directly. */
export function assertApplicationModelAllowed(provider: AiProvider, model: string): void {
  // A custom compatible base URL/provider label must not bypass the model restriction.
  if (aiModelProfile(provider, model).syntheticOnly || aiModelProfile('openrouter', model).syntheticOnly) {
    throw new Error(`Model ${model} is for synthetic evaluation only and cannot process application user data`);
  }
}

/** Public routing configuration only. Never return or log credential values here. */
export function aiProviderConfig(env: NodeJS.ProcessEnv) {
  const provider = env.AI_PROVIDER ?? 'qwen';
  if (provider !== 'qwen' && provider !== 'openrouter') throw new Error('AI_PROVIDER must be qwen or openrouter');
  const openrouter = provider === 'openrouter';
  const model = (openrouter ? env.OPENROUTER_MODEL : env.QWEN_MODEL) ?? (openrouter ? 'baidu/ernie-5.5-flash-preview:free' : 'qwen3.8-max');
  const baseURL = (openrouter ? env.OPENROUTER_BASE_URL : env.QWEN_BASE_URL) ?? (openrouter ? 'https://openrouter.ai/api/v1' : 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  const mode: 'compact' | 'strict' = (openrouter ? env.OPENROUTER_OUTPUT : env.QWEN_OUTPUT) === 'strict' ? 'strict' : 'compact';
  assertOutputModeSupported(provider, model, mode);
  return { provider: provider as AiProvider, model, baseURL, mode, apiKeyVariable: openrouter ? 'OPENROUTER_API_KEY' : 'QWEN_API_KEY' };
}

/** Extended waiting is opt-in per recovery-capable request; legacy clients keep their budget. */
export function recoveryTimeoutMs(env:NodeJS.ProcessEnv,provider:AiProvider,model:string):number|undefined {
  if(provider!=='openrouter'||!model.endsWith(':free'))return undefined;
  const raw=env.OPENROUTER_TIMEOUT_MS??'60000';
  if(!/^\d+$/.test(raw)||Number(raw)<20_000||Number(raw)>60_000)throw new Error('OPENROUTER_TIMEOUT_MS must be an integer from 20000 to 60000');
  return Number(raw);
}
