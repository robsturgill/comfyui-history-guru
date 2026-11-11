// Library mode for serve.mjs: serves a folder of media and a shared index to other devices, and lets an
// authenticated client change files. Node stdlib only.
//
// This is the only code that lets a network client touch the disk, so everything funnels through two
// gates: cleanRel() (what a path may look like) and resolveExisting()/resolveNew() (where it really points
// after symlinks). Writes and deletes are further limited to media extensions, so the API cannot be used to
// write or remove an arbitrary file.

import {createReadStream, createWriteStream, realpathSync} from 'node:fs';
import {lstat, readdir, realpath, rename, unlink, rmdir, mkdir, copyFile, stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {createHash, randomBytes} from 'node:crypto';
import {gzip, createGzip} from 'node:zlib';
import {promisify} from 'node:util';
import {join, sep, extname, basename} from 'node:path';
import {IndexStore, StoreError} from './index-store.mjs';

const gzipAsync = promisify(gzip);

// Single source of truth for server-side media extensions. Mirrors RX_MEDIA in the app, which stays
// authoritative: keep the two lists identical.
export const RX_MEDIA = /\.(png|jpe?g|webp|gif|mp4|webm|mov|mkv)$/i;

export const MIME = {
    '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
    '.mjs':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
    '.css':'text/css; charset=utf-8', '.txt':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8',
    // Must be exactly application/wasm or streaming instantiation refuses the module.
    '.wasm':'application/wasm',
    '.onnx':'application/octet-stream', '.bin':'application/octet-stream',
    '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
    '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon',
    '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime', '.mkv':'video/x-matroska'
};

export const send = (res, code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    res.writeHead(code, {'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra});
    res.end(body);
};

export class HttpError extends Error{
    constructor(status, msg){ super(msg); this.status = status }
}

// Whole-file and Range responses, shared by the static handler and /lib. Range support is what lets a
// <video> seek, and what lets the client read a video's metadata box without downloading the video.
export function serveFile(req, res, abs, st, type, headers = {}){
    res.setHeader('Accept-Ranges', 'bytes');
    for(const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const range = req.headers.range;
    if(range && /^bytes=\d*-\d*$/.test(range)){
        const [s, e] = range.slice(6).split('-');
        let start, end;
        if(s === '' && e !== '') { start = Math.max(0, st.size - +e); end = st.size - 1 }   // suffix: last N bytes
        else{ start = s ? +s : 0; end = e ? Math.min(+e, st.size - 1) : st.size - 1 }
        if(start >= st.size || start > end){
            res.writeHead(416, {'Content-Range': `bytes */${st.size}`});
            return res.end();
        }
        res.writeHead(206, {
            'Content-Type': type, 'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${st.size}`
        });
        if(req.method === 'HEAD') return res.end();
        return createReadStream(abs, {start, end}).pipe(res);
    }
    res.writeHead(200, {'Content-Type': type, 'Content-Length': st.size});
    if(req.method === 'HEAD') return res.end();
    createReadStream(abs).pipe(res);
}

// ---------------------------------------------------------------------------------- path safety

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Syntax only: what a relative path may look like. Returns the segments, or throws 400. Rejected on every
// platform, not just where they bite, so a library behaves the same wherever it is hosted:
//   - '..', '.', empty segments, backslashes, NUL, absolute paths
//   - ':' (NTFS alternate data streams: "a.exe:x.png" would pass the extension test)
//   - Windows reserved device names and trailing dot/space (silently rewritten by Win32)
export function cleanRel(p){
    if(typeof p !== 'string' || !p || p.length > 1024) throw new HttpError(400, 'Bad path');
    if(/[\0\\:]/.test(p) || p[0] === '/') throw new HttpError(400, 'Bad path');
    const segs = p.split('/');
    for(const s of segs){
        if(!s || s === '.' || s === '..' || s.length > 255) throw new HttpError(400, 'Bad path');
        if(/[. ]$/.test(s) || WIN_RESERVED.test(s.split('.')[0])) throw new HttpError(400, 'Bad path');
    }
    return segs;
}

const WIN = process.platform === 'win32';
const norm = s => WIN ? s.toLowerCase() : s;

export function createLibrary(cfg){
    const LIB = realpathSync(cfg.dir);
    const store = new IndexStore(cfg.data);
    const inside = abs => norm(abs) === norm(LIB) || norm(abs).startsWith(norm(LIB) + sep);

    // An existing target: follow symlinks, then require the *real* location to be inside the library.
    async function resolveExisting(rel){
        const segs = rel === '' ? [] : cleanRel(rel);
        let real;
        try{ real = await realpath(join(LIB, ...segs)) }
        catch(e){ if(e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new HttpError(404, 'Not found'); throw e }
        if(!inside(real)) throw new HttpError(403, 'Forbidden');
        return real;
    }
    // A target that may not exist yet (upload, mkdir, move destination). realpath can't resolve a missing
    // leaf, so resolve the parent, check *that*, and refuse a leaf that is itself a symlink.
    async function resolveNew(rel){
        const segs = cleanRel(rel);
        const leaf = segs.pop();
        let parent;
        try{ parent = await realpath(join(LIB, ...segs)) }
        catch(e){ if(e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new HttpError(404, 'Parent folder does not exist'); throw e }
        if(!inside(parent)) throw new HttpError(403, 'Forbidden');
        const abs = join(parent, leaf);
        try{ if((await lstat(abs)).isSymbolicLink()) throw new HttpError(403, 'Forbidden') }
        catch(e){ if(e instanceof HttpError) throw e; if(e.code !== 'ENOENT') throw e }
        return abs;
    }
    const media = rel => { if(!RX_MEDIA.test(rel)) throw new HttpError(400, 'Only media files may be changed here') };

    // ------------------------------------------------------------------------------------- tree
    // One call returns the whole library, rather than one listing per folder. Symlinks are never followed
    // or listed. Cached briefly so a burst of clients doesn't each re-walk the disk, and dropped on any
    // write from here; the short TTL is what lets files ComfyUI writes behind our back show up on refresh.
    let tree = null, treeAt = 0, treeBuilding = null;
    const TREE_TTL = 2000;
    const dropTree = () => { tree = null };

    async function walk(abs, rel, dirs, files){
        let ents;
        try{ ents = await readdir(abs, {withFileTypes: true}) }catch{ return }
        const jobs = [];
        for(const e of ents){
            const r = rel ? rel + '/' + e.name : e.name;
            if(e.isDirectory()){ dirs.push(r); jobs.push(walk(join(abs, e.name), r, dirs, files)) }
            else if(e.isFile() && RX_MEDIA.test(e.name))
                jobs.push(stat(join(abs, e.name)).then(s => { files.push({p: r, s: s.size, m: Math.floor(s.mtimeMs)}) }, () => {}));
        }
        await Promise.all(jobs);
    }
    async function getTree(){
        if(tree && Date.now() - treeAt < TREE_TTL) return tree;
        if(!treeBuilding) treeBuilding = (async () => {
            const dirs = [], files = [];
            await walk(LIB, '', dirs, files);
            dirs.sort(); files.sort((a, b) => a.p < b.p ? -1 : 1);
            const json = Buffer.from(JSON.stringify({dirs, files}));
            tree = {json, gz: await gzipAsync(json)}; treeAt = Date.now();
            return tree;
        })().finally(() => { treeBuilding = null });
        return treeBuilding;
    }

    // ------------------------------------------------------------------------------------ hashing
    const hashes = new Map();   // rel -> {size, m, sha}
    async function sha256(rel, abs, st){
        const h = hashes.get(rel);
        if(h && h.size === st.size && h.m === Math.floor(st.mtimeMs)) return h.sha;
        const hash = createHash('sha256');
        await pipeline(createReadStream(abs), hash);
        const sha = hash.digest('hex');
        if(hashes.size > 50000) hashes.clear();
        hashes.set(rel, {size: st.size, m: Math.floor(st.mtimeMs), sha});
        return sha;
    }

    // ------------------------------------------------------------------------------------- bodies
    const readBody = (req, limit) => new Promise((ok, no) => {
        let n = 0, over = false;
        const c = [];
        req.on('data', d => { n += d.length; if(n > limit) over = true; else c.push(d) });
        req.on('end', () => over ? no(new HttpError(413, 'Body too large')) : ok(Buffer.concat(c)));
        req.on('error', no);
    });
    const readJson = async (req, limit = 1 << 20) => {
        const b = await readBody(req, limit);
        try{ const v = JSON.parse(b.toString('utf8')); if(v && typeof v === 'object') return v }catch{}
        throw new HttpError(400, 'Body must be a JSON object');
    };
    const json = (res, code, obj, extra = {}) =>
        send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', {'Cache-Control': 'no-store', ...extra});

    // Basic credentials ride along on cross-site requests, so a page on another origin could otherwise
    // fire a form POST at us. A custom header forces a CORS preflight, which we never grant; the Origin
    // check covers browsers that send one anyway.
    function mutationRefusal(req){
        if(req.headers['x-guru'] !== '1') return 'Missing X-Guru header';
        const o = req.headers.origin;
        if(o){ try{ if(new URL(o).host !== req.headers.host) return 'Cross-origin request refused' }catch{ return 'Bad Origin' } }
        return null;
    }
    const isLocal = req => /^(::ffff:)?127\.|^::1$/.test(req.socket.remoteAddress || '');

    // -------------------------------------------------------------------------------------- handler
    // p is the already-decoded URL path. Returns true when it handled the request.
    async function handle(req, res, p, url){
        const isApi = p.startsWith('/api/');
        if(!isApi && !p.startsWith('/lib/') && p !== '/api') return false;
        await store.ready;
        try{
            if(p.startsWith('/lib/')) await serveLib(req, res, p.slice(5));
            else await api(req, res, p.slice(5), url);
        }catch(e){
            const status = e instanceof HttpError || e instanceof StoreError ? e.status : 500;
            if(status === 500) console.error('  library error:', req.method, p, e && e.message);
            if(res.headersSent) res.destroy();
            else json(res, status, {error: status === 500 ? 'Internal error' : e.message});
        }
        return true;
    }

    async function serveLib(req, res, rel){
        if(req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        media(rel);
        const abs = await resolveExisting(rel);
        const st = await stat(abs);
        if(!st.isFile()) throw new HttpError(404, 'Not found');
        const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
        // no-cache = always revalidate, and the ETag makes that a cheap 304. A file edited in place
        // (Fix & Save) gets a new ETag, so nothing is ever served stale.
        if(req.headers['if-none-match'] === etag && !req.headers.range){
            res.writeHead(304, {ETag: etag, 'Cache-Control': 'private, no-cache'});
            return res.end();
        }
        serveFile(req, res, abs, st, MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
            {ETag: etag, 'Cache-Control': 'private, no-cache', 'Content-Security-Policy': 'sandbox'});
    }

    async function api(req, res, route, url){
        const m = req.method, q = url.searchParams;
        const mutating = m !== 'GET' && m !== 'HEAD';
        if(mutating){ const why = mutationRefusal(req); if(why) throw new HttpError(403, why) }
        const only = (...ms) => { if(!ms.includes(m)) throw new HttpError(405, 'Method not allowed') };

        switch(route){
        case 'config': {
            only('GET');
            const ai = store.get('__ai__');
            return json(res, 200, {
                library: true, name: basename(LIB), writable: true, rev: store.rev,
                // The embedding tier the shared index was built at; clients refuse to mix tiers.
                tier: (ai && (ai.tier || (ai.backend && ai.backend.tier))) || null,
                local: isLocal(req)
            });
        }
        case 'rev':
            only('GET');
            return json(res, 200, {rev: store.rev});

        case 'tree': {
            only('GET');
            const t = await getTree();
            const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
            const body = gz ? t.gz : t.json;
            res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
                'Cache-Control': 'no-store', ...(gz ? {'Content-Encoding': 'gzip', Vary: 'Accept-Encoding'} : {})});
            return res.end(body);
        }

        case 'index':
            if(m === 'GET'){
                const s = q.get('since'), since = s === null ? null : +s;
                const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
                res.writeHead(200, {'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store',
                    ...(gz ? {'Content-Encoding': 'gzip', Vary: 'Accept-Encoding'} : {})});
                const out = gz ? createGzip() : res;
                if(gz) out.pipe(res);
                for(const line of store.dump(Number.isInteger(since) ? since : undefined))
                    if(!out.write(line)) await new Promise(r => out.once('drain', r));
                return out.end();
            }
            only('POST');
            {
                const body = await readJson(req, 256 << 20);
                return json(res, 200, await store.apply(body.ops));
            }

        case 'nextm': {
            only('POST');
            const b = await readJson(req);
            return json(res, 200, {id: await store.allocM(b.min)});
        }

        case 'hash': {
            only('GET');
            const rel = q.get('p'); media(rel || '');
            const abs = await resolveExisting(rel), st = await stat(abs);
            if(!st.isFile()) throw new HttpError(404, 'Not found');
            return json(res, 200, {sha: await sha256(rel, abs, st), size: st.size});
        }

        case 'file': {
            only('PUT', 'DELETE');
            const rel = q.get('p'); cleanRel(rel); media(rel);
            if(m === 'DELETE'){
                const abs = await resolveExisting(rel);
                if(!(await lstat(abs)).isFile()) throw new HttpError(404, 'Not found');
                await unlink(abs); dropTree(); hashes.delete(rel);
                return json(res, 200, {ok: true});
            }
            const abs = await resolveNew(rel);
            const tmp = join(abs, '..', '.' + randomBytes(6).toString('hex') + '.guru-tmp');
            const MAX = 1 << 30;
            let n = 0;
            const cap = new Transform({transform(c, _, cb){ n += c.length; n > MAX ? cb(new HttpError(413, 'File too large')) : cb(null, c) }});
            try{ await pipeline(req, cap, createWriteStream(tmp, {flags: 'wx'})) }
            catch(e){ await unlink(tmp).catch(() => {}); throw e }
            try{ await rename(tmp, abs) }catch(e){ await unlink(tmp).catch(() => {}); throw e }
            dropTree(); hashes.delete(rel);
            return json(res, 200, {ok: true, size: n, m: Math.floor((await stat(abs)).mtimeMs)});
        }

        case 'dir': {
            only('DELETE');
            const rel = q.get('p'); cleanRel(rel);
            const abs = await resolveExisting(rel);
            try{ await rmdir(abs) }
            catch(e){
                if(e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw new HttpError(409, 'Folder is not empty. It may hold files Guru does not list.');
                if(e.code === 'ENOTDIR') throw new HttpError(404, 'Not found');
                throw e;
            }
            dropTree();
            return json(res, 200, {ok: true});
        }

        case 'mkdir': {
            only('POST');
            const b = await readJson(req);
            const abs = await resolveNew(b.p);
            try{ await mkdir(abs) }
            catch(e){
                // Creating what already exists succeeds, like getDirectoryHandle({create:true}).
                if(e.code === 'EEXIST' && (await stat(abs)).isDirectory()){}
                else throw e;
            }
            dropTree();
            return json(res, 200, {ok: true});
        }

        case 'move': {
            only('POST');
            const b = await readJson(req);
            cleanRel(b.from); cleanRel(b.to); media(b.from); media(b.to);
            const src = await resolveExisting(b.from);
            const ss = await lstat(src);
            if(!ss.isFile()) throw new HttpError(404, 'Not found');
            const dst = await resolveNew(b.to);
            let ds = null;
            try{ ds = await lstat(dst) }catch(e){ if(e.code !== 'ENOENT') throw e }
            // Never overwrite. The one exception is a case-only rename on a case-insensitive disk, where
            // the "existing" destination is the source itself.
            if(ds && !(ds.ino === ss.ino && ds.dev === ss.dev && ss.ino !== 0)) throw new HttpError(409, 'A file with that name already exists');
            try{ await rename(src, dst) }
            catch(e){
                if(e.code !== 'EXDEV') throw e;
                await copyFile(src, dst); await unlink(src);
            }
            dropTree(); hashes.delete(b.from); hashes.delete(b.to);
            return json(res, 200, {ok: true});
        }

        default:
            throw new HttpError(404, 'Unknown endpoint');
        }
    }

    return {handle, store, ready: store.ready, dir: LIB, getTree, resolveExisting, resolveNew, cleanRel};
}
