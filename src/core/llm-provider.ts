import type { LLMProviderType } from '../types/index.js';

export interface LLMCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  jsonMode?: boolean;
  preferredProvider?: LLMProviderType;
  preferredModel?: string;
}

export interface LLMCompletionResponse {
  content: string;
  provider: string;
  model: string;
}

export interface ProviderStatusInfo {
  id: LLMProviderType;
  name: string;
  configured: boolean;
  defaultModel: string;
  description: string;
}

export function getProvidersStatus(): ProviderStatusInfo[] {
  return [
    {
      id: 'openai',
      name: 'OpenAI / Compatible API',
      configured: Boolean(process.env.OPENAI_API_KEY),
      defaultModel: process.env.OPENRABBIT_LLM_MODEL || 'gpt-4o',
      description: 'GPT-4o, o3-mini, or any OpenAI-compatible endpoint (Groq, DeepSeek, OpenRouter)',
    },
    {
      id: 'anthropic',
      name: 'Anthropic Claude',
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      defaultModel: process.env.OPENRABBIT_LLM_MODEL || 'claude-3-7-sonnet-latest',
      description: 'Claude 3.7 Sonnet / Claude 3.5 Sonnet for deep architectural & security review',
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      configured: Boolean(process.env.GEMINI_API_KEY),
      defaultModel: process.env.OPENRABBIT_LLM_MODEL || 'gemini-2.5-pro',
      description: 'Gemini 2.5 Pro / Flash with 1M+ token repository context window',
    },
    {
      id: 'ollama',
      name: 'Ollama (Local / Private)',
      configured: Boolean(process.env.OLLAMA_MODEL || process.env.OLLAMA_BASE_URL),
      defaultModel: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
      description: '100% air-gapped local code review via Ollama (Qwen2.5-Coder, DeepSeek-R1, Llama 3.3)',
    },
    {
      id: 'heuristic',
      name: 'OpenRabbit Static + AST Engine',
      configured: true,
      defaultModel: 'openrabbit-ast-v1',
      description: 'Zero-key deterministic security, async/concurrency, and AST pattern analyzer (Always ready)',
    },
  ];
}

export function resolveActiveProvider(
  preferred: LLMProviderType = 'auto',
  preferredModel?: string
): { provider: Exclude<LLMProviderType, 'auto'>; model: string } {
  const envProvider = (process.env.OPENRABBIT_LLM_PROVIDER as LLMProviderType) || preferred;
  const target = preferred !== 'auto' ? preferred : envProvider;

  if (target === 'openai' && process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      model: preferredModel || process.env.OPENRABBIT_LLM_MODEL || 'gpt-4o',
    };
  }
  if (target === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      model:
        preferredModel ||
        process.env.OPENRABBIT_LLM_MODEL ||
        'claude-3-7-sonnet-latest',
    };
  }
  if (target === 'gemini' && process.env.GEMINI_API_KEY) {
    return {
      provider: 'gemini',
      model: preferredModel || process.env.OPENRABBIT_LLM_MODEL || 'gemini-2.5-pro',
    };
  }
  if (target === 'ollama') {
    return {
      provider: 'ollama',
      model: preferredModel || process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
    };
  }
  if (target === 'heuristic') {
    return {
      provider: 'heuristic',
      model: 'openrabbit-ast-v1',
    };
  }

  // Auto-detect based on available credentials
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      model:
        preferredModel ||
        process.env.OPENRABBIT_LLM_MODEL ||
        'claude-3-7-sonnet-latest',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      model: preferredModel || process.env.OPENRABBIT_LLM_MODEL || 'gpt-4o',
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      provider: 'gemini',
      model: preferredModel || process.env.OPENRABBIT_LLM_MODEL || 'gemini-2.5-pro',
    };
  }
  if (process.env.OLLAMA_MODEL) {
    return {
      provider: 'ollama',
      model: preferredModel || process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
    };
  }

  return {
    provider: 'heuristic',
    model: 'openrabbit-ast-v1',
  };
}

export async function generateLLMCompletion(
  req: LLMCompletionRequest
): Promise<LLMCompletionResponse> {
  const { provider, model } = resolveActiveProvider(
    req.preferredProvider,
    req.preferredModel
  );
  const temperature = req.temperature ?? 0.2;

  if (provider === 'openai') {
    const baseUrl = (
      process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    ).replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${errText}`);
    }
    const data = (await res.json()) as any;
    return {
      content: data.choices?.[0]?.message?.content || '',
      provider: 'openai',
      model,
    };
  }

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature,
        system: req.systemPrompt,
        messages: [{ role: 'user', content: req.userPrompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${errText}`);
    }
    const data = (await res.json()) as any;
    const textBlock = data.content?.find((c: any) => c.type === 'text');
    return {
      content: textBlock?.text || '',
      provider: 'anthropic',
      model,
    };
  }

  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY || '';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: req.userPrompt }] }],
        generationConfig: {
          temperature,
          ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }
    const data = (await res.json()) as any;
    const text =
      data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
    return {
      content: text,
      provider: 'gemini',
      model,
    };
  }

  if (provider === 'ollama') {
    const baseUrl = (
      process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
    ).replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        ...(req.jsonMode ? { format: 'json' } : {}),
        options: { temperature },
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama API error (${res.status}): ${errText}`);
    }
    const data = (await res.json()) as any;
    return {
      content: data.message?.content || '',
      provider: 'ollama',
      model,
    };
  }

  throw new Error('Heuristic provider handles analysis directly without remote LLM calls.');
}
