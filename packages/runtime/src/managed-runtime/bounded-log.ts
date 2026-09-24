const DEFAULT_MAXIMUM_CHARACTERS = 32 * 1024;

export class BoundedRedactedLog {
  private rawValue = "";
  private readonly sensitiveValues = new Set<string>();

  constructor(
    private readonly maximumCharacters = DEFAULT_MAXIMUM_CHARACTERS
  ) {
    if (
      !Number.isInteger(maximumCharacters) ||
      maximumCharacters < 1_024 ||
      maximumCharacters > 128 * 1024
    ) {
      throw new Error("The diagnostic log bound is invalid.");
    }
  }

  clear(): void {
    this.rawValue = "";
    this.sensitiveValues.clear();
  }

  addSensitiveValue(value: string): void {
    if (value.length > 0) {
      this.sensitiveValues.add(value);
      this.rawValue = this.rawValue
        .split(value)
        .join("[redacted-sensitive]");
    }
  }

  append(chunk: Uint8Array | string): void {
    const decoded = typeof chunk === "string"
      ? chunk
      : new TextDecoder("utf-8", { fatal: false }).decode(chunk);
    let combined = `${this.rawValue}${decoded}`;
    for (const sensitiveValue of this.sensitiveValues) {
      combined = combined
        .split(sensitiveValue)
        .join("[redacted-sensitive]");
    }
    this.rawValue = combined.slice(-(this.maximumCharacters * 2));
  }

  snapshot(): string {
    let redacted = this.rawValue
      .replace(/[^\t\n\r\x20-\x7e]/gu, "\uFFFD")
      .replace(
        /\b(?:https?|file):\/\/[^\s"'<>]+/giu,
        "[redacted-url]"
      )
      .replace(
        /\b(?:authorization|api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu,
        "[redacted-secret]"
      )
      .replace(
        /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu,
        "Bearer [redacted]"
      );

    for (const sensitiveValue of this.sensitiveValues) {
      redacted = redacted
        .split(sensitiveValue)
        .join("[redacted-sensitive]");
    }

    redacted = redacted.replace(
      /(?:^|[\s("'=])\/(?:Users|private|var|tmp|Volumes|Applications)\/[^\s"'<>)]*/gmu,
      (match) => `${match.slice(0, match.indexOf("/"))}[redacted-path]`
    );
    return redacted.slice(-this.maximumCharacters);
  }
}
