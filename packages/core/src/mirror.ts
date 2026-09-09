/**
 * The git-tracked JSON mirror.
 *
 * Every mutation writes a SQLite row and queues a mirror write. Writes are
 * debounced and coalesced per record, so dragging a card across four columns
 * produces one file write, not four. The queue flushes synchronously on exit.
 *
 * See design/uassist-spec.md Part IV.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export type MirrorKind =
  | "cards"
  | "milestones"
  | "assets"
  | "jobs"
  | "health"
  | "suggestions";

export interface MirrorEntry {
  kind: MirrorKind;
  id: string;
  /** Serialized content, or null to delete the file. */
  content: string | null;
}

export interface MirrorOptions {
  /** Milliseconds to coalesce writes. 0 writes through synchronously. */
  debounceMs?: number;
}

export class Mirror {
  readonly root: string;
  private readonly debounceMs: number;
  private pending = new Map<string, MirrorEntry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private exitHooked = false;

  constructor(uassistDir: string, options: MirrorOptions = {}) {
    this.root = uassistDir;
    this.debounceMs = options.debounceMs ?? 250;
  }

  private pathFor(kind: MirrorKind, id: string): string {
    return join(this.root, kind, `${id}.json`);
  }

  /** Queue a write. Later queues for the same record replace earlier ones. */
  enqueue(entry: MirrorEntry): void {
    this.pending.set(`${entry.kind}/${entry.id}`, entry);
    if (this.debounceMs === 0) {
      this.flush();
      return;
    }
    this.hookExit();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    // Don't hold the process open just to write a mirror file.
    this.timer.unref?.();
  }

  /** Write a top-level file such as project.json or conventions.json. */
  writeFile(name: string, content: string): void {
    const path = join(this.root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.size === 0) return;

    const entries = [...this.pending.values()];
    this.pending.clear();

    for (const entry of entries) {
      const path = this.pathFor(entry.kind, entry.id);
      if (entry.content === null) {
        rmSync(path, { force: true });
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.content, "utf8");
    }
  }

  private hookExit(): void {
    if (this.exitHooked) return;
    this.exitHooked = true;
    // A pending mirror write that never lands is silent data loss from the
    // perspective of git, which is the only copy that matters.
    process.on("exit", () => this.flush());
  }
}
