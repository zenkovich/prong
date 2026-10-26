/** "git@github.com:Playrix/x.git", "https://github.com/Playrix/x" → host and owner (which account fits a remote) */
export function remoteOwner(url: string): { host: string; owner: string } | null {
  const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]+([^/]+)\/[^/]+?(?:\.git)?\/?$/i);
  return m ? { host: m[1].toLowerCase(), owner: m[2] } : null;
}
