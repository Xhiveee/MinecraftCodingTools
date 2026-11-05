import { validationInput } from './validation-schemas.js';
import type { ValidationKind } from './validation.js';

const descriptions: Record<ValidationKind, string> = {
  resources: 'Check asset JSON, model/blockstate/item-definition links, textures, sounds, fonts and PNG animation sidecars.',
  data: 'Check data JSON, pack metadata, version-sensitive paths, function-tag targets and tag cycles.',
  worldgen: 'Check worldgen JSON and local feature, biome, dimension, structure and template-pool references. Does not run game codecs.',
  plugin: 'Check plugin.yml/paper-plugin.yml syntax and metadata, source entry class discovery, dependency shapes and server reload calls. Does not prove JavaPlugin inheritance.',
  mod: 'Check Fabric JSON and Forge/NeoForge TOML descriptors, metadata fields, Fabric mixin files, entrypoint shape and access widener existence.',
  modules: 'Inspect detected mod/plugin modules for version/identity drift, duplicate plugin names and loader imports in common code. Allows Stonecutter version variants.',
};

export function validationTools(target: 'mod' | 'plugin') {
  const kinds: ValidationKind[] = target === 'mod' ? ['resources', 'mod', 'data', 'worldgen', 'modules'] : ['resources', 'plugin', 'data', 'worldgen', 'modules'];
  return kinds.map(kind => ({
    name: kind === 'modules' ? 'validate_modules' : `validate_${kind}`,
    title: `Validate ${kind}`,
    description: `${descriptions[kind]} Static local checks; no build/game execution. Unresolved external references are warnings. Supply roots for generated resources or unpacked dependencies.`,
    input: validationInput,
    readOnly: true,
    openWorld: false,
    load: async () => {
      const { validate } = await import('./validation.js');
      return async (_services: unknown, args: Parameters<typeof validate>[1]) => validate(kind, args);
    },
  }));
}
