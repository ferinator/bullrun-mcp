import { readFileSync } from "node:fs";

/** Both src/ and dist/ are immediately below the package manifest. */
export const SERVER_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
