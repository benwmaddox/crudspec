// "did you mean …?": the closest of the names a misspelled one could be, when it is close
// enough to be a slip (a few letters' edit), for the checker's and the parser's messages.
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined, bestD = Infinity;
  const limit = Math.max(1, Math.floor(name.length / 3));
  for (const c of candidates) {
    if (c === name) continue;
    const d = distance(name.toLowerCase(), c.toLowerCase());
    if (d < bestD || (d === bestD && best !== undefined && c.length < best.length)) { best = c; bestD = d; }
  }
  return bestD <= limit ? best : undefined;
}
// the message's ending: "; did you mean color?" or nothing
export const didYouMean = (name: string, candidates: Iterable<string>): string => {
  const c = closest(name, candidates);
  return c ? `; did you mean ${c}?` : "";
};
// edits (insert, delete, replace, swap two neighbours) from a to b
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
