// Domain errors carry a stable code and a Korean user message. Details are safe, structured
// facts (field names, ids, counts) — never SQL, file paths or stacks.
export type DomainErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'STALE_EPOCH'
  | 'DATASET_MISMATCH'
  | 'COMMAND_ID_REUSED'
  | 'RULE_VIOLATION'
  | 'MAINTENANCE_LOCKED'
  | 'INTEGRITY'
  | 'LIMIT_EXCEEDED'
  | 'CANCELLED';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const fail = (code: DomainErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new DomainError(code, message, details);
};

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
