# Plugin implementation

Inspect the actual platform, build and active descriptor first. Use `get_profile`, `docs_search` and the matching API source for version-specific behavior. Preserve Bukkit compatibility when required; use Paper-only APIs only for an intended Paper target.

For Bukkit-style commands, declare them in `plugin.yml` and register their handlers. Paper plugins use lifecycle command registration rather than a `commands` field in `paper-plugin.yml`. Keep sender/permission checks consistent with tab completion. Read [Paper plugin differences](https://docs.papermc.io/paper/dev/getting-started/paper-plugins/) when working with bootstrappers, loaders or isolated dependencies.

Register event listeners during enable. Treat MONITOR handlers as observers. Keep blocking database/file/network operations out of event hot paths and return world/entity work to the correct scheduler. Folia requires entity/region/global scheduling as appropriate; setting folia-supported does not establish thread safety. Release project-owned executors, subscriptions and scheduled work during disable.

Use stable NamespacedKey and PDC types for small persistent metadata. For larger state, follow the project's storage design. Validate configuration before starting recurring work. Use Adventure components or MiniMessage where supported; insert untrusted text through safe placeholders rather than parsing it as formatting.

Optional integrations need descriptor dependencies, presence checks and service-provider checks; an installed Vault plugin alone does not establish an economy provider. Keep provided platform/plugin APIs out of shaded output. Prefer public APIs before NMS; validate changed NMS references with `nms_validate`.

Run `validate_plugin`, build the intended artifact and restart the development server for lifecycle checks. Distinguish source descriptors with resource placeholders from the processed descriptors in the JAR.
