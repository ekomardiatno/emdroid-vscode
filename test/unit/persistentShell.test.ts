import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AdbClient } from '../../src/host/adb/AdbClient.ts';
import { PersistentShell } from '../../src/host/adb/PersistentShell.ts';
import { ChildProcessRegistry } from '../../src/host/childProcesses.ts';
import { Logger } from '../../src/host/log.ts';

/**
 * The persistent shell, against a real shell rather than a real device.
 *
 * `AdbClient` spawns `<adb> -s <serial> shell`, so pointing it at `/bin/sh`
 * produces `sh -s fake shell` -- and `-s` is precisely "read commands from
 * stdin", with the remaining words becoming positional parameters. That is a
 * genuine interactive shell on a pipe, which is the only thing this class
 * actually requires of the far end.
 *
 * This exists because of a bug the unit suite could not see: `AdbClient.spawn`
 * passes `stdio: ['ignore', ...]`, correctly, for `screenrecord` and `logcat`.
 * The persistent shell used it too, so it got /dev/null on stdin, the device
 * shell read EOF and exited, and every command was written to a dead pipe.
 * Nothing threw -- `DisplayWatcher` and `AdbInputSink` both log a failed exec
 * at debug and carry on -- so taps did nothing and rotation was never read,
 * with an empty log at the default level. Only a device run found it.
 */
describe('PersistentShell', () => {
  const logger = new Logger();
  const registry = new ChildProcessRegistry(logger.scope('test'));
  const client = new AdbClient(registry, logger.scope('test'), '/bin/sh');
  let shell: PersistentShell;

  before(() => {
    shell = new PersistentShell(client, 'fake', logger.scope('shell'));
  });

  after(() => {
    shell.dispose();
    registry.killAll();
    logger.dispose();
  });

  it('writes a command and reads back its output', async () => {
    // Fails outright if stdin is not a pipe: there is nowhere to write to.
    assert.equal((await shell.exec('printf hi', 5000)).trim(), 'hi');
  });

  it('keeps replies in order on one shell', async () => {
    // The sentinel is the only framing, so a reply landing on the wrong
    // promise is the failure mode worth pinning.
    const replies = await Promise.all([
      shell.exec('printf one', 5000),
      shell.exec('printf two', 5000),
      shell.exec('printf three', 5000),
    ]);
    assert.deepEqual(
      replies.map((r) => r.trim()),
      ['one', 'two', 'three'],
    );
  });

  it('does not treat output that looks like a command as framing', async () => {
    const out = await shell.exec("printf '%s\\n' 'echo __emdroid_not_the_sentinel__'", 5000);
    assert.equal(out.trim(), 'echo __emdroid_not_the_sentinel__');
  });

  it('rejects a command that never answers', async () => {
    await assert.rejects(() => shell.exec('sleep 5', 150), /timed out/);
    // And the shell is still usable: a timeout must drop its own queue entry
    // rather than leave the next reply paired with the abandoned one.
    assert.equal((await shell.exec('printf after', 8000)).trim(), 'after');
  });

  it('reports a shell that cannot be started', async () => {
    const broken = new PersistentShell(
      new AdbClient(registry, logger.scope('test'), '/nonexistent/adb'),
      'fake',
      logger.scope('shell'),
    );
    await assert.rejects(() => broken.exec('printf hi', 5000));
    broken.dispose();
  });
});
