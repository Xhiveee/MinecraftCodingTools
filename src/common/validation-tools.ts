import { pluginValidationInput, validationInput } from './validation-schemas.js';
import type { ValidationKind } from './validation.js';

const descriptions: Record<ValidationKind, string> = {
  resources: 'Check asset JSON, model/blockstate/item-definition links, textures, sounds, fonts and PNG animation sidecars.',
  data: 'Check data JSON, pack metadata, version-sensitive paths, function-tag targets and tag cycles.',
  worldgen: 'Check worldgen JSON and local feature, biome, dimension, structure and template-pool references. Does not run game codecs.',
  plugin: 'Check plugin descriptors, dependency shapes and source entry classes. With jarPath, inspect the processed descriptor and packaged main/bootstrapper/loader classes.',
  mod: 'Check loader/version-specific descriptor names, Fabric mixins and access widener, and Forge/NeoForge TOML metadata and declared Mixin config paths.',
  modules: 'Inspect detected mod/plugin modules for version/identity drift, duplicate plugin names and loader imports in common code. Allows Stonecutter version variants.',
};

export function validationTools(target: 'mod' | 'plugin') {
  const kinds: ValidationKind[] = target === 'mod' ? ['resources', 'mod', 'data', 'worldgen', 'modules'] : ['resources', 'plugin', 'data', 'worldgen', 'modules'];
  return kinds.map(kind => ({
    name: kind === 'modules' ? 'validate_modules' : `validate_${kind}`,
    title: `Validate ${kind}`,
    description: `${descriptions[kind]} Static local checks; no build/game execution. Unresolved external references are warnings. Supply roots for generated resources or unpacked dependencies.`,
    input: kind === 'plugin' ? pluginValidationInput : validationInput,
    readOnly: true,
    openWorld: false,
    load: async () => {
      const { validate } = await import('./validation.js');
      return async (_services: unknown, args: Parameters<typeof validate>[1]) => validate(kind, args);
    },
  }));
}
