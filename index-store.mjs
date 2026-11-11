// Server-side home for the library index (what lives in IndexedDB when the app runs standalone).
//
// Records are opaque JSON objects keyed by `p` (a relative path, or a reserved `_`-prefixed key such as
// `__ai__`). The server never interprets them. Typed arrays are encoded by the client before they get
// here, so a record is always plain JSON.
//
// On disk: an append-only journal, data/index.jsonl, one JSON object per line:
//     {r, p, rec}              replace the whole record
//     {r, p, set, unset}       merge top-level fields into the current record
//     {r, p, del:1}            delete
//     {r, meta:{nextM}}        server-owned counters
// `r` is a revision that rises with every applied batch. Latest line wins on replay. The journal is
// compacted at startup (temp file + rename) and the file it replaces is kept as a rolling .bak.N, because
// that is the only backup the index has.
//
// Why diffs, not just whole records: clients hold a snapshot of the index from when they loaded it. If a
// phone rewrites a whole record it can silently erase the embeddings, faces and hand-made person tags the
// GPU host wrote since. A diff only touches the fields it names.

import {mkdir, readFile, rename, copyFile, rm, open, stat} from 'node:fs/promises';
import {join} from 'node:path';

export class StoreError extends Error{
    constructor(status, msg){ super(msg); this.status = status }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
// Reserved records: `_` prefix and no '.', matching dAll() in the app (a real folder named _archive has
// no extension and never reaches the index as a key, because every media key ends in one).
export const isReserved = p => p[0] === '_' && !p.includes('.');
const MAX_KEY = 4096;

export class IndexStore{
    constructor(dir, {snapshots = 3} = {}){
        this.dir = dir;
        this.file = join(dir, 'index.jsonl');
        this.snapshots = snapshots;
        this.recs = new Map();      // p -> record
        this.revs = new Map();      // p -> rev it last changed at
        this.tomb = new Map();      // p -> rev it was deleted at (since startup only)
        this.meta = {};
        this.rev = 0;
        this.baseRev = 0;           // rev at startup: deltas older than this are unknowable, so full resync
        this.fh = null;
        this.chain = Promise.resolve();
        this.ready = this._open();
    }

    async _open(){
        await mkdir(this.dir, {recursive: true});
        let txt = '', exists = true;
        try{ txt = await readFile(this.file, 'utf8') }catch(e){ if(e.code !== 'ENOENT') throw e; exists = false }
        let lines = 0, bad = 0;
        const parts = txt.split('\n');
        const endsClean = txt === '' || txt.endsWith('\n');
        for(let i = 0; i < parts.length; i++){
            const s = parts[i];
            if(!s) continue;
            let o;
            try{ o = JSON.parse(s) }catch{ bad++; continue }
            if(!isObj(o)) { bad++; continue }
            lines++;
            this._replay(o);
        }
        this.baseRev = this.rev;
        this.tomb.clear();
        // Compact when the journal is mostly superseded lines, or when it needs repair (a truncated last
        // line, a bad line in the middle). Compacting also guarantees the next append starts on a fresh line.
        if(exists && (bad || !endsClean || lines > this.recs.size * 1.5 + 100)) await this._compact(true);
        this.fh = await open(this.file, 'a');
        this.corrupt = bad;
    }

    _replay(o){
        if(Number.isInteger(o.r) && o.r > this.rev) this.rev = o.r;
        if(isObj(o.meta)){ Object.assign(this.meta, o.meta); return }
        const p = o.p;
        if(typeof p !== 'string' || !p) return;
        if(o.del){ this.recs.delete(p); this.revs.delete(p); return }
        if(isObj(o.rec)){ this.recs.set(p, {...o.rec, p}) }
        else if(isObj(o.set) || Array.isArray(o.unset)){
            this.recs.set(p, this._merge(this.recs.get(p), p, o.set, o.unset));
        }else return;
        this.revs.set(p, o.r | 0);
    }

    _merge(cur, p, set, unset){
        const n = {...(cur || {}), ...(isObj(set) ? set : {}), p};
        if(Array.isArray(unset)) for(const k of unset) if(k !== 'p') delete n[k];
        return n;
    }

    async _compact(snapshot){
        const tmp = this.file + '.tmp';
        const fh = await open(tmp, 'w');
        try{
            let buf = [], n = 0;
            const flush = async () => { if(buf.length){ await fh.write(buf.join('')); buf = []; n = 0 } };
            if(Object.keys(this.meta).length) buf.push(JSON.stringify({r: this.rev, meta: this.meta}) + '\n');
            for(const [p, rec] of this.recs){
                buf.push(JSON.stringify({r: this.revs.get(p) || 0, p, rec}) + '\n');
                if(++n >= 500) await flush();
            }
            await flush();
            await fh.sync();
        }finally{ await fh.close() }
        if(snapshot){
            let size = 0; try{ size = (await stat(this.file)).size }catch{}
            if(size){
                for(let i = this.snapshots; i >= 1; i--){
                    const from = i === 1 ? null : `${this.file}.bak.${i - 1}`, to = `${this.file}.bak.${i}`;
                    if(i === this.snapshots) await rm(to, {force: true});
                    if(from) await rename(from, to).catch(() => {});
                }
                await copyFile(this.file, `${this.file}.bak.1`);
            }
        }
        await rename(tmp, this.file);
    }

