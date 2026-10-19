/**
 * Shorten prose for a tool response without cutting a sentence in half: whole
 * sentences up to `max` characters, else whole words followed by "...". A plain
 * slice ("...On the manufacturer profile the mechanisms with") reads as a
 * finished statement, and a wrong one.
 */
export function clipText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (sentenceEnd >= max * 0.4) return text.slice(0, sentenceEnd + 1);
  const wordEnd = head.lastIndexOf(" ", max - 3);
  return `${text.slice(0, wordEnd > 0 ? wordEnd : max - 3).replace(/[\s,;:.-]+$/, "")}...`;
}
