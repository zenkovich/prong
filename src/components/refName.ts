/**
 * Why git would refuse `name` as a branch or tag name (the rules of `git check-ref-format`), null when it is fine
 * (or empty).
 */
export function refNameProblem(name: string): string | null {
  if (!name) return null;
  if (/\s/.test(name)) return 'no spaces';
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(name)) return 'none of ~ ^ : ? * [ \\';
  if (name.startsWith('-')) return 'it cannot start with -';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return '/ only between parts';
  if (name.includes('..')) return 'no ..';
  if (name === '@' || name.includes('@{')) return 'no @{';
  if (name.split('/').some((p) => p.startsWith('.') || p.endsWith('.lock'))) return 'no part may start with . or end with .lock';
  if (name.endsWith('.')) return 'it cannot end with .';
  return null;
}
