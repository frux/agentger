export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const SECRET_KEY = /token|secret|authorization|cookie|password/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, SECRET_KEY.test(key) ? "[redacted]" : redact(child)]),
    );
  }
  return value;
}

function write(level: string, message: string, fields: Record<string, unknown> = {}): void {
  const safeFields = redact(fields) as Record<string, unknown>;
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...safeFields })}\n`);
}

export const logger: Logger = {
  debug: (message, fields) => write("debug", message, fields),
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
