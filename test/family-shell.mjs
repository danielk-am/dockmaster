import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
const assistant = await readFile(new URL('../src/AssistantPanel.jsx', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../server/ai-bridge-config.mjs', import.meta.url), 'utf8');

assert.match(source, /Ask Dockmaster[\s\S]*Help &amp; Feedback[\s\S]*App settings/);
assert.match(source, /Quick Start/);
assert.match(source, />01<[\s\S]*>02<[\s\S]*>03</);
assert.match(source, /prefers-reduced-motion: reduce/);
assert.match(source, /Go to Dockmaster overview/);
assert.match(source, /import \{ AiChatResizeHandle, PopoverSelect \} from '@1dr0\/ai-chat'/);
assert.match(source, /<AiChatResizeHandle[\s\S]*min=\{SIDEBAR_WIDTH_MIN\}[\s\S]*max=\{SIDEBAR_WIDTH_MAX\}[\s\S]*edge="right"/);
assert.match(source, /<PopoverSelect[\s\S]*label="TLD"/);
assert.equal([...source.matchAll(/<PopoverSelect\b/g)].length, 2);
assert.doesNotMatch(source, /<select\b/i);
assert.match(source, /localStorage\.setItem\(SIDEBAR_WIDTH_KEY, String\(next\)\)/);
assert.match(source, /generatedIdentityImage\('mark', 'Dockmaster'\)/);
assert.match(source, /generatedIdentityImage\('avatar', 'Dockmaster local operator'\)/);
assert.match(css, /grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
assert.match(css, /\.ps-sidebar[\s\S]*background:\s*var\(--ps-surface\)/);
assert.match(css, /\.ps-sidebar__resize\.a8c-ai-chat__resize-handle[\s\S]*right:\s*-8px/);
assert.match(css, /--ps-canvas:\s*#fff/);
assert.match(css, /--ps-surface:\s*#fff/);
assert.match(css, /\.ps-brand__mark[^}]*width:\s*36px[^}]*height:\s*36px/);
assert.match(css, /\.ps-local-profile__avatar[^}]*width:\s*28px[^}]*height:\s*28px/);
assert.doesNotMatch(css, /\.ps-nav button[^}]*border-left/);
assert.match(assistant, /name:\s*'open_section'/);
assert.doesNotMatch(assistant, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
assert.match(bridge, /createOpenAICompatibleRelay/);
assert.match(bridge, /mode:\s*'direct'/);

console.log('Dockmaster family shell contract passed.');
