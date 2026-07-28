// Verification harness for tokenizer.js against the real CLIP ViT-B/32 vocab.
// tokenizer.js is a plain script (no import/export, by design — it gets
// pasted verbatim into the host HTML's <script> block later), so it's loaded
// here via vm.runInThisContext rather than a normal ESM import.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokSrc = fs.readFileSync(path.join(__dirname, 'tokenizer.js'), 'utf8');
vm.runInThisContext(tokSrc + '\nglobalThis.__clip = { clipVocabLoad, clipTokenize };', { filename: 'tokenizer.js' });
const { clipVocabLoad, clipTokenize } = globalThis.__clip;

const vocabJson = fs.readFileSync(path.join(__dirname, '..', 'models', 'clip-tokenizer', 'vocab.json'), 'utf8');
const mergesTxt = fs.readFileSync(path.join(__dirname, '..', 'models', 'clip-tokenizer', 'merges.txt'), 'utf8');
clipVocabLoad(vocabJson, mergesTxt);

let pass = 0, fail = 0;
function arrStr(a){ return '[' + Array.from(a).join(', ') + ']'; }
function trimTrailingZeros(a){ const arr = Array.from(a); let end = arr.length; while (end > 0 && arr[end-1] === 0) end--; return arr.slice(0, end); }
function check(name, cond, detail){
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail || ''); }
}

// --- Known-good reference vectors ---
const SOT = 49406, EOT = 49407;
check('SOT id', clipTokenize('').length === 77 && clipTokenize('')[0] === SOT, `got ${clipTokenize('')[0]}`);

const catOut = clipTokenize('a photo of a cat');
const catExpectedNonZero = [49406, 320, 1125, 539, 320, 2368, 49407];
check(
  '"a photo of a cat" matches reference',
  arrStr(trimTrailingZeros(catOut)) === arrStr(catExpectedNonZero),
  `got ${arrStr(trimTrailingZeros(catOut))}, expected ${arrStr(catExpectedNonZero)}`
);

const helloOut = clipTokenize('hello world');
const helloExpectedNonZero = [49406, 3306, 1002, 49407];
check(
  '"hello world" matches reference',
  arrStr(trimTrailingZeros(helloOut)) === arrStr(helloExpectedNonZero),
  `got ${arrStr(trimTrailingZeros(helloOut))}, expected ${arrStr(helloExpectedNonZero)}`
);

// --- Self-consistency properties ---
function countEOT(arr){ return Array.from(arr).filter(x => x === EOT).length; }

check('always length 77 (cat)', catOut.length === 77);
check('always length 77 (hello)', helloOut.length === 77);
check('always Int32Array', catOut instanceof Int32Array);

check('always starts with SOT (cat)', catOut[0] === SOT);
check('always starts with SOT (empty)', clipTokenize('')[0] === SOT);
check('always starts with SOT (long)', clipTokenize('x '.repeat(200))[0] === SOT);

check('exactly one EOT (cat, untruncated)', countEOT(catOut) === 1, `count=${countEOT(catOut)}`);
check('exactly one EOT (hello, untruncated)', countEOT(helloOut) === 1, `count=${countEOT(helloOut)}`);

const emptyOut = clipTokenize('');
check('empty string -> [SOT, EOT, 0...]', arrStr(trimTrailingZeros(emptyOut)) === arrStr([SOT, EOT]), arrStr(emptyOut));

// >77 token input: force a long run of distinct-ish words so BPE can't collapse it
const longInput = Array.from({length: 120}, (_, i) => 'word' + i).join(' ');
const longOut = clipTokenize(longInput);
check('long input still length 77', longOut.length === 77);
check('long input truncates with EOT last', longOut[76] === EOT, `got ${longOut[76]}`);
check('long input has no interior zero before slot 76', !Array.from(longOut.slice(0, 76)).includes(0));

// punctuation
const punctOut = clipTokenize('a cat, a dog!! (and a "fox")');
check('punctuation: starts/ends correctly', punctOut[0] === SOT && countEOT(punctOut) === 1, arrStr(trimTrailingZeros(punctOut)));
check('punctuation: length 77', punctOut.length === 77);

// multiple spaces / whitespace normalization
const spacedA = clipTokenize('a    photo   of   a    cat');
const spacedB = clipTokenize('a photo of a cat');
check('multiple spaces normalize same as single spaces', arrStr(spacedA) === arrStr(spacedB), `${arrStr(trimTrailingZeros(spacedA))} vs ${arrStr(trimTrailingZeros(spacedB))}`);

// long repeated-word string (stresses BPE cache + truncation together)
const repeatedOut = clipTokenize('cat '.repeat(100).trim());
check('long repeated-word string length 77', repeatedOut.length === 77);
check('long repeated-word string starts SOT', repeatedOut[0] === SOT);
check('long repeated-word string ends EOT (truncated)', repeatedOut[76] === EOT);

console.log('\n--- Output vectors ---');
console.log('"a photo of a cat" ->', arrStr(trimTrailingZeros(catOut)), '(+ zero pad to 77)');
console.log('"hello world"       ->', arrStr(trimTrailingZeros(helloOut)), '(+ zero pad to 77)');
console.log('""                  ->', arrStr(trimTrailingZeros(emptyOut)), '(+ zero pad to 77)');
console.log('punctuation sample  ->', arrStr(trimTrailingZeros(punctOut)), '(+ zero pad to 77)');
console.log(`long (120 words)    -> length ${longOut.length}, last id ${longOut[76]} (EOT)`);
console.log(`repeated "cat "x100 -> length ${repeatedOut.length}, last id ${repeatedOut[76]} (EOT)`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
