/** The key shape the secrets API accepts. */
const VALID_KEY = /^[A-Z][A-Z0-9_]*$/i;

export interface ParsedEnv {
  /** key → value, in file order; a key given twice keeps its last value */
  entries: [key: string, value: string][];
  /** lines that couldn't be used, with the reason */
  skipped: { line: number; text: string; reason: string }[];
}

/**
 * Parse the text of a .env file: `KEY=value` lines, with optional `export`,
 * `#` comments, single- or double-quoted values (which may span lines) and
 * trailing comments after unquoted values. Values are never interpolated —
 * `$OTHER` stays as written.
 */
export function parseEnv(text: string): ParsedEnv {
  const entries = new Map<string, string>();
  const skipped: ParsedEnv["skipped"] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      skipped.push({ line: lineNo, text: preview(line), reason: "not a KEY=value line" });
      continue;
    }
    const key = match[1] ?? "";
    let rest = match[2] ?? "";
    let value: string;

    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // a quoted value runs to its closing quote, across lines if need be
      let end = closingQuote(rest, quote);
      while (end === -1 && i + 1 < lines.length) {
        i++;
        rest += `\n${lines[i] ?? ""}`;
        end = closingQuote(rest, quote);
      }
      if (end === -1) {
        skipped.push({ line: lineNo, text: key, reason: "the quote is never closed" });
        continue;
      }
      const inner = rest.slice(1, end);
      value =
        quote === '"'
          ? inner.replace(/\\([nrt"\\$])/g, (_, c: string) =>
              c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
            )
          : inner;
    } else {
      value = rest.replace(/\s+#.*$/, "").trim();
    }

    if (!VALID_KEY.test(key)) {
      skipped.push({
        line: lineNo,
        text: preview(key),
        reason: "the name must be letters, digits and underscores, starting with a letter",
      });
    } else if (value === "") {
      skipped.push({ line: lineNo, text: key, reason: "no value" });
    } else {
      entries.delete(key); // so a repeated key takes its later position too
      entries.set(key, value);
    }
  }
  return { entries: [...entries], skipped };
}

/** Index of the quote that closes the one at position 0, or -1. */
function closingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** Enough of a line to recognise it, without echoing a whole secret. */
const preview = (text: string): string => (text.length > 24 ? `${text.slice(0, 24)}…` : text);
