import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Content-address a local server jar and include index metadata that changes the resulting index. */
export async function indexCacheKey(file: string, mcVersion: string, kind: string): Promise<string> {
  const content = createHash("sha256");
  for await (const chunk of createReadStream(file)) content.update(chunk as Buffer);
  return createHash("sha256")
    .update(JSON.stringify({ file: path.resolve(file), mcVersion, kind, content: content.digest("hex") }))
    .digest("hex")
    .slice(0, 32);
}
