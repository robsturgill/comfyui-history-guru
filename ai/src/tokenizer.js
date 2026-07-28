// --- AI:TOKENIZER ---
// OpenAI CLIP (ViT-B/32) byte-level BPE tokenizer, dependency-free.
// Direct port of CLIP's simple_tokenizer.py (encoder/bpe/regex) so token
// ids match the reference tokenizer exactly. Fixed-length-77 output is a
// WebNN requirement, not part of the original algorithm.

let CLIPV=null, CLIPM=null; // CLIPV: Map<symbol,id> from vocab.json; CLIPM: Map<"sym1 sym2",rank> from merges.txt

// GPT-2/CLIP byte<->unicode table. BPE operates on "characters", but raw
// bytes 0-255 include control/whitespace codepoints that would collide with
// the regex splitter or just not round-trip as single chars. Printable-range
// bytes map to themselves; every other byte gets remapped to an unused
// codepoint above 255, so every possible byte has one stable single-char
// representation and the mapping is reversible (unused here, but why the
// table has to be a bijection, not just any escaping scheme).
function _b2u(){
  const bs=[];
  for(let i=33;i<=126;i++)bs.push(i);
  for(let i=161;i<=172;i++)bs.push(i);
  for(let i=174;i<=255;i++)bs.push(i);
  const cs=bs.slice();
  let n=0;
  for(let b=0;b<256;b++){ if(!bs.includes(b)){ bs.push(b); cs.push(256+n); n++; } }
  const m=new Map();
  for(let i=0;i<bs.length;i++) m.set(bs[i], String.fromCodePoint(cs[i]));
  return m;
}
const B2U=_b2u();

// Same split regex as CLIP: contractions, letter runs, single digits (numbers
// are split digit-by-digit on purpose), then runs of "other" (punctuation/
// symbols). \p{L}/\p{N} need the /u flag; text is lowercased before this
// runs so the /i flag is belt-and-suspenders.
const CLIP_PAT=/<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

// Parse vocab.json + merges.txt once. vocabJson may be a JSON string or an
// already-parsed object; mergesTxt is the raw merges.txt text (first line is
// a "#version:" header, last line(s) may be blank — both are skipped).
function clipVocabLoad(vocabJson, mergesTxt){
  const vobj = typeof vocabJson==='string' ? JSON.parse(vocabJson) : vocabJson;
  CLIPV = new Map(Object.entries(vobj));
  CLIPM = new Map();
  const lines = mergesTxt.split('\n');
  let rank=0;
  for(let i=1;i<lines.length;i++){
    const l=lines[i].trim();
    if(!l) continue;
    CLIPM.set(l, rank++); // key format matches the pair keys built in _pairs(): "sym1 sym2"
  }
}

function _pairs(word){
  const s=new Set();
  for(let i=0;i<word.length-1;i++) s.add(word[i]+' '+word[i+1]);
  return s;
}

const _bpeCache=new Map();

// Greedy lowest-rank-pair merging until no mergeable pair remains, per CLIP's
// bpe(). `token` is already byte->unicode mapped (one JS char per input
// byte). </w> marks the end of the *word*, not every symbol — it lets the
// model tell "cat" mid-word apart from "cat" at a word boundary, and only
// the last symbol of a word ever carries it.
function _bpe(token){
  if(_bpeCache.has(token)) return _bpeCache.get(token);
  let word = token.length>1
    ? token.slice(0,-1).split('').concat([token[token.length-1]+'</w>'])
    : [token+'</w>'];
  let pairs=_pairs(word);
  if(!pairs.size){ _bpeCache.set(token, token+'</w>'); return token+'</w>'; }
  while(true){
    let best=null, bestRank=Infinity;
    for(const p of pairs){ const r=CLIPM.has(p)?CLIPM.get(p):Infinity; if(r<bestRank){ bestRank=r; best=p; } }
    if(best===null || !CLIPM.has(best)) break;
    const sp=best.indexOf(' ');
    const first=best.slice(0,sp), second=best.slice(sp+1);
    const nw=[]; let i=0;
    while(i<word.length){
      const j=word.indexOf(first,i);
      if(j===-1){ nw.push(...word.slice(i)); break; }
      nw.push(...word.slice(i,j));
      i=j;
      if(word[i]===first && i<word.length-1 && word[i+1]===second){ nw.push(first+second); i+=2; }
      else { nw.push(word[i]); i+=1; }
    }
    word=nw;
    if(word.length===1) break;
    pairs=_pairs(word);
  }
  const out=word.join(' ');
  _bpeCache.set(token, out);
  return out;
}

// CLIP's basic_clean() also runs ftfy.fix_text + double html-unescape before
// this; skipped here to stay dependency-free. Only matters for text with
// mojibake or HTML entities, which prompt strings don't normally contain.
function _wordsOf(text){
  const norm = text.replace(/\s+/g,' ').trim().toLowerCase();
  return norm.match(CLIP_PAT) || [];
}

function _bytesToTokenStr(word){
  const bytes = new TextEncoder().encode(word);
  let out='';
  for(let i=0;i<bytes.length;i++) out += B2U.get(bytes[i]);
  return out;
}

// Tokenize to a fixed Int32Array(77): <|startoftext|> ... <|endoftext|>,
// zero-padded. WebNN needs a static input shape, so 77 is not a cap to
// relax later — truncation forces EOT into slot 76 so a cut-off sequence
// still parses as "ended" rather than trailing off mid-token.
function clipTokenize(str){
  const out = new Int32Array(77);
  const SOT = CLIPV.get('<|startoftext|>');
  const EOT = CLIPV.get('<|endoftext|>');
  const ids=[SOT];
  const words=_wordsOf(str||'');
  for(const w of words){
    const tok=_bytesToTokenStr(w);
    const bpeStr=_bpe(tok);
    for(const sym of bpeStr.split(' ')){
      const id=CLIPV.get(sym);
      if(id!==undefined) ids.push(id);
    }
  }
  ids.push(EOT);
  if(ids.length>77){ ids.length=77; ids[76]=EOT; }
  for(let i=0;i<ids.length;i++) out[i]=ids[i];
  return out;
}
// --- /AI:TOKENIZER ---
