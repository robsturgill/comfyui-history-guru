// node --test library.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, appendFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createApp} from './serve.mjs';
import {IndexStore} from './index-store.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'guru-lib-'));
const LIB = join(tmp, 'lib'), OUT = join(tmp, 'outside'), DATA = join(tmp, 'data');
after(() => rmSync(tmp, {recursive: true, force: true}));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const mk = (rel, buf) => { mkdirSync(join(LIB, rel, '..'), {recursive: true}); writeFileSync(join(LIB, rel), buf) };
const AUTH = 'Basic ' + Buffer.from('u:pw').toString('base64');

let app, srv;
const call = (path, {method = 'GET', headers = {}, body, guru = method !== 'GET' && method !== 'HEAD', raw = false} = {}) => new Promise((ok, no) => {
    const {port} = srv.address();
    const h = {authorization: AUTH, ...(guru ? {'x-guru': '1'} : {}), ...headers};
    const r = request({host: '127.0.0.1', port, path, method, headers: h}, res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => {
            let b = Buffer.concat(c);
            if(res.headers['content-encoding'] === 'gzip') b = gunzipSync(b);
            ok({status: res.statusCode, headers: res.headers, buf: b,
                body: raw ? null : b.toString('utf8'),
                json: () => JSON.parse(b.toString('utf8'))});
        });
    });
    r.on('error', no);
    if(body !== undefined) r.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    r.end();
});
const post = (path, body, o = {}) => call(path, {method: 'POST', body, headers: {'content-type': 'application/json'}, ...o});
const q = p => encodeURIComponent(p);

before(async () => {
    mkdirSync(OUT, {recursive: true});
    writeFileSync(join(OUT, 'secret.png'), 'TOPSECRET');
    mk('a/one.png', PNG);
    mk('a/b/two.jpg', Buffer.alloc(300, 7));
    mk('vid.mp4', Buffer.from('0123456789abcdefghij'));
    mk('notes.txt', 'not media');
    mkdirSync(join(LIB, 'empty'));
    symlinkSync(OUT, join(LIB, 'out'), 'dir');
    symlinkSync(join(OUT, 'secret.png'), join(LIB, 'link.png'));
    app = createApp({host: '127.0.0.1', port: 0, dir: LIB, data: DATA, password: 'pw', allowedHosts: [], tlsCert: null, tlsKey: null});
    await new Promise(ok => app.listen(0, '127.0.0.1', ok));
    srv = app;
    await app.library.ready;
});
after(async () => { await app.library.store.close(); app.close() });

// ------------------------------------------------------------------------------------------ tree

test('/api/config reports library mode, the folder name and whether the caller is local', async () => {
    const j = (await call('/api/config')).json();
    assert.equal(j.library, true);
    assert.equal(j.name, 'lib');
    assert.equal(j.writable, true);
    assert.equal(j.local, true);
    assert.equal(j.tier, null);
});

test('/api/tree lists media only, with sizes, and follows no symlinks', async () => {
    const t = (await call('/api/tree')).json();
    assert.deepEqual(t.files.map(f => f.p), ['a/b/two.jpg', 'a/one.png', 'vid.mp4']);
    assert.equal(t.files.find(f => f.p === 'a/one.png').s, PNG.length);
    assert.ok(t.files.every(f => Number.isInteger(f.m) && f.m > 0));
    assert.deepEqual(t.dirs, ['a', 'a/b', 'empty']);       // 'out' is a symlink: not listed, not walked
});

test('/api/tree is gzipped when asked', async () => {
    const r = await call('/api/tree', {headers: {'accept-encoding': 'gzip'}});
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(r.json().files.length, 3);
});

// ------------------------------------------------------------------------------------------ /lib

