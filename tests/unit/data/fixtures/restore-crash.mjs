// Runs a restore through the compiled data layer and kills the process at the requested step,
// simulating a power cut / forced termination during generation switching.
import { DataRoot } from '../../../../dist/main/data/data-root.js';
import { createDomainRegistry } from '../../../../dist/main/data/domain/registry.js';
import { previewRestore, restoreBackup } from '../../../../dist/main/data/restore.js';

const [dir, bundle, crashAt, corrupt] = process.argv.slice(2);
const root = DataRoot.open(dir, { registry: createDomainRegistry() });
const preview = await previewRestore(root, bundle);
const fs = await import('node:fs');
await restoreBackup(root, bundle, { datasetId: preview.manifest.datasetId, revision: preview.manifest.revision }, {
  actor: '정보부 관리자',
  faults: {
    hit(step) {
      if (step !== crashAt) return;
      if (corrupt === 'corrupt-new') {
        // Make the freshly activated generation unusable before dying.
        const active = root.catalog.active();
        root.store.close();
        fs.writeFileSync(root.catalog.datasetFile(active.generationId), 'not a database');
      }
      process.stdout.write(`crash at ${step}\n`);
      process.kill(process.pid, 'SIGKILL');
    },
  },
});
process.stdout.write('finished\n');
