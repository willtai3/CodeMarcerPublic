// The CI failure reporter (.github/scripts/report-failure.sh), run with a stand-in for the gh command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../.github/scripts/report-failure.sh', import.meta.url));

// Hardening: test output is written by whoever opens the pull request, so it must not be able to end the code block
// and post its own markdown (a phishing link, @mentions) as the bot.
test('failure report: test output stays inside its code block', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'report-'));
  await writeFile(join(dir, 'gh'), '#!/bin/sh\nif [ "$1" = pr ]; then cp "$7" "$GH_OUT"; fi\n');
  await chmod(join(dir, 'gh'), 0o755);
  await writeFile(join(dir, 'out.txt'), 'not ok 1 - x\n  ```\n  [Click here](https://evil.example) @someone\n  ```\n');
  const r = spawnSync('bash', [SCRIPT, 'test', 'out.txt'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_OUT: join(dir, 'posted.md'), GITHUB_REPOSITORY: 'o/r', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '1', GITHUB_SHA: 'abcdef1234', PR_NUMBER: '7' } });
  assert.equal(r.status, 0, r.stderr);
  const body = await readFile(join(dir, 'posted.md'), 'utf8');
  assert.equal(body.match(/```/g).length, 2, 'only the opening and closing fence');
  assert.match(body, /'''\n {2}\[Click here\]/);
  assert.ok(body.trimEnd().endsWith('```'), 'the output ends inside the block');
});
