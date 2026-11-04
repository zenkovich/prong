import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clientIdFor, ownClientId, PRONG_CLIENT_ID } from '../src/github.js';
import { loadSettings } from '../src/state.js';

/**
 * Signing in to GitHub in the browser goes through Prong's own OAuth app (like Fork's: its token reaches every
 * repository the user can), unless the user set an app of their own — which another server (GitHub Enterprise) needs.
 */
describe('the client id of the browser sign-in', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prong-client-id-'));
  const before = process.env.PRONG_STATE_DIR;
  process.env.PRONG_STATE_DIR = dir;
  afterAll(() => {
    process.env.PRONG_STATE_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  });

  it('github.com: Prong’s OAuth app when none is set; the user’s own when set', () => {
    expect(PRONG_CLIENT_ID).toMatch(/^Ov23/);
    expect(clientIdFor('github.com', '')).toBe(PRONG_CLIENT_ID);
    expect(clientIdFor('github.com', '  ')).toBe(PRONG_CLIENT_ID);
    expect(clientIdFor('github.com', 'Ov23mine')).toBe('Ov23mine');
  });

  it('another server: only an app of its own (none: a token instead)', () => {
    expect(clientIdFor('ghe.example.com', '')).toBe('');
    expect(clientIdFor('ghe.example.com', 'Iv1.ghe')).toBe('Iv1.ghe');
  });

  it('Prong’s former GitHub App saved in the settings is not the user’s choice: the built-in app replaces it', () => {
    expect(ownClientId('Iv23lifyjeOmrixbmyni')).toBe('');
    expect(clientIdFor('github.com', 'Iv23lifyjeOmrixbmyni')).toBe(PRONG_CLIENT_ID);
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ githubClientId: 'Iv23lifyjeOmrixbmyni', pullMode: 'merge' }));
    expect(loadSettings()).toMatchObject({ githubClientId: '', pullMode: 'merge' });
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ githubClientId: 'Iv1.own' }));
    expect(loadSettings().githubClientId).toBe('Iv1.own');
  });
});
