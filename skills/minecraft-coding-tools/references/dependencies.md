# Dependencies, mappings and JVM signatures

Use `get_profile` with `mcVersion` and the applicable `loader` or `platform`. Profile facts guide selection. Build files, resolved dependencies and compiled signatures establish what this project can actually use.

- For compile dependencies, call `list_project_artifacts` with the selected `projectDir`. Reuse the returned `jarPath` and optional `sourcesJarPath`. This can execute Gradle/Maven build logic. The result describes compile artifacts. Check runtime dependencies independently.
- Use `inspect_code_archive` for descriptors and packages. Use `search_code_archive` with `kind: "class"` or `"method"`, then `get_code_archive_class` with `mode: "outline"`. Request `mode: "source"` for the implementation and page as needed. Pass the same `projectDir` on each call, even for external JARs. Decompiled Java files are cached under the returned `indexDir` in its `src/` directory. Prefer attached original sources. Decompilation of Kotlin produces Java.
- Use fully qualified owners and JVM descriptors for overloaded members. Archive usages/callees are scoped to the selected JAR. Inspect nested archives and other dependencies separately when the call path crosses those boundaries.
- For Minecraft and server internals, use `search_source` and `get_class` with the same project, version and namespace. The default `get_class` result is an outline. Use `method` for one method and `detail: "hierarchy"` for inherited members. Use `translate_mapping` to reconcile names. Mods use `mojmap`, plugins use `mojang`.

## Mixin and NMS

- Use `mixin_targets` with `targetClass` and a focused `methodFilter` to inspect real injection points. Verify the full target descriptor, opcode/ordinal or slice expectations, handler parameters and client/server visibility. Check loader-specific registration, generated resources, refmaps and MixinExtras using the selected module. `mixin_validate` can execute Gradle and resolve dependencies.
- For NMS, establish the build and runtime namespace and exact server version before reading or patching internals. Use `nms_validate` with the selected `projectDir`, optional `targetVersion` and `targetPlatform`. Include compiled bytecode for the shipped artifact where available. Execution of Paperclip or BuildTools requires authorization.
- Kotlin source parsing is static. Confirm JVM names and descriptors after compilation when working with default arguments, bridge methods, companion objects or Mixin/NMS annotations. Test loading on the game side that actually uses the target.
