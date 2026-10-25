/**
 * Typed service errors. Route handlers / server actions map them with `toHttpError`.
 */
export type ServiceErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'UNAUTHENTICATED' | 'INVALID_STATE' | 'VALIDATION' | 'RATE_LIMITED' | 'CONFLICT';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: ServiceErrorCode, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class NotFoundError extends ServiceError {
  constructor(what = 'Resource', details?: Record<string, unknown>) {
    super('NOT_FOUND', 404, `${what} not found`, details);
  }
}

export class ForbiddenError extends ServiceError {
  constructor(message = 'You do not have permission to do that', details?: Record<string, unknown>) {
    super('FORBIDDEN', 403, message, details);
  }
}

export class UnauthenticatedError extends ServiceError {
  constructor(message = 'Please sign in') {
    super('UNAUTHENTICATED', 401, message);
  }
}

export class InvalidStateError extends ServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_STATE', 409, message, details);
  }
}

export class ConflictError extends ServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', 409, message, details);
  }
}

export class ValidationError extends ServiceError {
  /** Field-level messages, e.g. `{ studentNo: 'Required' }`. */
  readonly fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}, details?: Record<string, unknown>) {
    super('VALIDATION', 422, message, details);
    this.fieldErrors = fieldErrors;
  }
}

export class RateLimitedError extends ServiceError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = 'Too many attempts. Please wait and try again.') {
    super('RATE_LIMITED', 429, message, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isServiceError(e: unknown): e is ServiceError {
  return e instanceof ServiceError;
}

/** Serializable shape for server actions / JSON responses. */
export interface ErrorBody {
  error: { code: ServiceErrorCode | 'INTERNAL'; message: string; fieldErrors?: Record<string, string>; details?: Record<string, unknown> };
}

export function toErrorBody(e: unknown): { status: number; body: ErrorBody } {
  if (isServiceError(e)) {
    return {
      status: e.status,
      body: {
        error: {
          code: e.code,
          message: e.message,
          fieldErrors: e instanceof ValidationError ? e.fieldErrors : undefined,
          details: e.details,
        },
      },
    };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } } };
}
