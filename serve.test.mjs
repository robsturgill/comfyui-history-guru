// node --test serve.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig, validateConfig, createApp, hashPassword, parseArgs} from './serve.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'guru-test-'));
after(() => rmSync(tmp, {recursive: true, force: true}));

// Raw http.request so tests can set Host and send un-normalised paths, which fetch() won't.
const call = (srv, path, {headers = {}, method = 'GET'} = {}) => new Promise((ok, no) => {
    const {port} = srv.address();
    const r = request({host: '127.0.0.1', port, path, method, headers}, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => ok({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}));
    });
    r.on('error', no);
    r.end();
});
const basic = (pw, user = 'anyone') => 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
const listen = srv => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv)));
const cfgBase = {host: '127.0.0.1', port: 0, dir: null, data: tmp, allowedHosts: [], password: null, passwordHash: null, tlsCert: null, tlsKey: null};

// ----------------------------------------------------------------------------- config precedence

test('flags beat env beat config file beat defaults', () => {
    const f = join(tmp, 'a.json');
    writeFileSync(f, JSON.stringify({port: 1111, host: '10.0.0.5', password: 'file'}));
    assert.equal(loadConfig(['--config', f], {}).port, 1111);
    assert.equal(loadConfig(['--config', f], {GURU_PORT: '2222'}).port, 2222);
    assert.equal(loadConfig(['--config', f, '--port', '3333'], {GURU_PORT: '2222'}).port, 3333);
    assert.equal(loadConfig(['--config', f], {GURU_PASSWORD: 'env'}).password, 'env');
    assert.equal(loadConfig(['--config', f, '--password=flag'], {GURU_PASSWORD: 'env'}).password, 'flag');
});

test('defaults: loopback, 8787, no password', () => {
    const c = loadConfig([], {}, tmp);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.port, 8787);
    assert.equal(c.password, null);
});

test('GURU_PORT is still honoured (the original env var)', () => {
    assert.equal(loadConfig([], {GURU_PORT: '9000'}, tmp).port, 9000);
});

test('--lan means 0.0.0.0, but an explicit --host wins', () => {
    assert.equal(loadConfig(['--lan'], {}, tmp).host, '0.0.0.0');
    assert.equal(loadConfig(['--lan', '--host', '192.168.1.5'], {}, tmp).host, '192.168.1.5');
});

test('config-file paths resolve against the file, flag paths against the cwd', () => {
    const f = join(tmp, 'b.json');
    writeFileSync(f, JSON.stringify({dir: 'lib', tls: {cert: 'c.pem', key: 'k.pem'}}));
    const c = loadConfig(['--config', f], {}, '/somewhere/else');
    assert.equal(c.dir, join(tmp, 'lib'));
    assert.equal(c.tlsCert, join(tmp, 'c.pem'));
    assert.equal(loadConfig(['--dir', 'rel'], {}, '/somewhere/else').dir, '/somewhere/else/rel');
});

test('unknown flags and valueless flags are errors', () => {
    assert.throws(() => parseArgs(['--nope']), /Unknown option/);
    assert.throws(() => parseArgs(['--port']), /needs a value/);
    assert.throws(() => parseArgs(['--port', '--lan']), /needs a value/);
});

test('--hash-password takes an optional value without eating the next flag', () => {
    assert.equal(parseArgs(['--hash-password']).hashPassword, true);
    assert.equal(parseArgs(['--hash-password', 'pw']).hashPassword, 'pw');
    assert.equal(parseArgs(['--hash-password', '--lan']).hashPassword, true);
});

// ------------------------------------------------------------------------------- startup guards

test('library mode refuses to start without a password, even on loopback', () => {
    assert.match(validateConfig({...cfgBase, dir: tmp}), /requires a password/);
    assert.equal(validateConfig({...cfgBase, dir: tmp, password: 'x'}), null);
});

test('a non-loopback bind refuses to start without a password', () => {
    assert.match(validateConfig({...cfgBase, host: '0.0.0.0'}), /without a password/);
    assert.match(validateConfig({...cfgBase, host: '192.168.1.5'}), /without a password/);
    assert.equal(validateConfig({...cfgBase, host: '0.0.0.0', password: 'x'}), null);
});

test('plain loopback needs no password (the original behaviour)', () => {
    assert.equal(validateConfig(cfgBase), null);
    assert.equal(validateConfig({...cfgBase, host: 'localhost'}), null);
});

test('missing or non-directory --dir, half a TLS pair, bad port and bad hash are errors', () => {
    assert.match(validateConfig({...cfgBase, dir: join(tmp, 'nope'), password: 'x'}), /does not exist/);
    const f = join(tmp, 'file.txt'); writeFileSync(f, 'x');
    assert.match(validateConfig({...cfgBase, dir: f, password: 'x'}), /not a directory/);
    assert.match(validateConfig({...cfgBase, tlsCert: f}), /together/);
    assert.match(validateConfig({...cfgBase, tlsCert: f, tlsKey: join(tmp, 'missing')}), /not found/);
    assert.match(validateConfig({...cfgBase, port: 70000}), /Invalid port/);
    assert.match(validateConfig({...cfgBase, passwordHash: 'plaintext'}), /malformed/);
});

// ----------------------------------------------------------------------------------------- auth

let plain, hashed;
before(async () => {
    plain = await listen(createApp({...cfgBase, password: 'hunter2'}));
    hashed = await listen(createApp({...cfgBase, passwordHash: await hashPassword('s3cret')}));
});
after(() => { plain.close(); hashed.close() });

