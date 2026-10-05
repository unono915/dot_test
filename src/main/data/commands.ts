import { fail } from './errors.js';
import type { Db } from './sqlite.js';

export interface EmittedEvent {
  eventType: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  correctsEventId?: string | null;
  /** When the real-world fact happened, if different from the recording time (UTC ISO or date). */
  occurredAt?: string | null;
}

/** Everything a command handler may touch while its transaction is open. */
export interface TxContext {
  readonly db: Db;
  readonly now: string;
  readonly actor: string;
  readonly commandId: string;
  readonly correlationId: string;
  /** Revision this command will commit as (current + 1). */
  readonly revision: number;
  emit(event: EmittedEvent): string;
  expectVersion(entityType: string, entityId: string, actual: number | null, expected: number | null): void;
  /** Checked during long loops; throws CANCELLED before commit if the caller cancelled. */
  checkCancelled(): void;
  progress(done: number, total: number): void;
}

export interface CommandDefinition<P = unknown, R = unknown> {
  type: string;
  /** Validates and normalises the untrusted payload. Must throw DomainError('VALIDATION'). */
  parse(payload: unknown): P;
  run(ctx: TxContext, payload: P): R;
}

/**
 * Prefer the positional form: TypeScript infers the payload type from `parse` reliably only when
 * it is a separate argument.
 */
export function defineCommand<P, R>(type: string, parse: (payload: unknown) => P, run: (ctx: TxContext, payload: P) => R): CommandDefinition<P, R>;
export function defineCommand<P, R>(def: CommandDefinition<P, R>): CommandDefinition<P, R>;
export function defineCommand<P, R>(
  defOrType: CommandDefinition<P, R> | string,
  parse?: (payload: unknown) => P,
  run?: (ctx: TxContext, payload: P) => R,
): CommandDefinition<P, R> {
  return typeof defOrType === 'string' ? { type: defOrType, parse: parse!, run: run! } : defOrType;
}

export class CommandRegistry {
  readonly #defs = new Map<string, CommandDefinition>();

  register(...defs: CommandDefinition<any, any>[]): this {
    for (const def of defs) {
      if (this.#defs.has(def.type)) throw new Error(`duplicate command ${def.type}`);
      this.#defs.set(def.type, def as CommandDefinition);
    }
    return this;
  }

  get(type: string): CommandDefinition {
    return this.#defs.get(type) ?? fail('VALIDATION', '지원하지 않는 작업입니다.', { type });
  }

  types(): string[] {
    return [...this.#defs.keys()].sort();
  }
}
