// Build time only: bundle pure app serialization for the offline embedded JS engine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2]);
const { rolldown } = await import(pathToFileURL(path.join(root, 'frontend/node_modules/rolldown/dist/index.mjs')).href);
const sources = {};
const bundle = await rolldown({
  input: 'support-entry', cwd: root, platform: 'neutral',
  plugins: [{ name: 'offline-only',
    resolveId(id) {
      if (id === 'support-entry') return '\0support-entry';
      if (id.startsWith('./frontend/') || id.startsWith('./tools/')) return path.resolve(root, id);
    },
    load(id) {
      if (id === '\0support-entry') return `
        import { parseValidatedProject } from './frontend/src/utils/projectValidation.ts';
        import { serializeMIDIClipsForBackend, getMIDIClipSourceLoopLength } from './frontend/src/utils/midiClipSerialization.ts';
        import { midiExportOptions } from './frontend/src/utils/midiExportOptions.ts';
        import { prepareMIDI } from './tools/support-midi-core.mjs';
        export function prepare(project, selection) {
          return JSON.stringify(prepareMIDI(project, JSON.parse(selection), { parseValidatedProject,
            serializeMIDIClipsForBackend, getMIDIClipSourceLoopLength, midiExportOptions }));
        }`;
      if (/[\\/]services[\\/]NativeBridge\.ts$/.test(id))
        return 'export const nativeBridge = { setTrackMIDIClips() { throw new Error("Native bridge unavailable offline"); } };';
    },
    generateBundle() {
      for (const id of this.getModuleIds()) if (!id.startsWith('\0') && fs.existsSync(id))
        sources[path.relative(root, id).replaceAll('\\', '/')] = crypto.createHash('sha256').update(fs.readFileSync(id)).digest('hex');
    },
  }],
});
const result = await bundle.generate({ format: 'iife', name: 'SupportMIDI' });
await bundle.close();
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'support-midi.js'), result.output[0].code);
fs.writeFileSync(path.join(output, 'support-midi-sources.json'), JSON.stringify(sources, null, 2));
