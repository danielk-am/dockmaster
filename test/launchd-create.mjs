import assert from 'node:assert/strict';
import { buildAgentPlist, defaultLogPaths, validateAgentSpec, OWNED_LABEL } from '../server/launchd-lib.mjs';

const base = { label: 'am.danielk.example', program: ['/opt/homebrew/bin/node', '/x/y.mjs'] };

// A label becomes a filename under ~/Library/LaunchAgents and decides whether
// the lifecycle routes will touch the thing afterwards.
{
  assert.deepEqual(validateAgentSpec(base), []);
  for (const label of ['com.apple.something', 'random', '', 'am.danielk.x/../../evil', 'am.danielk.x.plist']) {
    assert.ok(validateAgentSpec({ ...base, label }).length > 0, `accepted bad label: ${label}`);
  }
  assert.ok(OWNED_LABEL.test('dev.1dr0.thing'));
  assert.ok(!OWNED_LABEL.test('com.apple.thing'));
}

// launchd has no PATH, so a bare command name is a crash-loop waiting to happen.
{
  assert.match(validateAgentSpec({ ...base, program: ['node'] })[0], /absolute path/);
  assert.match(validateAgentSpec({ ...base, program: [] })[0], /program is required/);
}

// An agent with no trigger at all is a confusing thing to have just created.
{
  assert.match(
    validateAgentSpec({ ...base, keepAlive: 'never', runAtLoad: false })[0],
    /would never run/
  );
  assert.deepEqual(validateAgentSpec({ ...base, keepAlive: 'never', runAtLoad: false, startInterval: 3600 }), []);
  assert.match(validateAgentSpec({ ...base, startInterval: 5 })[0], /at least 10/);
  assert.match(validateAgentSpec({ ...base, keepAlive: 'sometimes' })[0], /keepAlive must be one of/);
}

// Environment values reach launchd verbatim, so they must be strings under
// real variable names.
{
  assert.match(validateAgentSpec({ ...base, environment: { PATH: 1 } })[0], /must be a string/);
  assert.match(validateAgentSpec({ ...base, environment: { 'not a var': 'x' } })[0], /valid variable name/);
  assert.deepEqual(validateAgentSpec({ ...base, environment: { PATH: '/usr/bin' } }), []);
}

// Paths must be absolute: launchd resolves nothing.
{
  assert.match(validateAgentSpec({ ...base, workingDirectory: 'relative/dir' })[0], /absolute/);
  assert.match(validateAgentSpec({ ...base, stdoutPath: 'out.log' })[0], /absolute/);
}

// The generated XML has to be well formed and carry what was asked for.
{
  const xml = buildAgentPlist({
    ...base,
    workingDirectory: '/x',
    environment: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/d/.claude-a8c' },
    stdoutPath: '/tmp/o.log',
    stderrPath: '/tmp/e.log',
  });
  assert.match(xml, /<key>Label<\/key><string>am\.danielk\.example<\/string>/);
  assert.match(xml, /<string>\/opt\/homebrew\/bin\/node<\/string><string>\/x\/y\.mjs<\/string>/);
  assert.match(xml, /<key>CLAUDE_CONFIG_DIR<\/key><string>\/Users\/d\/\.claude-a8c<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  assert.match(xml, /<key>StandardOutPath<\/key><string>\/tmp\/o\.log<\/string>/);
  assert.ok(xml.trimEnd().endsWith('</dict></plist>'));
}

// crash-only is the dict form, and "never" omits the key rather than writing false.
{
  assert.match(buildAgentPlist({ ...base, keepAlive: 'crash-only' }), /<key>SuccessfulExit<\/key><false\/>/);
  const never = buildAgentPlist({ ...base, keepAlive: 'never', runAtLoad: true });
  assert.doesNotMatch(never, /<key>KeepAlive<\/key>/);
}

// Values reaching XML are escaped, not interpolated raw.
{
  const xml = buildAgentPlist({ ...base, program: ['/bin/sh', '-c', 'echo "a" && b < c'] });
  assert.match(xml, /&quot;a&quot;/);
  assert.match(xml, /&amp;&amp;/);
  assert.match(xml, /&lt; c/);
  assert.doesNotMatch(xml, /<string>echo "a"/);
}

// A comment cannot break out of the XML comment it sits in.
{
  const xml = buildAgentPlist({ ...base, comment: 'safe --> <injected/>' });
  assert.equal((xml.match(/-->/g) || []).length, 1);
}

// Default log paths are namespaced by label.
{
  const logs = defaultLogPaths('/Users/d', 'am.danielk.example');
  assert.equal(logs.stdoutPath, '/Users/d/Library/Logs/am.danielk.example/service.log');
  assert.equal(logs.stderrPath, '/Users/d/Library/Logs/am.danielk.example/service.error.log');
}

console.log('launchd-create: ok');
