# MinecraftCodingTools

MCP server for Java and Kotlin Minecraft development.

- Fabric, Forge, NeoForge mods; Bukkit, Spigot, Paper plugins.
- Version profiles, mappings, source search, Mixin/NMS checks.
- Dependency discovery, JAR inspection and Vineflower decompilation.
- Gradle/Maven builds and crash diagnostics.

## Setup

Requires Node.js 20+ and a JDK compatible with your project.

```sh
npm ci
npm run build
```

For a release ZIP, extract it and run `npm ci --omit=dev`; the server is already built.

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "MinecraftCodingTools": {
      "command": "node",
      "args": ["/absolute/path/MinecraftCodingTools/dist/index.js"]
    }
  }
}
```

## Agent skill

Install [skills/minecraft-coding-tools](skills/minecraft-coding-tools) in your client's skills directory. Codex: `~/.codex/skills/minecraft-coding-tools/`. Display name: **MinecraftCodingTools**; skill ID: `minecraft-coding-tools`.

Tools accept `{"request":{"target":"mod"}}` or `{"request":{"target":"plugin"}}` plus tool parameters. The server also supplies usage instructions during MCP initialization.

Build and classpath tools execute project build scripts. Kotlin analysis is static; dependency discovery covers compile classpaths. Archive analysis works one JAR at a time.

Static validation tools: `validate_resources`, `validate_data`, `validate_worldgen`, and `validate_modules` support both targets; `validate_mod` supports mods and `validate_plugin` supports plugins. Pass `projectDir`, optional `mcVersion`, resource `roots` (including generated/unpacked dependency resources), `strict`, `offset` and `limit`. Results include file diagnostics, error/warning counts and pagination. Validators do not execute builds or game codecs; unresolved external resources are warnings. Descriptor checks apply to a selected module. Module discovery supports detected Gradle mod layouts (including Architectury/Stonecutter) and Gradle/Maven plugin modules without evaluating build scripts.

For a built plugin, pass `jarPath` to `validate_plugin` to check its processed descriptor and declared classes. Use `audit_implementation` on edited Java/Kotlin files or line ranges and review the reported signals in context. `verify_requirements` reads local component, JAR and JUnit evidence, flags stale reports and surfaces gaps in verification. It does not execute tests.

Both variants of `build` retain their text output and add structured task/module failure evidence, classified diagnostics and a log path. See the [acceptance workflow](skills/minecraft-coding-tools/references/verification.md) for request examples.

`paper_smoke_test` starts a trusted local Paper JAR and built plugin with an explicit compatible JDK, execution authorization and EULA acceptance. It reports startup and enable/disable evidence and keeps a separate workspace and console log in `.mct/smoke/`. See the [runtime workflow](skills/minecraft-coding-tools/references/runtime.md) for the exact request and what the lifecycle check covers.

The bundled agent skill covers the full development and acceptance workflow, with focused references for mods, plugins, dependencies and assets. Image generation uses the client's image tool.

### Project storage

Add `.mct/` to the mod/plugin project's `.gitignore`. MCP uses the build root so modules in the same build share storage.

| Path | Contents |
| --- | --- |
| `.mct/gradle/` | Gradle User Home, including wrapper distributions, dependencies, Loom user cache and daemon logs |
| `.mct/gradle-project/` | Gradle's project cache for MCP invocations |
| `.mct/maven/` | Maven wrapper distributions and local dependency repository |
| `.mct/mod/` and `.mct/plugin/` | Indexes, decompiled sources, downloaded tools, mappings, documentation and helper workspaces |
| `.mct/logs/` and `.mct/smoke/` | Build logs and Paper smoke-test workspaces |

Pass `projectDir` to source and JAR tools, including when a JAR is outside the project. The archive tools resolve relative JAR paths against `projectDir` when supplied. `inspect_code_archive` returns `indexDir`, and Vineflower stores decompiled files under that index's `src/`. Original source JARs can be read in place. Calls without a project use `MCT_WORKSPACE_DIR` or the MCP process working directory. Existing `FFN_CACHE_DIR` and `BSP_CACHE_DIR` overrides still apply to calls without a project.

The first build and source lookup in a project may need to download dependencies and tools again. Put any required Gradle User Home settings in `.mct/gradle/gradle.properties` or configure them through the project's Gradle files and environment. Offline calls need a populated project cache. Legacy `.ffn/project.json` remains readable, with `.mct/project.json` taking priority. Manual IDE or terminal runs and third-party build plugins may use their own paths. Older Loom versions can still write a project-local `.gradle/loom-cache`.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run release
```

The offline suite uses local fixtures. For real Paper integration tests, run `npm run test:paper` with `MCT_PAPER_SERVER_JAR`, `MCT_PAPER_API_JAR`, and `MCT_PAPER_JDK` set to trusted local paths. Set `MCT_PAPER_ACCEPT_EULA=true` only after authorizing the run and accepting the [Minecraft EULA](https://aka.ms/MinecraftEULA). The test builds and loads both a working plugin and one with an intentional enable failure.

The release command creates `releases/MinecraftCodingTools-v<version>.zip` and a SHA-256 checksum. The version comes from `package.json` and appears in MCP server info. Pushing a `v*` tag builds and publishes the matching GitHub release.

MIT · Based on [FFN](https://github.com/Xhiveee/ffn) and [BSP](https://github.com/Xhiveee/bsp).
