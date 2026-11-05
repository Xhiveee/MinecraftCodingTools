# Mod implementation

Use the project's exact loader, Minecraft version and mappings from `inspect_mod_project` and `get_profile`. Resolve version-sensitive APIs through `docs_search` and real source instead of using fixed dependency pins or templates from another release. Keep Forge and NeoForge packages, event buses and metadata distinct.

Keep client renderers, screens and client initializers out of dedicated-server class loading. A logical-side condition does not protect a class that already imports client-only code. Keep authoritative gameplay on the logical server; validate incoming network payloads and schedule world changes on its thread.

When adding a block or item, update registration, item/block models, blockstates, textures, translations, recipes, tags and loot as applicable. Use the target version's item definitions and data directory conventions. Prefer the project's existing datagen providers and inspect generated output before validating resources/data. Include generated resource directories in `roots`.

Prefer public loader events over injection. For mixins, read actual method descriptors and injection points with `mixin_targets`, then use `mixin_validate`. Preserve Java/Kotlin source language. In multiloader projects, keep loader APIs in platform modules and use the established common/platform bridge. Use `validate_modules` to review drift without assuming every module should share one Minecraft version.

Finish with relevant descriptor/resource/data validation and the actual project build. Use dedicated-server testing when client/server separation changed. Static checks and compilation alone do not establish in-game behavior.
