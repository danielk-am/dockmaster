// Building and validating a new launchd user agent.
//
// Localhost Manager could already list, start, stop, enable, disable, kickstart and
// edit agents. What it could not do was create one, so every new service still
// meant hand-writing XML into ~/Library/LaunchAgents. This is that missing half.
//
// Everything here is pure: it turns a spec into plist XML, or into a list of
// problems. Anything touching launchctl or the filesystem stays in index.mjs.

import path from 'node:path';

// Same ownership rule the lifecycle routes enforce. Creating an agent outside
// this namespace would let Localhost Manager write plists it then refuses to manage.
export const OWNED_LABEL = /^(am\.danielk\.|com\.danielkam\.|dev\.1dr0\.)[A-Za-z0-9][A-Za-z0-9._-]*$/;

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

const KEEPALIVE_MODES = new Set(['always', 'never', 'crash-only']);

// A label becomes a filename, so it must not be able to climb out of the
// agents directory or collide with the .disabled / .retired parking suffixes.
function labelProblems(label) {
  if (!label) return ['label is required'];
  if (!OWNED_LABEL.test(label)) {
    return ['label must start with am.danielk., com.danielkam. or dev.1dr0. and contain only letters, digits, dot, dash or underscore'];
  }
  if (label.includes('/') || label.includes('..') || path.basename(label) !== label) {
    return ['label must not contain a path'];
  }
  if (/\.plist$/i.test(label)) return ['label must not end in .plist'];
  return [];
}

export function validateAgentSpec(spec = {}) {
  const problems = [...labelProblems(spec.label)];

  const program = Array.isArray(spec.program) ? spec.program.filter((a) => a !== '') : [];
  if (!program.length) problems.push('program is required, as an array of the command and its arguments');
  else if (!path.isAbsolute(program[0])) problems.push('the program must be an absolute path, because launchd has no PATH of its own');
  if (program.some((a) => typeof a !== 'string')) problems.push('every program argument must be a string');

  if (spec.workingDirectory != null && !path.isAbsolute(spec.workingDirectory)) {
    problems.push('workingDirectory must be an absolute path');
  }

  if (spec.environment != null) {
    if (typeof spec.environment !== 'object' || Array.isArray(spec.environment)) {
      problems.push('environment must be an object of string values');
    } else {
      for (const [k, v] of Object.entries(spec.environment)) {
        if (typeof v !== 'string') problems.push(`environment.${k} must be a string`);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) problems.push(`environment key "${k}" is not a valid variable name`);
      }
    }
  }

  if (spec.keepAlive != null && !KEEPALIVE_MODES.has(spec.keepAlive)) {
    problems.push(`keepAlive must be one of: ${[...KEEPALIVE_MODES].join(', ')}`);
  }

  if (spec.startInterval != null) {
    const n = Number(spec.startInterval);
    if (!Number.isInteger(n) || n < 10) problems.push('startInterval must be a whole number of seconds, at least 10');
  }

  for (const key of ['stdoutPath', 'stderrPath']) {
    if (spec[key] != null && !path.isAbsolute(spec[key])) problems.push(`${key} must be an absolute path`);
  }

  // A run-once agent with neither KeepAlive nor RunAtLoad nor StartInterval
  // never runs, which is a confusing thing to have just created.
  const keepAlive = spec.keepAlive ?? 'always';
  if (keepAlive === 'never' && !spec.runAtLoad && spec.startInterval == null) {
    problems.push('this agent would never run: set keepAlive, runAtLoad, or startInterval');
  }

  return problems;
}

function keepAliveNode(mode) {
  if (mode === 'never') return null;
  if (mode === 'crash-only') {
    return '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>';
  }
  return '  <key>KeepAlive</key><true/>';
}

export function buildAgentPlist(spec) {
  const {
    label,
    program,
    workingDirectory,
    environment,
    keepAlive = 'always',
    runAtLoad = true,
    startInterval,
    stdoutPath,
    stderrPath,
    comment,
  } = spec;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
  ];
  if (comment) lines.push(`  <!-- ${esc(String(comment).replace(/--+/g, '-')).slice(0, 300)} -->`);
  lines.push(`  <key>Label</key><string>${esc(label)}</string>`);
  lines.push(`  <key>ProgramArguments</key><array>${program.map((a) => `<string>${esc(a)}</string>`).join('')}</array>`);
  if (workingDirectory) lines.push(`  <key>WorkingDirectory</key><string>${esc(workingDirectory)}</string>`);

  const env = Object.entries(environment ?? {});
  if (env.length) {
    lines.push('  <key>EnvironmentVariables</key><dict>');
    for (const [k, v] of env) lines.push(`    <key>${esc(k)}</key><string>${esc(v)}</string>`);
    lines.push('  </dict>');
  }

  const ka = keepAliveNode(keepAlive);
  if (ka) lines.push(ka);
  lines.push(`  <key>RunAtLoad</key><${runAtLoad ? 'true' : 'false'}/>`);
  if (startInterval != null) lines.push(`  <key>StartInterval</key><integer>${Number(startInterval)}</integer>`);
  lines.push('  <key>ProcessType</key><string>Background</string>');
  if (stdoutPath) lines.push(`  <key>StandardOutPath</key><string>${esc(stdoutPath)}</string>`);
  if (stderrPath) lines.push(`  <key>StandardErrorPath</key><string>${esc(stderrPath)}</string>`);
  lines.push('</dict></plist>', '');

  return lines.join('\n');
}

// Log paths a new agent gets when the caller does not name its own.
export function defaultLogPaths(home, label) {
  const dir = path.join(home, 'Library/Logs', label);
  return { dir, stdoutPath: path.join(dir, 'service.log'), stderrPath: path.join(dir, 'service.error.log') };
}
