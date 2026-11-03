// Deliberately uses the unchanged shipped API. Only launched suspended into the
// native harness's owned Job; no service or production data directory is used.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../../server/app.mjs';

const root = process.argv[2];
if (!root || !path.basename(root).startsWith('reclaim-owner-lifetime-')) throw Error('Fixture root required');
const apps = [];
try {
  const dataDir = path.join(root, 'data');
  for (let n = 0; n < 2; n++) {
    const app = await createApp({ dataDir, routineProbe: async () => ({ scopes: [], notices: [] }) });
    apps.push(app);
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
  }
  const update = async (app, body) => {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const { token } = await (await fetch(base + '/api/state')).json();
    const response = await fetch(base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reclaim-Token': token }, body: JSON.stringify(body) });
    if (!response.ok) throw Error(await response.text());
  };
  await update(apps[0], { exclusions: ['owner-A-preserve-this'] });
  await fs.copyFile(path.join(root, 'data/state.json'), path.join(root, 'after-A.json'));
  await update(apps[1], { folderMinBytes: 123 });
  await fs.copyFile(path.join(root, 'data/state.json'), path.join(root, 'after-B.json'));
  await fs.writeFile(path.join(root, 'sequential-result.json'), JSON.stringify({ ports: apps.map(a => a.server.address().port), sameDataDirectory: true }));
} finally {
  for (const app of apps) await app.close();
}