test('/lib serves bytes with the right type; Range gives 206; suffix range works', async () => {
    const r = await call('/lib/a/one.png', {raw: true});
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.deepEqual(r.buf, PNG);
    const p = await call('/lib/vid.mp4', {headers: {range: 'bytes=2-5'}});
    assert.equal(p.status, 206);
    assert.equal(p.body, '2345');
    assert.equal(p.headers['content-range'], 'bytes 2-5/20');
    assert.equal((await call('/lib/vid.mp4', {headers: {range: 'bytes=-4'}})).body, 'ghij');
    assert.equal((await call('/lib/vid.mp4', {headers: {range: 'bytes=99-'}})).status, 416);
    assert.equal(r.headers['content-security-policy'], 'sandbox');
});

test('/lib revalidates with an ETag: 304 when unchanged, new ETag after an edit', async () => {
    const a = await call('/lib/a/one.png');
    const etag = a.headers.etag;
    assert.ok(etag);
    assert.equal((await call('/lib/a/one.png', {headers: {'if-none-match': etag}})).status, 304);
    mk('a/etag.png', Buffer.from('v1')); const e1 = (await call('/lib/a/etag.png')).headers.etag;
    mk('a/etag.png', Buffer.from('version two')); const e2 = (await call('/lib/a/etag.png')).headers.etag;
    assert.notEqual(e1, e2);
    rmSync(join(LIB, 'a/etag.png'));
});

test('/lib refuses non-media, folders, missing files and non-GET', async () => {
    assert.equal((await call('/lib/notes.txt')).status, 400);
    assert.equal((await call('/lib/a')).status, 400);
    assert.equal((await call('/lib/nope.png')).status, 404);
    assert.equal((await call('/lib/a/one.png', {method: 'POST'})).status, 405);
});

test('/lib needs auth like everything else', async () => {
    const r = await call('/lib/a/one.png', {headers: {authorization: 'Basic ' + Buffer.from('u:bad').toString('base64')}});
    assert.equal(r.status, 401);
});

// --------------------------------------------------------------------------------- path safety

test('traversal, absolute paths, backslashes, NUL, ADS and Windows names are rejected', async () => {
    const bad = ['../outside/secret.png', 'a/../../outside/secret.png', '/etc/passwd.png', 'a\\one.png',
        'a/one.png:stream.png', 'a/CON.png', 'a/nul.png', 'a/one.png.', 'a/one.png ', 'a//one.png', './a/one.png', 'a/%00.png'];
    for(const p of bad){
        const r = await call('/api/hash?p=' + q(p));
        assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
        assert.notEqual(r.status, 200, p);
    }
});

test('a symlinked folder or file pointing outside the library is unreachable', async () => {
    assert.equal((await call('/lib/out/secret.png')).status, 403);
    assert.equal((await call('/lib/link.png')).status, 403);
    assert.equal((await call('/api/hash?p=' + q('link.png'))).status, 403);
    // And not writable through them either.
    assert.equal((await call('/api/file?p=' + q('out/new.png'), {method: 'PUT', body: 'x'})).status, 403);
    assert.equal((await call('/api/file?p=' + q('out/secret.png'), {method: 'DELETE'})).status, 403);
    assert.equal(readFileSync(join(OUT, 'secret.png'), 'utf8'), 'TOPSECRET');
    assert.ok(!existsSync(join(OUT, 'new.png')));
});

test('a leaf that is a symlink cannot be overwritten', async () => {
    assert.equal((await call('/api/file?p=' + q('link.png'), {method: 'PUT', body: 'pwned'})).status, 403);
    assert.equal(readFileSync(join(OUT, 'secret.png'), 'utf8'), 'TOPSECRET');
});

test('moving onto or out through a symlink is refused', async () => {
    assert.equal((await post('/api/move', {from: 'a/one.png', to: 'out/one.png'})).status, 403);
    assert.ok(existsSync(join(LIB, 'a/one.png')));
    assert.ok(!existsSync(join(OUT, 'one.png')));
});

// ---------------------------------------------------------------------------------- CSRF guard

