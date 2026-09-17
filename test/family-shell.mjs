import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const assistantSource = await readFile(new URL('../src/AssistantPanel.jsx', import.meta.url), 'utf8');
const conversationalSource = await readFile(new URL('../src/ConversationalField.jsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const uiPlay = JSON.parse(await readFile(new URL('../.uiplay.json', import.meta.url), 'utf8'));

assert.match(source, /Ask Localhost Manager[\s\S]*Help &amp; Feedback[\s\S]*App settings/);
assert.match(source, /Quick Start/);
assert.match(source, />01<[\s\S]*>02<[\s\S]*>03</);
assert.match(source, /prefers-reduced-motion: reduce/);
assert.match(source, /function ThemeSwitch[\s\S]*?type="button"[\s\S]*?aria-pressed=\{pref === t\}/);
assert.match(source, /Go to Localhost Manager overview/);
assert.match(source, /import \{ AiChatResizeHandle, PopoverSelect \} from '@1dr0\/ai-chat'/);
assert.match(source, /<AiChatResizeHandle[\s\S]*min=\{SIDEBAR_WIDTH_MIN\}[\s\S]*max=\{SIDEBAR_WIDTH_MAX\}[\s\S]*edge="right"/);
assert.match(source, /left-panel-resize-handle/);
assert.match(source, /<PopoverSelect[\s\S]*label="Local suffix"/);
assert.doesNotMatch(source, /<select\b/i);
assert.match(source, /localStorage\.setItem\(SIDEBAR_WIDTH_KEY, String\(next\)\)/);
assert.match(source, /mountEditableProfilePage/);
assert.match(source, /profile: ProfilePage/);
assert.match(source, /onOpen=\{openProfile\}/);
assert.match(source, /const SIDEBAR_WIDTH_MIN = 240/);
assert.match(source, /const SIDEBAR_WIDTH_MAX = 400/);
assert.match(source, /const SIDEBAR_WIDTH_DEFAULT = 304/);
assert.match(source, /ps-main-column/);
assert.match(source, /ps-topbar/);
assert.match(source, /AI-powered tip/);
assert.match(source, /ps-insights/);
assert.match(assistantSource, /AiChatResizeHandle/);
assert.match(assistantSource, /right-panel-resize-handle/);
assert.doesNotMatch(assistantSource, /\n\s*resizable\s*\n/);
assert.match(css, /grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
assert.match(css, /\.ps-sidebar[\s\S]*background:\s*var\(--ps-surface\)/);
assert.match(css, /\.ps-sidebar__resize\.wpds-ai-chat__resize-handle[\s\S]*top:\s*0[\s\S]*bottom:\s*0[\s\S]*right:\s*-8px/);
assert.match(css, /\.ps-assistant__resize\.wpds-ai-chat__resize-handle[\s\S]*top:\s*0[\s\S]*bottom:\s*0/);
assert.match(css, /\.ps-sidebar__resize\.wpds-ai-chat__resize-handle[\s\S]*transform:\s*none/);
assert.match(css, /\.ps-assistant__resize\.wpds-ai-chat__resize-handle[\s\S]*transform:\s*none/);
assert.match(css, /\.ps-sidebar__resize\.wpds-ai-chat__resize-handle[\s\S]*justify-content:\s*flex-start/);
assert.match(css, /\.ps-assistant__resize\.wpds-ai-chat__resize-handle[\s\S]*left:\s*-1px[\s\S]*justify-content:\s*flex-start/);
assert.match(css, /\.ps-assistant__resize\.wpds-ai-chat__resize-handle::before\s*\{[^}]*margin-left:\s*8px/);
assert.match(css, /\.ps-overview__hero[\s\S]*border-radius:\s*18px/);
assert.match(css, /\.ps-app\.is-sidebar-collapsed\s*\{\s*--ps-sidebar-current:\s*0px/);
assert.doesNotMatch(css, /--ps-sidebar-current:\s*72px/);
assert.match(css, /\.ps-app\.is-sidebar-collapsed \.ps-sidebar\s*\{[^}]*overflow:\s*hidden/);
assert.match(css, /\.ps-app\.is-sidebar-collapsed \.ps-sidebar > \*\s*\{\s*visibility:\s*hidden/);
assert.match(css, /\.ps-app\.is-sidebar-collapsed \.ps-sidebar-collapse\.components-button\s*\{[^}]*position:\s*fixed[^}]*visibility:\s*visible/);
assert.match(css, /\.ps-app\.is-sidebar-collapsed \.ps-sidebar-collapse\.components-button svg\s*\{\s*transform:\s*scaleX\(-1\)/);
assert.match(css, /\.ps-app\.is-sidebar-collapsed \.ps-topbar\s*\{\s*padding-left:\s*60px/);
assert.match(css, /\.ps-app\.is-sidebar-collapsed \.ps-main\s*\{\s*padding-left:\s*68px/);
assert.match(css, /\.ps-sidebar__header\s*\{[^}]*min-height:\s*56px/);
assert.match(css, /\.ps-main-column\s*\{[^}]*grid-template-rows:\s*56px/);
assert.match(css, /\.ps-assistant-fab\.components-button\s*\{[^}]*position:\s*fixed/);
assert.match(source, /!assistantOpen &&[\s\S]*ps-assistant-fab/);
assert.match(css, /\.ps-local-profile\s*\{[^}]*width:\s*100%/);
assert.match(css, /@media \(max-width: 760px\)[\s\S]*transform:\s*translateX\(-105%\)/);
assert.doesNotMatch(css, /\.ps-nav button[^}]*border-left/);
assert.match(css, /\.ps-suffixfield \.ps-suffix-select > div\s*\{[^}]*outline:\s*0 !important[^}]*box-shadow:\s*none !important/);
assert.match(html, /data-app-style="waypoint"/);

assert.match(conversationalSource, /ps-conversational-field__label[\s\S]*?<p id=\{descriptionId\}>\{description\}<\/p>[\s\S]*?ps-conversational-field__control/);
assert.match(conversationalSource, /role="group"[\s\S]*?aria-labelledby=\{labelId\}[\s\S]*?aria-describedby=\{descriptionId\}/);
assert.match(source, /label="What local address should open this service\?"[\s\S]*?label="Which port is the service listening on\?"/);
assert.match(source, /<summary>Use another suffix<\/summary>/);
assert.match(source, /label="Which launchd service starts this site\?"/);
assert.match(source, /label="What IP address should this name resolve to\?"/);
assert.match(source, /label="Which vanity suffix should this Mac resolve\?"/);
assert.match(source, /label="Resolver file contents"[\s\S]*?validated hosts or dnsmasq edit|label="Resolver file contents"/);
assert.match(source, /label="Launchd service definition"[\s\S]*?Save validates the plist/);
assert.match(source, /<AppearanceShortcut pref=\{themePref\} onOpen=\{\(\) => navigate\('settings'\)\} \/>/);
assert.doesNotMatch(source, /function AppearanceControl/);
assert.match(css, /\.ps-conversation-form\s*\{[^}]*display:\s*grid;[^}]*width:\s*min\(760px, 100%\)/s);
assert.match(css, /\.ps-conversational-field__control[\s\S]*?width:\s*100%/);

assert.deepEqual(uiPlay.app.style, { id: 'waypoint', version: '1.2.0' });
assert.equal(uiPlay.shell.sidebar.resize_handle, 'component:left-panel-resize-handle');
assert.equal(uiPlay.shell.assistant_panel.resize_handle, 'component:right-panel-resize-handle');
assert.deepEqual(
  uiPlay.components.find(({ id }) => id === 'left-panel-resize-handle')?.range,
  { min: 240, max: 400, default: 304, step: 16 },
);
assert.deepEqual(
  uiPlay.components.find(({ id }) => id === 'right-panel-resize-handle')?.range,
  { min: 320, max: 560, default: 400, step: 16 },
);

console.log('Localhost Manager family shell contract passed.');
