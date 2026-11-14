# Runtime verification

For a Paper lifecycle check, build the deployable artifact and run `validate_plugin` with `jarPath`. Then use `paper_smoke_test` with trusted local JARs and a compatible JDK, after the user authorizes execution and accepts the [Minecraft EULA](https://aka.ms/MinecraftEULA).

```json
{
  "request": {
    "target": "plugin",
    "projectDir": "/work/plugin",
    "serverJar": "/local/paper.jar",
    "pluginJar": "target/demo.jar",
    "javaHome": "/local/jdk-21",
    "allowExecution": true,
    "acceptEula": true,
    "startupTimeoutSec": 180
  }
}
```

Pass optional `dependencyJars` for required plugin integrations. Set the MCP client's request timeout above the startup deadline plus 20 seconds for shutdown. The tool creates a fresh loopback development server under `.mct/smoke/`, starts Paper with a restricted environment and sends the fixed console command `stop`. The workspace and console log are retained. JAR code runs with the current user's privileges. Paperclip and plugins may fetch dependencies.

- `passed` requires server readiness, the selected plugin's enable and disable markers and clean exit. Follow up with feature tests for events, commands, permissions, persistence and integrations.
- For `plugin_failure`, inspect the target lifecycle error. For `infrastructure_failure`, start at the Java version, Paper startup, dependencies, port or shutdown diagnostics. Use `analyze_crash` with the reported log. `inconclusive` means the server reached readiness and the selected lifecycle markers were incomplete.
- Keep feature tests in a separate development server or an existing integration harness. Exercise denied and permitted commands, an event on both relevant sides, and persisted state after a restart when those behaviors are in scope.

For Fabric, Forge and NeoForge, inspect the selected module's existing Gradle runs or server distribution. Use its dedicated-server run configuration where present and authorized, with the intended mod artifact and dependencies. Check startup and registration, exercise common/server logic, then stop through the console. For an existing server run, `analyze_crash` accepts `projectDir` and optional `runDir`. Perform a separate client test for rendering, keybindings, local UI and client-only resource behavior. The MCP server provides a managed lifecycle smoke test for Paper.