test('mutations need X-Guru, and a foreign Origin is refused', async () => {
    const put = (headers, guru) => call('/api/file?p=' + q('csrf.png'), {method: 'PUT', body: 'x', headers, guru});
    assert.equal((await put({}, false)).status, 403);
    const {port} = srv.address();
    assert.equal((await put({origin: 'http://evil.example'}, true)).status, 403);
    assert.equal((await put({origin: `http://127.0.0.1:${port}`}, true)).status, 200);
    assert.equal((await post('/api/mkdir', {p: 'x'}, {guru: false})).status, 403);
    assert.equal((await call('/api/file?p=csrf.png', {method: 'DELETE', guru: false})).status, 403);
    assert.equal((await call('/api/file?p=csrf.png', {method: 'DELETE'})).status, 200);
});

// ---------------------------------------------------------------------------------- file writes

test('PUT writes atomically, overwrites, leaves no temp file, and the tree sees it', async () => {
    const put1 = await call('/api/file?p=' + q('a/new.png'), {method: 'PUT', body: 'first'});
    assert.equal(put1.status, 200);
    assert.deepEqual([put1.json().size, put1.json().m > 1e12], [5, true]);   // the client needs the real mtime back
    assert.equal(readFileSync(join(LIB, 'a/new.png'), 'utf8'), 'first');
    assert.equal((await call('/api/file?p=' + q('a/new.png'), {method: 'PUT', body: 'second!'})).status, 200);
    assert.equal(readFileSync(join(LIB, 'a/new.png'), 'utf8'), 'second!');
    assert.ok(readdirSync(join(LIB, 'a')).every(n => !n.endsWith('.guru-tmp')));
    assert.ok((await call('/api/tree')).json().files.some(f => f.p === 'a/new.png' && f.s === 7));
    await call('/api/file?p=' + q('a/new.png'), {method: 'DELETE'});
});

test('PUT and DELETE only touch media, and PUT needs an existing parent', async () => {
    assert.equal((await call('/api/file?p=' + q('evil.html'), {method: 'PUT', body: '<script>'})).status, 400);
    assert.equal((await call('/api/file?p=' + q('a/x.exe'), {method: 'PUT', body: 'x'})).status, 400);
    assert.equal((await call('/api/file?p=' + q('notes.txt'), {method: 'DELETE'})).status, 400);
    assert.equal((await call('/api/file?p=' + q('nodir/x.png'), {method: 'PUT', body: 'x'})).status, 404);
    assert.ok(existsSync(join(LIB, 'notes.txt')));
});

test('DELETE removes a file, 404s a missing one, and refuses a folder via /api/file', async () => {
    mk('gone.png', PNG);
    assert.equal((await call('/api/file?p=gone.png', {method: 'DELETE'})).status, 200);
    assert.ok(!existsSync(join(LIB, 'gone.png')));
    assert.equal((await call('/api/file?p=gone.png', {method: 'DELETE'})).status, 404);
    mkdirSync(join(LIB, 'dir.png'));
    assert.equal((await call('/api/file?p=dir.png', {method: 'DELETE'})).status, 404);
    rmSync(join(LIB, 'dir.png'), {recursive: true});
});

test('mkdir is idempotent; rmdir is non-recursive and explains a non-empty folder', async () => {
    assert.equal((await post('/api/mkdir', {p: 'made'})).status, 200);
    assert.equal((await post('/api/mkdir', {p: 'made'})).status, 200);
    assert.equal((await post('/api/mkdir', {p: 'made/sub'})).status, 200);
    assert.equal((await post('/api/mkdir', {p: 'no/parent'})).status, 404);
    assert.equal((await post('/api/mkdir', {p: 'bad/../x'})).status, 400);
    assert.ok((await call('/api/tree')).json().dirs.includes('made/sub'));
    const r = await call('/api/dir?p=made', {method: 'DELETE'});
    assert.equal(r.status, 409);
    assert.match(r.json().error, /not empty/);
    assert.equal((await call('/api/dir?p=' + q('made/sub'), {method: 'DELETE'})).status, 200);
    assert.equal((await call('/api/dir?p=made', {method: 'DELETE'})).status, 200);
    assert.equal((await call('/api/dir?p=made', {method: 'DELETE'})).status, 404);
});

