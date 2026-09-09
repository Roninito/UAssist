/**
 * OpenAI-compatible chat client.
 *
 * Ollama and LM Studio both expose an OpenAI-compatible API at /v1/chat/completions.
 * Streaming is done via Server-Sent Events. This module is small enough to
 * stay dependency-free while keeping token-by-token output streaming.
 *
 * Only `delta.content` is read from each chunk — a reasoning model's hidden
 * "thinking" trace rides in a separate, non-standard field some providers
 * add to the same delta (Ollama: `reasoning`), which is deliberately never
 * surfaced as chat content here. The practical effect worth knowing: those
 * tokens still count against `maxTokens`, so a reasoning model can exhaust
 * the whole budget before a single real content token appears — see
 * `describeEmptyReply`, which is how callers turn that specific, detectable
 * case into something other than a silent empty reply.
 *
 * See design/uassist-spec.md Part VIII.
 */

import type { AiProviderConfig, ChatMessage } from "./types.ts";

export interface CompletionOptions {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompletionChunk {
  /** A piece of the assistant's reply, or empty for the final done marker. */
  content: string;
  /** When true, no more chunks will follow. */
  done: boolean;
  /** Optional usage / finish reason on the final chunk. */
  finishReason?: string;
}

export interface LlmClient {
  /**
   * Stream chat completion chunks. The caller is responsible for accumulating
   * the assistant message and for cost accounting.
   */
  chat(options: CompletionOptions): AsyncIterable<CompletionChunk>;
  /** List models the provider advertises. */
  listModels(): AsyncIterable<string>;
}

interface OpenAiDelta {
  role?: string;
  content?: string;
}

interface OpenAiChoice {
  delta: OpenAiDelta;
  finish_reason?: string | null;
}

interface OpenAiChunk {
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAiModel {
  id?: string;
}

interface OpenAiModelList {
  data?: OpenAiModel[];
}

function makeUrl(baseUrl: string, path: string): string {
  const root = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}${path}`;
}

function headers(provider: AiProviderConfig): Record<string, string> {
  const out: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (provider.apiKey) out["authorization"] = `Bearer ${provider.apiKey}`;
  return out;
}

function parseSseLine(line: string): OpenAiChunk | undefined {
  const prefix = "data: ";
  if (!line.startsWith(prefix)) return undefined;
  const data = line.slice(prefix.length).trim();
  if (data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as OpenAiChunk;
  } catch {
    return undefined;
  }
}

export function createLlmClient(provider: AiProviderConfig): LlmClient {
  return {
    async *chat(options: CompletionOptions): AsyncIterable<CompletionChunk> {
      const model = options.model ?? provider.model;
      const body = {
        model,
        messages: options.messages.map((m) => ({
          role: m.role,
          content: m.content,
          name: m.name,
        })),
        stream: true,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
      };

      const res = await fetch(makeUrl(provider.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: headers(provider),
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
          const err = (await res.json()) as { error?: { message?: string }; message?: string };
          message = err.error?.message ?? err.message ?? message;
        } catch {
          // fall back to status text
        }
        throw new Error(`LLM request failed: ${message}`);
      }

      if (!res.body) {
        throw new Error("LLM response has no body");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const chunk = parseSseLine(line);
            if (!chunk) continue;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) {
              yield { content: "", done: true, finishReason: choice.finish_reason };
              return;
            }
            const content = choice.delta?.content ?? "";
            yield { content, done: false };
          }
        }
      } finally {
        reader.releaseLock();
      }

      yield { content: "", done: true };
    },

    async *listModels(): AsyncIterable<string> {
      const res = await fetch(makeUrl(provider.baseUrl, "/models"), {
        method: "GET",
        headers: headers(provider),
      });
      if (!res.ok) return;
      const data = (await res.json()) as OpenAiModelList;
      for (const m of data.data ?? []) {
        if (m.id) yield m.id;
      }
    },
  };
}

/**
 * A reasoning model can spend its entire token budget on a hidden
 * "thinking" trace before emitting a single visible token — the
 * OpenAI-compatible delta shape has no field for that trace (Ollama, at
 * least, puts it in a non-standard `reasoning` key this client doesn't
 * read at all — see the class doc comment), so from here it is
 * indistinguishable from the model answering with genuine silence. Either
 * way, a chat reply that is a literally empty bubble with no explanation
 * is confusing on its own; this is the one place both card chat and doc
 * chat turn that specific, detectable case into an honest message instead.
 */
export function describeEmptyReply(finishReason: string | undefined, maxTokens: number): string | undefined {
  if (finishReason !== "length") return undefined;
  return (
    `(no reply — the response was cut off at the ${maxTokens}-token limit before any visible content, ` +
    `likely spent on a reasoning model's hidden "thinking" trace. Try raising Max tokens in AI Settings, ` +
    `or switch to a non-reasoning model.)`
  );
}

/** Build a system message for a card from the project config and card context. */
export function systemMessage(
  systemPrompt: string,
  context?: { title?: string; description?: string; category?: string; kind?: string },
): ChatMessage {
  let content = systemPrompt;
  if (context) {
    content += "\n\nYou are discussing the following task:";
    if (context.title) content += `\nTitle: ${context.title}`;
    if (context.description) content += `\nDescription: ${context.description}`;
    if (context.category) content += `\nCategory: ${context.category}`;
    if (context.kind) content += `\nKind: ${context.kind}`;
  }
  return { role: "system", content, createdAt: Date.now() };
}
