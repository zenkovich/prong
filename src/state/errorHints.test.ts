import { describe, expect, it } from 'vitest';
import { errorHint, isSignInError } from './errorHints';

describe('error hints', () => {
  const cases: [string, string, RegExp][] = [
    ['Checkout failed', 'git checkout x failed (1): error: Your local changes to the following files would be overwritten by checkout:\n\timg/pixel.png', /Commit, stash or discard/],
    ['Push failed', ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', /Pull \(or fetch and rebase\) first/],
    ['Fetch failed', 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', /SSH key \(or an account\) this repository should use under Connection/],
    ['Pull failed', "fatal: could not read Username for 'https://github.com': terminal prompts disabled", /account \(or SSH key\) this repository should use under Connection/],
    ['Merge stopped on conflicts', 'resolve files in Changes, then commit', /Resolve the conflicted files/],
    ['Stage failed', "fatal: Unable to create '/r/.git/index.lock': File exists.", /index\.lock/],
    ['Create branch failed', "fatal: 'bad..name' is not a valid branch name", /cannot contain spaces/],
    ['Load commit failed', 'Failed to fetch', /git engine did not answer/],
    ['Fetch failed', 'fatal: unable to access \'https://x/\': Could not resolve host: x', /could not be reached/],
    ['Cloning township failed', "fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF\nfatal: index-pack failed", /Partial clone/],
    ['Fetching all remotes failed', 'git fetch --progress --prune --all failed (128): fatal: couldn\'t find remote ref refs/heads/hs/tmp/925_fix', /no longer has that branch/],
    ['Pull failed', "Your configuration specifies to merge with the ref 'refs/heads/x'\nfrom the remote, but no such ref was fetched.", /tracks is gone from the remote/],
    // the server said no: pulling first would not help
    ['Pushing main to origin/main failed', ' ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs', /server refused the push/],
    ['Pulling origin/main into main (fast-forward) failed', 'hint: Diverging branches can\'t be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.', /pull with Merge or Rebase/],
    // an unknown host key is no matter of which key we sign in with
    ['Fetching origin failed', 'Host key verification failed.\nfatal: Could not read from remote repository.', /host key[\s\S]*known_hosts/],
  ];
  for (const [title, detail, want] of cases) it(`${title}: ${detail.split('\n')[0].slice(0, 50)}`, () => expect(errorHint(title, detail)).toMatch(want));

  it('says nothing when it has nothing useful to say', () => {
    expect(errorHint('Unexpected error', 'TypeError: x is undefined')).toBeNull();
  });
});

describe('sign-in failures', () => {
  it('lead to the Connection settings', () => {
    expect(isSignInError('Pushing x failed', 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.')).toBe(true);
    expect(isSignInError('Fetch failed', "remote: Repository not found.\nfatal: repository 'https://github.com/Playrix/x.git/' not found")).toBe(true);
    expect(isSignInError('Pull failed', 'fatal: Authentication failed for https://github.com/x/y.git')).toBe(true);
    expect(errorHint('Pushing x failed', 'git@github.com: Permission denied (publickey).')).toMatch(/Connection/);
    expect(isSignInError('Checkout failed', 'Your local changes would be overwritten')).toBe(false);
    expect(errorHint('Fetch failed', 'Host key verification failed.')).not.toMatch(/Pick the SSH key/);
  });
});