test('a folder holding only non-media files is "not empty" even though the tree shows it empty', async () => {
    mkdirSync(join(LIB, 'hidden')); writeFileSync(join(LIB, 'hidden/readme.txt'), 'x');
    assert.ok((await call('/api/tree')).json().dirs.includes('hidden'));
    assert.equal((await call('/api/dir?p=hidden', {method: 'DELETE'})).status, 409);
    rmSync(join(LIB, 'hidden'), {recursive: true});
});

test('move renames, refuses to overwrite, and checks both extensions', async () => {
    mk('m/src.png', PNG);
    assert.equal((await post('/api/move', {from: 'm/src.png', to: 'm/dst.png'})).status, 200);
    assert.ok(existsSync(join(LIB, 'm/dst.png')) && !existsSync(join(LIB, 'm/src.png')));
    mk('m/other.png', Buffer.from('other'));
    assert.equal((await post('/api/move', {from: 'm/dst.png', to: 'm/other.png'})).status, 409);
    assert.equal(readFileSync(join(LIB, 'm/other.png'), 'utf8'), 'other');   // untouched
    assert.equal((await post('/api/move', {from: 'm/dst.png', to: 'm/dst.txt'})).status, 400);
    assert.equal((await post('/api/move', {from: 'notes.txt', to: 'n.png'})).status, 400);
    assert.equal((await post('/api/move', {from: 'm/ghost.png', to: 'm/x.png'})).status, 404);
    mkdirSync(join(LIB, 'm/deep'));
    assert.equal((await post('/api/move', {from: 'm/dst.png', to: 'm/deep/dst.png'})).status, 200);
    assert.equal((await post('/api/move', {from: 'm/deep/dst.png', to: 'nodir/dst.png'})).status, 404);
    rmSync(join(LIB, 'm'), {recursive: true});
});

test('a case-only rename is allowed (same file, not an overwrite)', async () => {
    mk('case/lower.png', PNG);
    const r = await post('/api/move', {from: 'case/lower.png', to: 'case/LOWER.png'});
    assert.equal(r.status, 200);
    assert.ok(readdirSync(join(LIB, 'case')).includes('LOWER.png'));
    rmSync(join(LIB, 'case'), {recursive: true});
});

test('a body over the JSON limit is a 413, not a crash', async () => {
    const r = await post('/api/nextm', Buffer.alloc((1 << 20) + 10, 32));
    assert.equal(r.status, 413);
});

// ----------------------------------------------------------------------------------------- hash

test('/api/hash is SHA-256, and changes when the file does', async () => {
    mk('h/x.png', Buffer.from('hello'));
    const want = createHash('sha256').update('hello').digest('hex');
    assert.equal((await call('/api/hash?p=h/x.png')).json().sha, want);
    mk('h/x.png', Buffer.from('hello!!'));
    assert.notEqual((await call('/api/hash?p=h/x.png')).json().sha, want);
    assert.equal((await call('/api/hash?p=notes.txt')).status, 400);
    rmSync(join(LIB, 'h'), {recursive: true});
});

// ----------------------------------------------------------------------------------- index (HTTP)

const lines = r => r.body.trim().split('\n').map(JSON.parse);

