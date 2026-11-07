import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(defaultRoot, "frontend/package.json"));
const ts = require("typescript");
const actionIds = ["transport.record", "clip.joinSelectedMidi", "clip.crossfadeSelected", "help.contextualHelp", "view.keyboardShortcuts"];
const websiteGuides = ["keyboard-shortcuts", "recording-and-editing", "midi-and-piano-roll", "mixing-and-routing", "rendering-and-export", "audio-setup"];
const plain = value => value.replace(/`|\*\*/g, "").replace(/\s+/g, " ").trim();
const canonicalKey = value => value.replace(/Cmd\//g, "").replace(/Ctrl\/Cmd/g, "Ctrl").replace(/Cmd/g, "Ctrl").replace(/\s+/g, "").toLowerCase();
function syntax(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (tree.parseDiagnostics.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(tree.parseDiagnostics[0].messageText, " ")}`);
  return tree;
}
function property(node, name) { return node.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText().replace(/["']/g, "") === name)?.initializer; }
function literal(node) { return node && ts.isStringLiteralLike(node) ? node.text : undefined; }
function walk(node, visitor) { visitor(node); ts.forEachChild(node, child => walk(child, visitor)); }
function objects(tree) { const result = []; walk(tree, node => { if (ts.isObjectLiteralExpression(node)) result.push(node); }); return result; }
function strings(tree) {
  const result = [];
  walk(tree, node => {
    if (ts.isPropertyAssignment(node) && ["text", "label", "title"].includes(node.name.getText().replace(/["']/g, ""))) {
      if (ts.isStringLiteralLike(node.initializer)) result.push(node.initializer.text);
      else if (ts.isTemplateExpression(node.initializer)) result.push(node.initializer.head.text + node.initializer.templateSpans.map(span => ` ${span.literal.text}`).join(""));
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.length && node.elements.every(ts.isStringLiteralLike)) result.push(node.elements.map(item => item.text).join(" | "));
    if (ts.isJsxAttribute(node) && node.name.getText() === "title" && node.initializer && ts.isStringLiteralLike(node.initializer)) result.push(node.initializer.text);
  }); return result;
}
function keyTokens(value) {
  return new Set((plain(value).match(/(?:Ctrl(?:\/Cmd)?|Cmd|Shift|Alt)(?:\+[A-Za-z0-9*]+)+|\bF1\b|(?<![\w+])R(?![\w+])/g) ?? []).map(canonicalKey));
}

/** Targeted source-checkout contract. AST reads data; no app/store/browser module executes. */
export function validateInputDocs({ appRoot = defaultRoot, websiteRoot, overrides = new Map() } = {}) {
  const errors = [], checked = [];
  const read = file => overrides.get(path.resolve(file)) ?? fs.readFileSync(file, "utf8");
  const assert = (condition, message) => { if (!condition) errors.push(message); };
  const catalogPath = path.join(appRoot, "frontend/src/store/actionRegistry.ts");
  const catalog = objects(syntax(catalogPath, read(catalogPath)));
  const facts = Object.fromEntries(actionIds.map(id => {
    const entry = catalog.find(node => literal(property(node, "id")) === id);
    if (!entry) { errors.push(`Action catalog is missing ${id}`); return [id, {}]; }
    const aliases = property(entry, "shortcutAliases");
    return [id, { name: literal(property(entry, "name")), key: literal(property(entry, "shortcut")),
      scope: literal(property(entry, "shortcutScope")) ?? "global", aliases: aliases && ts.isArrayLiteralExpression(aliases) ? aliases.elements.map(literal) : [] }];
  }));
  const profilesPath = path.join(appRoot, "frontend/src/utils/shortcutProfiles.ts");
  const profileTree = syntax(profilesPath, read(profilesPath));
  let previousBindings;
  walk(profileTree, node => { if (ts.isVariableDeclaration(node) && node.name.getText() === "PREVIOUS_OPENSTUDIO_BINDINGS") previousBindings = node.initializer; });
  for (const id of ["clip.joinSelectedMidi", "clip.crossfadeSelected"]) {
    const previous = previousBindings && property(previousBindings, id);
    assert(previous && ts.isCallExpression(previous) && previous.expression.getText() === "keys" && previous.arguments.length === 0, `${id}: vendor fallback must remain explicitly unassigned; review profile-specific docs before changing this policy`);
  }
  const openstudio = objects(profileTree).find(node => literal(property(node, "id")) === "openstudio");
  const overridesNode = openstudio && property(openstudio, "bindings");
  assert(Boolean(overridesNode && ts.isObjectLiteralExpression(overridesNode)), "OpenStudio profile bindings cannot be resolved from the source AST");
  for (const id of actionIds) {
    const configured = overridesNode && property(overridesNode, id);
    if (configured) {
      assert(ts.isCallExpression(configured) && configured.expression.getText() === "keys" && configured.arguments.every(ts.isStringLiteralLike), `${id}: unsupported OpenStudio override; extend the validator instead of assuming catalog fallback`);
      if (ts.isCallExpression(configured)) facts[id].profileKeys = configured.arguments.map(literal);
    }
  }
  assert(facts["transport.record"].key === "R", "transport.record: source primary must be R for this scoped contract");
  assert(["Ctrl+R", "NumpadMultiply"].every(key => facts["transport.record"].aliases?.includes(key)), "transport.record: retained Ctrl+R/numpad aliases changed; review documentation");
  for (const id of ["clip.joinSelectedMidi", "clip.crossfadeSelected"]) assert(facts[id].scope === "timeline", `${id}: source scope changed from timeline; review documentation`);
  for (const id of actionIds) if (facts[id].profileKeys) assert(facts[id].profileKeys.includes(facts[id].key), `${id}: OpenStudio profile no longer inherits its documented primary shortcut`);
  assert(facts["help.contextualHelp"].key === "F1" && facts["help.contextualHelp"].name === "Help Reference", "F1 must resolve to Help Reference");
  assert(facts["view.keyboardShortcuts"].name === "Keyboard, Mouse & Trackpad", "Input window source label changed; review scoped documentation");
  const menuPath = path.join(appRoot, "frontend/src/components/MenuBar.tsx");
  assert(strings(syntax(menuPath, read(menuPath))).filter(value => value.replace(/[….]/g, "") === facts["view.keyboardShortcuts"].name).length >= 2, "Options and Help must retain the catalog input-window label");

  const audit = (file, units, requirements) => {
    checked.push(file);
    const claims = {
      "transport.record": units.filter(unit => /\brecord\b/i.test(unit) && !/record[ -]arm/i.test(unit) && keyTokens(unit).size
        && (keyTokens(unit).has("r") || keyTokens(unit).has("ctrl+r") || /^\s*\|?\s*\**Record\b/i.test(unit))),
      "clip.joinSelectedMidi": units.filter(unit => /joins?\b[^|.]*\bMIDI|MIDI\b[^|.]*\bjoins?/i.test(unit) && keyTokens(unit).size),
      "clip.crossfadeSelected": units.filter(unit => /crossfade selected audio clips|Shift\+X/i.test(unit) && keyTokens(unit).size),
    };
    for (const [id, candidates] of Object.entries(claims)) {
      const expected = canonicalKey(facts[id].key ?? "missing");
      for (const unit of candidates) assert(keyTokens(unit).has(expected), `${file}: ${id} shortcut claim lacks source primary ${facts[id].key}: ${plain(unit).slice(0, 150)}`);
      if (requirements.includes(id)) assert(candidates.some(unit => keyTokens(unit).has(expected)), `${file}: missing scoped ${id} primary ${facts[id].key}`);
    }
    if (requirements.includes("aliases")) assert(claims["transport.record"].some(unit => keyTokens(unit).has("r") && keyTokens(unit).has("ctrl+r") && /numpad\s+\*/i.test(plain(unit))), `${file}: Record alias documentation must include R, Ctrl/Cmd+R and numpad * together`);
    if (requirements.includes("help")) {
      assert(units.some(unit => /Help Reference/i.test(unit) && keyTokens(unit).has("f1")), `${file}: missing F1 Help Reference claim`);
      assert(units.some(unit => /Keyboard,?\s+Mouse\s*&\s*Trackpad/i.test(plain(unit))), `${file}: missing current input-window name`);
    }
    for (const unit of units) {
      const cells = unit.split("|").map(plain).filter(Boolean);
      const rowAction = /^Record\s*\/\s*Finish Recording$/i.test(cells[0] ?? "") ? "transport.record"
        : ["clip.joinSelectedMidi", "clip.crossfadeSelected"].find(id => cells[0] === facts[id].name);
      if (rowAction) {
        const allowed = new Set([facts[rowAction].key, ...(facts[rowAction].aliases ?? [])].filter(Boolean).map(canonicalKey));
        for (const key of keyTokens(cells.slice(1).join(" "))) assert(allowed.has(key), `${file}: ${rowAction} table contains undocumented source alias ${key}`);
      }
      assert(!/record[ -]arm\s*(?:\*|`)*\s*\(\s*`?R`?\s*\)/i.test(unit), `${file}: stale Record Arm (R) claim`);
      if (keyTokens(unit).has("f1") && /keyboard shortcuts|key\s*map|Keyboard,?\s+Mouse\s*&\s*Trackpad/i.test(plain(unit)))
        assert(/Help Reference/i.test(unit) || /\bnot\b/i.test(unit), `${file}: F1 incorrectly advertised as the shortcut/profile window`);
    }
  };
  const manual = path.join(appRoot, "docs/USER_MANUAL.md");
  audit(manual, read(manual).split(/\n\s*\n|\n(?=\|)/), [...actionIds.slice(0, 3), "aliases", "help"]);
  if (websiteRoot) for (const guide of websiteGuides) {
    const file = path.join(websiteRoot, `src/features/docs/content/${guide}.ts`), tree = syntax(file, read(file));
    const reference = objects(tree).find(node => literal(property(node, "channel")) && property(node, "commit"));
    assert(literal(reference && property(reference, "channel")) === "development", `${file}: scoped source-checkout guide must retain development appReference`);
    const units = strings(tree);
    const requirements = guide === "keyboard-shortcuts" ? [...actionIds.slice(0, 3), "aliases", "help"]
      : guide === "recording-and-editing" ? ["transport.record", "clip.crossfadeSelected"]
        : guide === "midi-and-piano-roll" ? ["transport.record", "clip.joinSelectedMidi"] : [];
    audit(file, units, requirements);
  }
  if (websiteRoot) {
    const header = path.join(websiteRoot, "src/features/daw-preview/TrackHeaderLite.tsx");
    audit(header, strings(syntax(header, read(header))), []);
  }
  return { pass: errors.length === 0, scope: "OpenStudio defaults: Record/aliases, timeline Join/Crossfade, F1/window labels; six development website guides when explicitly supplied", facts, checked, errors, website: websiteRoot ? "checked" : "not_requested" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith("--"))) throw new Error(`${name} needs a path`); return index >= 0 ? args[index + 1] : undefined; };
    if (args.includes("--help")) { console.log("node tools/validate-input-docs.mjs [--website-root ../openstudio-website] [--json output/report.json]"); process.exit(0); }
    const report = validateInputDocs({ websiteRoot: option("--website-root") ? path.resolve(option("--website-root")) : undefined });
    const output = option("--json"); if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
    if (!report.pass) { console.error(report.errors.join("\n")); process.exitCode = 1; }
    else console.log(`Input documentation contracts passed (${report.checked.length} documents; website ${report.website}).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
