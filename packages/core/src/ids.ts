/**
 * Branded id primitives.
 *
 * Branding keeps a CardId from being passed where a JobId belongs. The brand
 * exists only in the type system; at runtime these are plain strings.
 */

declare const brand: unique symbol;

export type Id<T extends string> = string & { readonly [brand]: T };

export type ProjectId = Id<"project">;
export type CardId = Id<"card">;
export type MilestoneId = Id<"milestone">;
export type AssetId = Id<"asset">;
export type JobId = Id<"job">;
export type HealthItemId = Id<"health">;

/**
 * UUIDv7 is monotonic by time, so ids sort chronologically. That gives the
 * append-only event log and the JSON mirror a stable order for free, and means
 * a creation-order sort needs no extra column.
 */
export function newId<T extends string>(kind: T): Id<T> {
  return `${kind}_${Bun.randomUUIDv7()}` as Id<T>;
}

/** Re-adopt an id string read back from SQLite or JSON. */
export function asId<T extends string>(kind: T, raw: string): Id<T> {
  if (!raw.startsWith(`${kind}_`)) {
    throw new Error(`expected a ${kind} id, got ${JSON.stringify(raw)}`);
  }
  return raw as Id<T>;
}

export function isId<T extends string>(kind: T, raw: unknown): raw is Id<T> {
  return typeof raw === "string" && raw.startsWith(`${kind}_`);
}
