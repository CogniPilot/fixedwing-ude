// Monaco editor for the Modelica plant, with Rumoca diagnostics.
import initRumoca, * as rumoca from "../public/vendor/rumoca/rumoca_bind_wasm.js";
import { registerModelicaLanguage } from "../public/vendor/rumoca/modelica_language.js";

const MONACO_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.49.0/min/vs";
let rumocaReady = null;
const loadRumoca = () => (rumocaReady ||= initRumoca().then(() => rumoca).catch((error) => { rumocaReady = null; throw error; }));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", reject, { once: true });
    document.head.append(script);
  });
}

async function loadMonaco() {
  if (window.monaco?.editor) return window.monaco;
  await loadScript(`${MONACO_BASE}/loader.js`);
  // Monaco's workers are cross-origin on the CDN; bootstrap them from a data: URL.
  window.MonacoEnvironment = {
    getWorkerUrl() {
      const code = `self.MonacoEnvironment={baseUrl:${JSON.stringify(`${MONACO_BASE}/`)}};importScripts(${JSON.stringify(`${MONACO_BASE}/base/worker/workerMain.js`)});`;
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
    },
  };
  return new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: MONACO_BASE } });
    window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
  });
}

async function diagnose(source) {
  const wasm = await loadRumoca();
  if (typeof wasm.lsp_diagnostics !== "function") return [];
  try {
    const parsed = JSON.parse(wasm.lsp_diagnostics(source) || "[]");
    return Array.isArray(parsed) ? parsed : parsed?.diagnostics || parsed?.items || [];
  } catch (_error) {
    return [];
  }
}

function marker(monaco, diagnostic) {
  const range = diagnostic.range || diagnostic.span || diagnostic.location || {};
  const start = range.start || range;
  const end = range.end || start;
  const startLineNumber = Math.max(1, (start.line ?? 0) + 1);
  const startColumn = Math.max(1, (start.character ?? start.column ?? 0) + 1);
  const severity = String(diagnostic.severity || "").toLowerCase();
  return {
    severity: severity === "error" || diagnostic.severity === 1 ? monaco.MarkerSeverity.Error
      : severity === "warning" || diagnostic.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
    message: diagnostic.message || String(diagnostic),
    startLineNumber,
    startColumn,
    endLineNumber: Math.max(startLineNumber, (end.line ?? start.line ?? 0) + 1),
    endColumn: Math.max(startColumn + 1, (end.character ?? end.column ?? 0) + 1),
    source: "Rumoca",
  };
}

// Returns { getSource, setSource, onChange }. Falls back to a textarea when the CDN is unreachable.
export async function createEditor(mount, source, onDiagnostics) {
  let monaco;
  try {
    monaco = await loadMonaco();
  } catch (error) {
    const area = document.createElement("textarea");
    area.className = "editor-fallback";
    area.spellcheck = false;
    area.value = source;
    mount.replaceChildren(area);
    return { getSource: () => area.value, setSource: (text) => { area.value = text; }, onChange: (fn) => area.addEventListener("input", fn) };
  }
  registerModelicaLanguage(monaco);
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const editor = monaco.editor.create(mount, {
    value: source, language: "modelica", theme: dark.matches ? "vs-dark" : "vs", automaticLayout: true,
    minimap: { enabled: false }, fontSize: 12, lineHeight: 18, tabSize: 2, scrollBeyondLastLine: false,
  });
  dark.addEventListener("change", () => monaco.editor.setTheme(dark.matches ? "vs-dark" : "vs"));
  let timer = 0;
  const refresh = async () => {
    const diagnostics = await diagnose(editor.getValue());
    monaco.editor.setModelMarkers(editor.getModel(), "rumoca", diagnostics.map((d) => marker(monaco, d)));
    onDiagnostics?.(diagnostics);
  };
  editor.onDidChangeModelContent(() => { clearTimeout(timer); timer = setTimeout(refresh, 450); });
  refresh();
  return { getSource: () => editor.getValue(), setSource: (text) => editor.setValue(text), onChange: (fn) => editor.onDidChangeModelContent(fn) };
}
