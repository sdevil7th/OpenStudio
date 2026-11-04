// Offline subprocess only. Loads the actual frontend serializer without opening
// a browser, listening on a port, loading plugins, or writing the project.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [projectPath, selectionJSON = "[]"] = process.argv.slice(2);
if (!projectPath) throw new Error("A saved .osproj snapshot is required");
if (fs.statSync(projectPath).size > 32 * 1024 * 1024) throw new Error("Project exceeds 32 MiB limit");
const bytes = fs.readFileSync(projectPath);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const sourceHash = hash(bytes);
const selected = JSON.parse(selectionJSON);
if (!Array.isArray(selected) || !selected.every(id => typeof id === "string")) throw new Error("Invalid clip selection");
// Imported application modules can log their development environment. Keep stdout
// a single machine-readable payload; do not collect those messages as evidence.
console.log = () => {};
const { createServer } = await import(pathToFileURL(path.join(root, "frontend/node_modules/vite/dist/node/index.js")).href);
const server = await createServer({ configFile: false, root: path.join(root, "frontend"),
  logLevel: "silent", server: { middlewareMode: true, hmr: false, watch: null } });
try {
  const { parseValidatedProject } = await server.ssrLoadModule("/src/utils/projectValidation.ts");
  const { serializeMIDIClipsForBackend, getMIDIClipSourceLoopLength } = await server.ssrLoadModule("/src/utils/midiClipSerialization.ts");
  const { midiExportOptions } = await server.ssrLoadModule("/src/utils/midiExportOptions.ts");
  const { prepareMIDI } = await import("./support-midi-core.mjs");
  const prepared = prepareMIDI(bytes.toString("utf8"), selected, { parseValidatedProject,
    serializeMIDIClipsForBackend, getMIDIClipSourceLoopLength, midiExportOptions });
  if (hash(fs.readFileSync(projectPath)) !== sourceHash) throw new Error("Project changed while preparing comparison");
  const payload = { ...prepared, sourceProjectSha256: sourceHash,
    preparationSources: Object.fromEntries(["midiClipSerialization.ts", "midiNotes.ts", "midiExportOptions.ts", "projectValidation.ts"]
      .map(file => [file, hash(fs.readFileSync(path.join(root, "frontend/src/utils", file)))])) };
  const encoded = JSON.stringify(payload);
  if (encoded.length > 32 * 1024 * 1024) throw new Error("Prepared MIDI exceeds 32 MiB limit");
  process.stdout.write(encoded);
} finally {
  await server.close();
}
