import { describe, expect, it } from 'vitest';
import { canonFolder, resolveFileIcon, resolveFolderIcon } from './fileIconResolve';
import { ICONS } from './fileIconMap.generated';

describe('file icons', () => {
  it('matches exact file names before extensions', () => {
    expect(resolveFileIcon('package.json')).toEqual({ kind: 'theme', icon: 'nodejs' });
    expect(resolveFileIcon('src/tsconfig.json')).toEqual({ kind: 'theme', icon: 'tsconfig' });
    expect(resolveFileIcon('Dockerfile')).toEqual({ kind: 'theme', icon: 'docker' });
    expect(resolveFileIcon('.gitignore')).toEqual({ kind: 'theme', icon: 'git' });
  });
  it('prefers the longest compound extension', () => {
    expect(resolveFileIcon('a/b/c.ts')).toEqual({ kind: 'theme', icon: 'typescript' });
    expect(resolveFileIcon('types.d.ts').kind).toBe('theme');
    expect((resolveFileIcon('types.d.ts') as any).icon).not.toBe('typescript');
    expect(resolveFileIcon('App.tsx')).toEqual({ kind: 'theme', icon: 'react_ts' });
    expect(resolveFileIcon('sound.WAV')).toEqual({ kind: 'theme', icon: 'audio' });
    expect(resolveFileIcon('clip.webm')).toEqual({ kind: 'theme', icon: 'video' });
  });
  it('asks the OS for unknown extensions and falls back to a document for odd names', () => {
    expect(resolveFileIcon('Assets/scene.meta')).toEqual({ kind: 'system', ext: 'meta' });
    expect(resolveFileIcon('Project.pbxproj')).toEqual({ kind: 'system', ext: 'pbxproj' });
    expect(resolveFileIcon('NOEXTENSIONFILE')).toEqual({ kind: 'theme', icon: ICONS.file });
    expect(resolveFileIcon('weird.ext with space')).toEqual({ kind: 'theme', icon: ICONS.file });
  });
  it('uses light-theme variants when the scheme is light', () => {
    const lightName = Object.keys(ICONS.light.ext)[0];
    if (lightName) expect((resolveFileIcon(`x.${lightName}`, true) as any).icon).toBe(ICONS.light.ext[lightName]);
  });
  it('names folders by their canonical name and opens them when expanded', () => {
    expect(canonFolder('__tests__')).toBe('tests');
    expect(canonFolder('.github')).toBe('github');
    expect(resolveFolderIcon('src', false)).toBe('folder-src');
    expect(resolveFolderIcon('src', true)).toBe('folder-src-open');
    expect(resolveFolderIcon('a/b/.github', false)).toBe('folder-github');
    expect(resolveFolderIcon('some-random-dir', false)).toBe(ICONS.folder);
    expect(resolveFolderIcon('some-random-dir', true)).toBe(ICONS.folderOpen);
  });
});
