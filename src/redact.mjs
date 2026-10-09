const MAX_DEPTH = 8;
const SENSITIVE_KEY =
  /^(authorization|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|password)$/i;

function redactString(value) {
  return value
    .replace(
      /(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi,
      "$1[REDACTED]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*[:=]\s*)(["']?)([^\s"',;}\]]+)(\2)/gi,
      (_, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`
    )
    .replace(
      /("(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|password|authorization)"\s*:\s*")([^"]*)(")/gi,
      "$1[REDACTED]$3"
    );
}

function redactValue(value, depth, seen) {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return "[TRUNCATED]";
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactValue(entry, depth + 1, seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : redactValue(entry, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

export function redactSecrets(value) {
  const redacted = redactValue(value, 0, new WeakSet());
  if (typeof redacted === "string") {
    return redacted;
  }
  try {
    return JSON.stringify(redacted);
  } catch {
    return String(redacted);
  }
}
