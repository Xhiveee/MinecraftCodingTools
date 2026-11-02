import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  displayName: string;
  version: string;
};

export const SERVER_INFO = { name: manifest.displayName, version: manifest.version };
