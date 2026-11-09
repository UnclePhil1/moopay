export type ErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_ASSET"
  | "NOTE_NOT_FOUND"
  | "NOTE_NOT_FUNDED"
  | "NOTE_EXPIRED"
  | "NOTE_ALREADY_CLAIMED"
  | "BAD_RECIPIENT"
  | "QUOTE_FAILED"
  | "SIGNING_FAILED"
  | "DEPOSIT_FAILED"
  | "UPSTREAM_TIMEOUT"
  | "INTERNAL";

/** Error with a stable code. Messages must never contain the secret, JWT or private key. */
export class MoopayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MoopayError";
  }
}

export function asMoopayError(err: unknown): MoopayError {
  if (err instanceof MoopayError) return err;
  // Unknown errors are not echoed: they may carry request bodies or credentials.
  console.error("[moopay] unexpected error:", err instanceof Error ? (process.env["MOOPAY_DEBUG"] ? `${err.name}: ${err.message}` : err.name) : typeof err);
  return new MoopayError("INTERNAL", "Something went wrong on my side. If you were sending money, check your activity before trying again.");
}
