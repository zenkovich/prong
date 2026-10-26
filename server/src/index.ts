import { createApi } from './api.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// project root (prong/) when the engine runs from its sources; the packaged app has no sources beside it
try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pkg = path.join(root, 'package.json');
  if (!process.env.PRONG_SOURCES_DEFAULT && existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'prong') process.env.PRONG_SOURCES_DEFAULT = root;
} catch {
  /* ignore */
}

const port = parseInt(process.env.PRONG_PORT ?? '8790', 10);
const { server } = createApi({ log: (s) => console.log(`[prong] ${s}`) });
server.listen(port, '127.0.0.1', () => {
  console.log(`[prong] git engine listening on http://127.0.0.1:${port}${process.env.PRONG_WEB_DIR ? ' (serving web ui)' : ''}`);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