test('index: whole records, field diffs, deletes, and a full dump', async () => {
    const ops = [
        {p: 'a/one.png', rec: {n: 'one.png', d: 1, emb: {$ta: 'Int8Array', b64: 'AQID'}, pA: [1000001]}},
        {p: 'a/b/two.jpg', rec: {n: 'two.jpg', d: 2}},
    ];
    const w = (await post('/api/index', {ops})).json();
    assert.ok(w.rev > 0);
    // A diff from a stale client must not erase what it didn't mention.
    await post('/api/index', {ops: [{p: 'a/one.png', set: {dim: '1x1'}, unset: ['d']}]});
    const dump = lines(await call('/api/index'));
    const head = dump[0], recs = Object.fromEntries(dump.slice(1).map(r => [r.p, r]));
    assert.equal(head.full, true);
    assert.deepEqual(recs['a/one.png'], {p: 'a/one.png', n: 'one.png', emb: {$ta: 'Int8Array', b64: 'AQID'}, pA: [1000001], dim: '1x1'});
    await post('/api/index', {ops: [{p: 'a/b/two.jpg', del: true}]});
    assert.equal(lines(await call('/api/index')).length, 2);   // header + one.png
});

test('index: gzip dump matches plain, and bad ops are 400', async () => {
    const plain = (await call('/api/index')).body;
    const gz = (await call('/api/index', {headers: {'accept-encoding': 'gzip'}})).body;
    assert.equal(gz, plain);
    for(const bad of [{ops: 'x'}, {ops: [{}]}, {ops: [{p: 'x'}]}, {ops: [{p: 'x', rec: 5}]}, {ops: [{p: 'x', unset: [1]}]}, {ops: [{p: '', rec: {}}]}])
        assert.equal((await post('/api/index', bad)).status, 400, JSON.stringify(bad));
});

test('index: delta dump returns only what changed, with tombstones; stale since falls back to full', async () => {
    const base = (await call('/api/config')).json().rev;
    await post('/api/index', {ops: [{p: 'a/b/two.jpg', rec: {n: 'two.jpg'}}, {p: 'a/one.png', del: true}]});
    const d = lines(await call('/api/index?since=' + base));
    assert.equal(d[0].full, false);
    const rest = d.slice(1);
    assert.deepEqual(rest.find(r => r.p === 'a/one.png'), {p: 'a/one.png', del: 1});
    assert.ok(rest.find(r => r.p === 'a/b/two.jpg' && r.n === 'two.jpg'));
    assert.equal(lines(await call('/api/index?since=-5'))[0].full, true);
});

test('index: __ai__ writes are conditional on the revision the client last saw', async () => {
    const r1 = (await post('/api/index', {ops: [{p: '__ai__', rec: {tier: 'fp16', clusters: []}}]})).json();
    const rev1 = r1.revs.__ai__;
    assert.ok(rev1);
    assert.equal((await call('/api/config')).json().tier, 'fp16');
    const ok = (await post('/api/index', {ops: [{p: '__ai__', set: {nextM: 5}, ifRev: rev1}]})).json();
    assert.deepEqual(ok.conflicts, []);
    // A second client still holding rev1 loses, and is handed the current copy to re-apply onto.
    const stale = (await post('/api/index', {ops: [{p: '__ai__', set: {nextM: 99}, ifRev: rev1}, {p: 'other.png', rec: {n: 'x'}}]})).json();
    assert.equal(stale.conflicts.length, 1);
    assert.equal(stale.conflicts[0].rec.nextM, 5);
    assert.equal(lines(await call('/api/index')).find(r => r.p === 'other.png').n, 'x');   // the rest of the batch still applied
    assert.equal(lines(await call('/api/index')).find(r => r.p === '__ai__').nextM, 5);
    assert.ok(lines(await call('/api/index'))[0].revs.__ai__ >= ok.revs.__ai__);
});

test('nextm hands out distinct ids and honours a client floor', async () => {
    const a = (await post('/api/nextm', {})).json().id, b = (await post('/api/nextm', {})).json().id;
    assert.equal(a, 1000000);
    assert.equal(b, 1000001);
    assert.equal((await post('/api/nextm', {min: 1000500})).json().id, 1000500);
    assert.equal((await post('/api/nextm', {})).json().id, 1000501);
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => post('/api/nextm', {}).then(r => r.json().id)));
    assert.equal(new Set(ids).size, 5);
});

