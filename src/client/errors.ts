// Typed errors of the client (core spec §6): the P2PACT error codes, and the tool's own JSON-RPC errors.
import { ErrBadArgs, ErrFailed, ErrForbidden, ErrNoMethod, ErrNotDelivered, ErrNotFound, P2PACTError } from "../node.js";

/** A P2PACT error (core spec §6): the call never reached the tool. `code` is one of the
 * `Err…` codes; the subclasses name the ones an application handles. */
export class ProtocolError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Error 1: the device has no such tool or method. */
export class NoMethodError extends ProtocolError {
  constructor(message: string) {
    super(ErrNoMethod, message);
  }
}

/** Error 2: the arguments are wrong. */
export class BadArgsError extends ProtocolError {
  constructor(message: string) {
    super(ErrBadArgs, message);
  }
}

/** Error 3: no such thing. */
export class NotFoundError extends ProtocolError {
  constructor(message: string) {
    super(ErrNotFound, message);
  }
}

/** Error 4: the grants of the device do not allow the call (spec §8.1). */
export class ForbiddenError extends ProtocolError {
  constructor(message: string) {
    super(ErrForbidden, message);
  }
}

/** Error 5: the call failed on the device. */
export class FailedError extends ProtocolError {
  constructor(message: string) {
    super(ErrFailed, message);
  }
}

/** Error 6: not delivered, e.g. a hosted tool whose plugin is gone (spec §8.2); also a call that
 * got no answer in time. */
export class NotDeliveredError extends ProtocolError {
  constructor(message: string) {
    super(ErrNotDelivered, message);
  }
}

/** A JSON-RPC error of the tool itself (the call was delivered): `code` is JSON-RPC's (-32601 no
 * such method, -32602 params, -32004 no such resource, -32000 failed), `data` the optional extra. */
export class RpcError extends Error {
  static readonly METHOD_NOT_FOUND = -32601;
  static readonly INVALID_PARAMS = -32602;
  static readonly NO_SUCH_RESOURCE = -32004;
  static readonly FAILED = -32000;

  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }

  get isMethodNotFound() {
    return this.code === RpcError.METHOD_NOT_FOUND;
  }

  get isNoSuchResource() {
    return this.code === RpcError.NO_SUCH_RESOURCE;
  }
}

/** typed turns the library's P2PACTError into the error of its code; others stay as they are. */
export function typed(e: unknown): unknown {
  if (!(e instanceof P2PACTError)) return e;
  switch (e.code) {
    case ErrNoMethod: return new NoMethodError(e.message);
    case ErrBadArgs: return new BadArgsError(e.message);
    case ErrNotFound: return new NotFoundError(e.message);
    case ErrForbidden: return new ForbiddenError(e.message);
    case ErrFailed: return new FailedError(e.message);
    case ErrNotDelivered: return new NotDeliveredError(e.message);
    default: return new ProtocolError(e.code, e.message);
  }
}
