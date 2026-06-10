import fs from "node:fs";

const pkgUrl = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf8"));

export const CLAWBACK_VERSION = pkg.version;
