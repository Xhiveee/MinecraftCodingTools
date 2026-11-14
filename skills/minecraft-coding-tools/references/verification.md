# Validation and acceptance evidence

Use `projectDir` for the affected module. Build and classpath resolution execute the project's build logic as the MCP user. These calls use the build root's `.mct/` for Gradle and Maven state. A first offline build can require populating that local cache.

| Check | Evidence |
| --- | --- |
| `validate_mod` / `validate_plugin` | Loader-specific descriptor checks. Pass `jarPath` to `validate_plugin` to inspect processed metadata and packaged main/bootstrapper/loader classes. |
| `validate_resources`, `validate_data`, `validate_worldgen` | JSON and local resource references. Supply `mcVersion` and add generated or unpacked dependency resources in `roots` as needed. Follow `nextOffset`. Game codecs and external dependencies require separate evidence. |
| `validate_modules` | Detected module consistency and common-source loader imports. Detection uses build files without evaluating Gradle. Stonecutter version variants can differ. |
| `audit_implementation` | Candidate TODO/FIXME comments, stub throws and empty annotated handlers. Use `files: [{ "file": "src/main/kotlin/demo/Join.kt", "fromLine": 18, "toLine": 45 }]` with module-relative paths. Review each finding in context and check `unavailable`. |
| `build` | Run intended Gradle tasks or Maven goals, then inspect `structuredContent` for status, selected module, failed tasks, diagnostics and log path. Explicitly request the relevant test task when the default build omits it. |
| `analyze_crash` | Diagnose a real build or game log using `path`, `offset` and `limit`. Begin with the failing module and first concrete error, then verify the API signature or toolchain implicated by the log. |

For substantive requirements, pass observed artifacts to `verify_requirements`. Use paths relative to `projectDir` and list the changed implementation files that can invalidate the report or JAR. The following request assumes Maven built the plugin and ran the named test.

```json
{
  "request": {
    "target": "plugin",
    "projectDir": "/work/plugin",
    "requirements": [{
      "id": "save-on-disable",
      "behavior": "Persist pending records when the plugin shuts down.",
      "components": ["src/main/java/demo/Storage.java", "src/main/java/demo/DemoPlugin.java"],
      "checks": [
        { "kind": "jar_entry", "file": "target/demo.jar", "entry": "demo/Storage.class" },
        { "kind": "junit", "file": "target/surefire-reports/TEST-demo.StorageTest.xml", "className": "demo.StorageTest", "testName": "flushesPendingRecords" }
      ],
      "runtimeRequired": true,
      "limitation": "Exercise save, restart and reload of records in Paper."
    }]
  }
}
```

`source_contains` accepts `file` and literal `text` for wiring evidence. Files and JAR entries establish presence. A matching passed JUnit case establishes recorded test execution, with freshness checked against the listed components. Check `structuredContent.requirements` for failed assertions, absent artifacts, skipped tests and runtime gaps. Review whether tests exercise the requested behavior and record manual or integration observations separately.
