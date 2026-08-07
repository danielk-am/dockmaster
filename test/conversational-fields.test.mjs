import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');

test('editable workflows use labelled WordPress controls with helpful copy', () => {
  assert.match(app, /function ConversationalField/);
  assert.match(app, /useBaseControlProps/);
  const wrapper = app.slice(app.indexOf('function ConversationalField'), app.indexOf('// Copy-for-AI'));
  assert.ok(wrapper.indexOf('<BaseControl') < wrapper.indexOf('ps-conversational-field__description'));
  assert.ok(wrapper.indexOf('ps-conversational-field__description') < wrapper.indexOf("children({ ...controlProps, 'aria-describedby': descriptionId })"));
  assert.match(wrapper, /const descriptionId = `\$\{controlProps\.id\}__description`/);
  assert.match(app, /label="Domain"[\s\S]*description="Choose the local address/);
  assert.match(app, /label="Upstream port"[\s\S]*description="Enter the port where this app is already listening/);
  assert.match(app, /label="Launchd service"[\s\S]*description="Linking lets Dockmaster show service state/);
  assert.match(app, /label="IP address"[\s\S]*description=/);
  assert.match(app, /label={`Resolver rules for \./);
  assert.match(app, /label="Vanity TLD"[\s\S]*description="Add only the suffix/);
  assert.match(app, /label="Launchd property list"[\s\S]*description="Edit the XML/);
});

test('forms are stacked and fill their available width', () => {
  assert.match(styles, /\.ps-form \{[\s\S]*flex-direction: column/);
  assert.match(styles, /\.ps-form \{[\s\S]*width: 100%/);
  assert.match(styles, /\.ps-suffixfield \{[\s\S]*width: 100%/);
});

test('navigation and theme choices expose their current state', () => {
  assert.match(app, /aria-pressed={pref === t}/);
  assert.match(app, /aria-current={page === n\.id \? 'page' : undefined}/);
  assert.match(app, /type="button"/);
});

test('forms own Enter submission so edits cannot fire twice', () => {
  assert.doesNotMatch(app, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter' && edit\.port\)/);
  assert.doesNotMatch(app, /if \(e\.key === 'Enter' && ipEdit\.ip\)/);
  assert.match(app, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Escape'\) setEdit\(null\); \}\}/);
  assert.match(app, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Escape'\) setIpEdit\(null\); \}\}/);
});
