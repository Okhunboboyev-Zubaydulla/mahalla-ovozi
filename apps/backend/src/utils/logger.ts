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

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack,
      ...(err as unknown as Record<string, unknown>),
    };
  }
  return { value: String(err) };
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
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

  const serialized = JSON.stringify(entry, errorReplacer);
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
