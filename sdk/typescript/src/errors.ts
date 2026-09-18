/**
 * Typed failures. Every error the SDK throws is a {@link DGCError}; mirrors the Python SDK's
 * dgc_sdk.errors. A run that hits its own timeout does not throw: its result has
 * `status: "failed"` and `reason: "timeout"`.
 */

export class DGCError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Session or client options are invalid. */
export class DGCConfigError extends DGCError {}

/** The DGC runtime could not start, handshake, stay alive, or carry out a command. */
export class DGCRuntimeError extends DGCError {}

/** The runtime speaks a protocol this SDK does not, or broke the one it offered. */
export class DGCProtocolError extends DGCRuntimeError {
  /** The protocol a `ready` handshake offered, when that was the problem. */
  readonly offeredProtocol?: unknown;
  /** The CLI version the runtime reported, when known. */
  readonly backendVersion?: string;

  constructor(message: string, details: { offeredProtocol?: unknown; backendVersion?: string; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.offeredProtocol = details.offeredProtocol;
    this.backendVersion = details.backendVersion;
  }
}

/**
 * The runtime refused a command (`command_rejected`, or an `error` naming the request).
 * `reason` is the runtime's machine-readable code when it sent one (for example
 * `turn_in_progress` or `session_unavailable`); `command` is the refused command type.
 */
export class DGCCommandRejectedError extends DGCRuntimeError {
  readonly reason: string;
  readonly command: string;

  constructor(message: string, details: { reason?: string; command?: string; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.reason = details.reason || "";
    this.command = details.command || "";
  }
}

/** A control request, the runtime handshake, or a wait on a run's result ran out of time. */
export class DGCTimeoutError extends DGCError {}

/** A requested capability is not available on this host or runtime. */
export class DGCUnsupportedError extends DGCConfigError {}

/**
 * The SDK's own error for any failure, keeping its message and details. `context` prefixes the
 * message. A DGCError keeps its class; anything else becomes a DGCRuntimeError.
 */
export function publicError(error: unknown, context = ""): DGCError {
  const base = error instanceof Error ? (error.message || error.name) : String(error);
  const message = context ? `${context}: ${base}` : base;
  if (error instanceof DGCCommandRejectedError) {
    return new DGCCommandRejectedError(message, { reason: error.reason, command: error.command, cause: error });
  }
  if (error instanceof DGCProtocolError) {
    return new DGCProtocolError(message, {
      offeredProtocol: error.offeredProtocol, backendVersion: error.backendVersion, cause: error,
    });
  }
  for (const Kind of [DGCUnsupportedError, DGCTimeoutError, DGCConfigError] as const) {
    if (error instanceof Kind) return new Kind(message, { cause: error });
  }
  return new DGCRuntimeError(message, { cause: error });
}
