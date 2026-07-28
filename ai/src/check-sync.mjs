// The worker importScripts ai/src/*.js while the app has verbatim copies pasted into its marker
// blocks. If they drift, the main thread and worker silently disagree about preprocessing or
// tokenization - which degrades results rather than erroring. This is the check for that.
import fs from 'node:fs';
const h = fs.readFileSync('Guru Manager ChromeEdge Edition.html', 'utf8');
const norm = s => s.replace(/\r\n/g, '\n').trim();
let bad = 0;
for (const [marker, file] of [['AI:TOKENIZER', 'ai/src/tokenizer.js'], ['AI:PREPROC', 'ai/src/preproc.js']]) {
  // The split leaves the '// ' prefix of the CLOSING marker line dangling on the end of the body -
  // strip it, or every comparison reports a phantom 3-byte drift.
  const body = norm(h.split(`--- ${marker} ---`)[1].split(`--- /${marker} ---`)[0])
    .replace(/\/\/\s*$/, '').trim()
    .split('\n').filter(l => !/^\/\/ (Pasted verbatim|file, so the two)/.test(l)).join('\n').trim();
  const src = norm(fs.readFileSync(file, 'utf8'))
    .split('\n').filter(l => !/^\/\/ --- \/?AI:/.test(l)).join('\n').trim();
  const same = body === src;
  if (!same) bad++;
  console.log(`  ${same ? 'in sync' : 'DRIFTED'}  ${marker} vs ${file}  (${body.length} vs ${src.length} bytes)`);
}
console.log(bad ? `\n${bad} file(s) drifted - the worker and app disagree` : '\nboth copies identical');
