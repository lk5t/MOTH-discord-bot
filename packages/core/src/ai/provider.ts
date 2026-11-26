import { z } from "zod";

/**
 * Provider-independent AI layer. Uses plain HTTP (fetch) so any OpenAI-compatible
 * endpoint (OpenAI, OpenRouter, Groq, Together, LM Studio, vLLM, Ollama /v1),
 * Anthropic's Messages API, or a local Ollama server can be used interchangeably.
 */

export type AIProviderKind = "openai" | "anthropic" | "ollama" | "openai-compatible";

export interface AIProviderConfig {
  kind: AIProviderKind;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  temperature?: number;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  /** Ask the model for a single JSON object (uses native JSON mode when available). */
  json?: boolean;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class AIError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) { super(message); }
}

const DEFAULT_BASE: Record<AIProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  ollama: "http://localhost:11434/v1",
  "openai-compatible": "http://localhost:8000/v1",
};

export function defaultBaseUrl(kind: AIProviderKind): string {
  return DEFAULT_BASE[kind];
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 500);
      try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? msg; } catch { /* keep raw */ }
      throw new AIError(`AI provider returned ${res.status}: ${msg}`, res.status, res.status === 429 || res.status >= 500);
    }
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof AIError) throw err;
    if ((err as Error).name === "AbortError") throw new AIError("AI provider request timed out", undefined, true);
    throw new AIError(`AI provider request failed: ${(err as Error).message}`, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

export class AIClient {
  constructor(readonly config: AIProviderConfig) {}

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<CompletionResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return this.config.kind === "anthropic" ? await this.anthropic(messages, opts) : await this.openai(messages, opts);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof AIError) || !err.retryable) throw err;
        if (this.config.kind === "ollama" && /timed out/.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  private async openai(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    const base = (this.config.baseUrl || DEFAULT_BASE[this.config.kind]).replace(/\/$/, "");
    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? this.config.temperature ?? 0.4,
    };
    if (opts.json) body.response_format = { type: "json_object" };
    let data;
    try {
      data = await postJson(`${base}/chat/completions`, body, headers, this.config.timeoutMs ?? 120_000, opts.signal);
    } catch (err) {
      // Some compatible servers reject response_format — retry once without it.
      if (err instanceof AIError && err.status === 400 && body.response_format) {
        delete body.response_format;
        data = await postJson(`${base}/chat/completions`, body, headers, this.config.timeoutMs ?? 120_000, opts.signal);
      } else throw err;
    }
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      model: data.model ?? this.config.model,
    };
  }

  private async anthropic(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    const base = (this.config.baseUrl || DEFAULT_BASE.anthropic).replace(/\/$/, "");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const convo = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    if (opts.json && convo.length) convo[convo.length - 1].content += "\n\nRespond with a single JSON object only, no prose.";
    const data = await postJson(`${base}/messages`, {
      model: this.config.model,
      system: system || undefined,
      messages: convo,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? this.config.temperature ?? 0.4,
    }, { "x-api-key": this.config.apiKey ?? "", "anthropic-version": "2023-06-01" }, this.config.timeoutMs ?? 120_000, opts.signal);
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    return { text, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0, model: data.model ?? this.config.model };
  }

  /**
   * Requests structured JSON and validates it against a zod schema. On invalid
   * output the validation errors are fed back to the model once for repair.
   */
  async completeJson<T extends z.ZodTypeAny>(messages: ChatMessage[], schema: T, opts: CompletionOptions = {}): Promise<{ data: z.infer<T>; usage: CompletionResult }> {
    const convo = [...messages];
    let last: CompletionResult | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      last = await this.complete(convo, { ...opts, json: true });
      const parsed = extractJson(last.text);
      const result = parsed === undefined ? null : schema.safeParse(parsed);
      if (result?.success) return { data: result.data, usage: last };
      const problem = result ? result.error.issues.slice(0, 12).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "response was not valid JSON";
      convo.push({ role: "assistant", content: last.text.slice(0, 6000) }, { role: "user", content: `Your previous response was invalid (${problem}). Reply again with ONLY the corrected JSON object.` });
    }
    throw new AIError(`AI returned invalid structured output: ${last?.text.slice(0, 200)}`);
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; model: string; error?: string }> {
    const start = Date.now();
    try {
      const r = await this.complete([{ role: "user", content: "Reply with the single word: pong" }], { maxTokens: 10 });
      return { ok: true, latencyMs: Date.now() - start, model: r.model };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, model: this.config.model, error: (err as Error).message };
    }
  }
}

/** Extracts the first JSON object from model output (handles ```json fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const start = candidate.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}
