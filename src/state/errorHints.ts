/**
 * What to do about common git failures: one sentence shown above the raw output in the error dialog.
 * Matched against the title and the full message; the first rule that matches wins.
 */
const RULES: [RegExp, string][] = [
  [/local changes to the following files would be overwritten|your local changes would be overwritten/i, 'Commit, stash or discard these changes first, then try again.'],
  [/untracked working tree files would be (overwritten|removed)/i, 'Move or delete those untracked files first, or add them to .gitignore.'],
  [/stopped on conflicts|\bCONFLICT\b|unmerged files|you have unmerged paths/i, 'Resolve the conflicted files in Changes and stage them, then continue or abort from the status bar.'],
  [/non-fast-forward|\[rejected\]|updates were rejected|fetch first/i, 'The remote has commits you do not have. Pull (or fetch and rebase) first, then push.'],
  // the server itself said no: a hook, a protected branch, missing rights — pulling does not help
  [/\[remote rejected\]|pre-receive hook declined|protected branch/i, 'The server refused the push (a hook, a protected branch or missing rights): its reason is in the output below. Push to another branch and open a pull request, or ask for the rights.'],
  [/not possible to fast-forward|diverging branches can't be fast-forwarded/i, 'The branches have diverged, so a fast-forward is not possible: pull with Merge or Rebase instead.'],
  [/sign-in of .* (has expired|is missing|was refused|could not be renewed)|sign in again under accounts|bad credentials/i, 'GitHub no longer accepts this account’s sign-in (it expired or was revoked). Sign in again under Accounts as the same user; Prong renews it by itself from then on.'],
  // the server's own key is unknown or changed: no key of ours fixes that (it used to say "pick the SSH key")
  [/host key verification failed|remote host identification has changed/i, 'SSH does not trust the server’s host key: it is new to this Mac (or it changed). Connect once in a terminal (ssh -T git@<host>) and accept it, or fix ~/.ssh/known_hosts.'],
  [/permission denied \(publickey\)/i, 'SSH could not sign in with the key it tried. Pick the SSH key (or an account) this repository should use under Connection; its submodules follow it.'],
  [/authentication failed|could not read username|terminal prompts disabled|invalid username or password|\b403\b|repository not found/i, 'The remote did not accept the credentials. Pick the account (or SSH key) this repository should use under Connection; its submodules follow it.'],
  [/could not resolve host|connection timed out|network is unreachable|connection refused|unable to access/i, 'The server could not be reached. Check the network and the remote URL.'],
  [/couldn't find remote ref/i, 'The remote no longer has that branch (deleted or renamed there). Remove it from the remote’s fetched branches (git config remote.<name>.fetch), or push it again.'],
  [/no such ref was fetched|upstream is gone|no tracking information/i, 'The branch this one tracks is gone from the remote. Push it again, or pick another upstream with Set upstream….'],
  [/early eof|index-pack failed|unexpected disconnect|hung up unexpectedly|rpc failed|connection (reset|closed) by/i, 'The download broke off midway (a long transfer over one connection). Try again; for a large repository tick “Partial clone” in Clone — the history arrives without old file contents, in a fraction of the time.'],
  [/index\.lock|unable to create '.*\.lock'/i, 'Another git process is working in this repository, or one crashed. If none is running, delete .git/index.lock.'],
  [/please tell me who you are|empty ident name/i, 'Git does not know your name and e-mail yet. Set them under Preferences.'],
  [/gpg failed to sign|cannot run gpg|ssh-keygen.*sign|failed to write commit object/i, 'Signing failed. Check the signing key under Preferences → SSH, or turn Sign off.'],
  [/not a valid branch name|is not a valid (ref|tag) name/i, 'Branch and tag names cannot contain spaces, "..", "~", "^", ":" or end with ".lock".'],
  [/not fully merged/i, 'These branches have commits that are on no other branch. Delete again with “also unmerged” ticked if you want them gone.'],
  [/already exists/i, 'Pick another name, or delete the existing one first.'],
  [/pathspec .* did not match|unknown revision|bad revision/i, 'The branch, commit or file does not exist (any more). Refresh and try again.'],
  [/is not in the submodule clone/i, 'Fetch in the submodule’s tab, or use “Update to index” in the parent repository.'],
  [/not a git repository/i, 'The folder is not a git repository, or it was moved. Open it again from the start screen.'],
  [/failed to fetch|networkerror|engine is offline|load failed/i, 'Prong’s git engine did not answer. If it stopped, restart Prong.'],
];

/** a GitHub account's sign-in that no longer works: Accounts → Sign in again fixes it */
export function isAccountSignInError(title: string, detail?: string) {
  return /sign-in of .* (has expired|is missing|was refused|could not be renewed)|sign in again under accounts|bad credentials/i.test(`${title}\n${detail ?? ''}`);
}

/** the remote refused who we are (SSH key or token): the Connection settings fix it */
export function isSignInError(title: string, detail?: string) {
  return /permission denied \(publickey\)|authentication failed|could not read username|terminal prompts disabled|invalid username or password|\b403\b|repository not found/i.test(`${title}\n${detail ?? ''}`);
}

export function errorHint(title: string, detail?: string): string | null {
  const text = `${title}\n${detail ?? ''}`;
  for (const [re, hint] of RULES) if (re.test(text)) return hint;
  return null;
}
