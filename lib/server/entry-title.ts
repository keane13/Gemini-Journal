/**
 * @file lib/server/entry-title.ts
 * Derives an entry title from the writer's own words.
 *
 * Used by the "save without reply" path so that saving quietly requires no generative
 * call at all: the title comes from the first sentence the user actually wrote, not from
 * a model round-trip. Lives here rather than in the route because Next.js restricts which
 * names a route module may export.
 */

export function deriveTitle(text: string): string {
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const candidate = (firstSentence || firstLine).trim();

  if (!candidate) return 'Untitled entry';
  if (candidate.length <= 72) return candidate;

  const cut = candidate.slice(0, 72);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
