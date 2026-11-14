---
name: minecraft-coding-tools
description: Develop and verify Java/Kotlin Minecraft mods for Fabric, Forge or NeoForge and plugins for Bukkit, Spigot or Paper. Use the MCP tools for version-specific APIs, dependency and JAR inspection, Mixin/NMS, builds, crash diagnosis and acceptance evidence.
---

# MinecraftCodingTools

Discover the connected server's tools. Wrap MCP arguments in `request` with `target: "mod"` or `target: "plugin"`. Use the exposed names `build` and `search_source`. If the MCP server is unavailable, use the project's wrappers, local files and test reports and disclose any lost coverage.

Pass `projectDir` when inspecting dependencies or sources so MinecraftCodingTools keeps its working files under the build root's `.mct/`.

1. **Discover the module.** Use `inspect_mod_project` for mods and read the build files and active descriptor for plugins. Establish the loader/platform, game and API versions, JDK, mappings, source sets and packaging task. Preserve the project's Java/Kotlin conventions and verify each changed platform or variant.
2. **Define acceptance.** For each substantive requirement, write the expected behavior, affected components and a check that could fail if that behavior were absent. Include relevant negative cases, dedicated-server or client behavior, saved state after restart and optional dependencies. A small fix can use one acceptance check.
3. **Resolve the API.** Use `get_profile` and `docs_search` for the actual version, then confirm signatures against the compile classpath or version-matched source. Start with `search_source` and focused `get_class` outlines. Prefer public events and registration APIs before reaching for Mixin or NMS.
4. **Implement the entire path.** Follow each requirement from entry point through registration, permissions, state changes, persistence/networking and resources as applicable. Replace temporary scaffolding before completion. Report any accepted behavior that remains incomplete.
5. **Verify the change.** Review edited lines with `audit_implementation`, run applicable metadata/resource/Mixin/NMS validators, and build the selected module. Run focused automated tests and inspect the produced artifact. Use `verify_requirements` to check files, JAR entries and named JUnit cases. Run the required game scenarios in an authorized development environment.
6. **Diagnose and retest.** Start from the failing task, first actionable diagnostic and retained log. Confirm the dependency, namespace or signature before editing. Rerun the failed check after fixing its cause, then run the affected regression checks.
7. **Review acceptance before closing.** Report the checks that ran, observed outcomes and evidence for each material requirement. Separate source review, static validation, compilation, unit/integration tests, runtime checks and manual play tests. Identify any blocked or unverified behavior.

## References

- [Mod development](references/modding.md) for initialization, registries, sides, networking, data and multiloader projects.
- [Plugin development](references/plugin-dev.md) for lifecycle, commands, dependencies, persistence, schedulers and Folia.
- [Dependency and source inspection](references/dependencies.md) for exact APIs, mappings, Mixin and NMS.
- [Validation and acceptance](references/verification.md) for tool schemas, build diagnosis and test evidence.
- [Runtime verification](references/runtime.md) for the Paper lifecycle smoke test and dedicated-server and client checks.
- [Minecraft assets](references/imagegen.md) for image generation and in-game asset checks.
