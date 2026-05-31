import { homedir } from 'os';
import { isAbsolute, relative, resolve } from 'path';

export function isPathInside(child, parent) {
  const base = resolve(parent);
  const target = resolve(child);
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveUnderHome(input, { label = 'path', requireCanonical = false } = {}) {
  if (typeof input !== 'string' || !isAbsolute(input)) {
    throw new Error(`invalid ${label}`);
  }
  const resolved = resolve(input);
  if (requireCanonical && resolved !== input) {
    throw new Error(`invalid ${label}`);
  }
  if (!isPathInside(resolved, homedir())) {
    throw new Error(`${label} outside $HOME`);
  }
  return resolved;
}