    // Serialised: one writer, in order. A failed batch must not poison the ones behind it.
    _serial(fn){
        const run = this.chain.then(fn);
        this.chain = run.catch(() => {});
        return run;
    }

    async _append(lines){
        if(!lines.length) return;
        await this.fh.write(lines.join(''));
        await this.fh.sync();
    }

    // ops: [{p, rec} | {p, set, unset} | {p, del:true}], each optionally {ifRev}. An op with ifRev applies
    // only if the record is still at that revision, else it is returned as a conflict with the current
    // copy so the caller can re-apply on top. Everything else in the batch still applies.
    apply(ops){
        return this._serial(async () => {
            await this.ready;
            if(!Array.isArray(ops)) throw new StoreError(400, 'ops must be an array');
            const r = this.rev + 1, staged = new Map(), conflicts = [], lines = [], revs = {};
            const cur = p => staged.has(p) ? staged.get(p) : this.recs.get(p);
            for(const op of ops){
                if(!isObj(op) || typeof op.p !== 'string' || !op.p || op.p.length > MAX_KEY || op.p.includes('\0'))
                    throw new StoreError(400, 'every op needs a string key p');
                const p = op.p;
                if(op.ifRev !== undefined && (this.revs.get(p) || 0) !== op.ifRev){
                    conflicts.push({p, rev: this.revs.get(p) || 0, rec: this.recs.get(p) || null});
                    continue;
                }
                if(op.del){
                    staged.set(p, null);
                    lines.push(JSON.stringify({r, p, del: 1}) + '\n');
                }else if(op.rec !== undefined){
                    if(!isObj(op.rec)) throw new StoreError(400, 'rec must be an object');
                    staged.set(p, {...op.rec, p});
                    lines.push(JSON.stringify({r, p, rec: op.rec}) + '\n');
                }else if(isObj(op.set) || Array.isArray(op.unset)){
                    if(op.unset !== undefined && !(Array.isArray(op.unset) && op.unset.every(k => typeof k === 'string')))
                        throw new StoreError(400, 'unset must be an array of field names');
                    staged.set(p, this._merge(cur(p), p, op.set, op.unset));
                    lines.push(JSON.stringify({r, p, set: op.set, unset: op.unset}) + '\n');
                }else throw new StoreError(400, 'op needs one of rec, set/unset, del');
                if(isReserved(p)) revs[p] = r;
            }
            await this._append(lines);
            // Commit only after the journal has it, so memory never runs ahead of disk.
            if(lines.length){
                this.rev = r;
                for(const [p, v] of staged){
                    if(v === null){ this.recs.delete(p); this.revs.delete(p); this.tomb.set(p, r) }
                    else{ this.recs.set(p, v); this.revs.set(p, r); this.tomb.delete(p) }
                }
            }
            return {rev: this.rev, revs, conflicts};
        });
    }

    // Hand out a manual-person id. Clients used to mint these locally, so two devices could pick the same
    // one and silently merge two different people. `min` lets a client that already has a local counter
    // push the server past it.
    allocM(min){
        return this._serial(async () => {
            await this.ready;
            const id = Math.max(this.meta.nextM || 1000000, Number.isInteger(min) ? min : 0, 1000000);
            const r = this.rev + 1;
            await this._append([JSON.stringify({r, meta: {nextM: id + 1}}) + '\n']);
            this.meta.nextM = id + 1;
            this.rev = r;
            return id;
        });
    }

    // Header + one record per line. With `since` (and a store that has been up since then) only what changed.
    * dump(since){
        const delta = Number.isInteger(since) && since >= this.baseRev;
        const revs = {};
        for(const p of this.recs.keys()) if(isReserved(p)) revs[p] = this.revs.get(p) || 0;
        yield JSON.stringify({rev: this.rev, baseRev: this.baseRev, full: !delta, meta: this.meta, revs}) + '\n';
        if(delta){
            for(const [p, r] of this.tomb) if(r > since) yield JSON.stringify({p, del: 1}) + '\n';
            for(const [p, rec] of this.recs) if((this.revs.get(p) || 0) > since) yield JSON.stringify(rec) + '\n';
        }else for(const rec of this.recs.values()) yield JSON.stringify(rec) + '\n';
    }

    get(p){ return this.recs.get(p) || null }

    async close(){ await this.chain; if(this.fh){ await this.fh.close(); this.fh = null } }
}
