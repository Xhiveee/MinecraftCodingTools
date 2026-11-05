# Minecraft asset generation

Use an available client image-generation/editing tool for requested raster art. If none is available, explain that limitation and prepare an asset brief; do not claim that MinecraftCodingTools can generate it. Follow the host tool's image instructions.

Determine the output's role: in-game texture, pack icon, UI concept, thumbnail or release artwork. Use existing assets as visual references when supplied. Specify subject, silhouette, palette, dimensions, transparency and destination. Preserve the existing art direction when editing a pack.

In-game textures need deliberate pixel shapes, the project's resolution and correct UV/layout conventions. Tileable block surfaces need matching edges. An attractive rendered cube is concept art, not a usable flat texture. Inspect the generated output at native size and in a repeated/tiled view where relevant; do not label it game-ready until dimensions, alpha and layout have been checked.

Pack icons and promotional art can use larger illustration styles. Keep important subjects readable at thumbnail size. Request transparency for cutouts and preserve it during edits. Save approved assets under the intended resources path, update references and run `validate_resources`; that tool verifies file links, not visual quality.
