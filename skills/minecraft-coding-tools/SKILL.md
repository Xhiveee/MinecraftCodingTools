---
name: minecraft-coding-tools
description: Use MinecraftCodingTools to develop or debug Fabric, Forge, NeoForge mods and Bukkit, Spigot, Paper plugins, including Java/Kotlin, mappings, dependencies, Mixin/NMS, resource and data validation, and Minecraft asset generation with a host image tool.
---

# MinecraftCodingTools

## Routing

- Discover the server's current tool schemas. Every call wraps arguments in `request` with `target: "mod"` or `target: "plugin"`.
- Use exposed names `build` and `search_source`; internal names such as `gradle_build` and `search_mc_source` are aliases, not exposed tools.
- Mod example: `get_profile({"request":{"target":"mod","mcVersion":"1.20.1","loader":"fabric"}})`.
- Plugin example: `get_profile({"request":{"target":"plugin","mcVersion":"1.20.4","platform":"paper"}})`.

## Project workflow

1. Establish the actual module, loader/platform, Minecraft version and namespace. For mods, call `inspect_mod_project`; for plugins, inspect build files and plugin metadata. Pass `projectDir` where supported.
2. Use `get_profile` for version-specific build facts. Prefer public API events before Mixin or NMS.
3. Find symbols with `search_source`. Read `get_class` outlines first, then request the relevant method or hierarchy. Use exact descriptors for overloaded methods.
4. For existing mods, use `project_source_search` and `get_project_source` to inspect Java/Kotlin code. Preserve the existing file language; follow the detected language preference for new files.
5. After changes, use the project's build and relevant tests. Run `mixin_validate` for changed mixins and `nms_validate` for changed NMS/CraftBukkit references. Use `analyze_crash` with a real log when execution fails.

## Implementation guidance

- For mod gameplay, registration, networking, sides or datagen, read [modding](references/modding.md).
- For plugin commands, events, scheduling, PDC or configuration, read [plugin development](references/plugin-dev.md).
- For textures, icons, concept art or release artwork requested by the user, read [image generation](references/imagegen.md). This requires the client's image tool; the MCP server does not generate images.

## Static project validation

- `validate_mod` (`target=mod`): Fabric JSON and Forge/NeoForge TOML descriptors, required metadata and Fabric mixin config paths.
- `validate_plugin` (`target=plugin`): YAML descriptors, main class discovery, dependencies, api-version shape, Paper command metadata and reload calls.
- `validate_resources`: JSON, model/blockstate/item-definition references, textures, sounds, fonts and PNG animation metadata.
- `validate_data`: JSON, metadata, version-sensitive paths, function tag references and cycles.
- `validate_worldgen`: local references between features, structures, pools, biome modifiers and dimensions.
- `validate_modules`: detected mod/plugin modules, version differences, mod identity, duplicate plugin names and loader imports in common code. Stonecutter version variants are expected to differ.

Shared arguments: `projectDir`, optional `mcVersion`, `roots`, `strict`, `offset`, `limit`. Pass a selected module for descriptor checks. Use `roots` to include generated resources and unpacked dependency resources. These tools execute no builds, resolve no dependencies and run no game codecs. External references are warnings when not supplied locally; static success does not prove runtime compatibility. Module checks discover projects from build files and do not evaluate Gradle.

## Dependency integration

1. Call `list_project_artifacts` for the relevant module.
2. Pass the returned `jarPath` and optional `sourcesJarPath` to `inspect_code_archive`.
3. Use `search_code_archive` for symbols; use `kind: "usages"` or `"callees"` for bytecode references inside that JAR.
4. Read `get_code_archive_class` with `mode: "outline"`, then `mode: "source"`. Prefer original sources over decompilation.
5. Follow returned pagination offsets. Resolve ambiguous names with fully qualified names and descriptors.

## Constraints

- Build and classpath resolution execute project build logic as the current user. Use them within the user's authorized project work; set `runPaperclip: true` or `buildtools: true` only when that execution is authorized.
- Keep namespace and version consistent across calls. Use `translate_mapping` when names differ; mod `mojmap` and plugin `mojang` are distinct schema values.
- Classpath discovery covers compile dependencies. An absent result does not prove a runtime dependency is absent.
- Archive references are scoped to one JAR. Nested JARs and other dependencies require separate analysis. For Maven reactor modules, unresolved sibling artifacts may need the project's normal reactor build/install.
- Kotlin parsing is static, and decompilation produces Java. Confirm JVM signatures through compilation before relying on them.
- Report which checks actually ran. Distinguish source evidence, compilation, static validation and runtime verification.
