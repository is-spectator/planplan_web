import { describe, expect, it } from 'vitest';
import { aiProviderConfig } from '../src/ai/provider.js';
import { OpenAICompatibleLlm, QwenLlm, classifyLlmError } from '../src/ai/llm.js';
import { webFixtureLegal } from '../scripts/web-fixture-legal.js';

const model = 'baidu/ernie-5.5-flash-preview:free';
const success = () => new Response(JSON.stringify({
  id: 'synthetic', choices: [{ message: { role: 'assistant', content: JSON.stringify({ intent: 'smalltalk', reply: '你好' }) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 10 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

describe('Qwen 和 OpenRouter 独立配置与传输', () => {
  it('保持 Qwen 默认值，OpenRouter 显式选择且不混用 Qwen 配置或密钥变量', () => {
    expect(aiProviderConfig({})).toEqual({ provider: 'qwen', model: 'qwen3.8-max', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mode: 'compact', apiKeyVariable: 'QWEN_API_KEY' });
    expect(aiProviderConfig({ AI_PROVIDER: 'openrouter', QWEN_MODEL: 'ignored', QWEN_BASE_URL: 'https://ignored.test', QWEN_OUTPUT: 'strict' })).toEqual({ provider: 'openrouter', model, baseURL: 'https://openrouter.ai/api/v1', mode: 'compact', apiKeyVariable: 'OPENROUTER_API_KEY' });
    expect(aiProviderConfig({ AI_PROVIDER: 'openrouter', OPENROUTER_OUTPUT: 'strict' }).mode).toBe('strict');
    expect(() => aiProviderConfig({ AI_PROVIDER: 'unknown' })).toThrow('AI_PROVIDER');
  });

  it('OpenRouter 使用标准 JSON 输出和 baidu 路由，不发送 enable_thinking 或自动换供应商', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    let calls = 0;
    const llm = new OpenAICompatibleLlm('synthetic-openrouter-key', 'https://openrouter.ai/api/v1', model, 'compact', 100, {
      provider: 'openrouter', fetch: async (input, init) => { calls++; url = String(input); body = JSON.parse(init!.body as string); return success(); },
    });
    const result = await llm.plan('system fixture', '你好');
    expect(result.turn.reply).toBe('你好');
    expect(result.usage).toMatchObject({ prompt: 20, completion: 10 });
    expect(calls).toBe(1);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body).toMatchObject({ model, response_format: { type: 'json_object' }, provider: { only: ['baidu'], allow_fallbacks: false, require_parameters: true } });
    expect(body).not.toHaveProperty('enable_thinking');
    // ERNIE's free endpoint requires reasoning; do not force it off or cap tokens.
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('models');
  });

  it('现有 Qwen 构造器仍只发送百炼扩展，严格 JSON Schema 保持不变', async () => {
    let body: Record<string, unknown> = {};
    const llm = new QwenLlm('synthetic-qwen-key', 'https://fixture.test/v1', 'qwen3.8-max', 'strict', 100, {
      fetch: async (_input, init) => { body = JSON.parse(init!.body as string); return success(); },
    });
    await llm.plan('system fixture', '你好');
    expect(body.enable_thinking).toBe(false);
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'turn', strict: true } });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('受控HTTP样本只分类为既有错误，不放宽空对象、坏JSON、截断或schema', async () => {
    const sample = async (body: unknown, status = 200) => {
      let calls = 0;
      const llm = new OpenAICompatibleLlm('synthetic-openrouter-key', 'https://fixture.test/v1', model, 'compact', 100, {
        provider: 'openrouter', fetch: async () => { calls++; return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); },
      });
      const error = await llm.plan('system fixture', '午饭20元').then(() => null, (caught: unknown) => caught);
      return { calls, error };
    };
    const ok = (intent: string) => ({ choices: [{ message: { role: 'assistant', content: intent }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    for (const content of ['{}', '', '{bad', '{"intent":"write","writes":[]}']) {
      const { calls, error } = await sample(ok(content));
      expect(calls).toBe(1);
      expect(error).toMatchObject({ kind: 'invalid_output', message: 'Model request failed: invalid_output' });
      if (content) expect(String((error as Error).message)).not.toContain(content);
    }
    const truncated = await sample({ choices: [{ message: { content: '{"intent":"write"' }, finish_reason: 'length' }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
    expect(truncated.error).toMatchObject({ kind: 'invalid_output', usage: { prompt: 4, completion: 2 } });
    const schema = await sample(ok(JSON.stringify({ intent: 'not-a-turn', reply: 'raw provider text' })));
    expect(schema.error).toMatchObject({ kind: 'invalid_output' });
    expect(String((schema.error as Error).message)).not.toContain('raw provider text');
    for (const [status, kind] of [[429, 'rate_limited'], [401, 'unauthorized'], [403, 'unauthorized'], [402, 'billing'], [400, 'invalid_request'], [500, 'unavailable']] as const) {
      const { calls, error } = await sample({ error: { message: 'sk-secret-provider-body', code: status } }, status);
      expect(calls).toBe(1);
      expect(error).toMatchObject({ kind, message: `Model request failed: ${kind}` });
      expect(String((error as Error).message)).not.toContain('sk-secret-provider-body');
    }
  });

  it('OpenRouter HTTP402归为billing且SDK不重试或传播原文', async () => {
    let calls = 0;
    const llm = new OpenAICompatibleLlm('synthetic-openrouter-key', 'https://fixture.test/v1', model, 'compact', 100, {
      provider: 'openrouter', fetch: async () => { calls++; return new Response(JSON.stringify({ error: { code: 402, message: 'private provider detail' } }), { status: 402 }); },
    });
    await expect(llm.plan('', '')).rejects.toMatchObject({ kind: 'billing', message: 'Model request failed: billing' });
    expect(calls).toBe(1);
    expect(classifyLlmError({ status: 401 })).toBe('unauthorized');
    expect(classifyLlmError({ status: 429 })).toBe('rate_limited');
  });

  it('本机告知切到 OpenRouter 和百度千帆且使旧 Qwen 授权失效', async () => {
    const old = webFixtureLegal(true);
    const next = webFixtureLegal(true, { AI_PROVIDER: 'openrouter', OPENROUTER_MODEL: model });
    const metadata = await (await next.routes.request('/metadata')).json();
    expect(metadata).toMatchObject({ developmentOnly: true, reviewed: false, aiPrivacyURL: 'https://openrouter.ai/privacy' });
    expect(metadata.aiRecipient).toContain('OpenRouter');
    expect(metadata.aiRecipient).toContain('百度千帆');
    expect(metadata.aiRecipient).not.toContain('阿里云');
    expect(metadata.aiService).toContain(model);
    expect(metadata.aiProcessingDisclosure).toContain('转发');
    expect(next.consentVersion).not.toBe(old.consentVersion);
    expect(() => webFixtureLegal(true, { AI_PROVIDER: 'openrouter', OPENROUTER_BASE_URL: 'https://unreviewed.test/v1' })).toThrow();
  });
});
