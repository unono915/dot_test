// Runs a toolchain check in Electron's embedded Node, not the GUI application.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const result = spawnSync(electron, ['--test', 'tests/toolchain/sqlite-smoke.cjs'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  timeout: 30_000,
});
if (result.error) console.error(result.error.message);
if (result.signal) console.error(`Electron Node-mode check terminated: ${result.signal}`);
process.exit(result.status === null ? 1 : result.status);
