/**
 * Event bus over Bun's WebSocket pub/sub.
 *
 * Every event carries the store's monotonic `seq`. A reconnecting client sends
 * its last seq and gets the gap replayed from events.log, or an instruction to
 * re-fetch when the gap is too large. Without this, a closed laptop lid leaves
 * a board that looks correct and is wrong.
 *
 * See design/uassist-spec.md Part XIII.
 */

import type { ServerWebSocket } from "bun";
import type { ChatMessage, Store } from "@uassist/core";

export const TOPIC = "project";

/** Beyond this many missed events, a full refetch is cheaper than a replay. */
export const MAX_REPLAY = 500;

export type ServerEvent =
  | { kind: "cardChanged"; seq: number; id: string; fields?: string[] }
  | { kind: "cardCreated"; seq: number; id: string }
  | { kind: "cardDeleted"; seq: number; id: string }
  | { kind: "milestoneChanged"; seq: number; id: string }
  | { kind: "projectChanged"; seq: number; id: string }
  | { kind: "planImported"; seq: number; added: number; updated: number; renamed: number }
  | { kind: "healthItemCreated"; seq: number; id: string }
  | { kind: "healthItemResolved"; seq: number; id: string }
  | { kind: "chatMessageAdded"; seq: number; cardId: string; message: ChatMessage }
  | { kind: "chatToken"; seq: number; cardId: string; token: string; done: boolean }
  | { kind: "workspaceScanned"; seq: number }
  | { kind: "docChanged"; seq: number; path: string }
  | { kind: "docThreadChanged"; seq: number; docPath: string }
  | { kind: "docChatMessageAdded"; seq: number; docPath: string; message: ChatMessage }
  | { kind: "docChatToken"; seq: number; docPath: string; token: string; done: boolean }
  | { kind: "jobUpdated"; seq: number; id: string; cardId: string; state: string }
  | { kind: "jobOutput"; seq: number; id: string; cardId: string; text: string }
  | { kind: "jobQuestion"; seq: number; id: string; cardId: string; question: string; options?: string[] }
  | { kind: "ledgerEntryAdded"; seq: number; jobId: string; amountUsd: number }
  | { kind: "suggestionsChanged"; seq: number }
  | { kind: "healthChanged"; seq: number };

export type ClientMessage =
  | { kind: "hello"; lastSeq?: number }
  | { kind: "ping" };

export type ServerMessage =
  | { kind: "welcome"; seq: number }
  | { kind: "replay"; events: unknown[]; seq: number }
  | { kind: "resync"; seq: number; reason: string }
  | { kind: "pong" }
  | ServerEvent;

/**
 * Only the part of Bun's Server we actually use. Depending on the shape rather
 * than the generic class keeps this module free of Bun's serve type parameters.
 */
export interface Publisher {
  publish(topic: string, data: string): unknown;
}

export class EventBus {
  private server: Publisher | undefined;

  attach(server: Publisher): void {
    this.server = server;
  }

  /** Broadcast to every subscribed client. */
  publish(event: ServerMessage): void {
    this.server?.publish(TOPIC, JSON.stringify(event));
  }

  /**
   * Handle a client's opening message.
   *
   * A client with no `lastSeq` is new and will fetch the board itself. One
   * that is behind gets the gap; one that is too far behind is told to resync.
   */
  hello(
    ws: ServerWebSocket<unknown>,
    store: Store,
    lastSeq: number | undefined,
  ): void {
    const current = store.lastSeq;

    if (lastSeq === undefined) {
      send(ws, { kind: "welcome", seq: current });
      return;
    }
    if (lastSeq === current) {
      send(ws, { kind: "welcome", seq: current });
      return;
    }
    if (current - lastSeq > MAX_REPLAY) {
      send(ws, {
        kind: "resync",
        seq: current,
        reason: `${current - lastSeq} events missed`,
      });
      return;
    }
    send(ws, {
      kind: "replay",
      events: store.eventsSince(lastSeq),
      seq: current,
    });
  }
}

export function send(
  ws: ServerWebSocket<unknown>,
  message: ServerMessage,
): void {
  ws.send(JSON.stringify(message));
}

/**
 * Parse a client message. Untrusted input: anything that is not a shape we
 * recognise is rejected rather than coerced.
 */
export function parseClientMessage(raw: string | Buffer): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;

  if (kind === "ping") return { kind: "ping" };
  if (kind === "hello") {
    const lastSeq = (value as { lastSeq?: unknown }).lastSeq;
    if (lastSeq === undefined) return { kind: "hello" };
    if (typeof lastSeq !== "number" || !Number.isFinite(lastSeq) || lastSeq < 0) {
      return { kind: "hello" };
    }
    return { kind: "hello", lastSeq };
  }
  return undefined;
}
