import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalPath = process.argv[2];
const normalizedPath = process.argv[3];
if (!originalPath) throw new Error("Usage: node tools/qualify-midi-tempo.mjs <original.osproj> [frontend-normalized.json]");
const bytes = fs.readFileSync(originalPath), originalSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const original = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const project = normalizedPath ? JSON.parse(fs.readFileSync(normalizedPath, "utf8")) : original;
if (normalizedPath && project.sourceProjectSha256 !== originalSha256) throw new Error("Normalized state belongs to a different project snapshot");
const { createServer } = await import(pathToFileURL(path.join(root, "frontend/node_modules/vite/dist/node/index.js")).href);
const server = await createServer({ root: path.join(root, "frontend"), logLevel: "error", server: { middlewareMode: true } });
try {
  const { analyzeMIDIClipTempo } = await server.ssrLoadModule("/src/utils/midiTempoAnalysis.ts");
  const clips = project.tracks.flatMap(track => (track.midiClips ?? []).map(clip => {
    const started = performance.now();
    const analysis = analyzeMIDIClipTempo(clip);
    return { trackId: track.id, clipId: clip.id, name: clip.name, duration: clip.duration,
      analysis, milliseconds: performance.now() - started, classification: "diagnostic_only" };
  }));
  const afterSha256 = crypto.createHash("sha256").update(fs.readFileSync(originalPath)).digest("hex");
  const report = { classification: "diagnostic_only", originalPath, normalizedPath, originalSha256,
    originalUnchanged: originalSha256 === afterSha256,
    configuredProjectBpmReferenceOnly: original.tempo, configuredTempoPassedToEstimator: false,
    subjectiveBeatUnitAccuracy: "not_asserted", clips };
  const output = path.join(root, "output/tempo-research/midi-project-report.json");
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, originalUnchanged: report.originalUnchanged,
    clips: clips.map(clip => ({ clipId: clip.clipId, bpm: clip.analysis.bpm, confidence: clip.analysis.confidence,
      spread: clip.analysis.tempoSpreadBpm, milliseconds: clip.milliseconds, error: clip.analysis.error })) }, null, 2));
  if (!report.originalUnchanged) throw new Error("The original project changed during read-only qualification");
} finally { await server.close(); }
