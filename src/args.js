// Command-line options shared by server.js: --config <file>, --no-scheduler.
import path from 'node:path';

const argv = process.argv.slice(2);
const i = argv.indexOf('--config');
if (i >= 0 && argv[i + 1]) process.env.DOH_PORTAL_CONFIG = path.resolve(argv[i + 1]);
if (argv.includes('--no-scheduler')) process.env.DOH_PORTAL_NO_SCHEDULER = '1';
