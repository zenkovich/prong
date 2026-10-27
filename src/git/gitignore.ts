/**
 * A .gitignore line for exactly this path: anchored at the root ("/notes.txt" — "notes.txt" would ignore every
 * notes.txt in every folder), with git's pattern characters escaped and trailing spaces kept. A folder keeps its
 * trailing slash ("/fresh/").
 */
export function ignorePattern(p: string): string {
  const escaped = p.replace(/([\\*?[\]!#])/g, '\\$1');
  // git drops trailing spaces of a pattern unless they are escaped
  const spaces = escaped.match(/ +$/)?.[0] ?? '';
  return '/' + (spaces ? escaped.slice(0, -spaces.length) + spaces.replace(/ /g, '\\ ') : escaped);
}