// --------------------------------------------------------------------------- index store (direct)

const fresh = () => join(tmp, 'store-' + Math.random().toString(36).slice(2));

test('store: survives a restart, typed-array encodings and all', async () => {
    const d = fresh(), enc = {$ta: 'Int8Array', b64: '/wCA'};
    let s = new IndexStore(d);
    await s.apply([{p: 'x.png', rec: {n: 'x', emb: enc}}, {p: 'x.png', set: {k: 1}}, {p: '__ai__', rec: {tier: 'int8'}}]);
    await s.allocM();
    await s.close();
    s = new IndexStore(d); await s.ready;
    assert.deepEqual(s.get('x.png'), {p: 'x.png', n: 'x', emb: enc, k: 1});
    assert.equal(s.get('__ai__').tier, 'int8');
    assert.equal(s.meta.nextM, 1000001);
    assert.equal(s.baseRev, s.rev);
    await s.close();
});

test('store: a truncated last line is ignored, repaired, and a .bak keeps the damaged file', async () => {
    const d = fresh();
    let s = new IndexStore(d);
    await s.apply([{p: 'a.png', rec: {n: 'a'}}, {p: 'b.png', rec: {n: 'b'}}]);
    await s.close();
    appendFileSync(join(d, 'index.jsonl'), '{"r":9,"p":"c.png","rec":{"n":"c');   // power cut mid-write
    s = new IndexStore(d); await s.ready;
    assert.equal(s.recs.size, 2);
    assert.equal(s.corrupt, 1);
    assert.ok(existsSync(join(d, 'index.jsonl.bak.1')));
    await s.apply([{p: 'd.png', rec: {n: 'd'}}]);               // next append must start on a clean line
    await s.close();
    s = new IndexStore(d); await s.ready;
    assert.deepEqual([...s.recs.keys()].sort(), ['a.png', 'b.png', 'd.png']);
    assert.equal(s.corrupt, 0);
    await s.close();
});

test('store: the journal compacts at startup and rolling backups are capped', async () => {
    const d = fresh();
    let s = new IndexStore(d, {snapshots: 2});
    for(let i = 0; i < 200; i++) await s.apply([{p: 'a.png', set: {i}}]);   // 200 lines, 1 live record
    await s.close();
    for(let round = 0; round < 4; round++){
        s = new IndexStore(d, {snapshots: 2}); await s.ready;
        for(let i = 0; i < 200; i++) await s.apply([{p: 'a.png', set: {i: i + round}}]);
        await s.close();
    }
    s = new IndexStore(d, {snapshots: 2}); await s.ready;
    assert.equal(s.get('a.png').i, 202);
    assert.equal(readFileSync(join(d, 'index.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.ok(readdirSync(d).filter(n => n.includes('.bak.')).length <= 2);
    await s.close();
});

test('store: a rejected batch changes nothing, in memory or on disk', async () => {
    const d = fresh();
    const s = new IndexStore(d);
    await s.apply([{p: 'a.png', rec: {n: 'a'}}]);
    await assert.rejects(s.apply([{p: 'a.png', set: {n: 'CHANGED'}}, {p: 'b.png'}]), /needs one of/);
    assert.equal(s.get('a.png').n, 'a');
    assert.equal(s.get('b.png'), null);
    await s.apply([{p: 'c.png', rec: {n: 'c'}}]);                // and the queue is not poisoned
    assert.equal(s.get('c.png').n, 'c');
    await s.close();
});

test('store: concurrent batches are serialised and none is lost', async () => {
    const d = fresh();
    const s = new IndexStore(d);
    await Promise.all(Array.from({length: 50}, (_, i) => s.apply([{p: `f${i}.png`, rec: {i}}])));
    assert.equal(s.recs.size, 50);
    await s.close();
    const s2 = new IndexStore(d); await s2.ready;
    assert.equal(s2.recs.size, 50);
    await s2.close();
});
