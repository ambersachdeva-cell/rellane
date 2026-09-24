/** A reference is clickable only when every ID resolves unambiguously in this work. */
export function splitSourceReferences(text: string, sourceIds: readonly string[]): readonly (string | { ids: readonly string[] })[] {
  const id = "[a-f0-9-]{8,36}";
  const list = `${id}(?:,\\s*${id})*`;
  const pattern = new RegExp(`(\\[${list}\\]|\\(Sources?:\\s*${list}\\))`, "giu");
  return text.split(pattern).map(piece => {
    const bracket = /^\[([^\]]+)\]$/u.exec(piece);
    const parenthesis = /^\(Sources?:\s*([^\)]+)\)$/iu.exec(piece);
    const reference = bracket?.[1] ?? parenthesis?.[1];
    if (!reference) return piece;
    const matches = reference.split(/,\s*/u).map(value => sourceIds.filter(sourceId => sourceId.toLowerCase().startsWith(value.toLowerCase())));
    if (matches.some(values => values.length !== 1)) return piece;
    return { ids: [...new Set(matches.map(values => values[0]!))] };
  });
}
