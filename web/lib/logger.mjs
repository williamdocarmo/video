const toErrorPayload = (error) => {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null
    };
  }

  return {
    name: "Error",
    message: String(error),
    stack: null
  };
};

const sanitizeValue = (value, depth = 0) => {
  if (depth > 4) {
    return "[truncated]";
  }

  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (value instanceof Error) {
    return toErrorPayload(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, nestedValue]) => [key, sanitizeValue(nestedValue, depth + 1)])
    );
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return value;
};

export const logJsonLine = (level, event, fields = {}) => {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeValue(fields)
  };
  const line = `${JSON.stringify(payload)}\n`;

  if (level === "error" || level === "warn") {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
};

export const serializeError = (error) => sanitizeValue(error);
