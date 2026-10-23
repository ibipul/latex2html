import { convert, renderDocument } from '../src/latex2html.js';

const KATEX_VERSION = '0.16.11';
const KATEX_BASE = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist`;
const STORAGE_KEY = 'latex2html:source';

const $ = id => document.getElementById(id);
const source = $('source');
const preview = $('preview');
const code = $('code');
const status = $('status');
const warningsBox = $('warnings');
const mathMode = $('mathMode');

let katex = null;
let files = {};          // name -> text (.tex) or data: URL (images)
let mainName = '';       // file name the editor content came from
let lastPage = '';
let lastTitle = '';
let timer = 0;

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

function renderMath(tex, displayMode) {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: true,
    strict: 'ignore',
    output: mathMode.value === 'mathml' ? 'mathml' : 'htmlAndMathml',
  });
}

function update() {
  const started = performance.now();
  let result;
  try {
    result = convert(source.value, { files, renderMath: katex ? renderMath : null });
  } catch (err) {
    status.textContent = `Conversion failed: ${err.message}`;
    console.error(err);
    return;
  }
  const stylesheets = result.hasMath && katex && mathMode.value === 'katex' ? [`${KATEX_BASE}/katex.min.css`] : [];
  lastPage = renderDocument(result, { stylesheets });
  lastTitle = result.title;

  // Keep the reader's place in the preview across re-renders.
  let scroll = 0;
  try { scroll = preview.contentWindow.scrollY; } catch { /* not loaded yet */ }
  preview.onload = () => {
    try { preview.contentWindow.scrollTo(0, scroll); } catch { /* ignore */ }
  };
  // In the preview, open external links in a new tab rather than inside the frame.
  preview.srcdoc = lastPage.replace(/<a href="(https?:)/g, '<a target="_blank" rel="noopener" href="$1');
  code.firstChild.textContent = lastPage;

  const ms = Math.round(performance.now() - started);
  const mathNote = result.hasMath && !katex ? ' · math shown as source (KaTeX not loaded)' : '';
  status.textContent = `Converted in ${ms} ms${mathNote}`;
  showWarnings(result.warnings);
}

function showWarnings(warnings) {
  warningsBox.hidden = warnings.length === 0;
  if (!warnings.length) return;
  const total = warnings.reduce((n, w) => n + w.count, 0);
  warningsBox.querySelector('summary').textContent = `${total} warning${total === 1 ? '' : 's'}`;
  const list = warningsBox.querySelector('ul');
  list.replaceChildren(...warnings.map(w => {
    const li = document.createElement('li');
    li.textContent = w.count > 1 ? `${w.message} (×${w.count})` : w.message;
    return li;
  }));
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    update();
    store.set(STORAGE_KEY, source.value);
  }, 200);
}

/* ---- Files --------------------------------------------------------------- */

const isText = file => /\.(tex|ltx|sty|cls|txt|bib)$/i.test(file.name);

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    if (isText(file)) reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

async function addFiles(list) {
  const incoming = [...list];
  if (!incoming.length) return;
  const loaded = await Promise.all(incoming.map(async f => [f.name, await readFile(f)]));
  const texFiles = loaded.filter(([name]) => /\.(tex|ltx)$/i.test(name));
  // The main file is the one with \begin{document}, else the only .tex file given.
  const main = texFiles.find(([, text]) => /\\begin\s*\{document\}/.test(text)) ||
    (texFiles.length === 1 ? texFiles[0] : null);
  for (const [name, content] of loaded) if (!main || name !== main[0]) files[name] = content;
  if (main) {
    mainName = main[0];
    source.value = main[1];
  }
  renderFiles();
  update();
  store.set(STORAGE_KEY, source.value);
}

function renderFiles() {
  const box = $('files');
  const names = Object.keys(files);
  box.hidden = !names.length && !mainName;
  const chips = [];
  if (mainName) {
    const chip = document.createElement('span');
    chip.className = 'chip main';
    chip.textContent = mainName;
    chip.title = 'Main document (in the editor)';
    chips.push(chip);
  }
  for (const name of names) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.onclick = () => { delete files[name]; renderFiles(); update(); };
    chip.append(remove);
    chips.push(chip);
  }
  box.replaceChildren(...chips);
}

/* ---- Wiring -------------------------------------------------------------- */

source.addEventListener('input', schedule);

// Tab inserts two spaces instead of leaving the editor.
source.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  document.execCommand('insertText', false, '  ');
});

$('fileInput').addEventListener('change', e => {
  addFiles(e.target.files);
  e.target.value = '';
});

const sourcePane = $('sourcePane');
let dragDepth = 0;
sourcePane.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; sourcePane.classList.add('dragging'); });
sourcePane.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; sourcePane.classList.remove('dragging'); } });
sourcePane.addEventListener('dragover', e => e.preventDefault());
sourcePane.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  sourcePane.classList.remove('dragging');
  addFiles(e.dataTransfer.files);
});

async function loadExample(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path}`);
  source.value = await res.text();
  mainName = path.split('/').pop();
  files = {};
  renderFiles();
  update();
  store.set(STORAGE_KEY, source.value);
}

$('example').addEventListener('change', e => {
  const path = e.target.value;
  e.target.value = '';
  if (path) loadExample(path).catch(err => { status.textContent = err.message; });
});

$('clear').addEventListener('click', () => {
  source.value = '';
  files = {};
  mainName = '';
  renderFiles();
  update();
  store.set(STORAGE_KEY, '');
  source.focus();
});

mathMode.addEventListener('change', () => {
  store.set('latex2html:mathMode', mathMode.value);
  update();
});

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t === tab));
    const showCode = tab.dataset.view === 'code';
    code.hidden = !showCode;
    preview.hidden = showCode;
  });
}

function outputName() {
  const base = mainName ? mainName.replace(/\.[^.]+$/, '') :
    lastTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `${base || 'document'}.html`;
}

$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([lastPage], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = outputName();
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('copy').addEventListener('click', async () => {
  const button = $('copy');
  try {
    await navigator.clipboard.writeText(lastPage);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = 'Copy HTML'; }, 1500);
});

/* ---- Start --------------------------------------------------------------- */

mathMode.value = store.get('latex2html:mathMode') === 'mathml' ? 'mathml' : 'katex';
const saved = store.get(STORAGE_KEY);
if (saved) {
  source.value = saved;
  update();
} else {
  loadExample('examples/showcase.tex').catch(() => update());
}

import(`${KATEX_BASE}/katex.mjs`)
  .then(mod => {
    katex = mod.default;
    update();
  })
  .catch(() => {
    status.textContent = 'KaTeX could not be loaded, so math is shown as TeX source.';
  });
