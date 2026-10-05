export interface StructuredLogger {
  debug(data: Record<string, unknown>, msg?: string): void;
  debug(msg: string): void;
  info(data: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  warn(data: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  error(data: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
}

export interface SerializedError {
  name?: string;
  message?: string;
  stack?: string;
  code?: string | number;
  statusCode?: number | string;
  status?: number | string;
  category?: string;
  cause?: SerializedError | string;
  value?: string;
}

export const MAX_CAUSE_DEPTH = 8;

export function safeJsonStringify(val: unknown): string {
  if (typeof val === 'string') {
    return val;
  }
  const seen = new WeakSet();
  try {
    const result = JSON.stringify(val, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    });
    return result !== undefined ? result : String(val);
  } catch {
    return String(val);
  }
}

export function isSerializedError(val: unknown): val is SerializedError {
  if (typeof val !== 'object' || val === null) return false;
  const record = val as Record<string, unknown>;
  return (
    typeof record.value === 'string' ||
    (typeof record.name === 'string' && typeof record.message === 'string')
  );
}

export function serializeError(
  err: unknown,
  seen: Set<unknown> = new Set(),
  depth: number = 0,
): SerializedError {
  if (typeof err === 'object' && err !== null) {
    seen.add(err);
  }

  if (err instanceof Error) {
    const serialized: SerializedError = {
      name: err.name,
      message: err.message,
    };

    if (typeof err.stack === 'string') {
      serialized.stack = err.stack;
    }

    const record = err as unknown as Record<string, unknown>;

    // Allowlisted diagnostic properties (string or number only; ignore objects or invalid types)
    if (
      (typeof record.code === 'string' && record.code.length > 0) ||
      (typeof record.code === 'number' && !Number.isNaN(record.code))
    ) {
      serialized.code = record.code;
    }

    if (
      (typeof record.statusCode === 'number' && !Number.isNaN(record.statusCode)) ||
      (typeof record.statusCode === 'string' && record.statusCode.length > 0)
    ) {
      serialized.statusCode = record.statusCode;
    }

    if (
      (typeof record.status === 'number' && !Number.isNaN(record.status)) ||
      (typeof record.status === 'string' && record.status.length > 0)
    ) {
      serialized.status = record.status;
    }

    if (typeof record.category === 'string' && record.category.length > 0) {
      serialized.category = record.category;
    }

    // Recursive cause handling
    if ('cause' in err && err.cause !== undefined) {
      const cause = err.cause;
      if (typeof cause === 'object' && cause !== null && seen.has(cause)) {
        serialized.cause = '[Circular]';
      } else if (depth >= MAX_CAUSE_DEPTH) {
        serialized.cause = '[MaxDepthExceeded]';
      } else if (cause instanceof Error) {
        serialized.cause = serializeError(cause, seen, depth + 1);
      } else if (typeof cause === 'string') {
        serialized.cause = cause;
      } else if (typeof cause === 'object' && cause !== null) {
        serialized.cause = safeJsonStringify(cause);
      } else {
        serialized.cause = String(cause);
      }
    }

    return serialized;
  }

  // Non-Error thrown values
  if (typeof err === 'string') {
    return { value: err };
  }

  if (typeof err === 'object' && err !== null) {
    return { value: safeJsonStringify(err) };
  }

  return { value: String(err) };
}

function errorReplacer(key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }
  if ((key === 'err' || key === 'error') && value !== undefined && value !== null) {
    if (!isSerializedError(value)) {
      return serializeError(value);
    }
  }
  return value;
}

function writeLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  arg1: Record<string, unknown> | string,
  arg2?: string,
): void {
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_LOGS) {
    return;
  }

  const timestamp = new Date().toISOString();
  let entry: Record<string, unknown>;

  if (typeof arg1 === 'string') {
    entry = {
      level,
      time: timestamp,
      msg: arg1,
    };
  } else {
    entry = {
      level,
      time: timestamp,
      ...(arg2 ? { msg: arg2 } : {}),
      ...arg1,
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(entry, errorReplacer);
  } catch (err) {
    serialized = safeJsonStringify({
      level,
      time: timestamp,
      msg: 'Failed to serialize log entry',
      serializationError: serializeError(err),
    });
  }

  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${serialized}\n`);
  } else {
    process.stdout.write(`${serialized}\n`);
  }
}

export const logger: StructuredLogger = {
  debug: (arg1: Record<string, unknown> | string, arg2?: string) => writeLog('debug', arg1, arg2),
  info: (arg1: Record<string, unknown> | string, arg2?: string) => writeLog('info', arg1, arg2),
  warn: (arg1: Record<string, unknown> | string, arg2?: string) => writeLog('warn', arg1, arg2),
  error: (arg1: Record<string, unknown> | string, arg2?: string) => writeLog('error', arg1, arg2),
};
