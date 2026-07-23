// Seeds the Local Ingress registry (run as danielkam by deploy/install.sh):
// registers snippets.test → 4949 if absent (migrating the espanso-ui deploy
// kit), mints any missing certs, regenerates Caddyfile + sites + staging.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CERTS, MKCERT, ensureDirs, readRegistry, regenerate, writeRegistry } from '../server/ingress-lib.mjs';

ensureDirs();
const reg = readRegistry();
if (!reg.domains.some((d) => d.host === 'snippets.test')) {
	reg.domains.push({ host: 'snippets.test', port: 4949 });
	writeRegistry(reg);
}
for (const d of readRegistry().domains) {
	const pem = path.join(CERTS, `${d.host}.pem`);
	if (!fs.existsSync(pem)) {
		execFileSync(MKCERT, ['-cert-file', pem, '-key-file', path.join(CERTS, `${d.host}-key.pem`), d.host], {
			stdio: 'inherit',
		});
	}
}
regenerate();
console.log('  seeded:', readRegistry().domains.map((d) => `${d.host}→${d.port}`).join(', '));
