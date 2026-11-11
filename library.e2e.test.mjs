// End-to-end test of library mode in a real browser.
//
//   node --test library.e2e.test.mjs
//
// Needs `playwright` resolvable (same as ai/src/people.test.mjs) and a Chromium. Set GURU_CHROMIUM to a
// binary path if Playwright's own isn't installed. Runs the real page against a real `serve.mjs --dir`.
//
// DESTRUCTIVE TESTS RUN ON A COPY. samples/ has no backup; this copies it to a temp dir and points the
// server there, so move/rename/delete/Fix&Save never touch the original. Skipped if samples/ is absent.
//
// A second client is opened on the machine's LAN address when there is one: that is a non-loopback peer, so
// the server treats it as "not the host" and it is on a plain-http (non-secure) origin, which is exactly
// the situation of a phone on the network. Those tests are skipped without a LAN address.
import {test, before, after, describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {lanAddresses} from './serve.mjs';

const REPO = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(REPO, 'samples');
const HAVE = existsSync(SAMPLES);
const LAN = lanAddresses()[0];
const PORT = 8841 + (process.pid % 50);
const AUTH = 'Basic ' + Buffer.from('u:pw').toString('base64');

let tmp, LIB, srv, browser;
const opened = [];

const api = async (path, body) => (await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: body ? 'POST' : 'GET', headers: {authorization: AUTH, 'x-guru': '1', 'content-type': 'application/json'}, body: body && JSON.stringify(body)})).text();
const index = async () => Object.fromEntries((await api('/api/index')).trim().split('\n').slice(1).map(l => { const r = JSON.parse(l); return [r.p, r] }));

async function client(host){
    const ctx = await browser.newContext({httpCredentials: {username: 'u', password: 'pw'}});
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());                    // confirm() -> OK
    await page.goto(`http://${host}:${PORT}/`);
    await page.waitForFunction(() => typeof REMOTE !== 'undefined' && REMOTE && document.getElementById('load').classList.contains('hidden'), null, {timeout: 60000});
    const c = {page, errors, drain: () => page.evaluate(() => rDrain())};
    opened.push(ctx);
    return c;
}

before(async () => {
    if(!HAVE) return;
    tmp = mkdtempSync(join(tmpdir(), 'guru-e2e-'));
    LIB = join(tmp, 'lib');
    cpSync(SAMPLES, LIB, {recursive: true});
    srv = spawn('node', ['serve.mjs', '--dir', LIB, '--data', join(tmp, 'data'), '--lan', '--port', PORT],
        {cwd: REPO, env: {...process.env, GURU_PASSWORD: 'pw'}, stdio: 'ignore'});
    await new Promise(r => setTimeout(r, 1200));
    browser = await chromium.launch(process.env.GURU_CHROMIUM ? {executablePath: process.env.GURU_CHROMIUM, args: ['--no-sandbox']} : {});
});
after(async () => {
    for(const c of opened) await c.close().catch(() => {});
    if(browser) await browser.close();
    if(srv) srv.kill();
    if(tmp) rmSync(tmp, {recursive: true, force: true});
});

