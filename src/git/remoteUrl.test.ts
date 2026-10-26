import { describe, expect, it } from 'vitest';
import { remoteOwner } from '../git/remoteUrl';

describe('remote owner (which account fits the remote)', () => {
  it('reads host and owner from SSH and HTTPS addresses', () => {
    expect(remoteOwner('git@github.com:Playrix/perfect-project.git')).toEqual({ host: 'github.com', owner: 'Playrix' });
    expect(remoteOwner('https://github.com/Playrix/homescapes')).toEqual({ host: 'github.com', owner: 'Playrix' });
    expect(remoteOwner('ssh://git@github.example.com/team/repo.git')).toEqual({ host: 'github.example.com', owner: 'team' });
    expect(remoteOwner('/local/path/repo.git')).toBeNull();
  });
});
