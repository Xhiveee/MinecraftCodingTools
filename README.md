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

## Development

```sh
npm run typecheck
npm test
npm run release
```

Release output: `releases/MinecraftCodingTools-v0.1.0.zip` and SHA-256 checksum. Version comes from `package.json` and is reported in MCP server info. Pushing a `v*` tag builds and publishes the matching GitHub release.

MIT · Based on [FFN](https://github.com/Xhiveee/ffn) and [BSP](https://github.com/Xhiveee/bsp).