test('401 with a Basic challenge when no credentials are sent', async () => {
    const r = await call(plain, '/');
    assert.equal(r.status, 401);
    assert.match(r.headers['www-authenticate'], /^Basic realm=/);
});

test('wrong password is 401, right password is 200, username is ignored', async () => {
    assert.equal((await call(plain, '/', {headers: {authorization: basic('nope')}})).status, 401);
    assert.equal((await call(plain, '/', {headers: {authorization: basic('hunter2')}})).status, 200);
    assert.equal((await call(plain, '/', {headers: {authorization: basic('hunter2', 'whoever')}})).status, 200);
});

test('malformed Authorization headers are 401, not a crash', async () => {
    for(const a of ['Basic', 'Basic !!!', 'Bearer abc', 'Basic ' + Buffer.from('nocolon').toString('base64')])
        assert.equal((await call(plain, '/', {headers: {authorization: a}})).status, 401, a);
});

test('a passwordHash works, and a plaintext guess of the hash does not', async () => {
    assert.equal((await call(hashed, '/', {headers: {authorization: basic('s3cret')}})).status, 200);
    assert.equal((await call(hashed, '/', {headers: {authorization: basic('wrong')}})).status, 401);
});

test('a verified header keeps working on later requests (memoised)', async () => {
    const h = {authorization: basic('hunter2')};
    for(let i = 0; i < 3; i++) assert.equal((await call(plain, '/ai/ai-worker.js', {headers: h})).status, 200);
});

test('every path needs auth, not just the page', async () => {
    for(const p of ['/ai/ai-worker.js', '/api/config', '/nothing'])
        assert.equal((await call(plain, p)).status, 401, p);
});

// ------------------------------------------------------------------------------ Host / rebinding

test('a rebound hostname is rejected before auth is even consulted', async () => {
    const h = {authorization: basic('hunter2')};
    for(const host of ['evil.example.com', 'evil.example.com:8787', 'localhost.evil.com'])
        assert.equal((await call(plain, '/', {headers: {...h, host}})).status, 403, host);
});

test('localhost, IP literals and IPv6 literals are accepted', async () => {
    const h = {authorization: basic('hunter2')};
    for(const host of ['localhost:8787', '127.0.0.1:8787', '192.168.1.20', '[::1]:8787', 'app.localhost'])
        assert.equal((await call(plain, '/', {headers: {...h, host}})).status, 200, host);
});

test('--allow-host vouches for a DNS name', async () => {
    const s = await listen(createApp({...cfgBase, password: 'p', allowedHosts: ['guru.lan']}));
    try{
        assert.equal((await call(s, '/', {headers: {authorization: basic('p'), host: 'guru.lan:8787'}})).status, 200);
        assert.equal((await call(s, '/', {headers: {authorization: basic('p'), host: 'other.lan'}})).status, 403);
    }finally{ s.close() }
});

// ------------------------------------------------------------------------------ static allowlist

let open;
before(async () => { open = await listen(createApp(cfgBase)) });
after(() => open.close());

test('the app, ai/ and the diagnostics page are served', async () => {
    assert.equal((await call(open, '/')).status, 200);
    assert.match((await call(open, '/')).headers['content-type'], /text\/html/);
    assert.equal((await call(open, '/ai/ai-worker.js')).status, 200);
    assert.equal((await call(open, '/ai-check.html')).status, 200);
});

test('secrets and source outside the allowlist are not downloadable', async () => {
    for(const p of ['/guru.config.json', '/data/index.jsonl', '/.git/config', '/.gitignore', '/serve.mjs',
                    '/CLAUDE.md', '/samples/x.png', '/package.json', '/ai'])
        assert.ok([403, 404].includes((await call(open, p)).status), p);
});

test('traversal out of ai/ is refused, encoded or not', async () => {
    for(const p of ['/ai/../serve.mjs', '/ai/%2e%2e/serve.mjs', '/ai/..%2fserve.mjs', '/ai/%2e%2e%2f%2e%2e%2fetc/passwd', '/ai/.%2e/serve.mjs'])
        assert.ok([403, 404].includes((await call(open, p)).status), p);
});

test('dotfiles and NULs inside ai/ are refused', async () => {
    assert.equal((await call(open, '/ai/.hidden')).status, 403);
    assert.equal((await call(open, '/ai/a%00b')).status, 403);
});

test('a malformed percent-escape is a 400, not a crash', async () => {
    assert.equal((await call(open, '/ai/%E0%A4%A')).status, 400);
});

// ---------------------------------------------------------------------------------- existing bits

test('COOP/COEP/CORP and nosniff headers are present', async () => {
    const h = (await call(open, '/')).headers;
    assert.equal(h['cross-origin-opener-policy'], 'same-origin');
    assert.equal(h['cross-origin-embedder-policy'], 'require-corp');
    assert.equal(h['cross-origin-resource-policy'], 'same-origin');
    assert.equal(h['x-content-type-options'], 'nosniff');
});

test('Range requests still return 206, and an unsatisfiable range is 416', async () => {
    const r = await call(open, '/ai/ai-worker.js', {headers: {range: 'bytes=0-9'}});
    assert.equal(r.status, 206);
    assert.equal(r.body.length, 10);
    assert.equal((await call(open, '/ai/ai-worker.js', {headers: {range: 'bytes=999999999-'}})).status, 416);
});

test('source is no-store; HEAD has no body', async () => {
    const r = await call(open, '/ai/ai-worker.js', {method: 'HEAD'});
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body, '');
});

test('/api/config reports library mode off until a library is configured', async () => {
    assert.deepEqual(JSON.parse((await call(open, '/api/config')).body), {library: false});
});
