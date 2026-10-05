import { CommandRegistry } from '../commands.js';
import { importApply } from '../import/apply.js';
import { assetCommands } from './assets.js';
import { inventoryCommands } from './inventory.js';
import { networkCommands } from './network.js';
import { observationCommands } from './observations.js';
import { peopleLocationCommands } from './people-locations.js';
import { workflowCommands } from './workflows.js';

/** Every production command. The IPC layer can only reach commands registered here. */
export function createDomainRegistry(): CommandRegistry {
  return new CommandRegistry().register(...peopleLocationCommands, ...assetCommands, ...networkCommands, ...workflowCommands, ...observationCommands, ...inventoryCommands, importApply);
}
