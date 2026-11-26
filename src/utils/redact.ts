const secrets = new Set<string>();

/** Register only authentication material, never accounting data. */
export function registerSecrets(...values: Array<string | undefined>): void {
  for (const value of values) if (value) secrets.add(value);
}

export function redactText(text: string): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    for (const variant of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]) {
      result = result.split(variant).join("[REDACTED]");
    }
  }
  // Redact entire URLs: callback queries and request URLs can contain secrets.
  result = result.replace(/https?:\/\/[^\s<>"']+/gi, "[REDACTED URL]");
  result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]");
  result = result.replace(/(["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization(?:[_-]?code)?|password|code|state)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[REDACTED]");
  return result.slice(0, 4000);
}
