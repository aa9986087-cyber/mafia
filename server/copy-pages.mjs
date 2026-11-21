// Before each deploy: copy only the game's pages into server/public, which Cloudflare serves next to the rooms.
import { cp, rm, mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url), out = new URL("public/", import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const item of ["index.html", "css", "js", "assets"]) await cp(new URL(item, root), new URL(item, out), { recursive: true });
console.log("pages copied to server/public");
