// Commits one synthetic command through the compiled data layer, then dies before it can
// deliver the response (simulates a crash between commit and IPC reply).
import { DataRoot } from '../../../../dist/main/data/data-root.js';
import { CommandRegistry, defineCommand } from '../../../../dist/main/data/commands.js';

const [dir, commandId] = process.argv.slice(2);
const registry = new CommandRegistry();
registry.register(
  defineCommand({
    type: 'test.put',
    parse: (p) => p,
    run(ctx, p) {
      const versions = {};
      for (const item of p.items) {
        ctx.db.prepare('INSERT INTO settings VALUES (?, ?, 1)').run(item.key, JSON.stringify(item.value));
        ctx.emit({ eventType: 'setting.put', entityType: 'setting', entityId: item.key, before: null, after: { value: item.value, version: 1 } });
        versions[item.key] = 1;
      }
      return { versions };
    },
  }),
);
const root = DataRoot.open(dir, { registry });
root.store.execute(
  { datasetId: root.store.datasetId, epoch: root.store.epoch, commandId, type: 'test.put', payload: { items: [{ key: 'crash', value: '합성', expectedVersion: null }] } },
  '관리자',
);
process.stdout.write('committed\n', () => {
  process.kill(process.pid, 'SIGKILL');
  process.stdout.write('responded\n');
});