describe('library mode in a real browser', {skip: !HAVE && 'no samples/ folder'}, () => {
    let host, first, files;

    test('the host client lists, parses and saves the whole library to the server', async () => {
        host = await client('127.0.0.1');
        const s = await host.page.evaluate(() => ({local: REMOTE.local, files: fReg.size, cache: cache.size, open: getComputedStyle(document.querySelector('.no-remote')).display}));
        assert.equal(s.local, true);
        assert.equal(s.files, s.cache);
        assert.equal(s.open, 'none', 'Open Folder is hidden');
        await host.drain();
        files = (await host.page.evaluate(() => [...fReg.keys()].sort()));
        first = files[0];
        const ix = await index();
        assert.equal(Object.keys(ix).filter(k => !k.startsWith('_')).length, files.length);
    });

    test('a reload is served from the index and writes nothing', async () => {
        const again = await client('127.0.0.1');
        let posts = 0;
        again.page.on('request', r => { if(r.method() === 'POST' && r.url().endsWith('/api/index')) posts++ });
        await again.page.waitForTimeout(600);
        assert.equal(await again.page.evaluate(() => cache.size), files.length);
        assert.equal(posts, 0);
    });

    test('RFile reads are byte-exact Range requests, and getFile() never downloads', async () => {
        const r = await host.page.evaluate(async p => {
            const reqs = [];
            const f = await fReg.get(p).getFile();                       // must not fetch
            const full = new Uint8Array(await f.arrayBuffer());
            const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
            return {size: f.size === full.length,
                head: eq(new Uint8Array(await f.slice(10, 30).arrayBuffer()), full.slice(10, 30)),
                tail: eq(new Uint8Array(await f.slice(f.size - 16).arrayBuffer()), full.slice(-16)),
                blob: eq(new Uint8Array(await (await toBlob(f)).arrayBuffer()), full)};
        }, first);
        assert.deepEqual(r, {size: true, head: true, tail: true, blob: true});
    });

    test('typed arrays round-trip, and a stale write never erases another device\'s fields', async () => {
        await host.page.evaluate(p => { const it = cache.get(p); it.emb = new Int8Array([1, -2, 127, -128]); it.pA = [1000001]; dPut(it) }, first);
        await host.drain();
        assert.deepEqual((await index())[first].emb, {$ta: 'Int8Array', b64: Buffer.from([1, 254, 127, 128]).toString('base64')});
        const stale = await client('127.0.0.1');                         // loads the snapshot now
        await host.page.evaluate(p => { const it = cache.get(p); it.pA = [1000001, 1000002]; it.faces = [{c: 3}]; dPut(it) }, first);
        await host.drain();
        await stale.page.evaluate(p => { const it = cache.get(p); it.fav = true; dPut(it) }, first);
        await stale.drain();
        const r = (await index())[first];
        assert.equal(r.fav, true);
        assert.deepEqual(r.pA, [1000001, 1000002], 'the stale client must not revert pA');
        assert.ok(r.faces && r.emb);
        assert.equal(await stale.page.evaluate(p => cache.get(p).emb instanceof Int8Array, first), true);
    });

    test('a put queued after a delete wins and is sent whole', async () => {
        await host.page.evaluate(p => { const it = cache.get(p); dDel(p); dPut(it) }, first);
        await host.drain();
        const r = (await index())[first];
        assert.ok(r && r.fav === true && r.emb && r.jt);
    });

    test('move is a server-side rename that carries the index record and the star', async () => {
        const [a, b] = [files[1], files.find(f => f.split('/')[0] !== files[1].split('/')[0])];
        const dest = b.split('/')[0], name = a.split('/').pop();
        await host.page.evaluate(async ([p, d]) => { favorites.add(p); rFavSave(p); await moveFile(JSON.stringify([p]), d) }, [a, dest]);
        await host.drain();
        assert.ok(!existsSync(join(LIB, a)) && existsSync(join(LIB, dest, name)));
        const ix = await index();
        assert.ok(!ix[a] && ix[`${dest}/${name}`].fav === true && ix[`${dest}/${name}`].jt);
        assert.equal(await host.page.evaluate(p => favorites.has(p), `${dest}/${name}`), true);
    });

    test('rename keeps the same handle valid; delete removes the file and its record; mkdir/rmdir', async () => {
        const p = files[2], par = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
        await host.page.evaluate(async p => { window.prompt = () => 'renamed_e2e.png'; cItem = {p, h: fReg.get(p), d: 0, n: ''}; await renameFile() }, p);
        assert.ok(existsSync(join(LIB, par + 'renamed_e2e.png')) && !existsSync(join(LIB, p)));
        assert.equal(await host.page.evaluate(n => fReg.get(n).name, par + 'renamed_e2e.png'), 'renamed_e2e.png');
        const del = files[3];
        await host.page.evaluate(p => confirmDelete([p]), del);
        await host.drain();
        assert.ok(!existsSync(join(LIB, del)) && !(await index())[del]);
        await host.page.evaluate(async () => { window.prompt = () => 'e2e_folder'; cDir = null; await mkDir() });
        assert.ok(existsSync(join(LIB, 'e2e_folder')));
        assert.ok((await host.page.evaluate(() => [...dReg.keys()])).includes('e2e_folder'));
        const out = await host.page.evaluate(() => rH.removeEntry('e2e_folder').then(() => 'ok', e => e.message));
        assert.equal(out, 'ok');
        assert.ok(!existsSync(join(LIB, 'e2e_folder')));
    });

    test('Fix & Save rewrites a PNG, and converts a JPEG by writing the PNG before removing the JPEG', async () => {
        const q = files[5];
        await host.page.evaluate(async p => { cItem = {p, h: fReg.get(p), d: 0, n: ''}; document.getElementById('mPos').value = 'EDITED BY E2E'; document.getElementById('mNeg').value = ''; await fixSave() }, q);
        await host.drain();
        assert.ok(readFileSync(join(LIB, q)).includes(Buffer.from('EDITED BY E2E')));
        assert.ok(readdirSync(join(LIB, q.split('/')[0])).every(n => !n.endsWith('.guru-tmp')));
        const dir = files[6].split('/')[0];
        await host.page.evaluate(async d => {
            const c = document.createElement('canvas'); c.width = 32; c.height = 32; c.getContext('2d').fillRect(0, 0, 32, 32);
            await rApi('/api/file?p=' + encodeURIComponent(d + '/e2e.jpg'), {method: 'PUT', body: await new Promise(r => c.toBlob(r, 'image/jpeg'))});
            await fullScan();
            cItem = {p: d + '/e2e.jpg', h: fReg.get(d + '/e2e.jpg'), d: 0, n: ''};
            document.getElementById('mPos').value = 'jpeg'; document.getElementById('mNeg').value = '';
            await fixSave();
        }, dir);
        assert.ok(existsSync(join(LIB, dir, 'e2e.png')) && !existsSync(join(LIB, dir, 'e2e.jpg')));
    });

    test('duplicate scan runs in library mode without downloading files', async () => {
        await host.page.evaluate(() => scanDuplicates());
        await host.page.waitForFunction(() => !dupScanState, null, {timeout: 60000});
    });

    test('no page errors on the host client', () => assert.deepEqual(host.errors, []));

    describe('a client on the LAN address (not the host, plain http)', {skip: !LAN && 'no LAN address'}, () => {
        let lan;
        test('sees the shared index and the stars; indexes nothing', async () => {
            lan = await client(LAN);
            const s = await lan.page.evaluate(() => ({local: REMOTE.local, secure: isSecureContext, unidx: REMOTE.unindexed, fav: favorites.size}));
            assert.equal(s.local, false);
            assert.equal(s.secure, false);
            assert.equal(s.unidx, 0);
            assert.ok(s.fav >= 1);
        });
        test('has full file management', async () => {
            const target = (await lan.page.evaluate(() => [...fReg.keys()].sort())).at(-1);
            await lan.page.evaluate(p => confirmDelete([p]), target);
            await lan.drain();
            assert.ok(!existsSync(join(LIB, target)));
        });
        test('like: and the People view work without a secure context; sem: explains itself', async () => {
            const name = (await lan.page.evaluate(() => [...fReg.keys()][0])).split('/').pop();
            await lan.page.evaluate(() => showPeople());
            assert.equal(await lan.page.evaluate(() => vMode), 'faces');
            await lan.page.evaluate(() => setView('list'));
            await lan.page.evaluate(() => runSearch('sem:"a ship"'));
            assert.ok((await lan.page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent))).some(t => /secure page/.test(t)));
            await lan.page.evaluate(() => aiClearData());
            assert.ok((await lan.page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent))).some(t => /host machine/.test(t)));
        });
        test('an empty index yields in-memory placeholders that are never saved', async () => {
            await api('/api/index', {ops: Object.keys(await index()).filter(k => !k.startsWith('_')).map(p => ({p, del: true}))});
            const fresh = await client(LAN);
            const s = await fresh.page.evaluate(() => ({n: cache.size, ph: [...cache.values()].every(v => v.unindexed)}));
            assert.ok(s.n > 0 && s.ph);
            await fresh.page.evaluate(() => { for(const v of cache.values()) dPut(v); return rDrain() });
            assert.equal(Object.keys(await index()).filter(k => !k.startsWith('_')).length, 0);
            assert.deepEqual(fresh.errors, []);
        });
    });
});
