export class UserError extends Error {}
export class AuthError extends Error {}

export class CapacityError extends Error {
  constructor(
    readonly status: 413 | 429 | 503,
    readonly code: 'UPLOAD_TOO_LARGE' | 'UPLOAD_RATE_LIMITED' | 'QUARANTINE_CAPACITY_EXHAUSTED',
    message: string,
  ) {
    super(message);
  }
}

export class ConflictError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
