// Launcher for Guru Manager.
//
// Why this exists: Chrome gates WebNN, WebGPU and Web Workers behind a secure context, and file://
// is not one. http://localhost is. The core app still runs fine by double-clicking the HTML - this
// server exists so the AI features have a context they're allowed to run in, and (optionally) so one
// machine can host a library for the rest of the LAN.
//
//   node serve.mjs                              loopback only, then open http://127.0.0.1:8787/
//   node serve.mjs --lan --password <pw>        reachable from the LAN, password required
//   node serve.mjs --help                       every option
//
// Node stdlib only, no dependencies, no build step.

import {createServer as createHttp} from 'node:http';
import {createServer as createHttps} from 'node:https';
import {statSync, readFileSync, existsSync} from 'node:fs';
import {extname, normalize, join, sep, resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, timingSafeEqual, scrypt, randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {hostname as osHostname, networkInterfaces} from 'node:os';
import {MIME, send, serveFile, createLibrary} from './library.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');
const APP = 'Guru Manager ChromeEdge Edition.html';
// Everything the browser may fetch from ROOT. An allowlist, not "everything under ROOT": guru.config.json
// (password), data/ (the shared index) and .git live in the same tree and must never be downloadable.
const STATIC_FILES = new Set(['/' + APP, '/ai-check.html']);
const STATIC_PREFIX = '/ai/';

// ---------------------------------------------------------------------------------------- config

const HELP = `
  node serve.mjs [options]

  --dir <path>          Library to host (enables library mode; requires a password)
  --host <addr>         Bind address (default 127.0.0.1)
  --lan                 Shorthand for --host 0.0.0.0 (requires a password)
  --port <n>            Port (default 8787; never auto-incremented, see below)
  --password <pw>       Password. Prefer GURU_PASSWORD or the config file: a CLI value shows in 'ps'
  --tls-cert <file>     PEM certificate  } both or neither; switches to https, which gives LAN
  --tls-key <file>      PEM private key  } clients a secure context (needed for on-device AI)
  --data <path>         Where the shared index lives (default ./data)
  --allow-host <name>   Extra Host header accepted (repeatable), e.g. a DNS name for this machine
  --config <file>       JSON config (default ./guru.config.json if present)
  --hash-password [pw]  Print a passwordHash for the config file and exit (reads stdin if no pw)

  Precedence: flags > GURU_* environment > config file > defaults.
  Environment: GURU_DIR GURU_HOST GURU_PORT GURU_PASSWORD GURU_TLS_CERT GURU_TLS_KEY GURU_DATA GURU_CONFIG
  Config file keys: dir host port password passwordHash tls{cert,key} data allowedHosts

  The port is part of the browser origin, and a changed origin means a fresh IndexedDB. It is fixed on
  purpose; a busy port is an error, not a reason to move to 8788.
`;

const FLAG_VALUE = {'--dir':'dir', '--host':'host', '--port':'port', '--password':'password',
    '--tls-cert':'tlsCert', '--tls-key':'tlsKey', '--data':'data', '--config':'config'};

export function parseArgs(argv){
    const o = {allowedHosts: []};
    for(let i = 0; i < argv.length; i++){
        const a = argv[i], eq = a.indexOf('='), k = eq > 0 ? a.slice(0, eq) : a;
        const val = () => {
            if(eq > 0) return a.slice(eq + 1);
            if(i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${k} needs a value`);
            return argv[++i];
        };
        if(k === '--lan') o.lan = true;
        else if(k === '--help' || k === '-h') o.help = true;
        else if(k === '--allow-host') o.allowedHosts.push(val());
        else if(k === '--hash-password'){
            // The value is optional (stdin otherwise), so don't swallow a following flag.
            o.hashPassword = eq > 0 ? a.slice(eq + 1) : (i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true);
        }
        else if(FLAG_VALUE[k]) o[FLAG_VALUE[k]] = val();
        else throw new Error(`Unknown option ${a}`);
    }
    return o;
}

// Resolve flags + env + file into one config. Paths from the file resolve against the file's own folder,
// so the config can live next to the library; paths from flags/env resolve against the cwd.
export function loadConfig(argv, env = process.env, cwd = process.cwd()){
    const flags = parseArgs(argv);
    const cfgPath = flags.config || env.GURU_CONFIG || (existsSync(join(ROOT, 'guru.config.json')) ? join(ROOT, 'guru.config.json') : null);
    let file = {}, fileDir = cwd;
    if(cfgPath){
        const p = resolve(cwd, cfgPath);
        try{ file = JSON.parse(readFileSync(p, 'utf8')) }
        catch(e){ throw new Error(`Cannot read config ${p}: ${e.message}`) }
        if(!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`Config ${p} must be a JSON object`);
        fileDir = dirname(p);
    }
    const pick = (flag, envKey, fileVal, base) => {
        if(flag !== undefined) return [flag, cwd];
        if(env[envKey] !== undefined && env[envKey] !== '') return [env[envKey], cwd];
        return [fileVal, base];
    };
    const path = (flag, envKey, fileVal) => {
        const [v, base] = pick(flag, envKey, fileVal, fileDir);
        return v ? resolve(base, String(v)) : null;
    };
    const cfg = {};
    cfg.dir = path(flags.dir, 'GURU_DIR', file.dir);
    cfg.data = path(flags.data, 'GURU_DATA', file.data) || join(ROOT, 'data');
    cfg.tlsCert = path(flags.tlsCert, 'GURU_TLS_CERT', file.tls && file.tls.cert);
    cfg.tlsKey = path(flags.tlsKey, 'GURU_TLS_KEY', file.tls && file.tls.key);
    cfg.host = flags.lan && flags.host === undefined ? '0.0.0.0' : pick(flags.host, 'GURU_HOST', file.host)[0] || '127.0.0.1';
    cfg.port = +(pick(flags.port, 'GURU_PORT', file.port)[0] ?? 8787);
    cfg.password = pick(flags.password, 'GURU_PASSWORD', file.password)[0] || null;
    cfg.passwordHash = file.passwordHash || null;
    cfg.allowedHosts = [...flags.allowedHosts, ...(Array.isArray(file.allowedHosts) ? file.allowedHosts : [])].map(s => String(s).toLowerCase());
    cfg.help = !!flags.help;
    cfg.hashPassword = flags.hashPassword;
    cfg.configPath = cfgPath ? resolve(cwd, cfgPath) : null;
    return cfg;
}

export const isLoopback = h => h === 'localhost' || h === '::1' || /^127\./.test(h);

// Returns an error string, or null. Every rule here exists because breaking it is a security problem,
// not a preference.
export function validateConfig(cfg){
    if(!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) return `Invalid port: ${cfg.port}`;
    if(cfg.passwordHash && !/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(cfg.passwordHash))
        return 'passwordHash is malformed. Generate one with: node serve.mjs --hash-password';
    const hasPw = !!(cfg.password || cfg.passwordHash);
    if(cfg.dir){
        let st; try{ st = statSync(cfg.dir) }catch{ return `--dir does not exist: ${cfg.dir}` }
        if(!st.isDirectory()) return `--dir is not a directory: ${cfg.dir}`;
        // Library mode lets a client read, write and delete files. Never without a password, even on
        // loopback: a rebound hostname would otherwise reach it from any web page.
        if(!hasPw) return 'Library mode (--dir) requires a password. Set GURU_PASSWORD, --password, or the config file.';
    }
    if(!isLoopback(cfg.host) && !hasPw)
        return `Refusing to listen on ${cfg.host} without a password. Set GURU_PASSWORD, --password, or the config file.`;
    if(!!cfg.tlsCert !== !!cfg.tlsKey) return '--tls-cert and --tls-key must be given together.';
    for(const f of [cfg.tlsCert, cfg.tlsKey]) if(f && !existsSync(f)) return `TLS file not found: ${f}\nCreate one with: node make-cert.mjs`;
    return null;
}

// scrypt$<salt b64>$<hash b64>. The config file can then hold this instead of the password.
export function hashPassword(pw){
    const salt = randomBytes(16);
    return new Promise((ok, no) => scrypt(pw, salt, 32, (e, k) => e ? no(e) : ok(`scrypt$${salt.toString('base64')}$${k.toString('base64')}`)));
}

export function lanAddresses(){
    const out = [];
    for(const list of Object.values(networkInterfaces()))
        for(const n of list || []) if(n.family === 'IPv4' && !n.internal) out.push(n.address);
    return out;
}

// ------------------------------------------------------------------------------------------ auth

const sha = s => createHash('sha256').update(s).digest();
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// Returns async (req) => boolean, or null when no password is configured. Basic auth resends the header
// on every request - every thumbnail, every Range chunk - so a verified header is remembered by its hash
// instead of re-running scrypt each time. Failures are slowed per IP.
function makeAuth(cfg){
    if(!cfg.password && !cfg.passwordHash) return null;
    let verify;
    if(cfg.passwordHash){
        const [, salt, hash] = cfg.passwordHash.split('$');
        const s = Buffer.from(salt, 'base64'), h = Buffer.from(hash, 'base64');
        verify = pw => new Promise(ok => scrypt(pw, s, h.length, (e, k) => ok(!e && same(k, h))));
    }else{
        const want = sha(cfg.password);
        verify = async pw => same(sha(pw), want);
    }
    const good = new Set(), fails = new Map();
    return async req => {
        const ip = req.socket.remoteAddress || '?';
        const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(req.headers.authorization || '');
        if(!m) return false;
        const key = sha(m[1]).toString('hex');
        if(good.has(key)) return true;
        const n = fails.get(ip) || 0;
        if(n) await new Promise(r => setTimeout(r, Math.min(n * 300, 3000)));
        const dec = Buffer.from(m[1], 'base64').toString('utf8'), i = dec.indexOf(':');
        // The username is ignored: one shared password, so there is nothing to get wrong on a phone.
        if(i >= 0 && await verify(dec.slice(i + 1))){
            fails.delete(ip);
            if(good.size >= 256) good.clear();
            good.add(key);
            return true;
        }
        if(fails.size >= 1024) fails.clear();
        fails.set(ip, n + 1);
        return false;
    };
}

// DNS rebinding: a hostile page points its own domain at this machine's LAN IP, and the browser then
// treats requests to it as same-origin. IP-literal and localhost Hosts can't be rebound, so everything
// else has to be a name the owner vouched for.
function makeHostCheck(cfg){
    const hn = osHostname().toLowerCase();
    const names = new Set(['localhost', hn, hn + '.local', ...cfg.allowedHosts]);
    return header => {
        let h = String(header || '').toLowerCase();
        h = h[0] === '[' ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '');
        return !!h && (isIP(h) !== 0 || names.has(h) || h.endsWith('.localhost'));
    };
}

// --------------------------------------------------------------------------------------- server

export function createApp(cfg){
    const auth = makeAuth(cfg), hostOK = makeHostCheck(cfg);
    const lib = cfg.dir ? createLibrary(cfg) : null;
    const handler = async (req, res) => {
        // COOP+COEP make the page crossOriginIsolated, which is what unlocks SharedArrayBuffer and so
        // multi-threaded WASM. That's a 2-4x win on the CPU fallback path and costs nothing here since
        // every asset is same-origin.
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        if(!hostOK(req.headers.host)) return send(res, 403, 'Forbidden: unrecognised Host header');
        if(auth && !await auth(req))
            return send(res, 401, 'Authentication required', 'text/plain; charset=utf-8',
                {'WWW-Authenticate': 'Basic realm="Guru Manager", charset="UTF-8"'});

        let p;
        try{ p = decodeURIComponent(new URL(req.url, 'http://x').pathname) }
        catch{ return send(res, 400, 'Bad request') }

        // /api/* and /lib/* belong to library mode. Without --dir the probe still answers, so the page can
        // tell "plain server" from "no server at all (file://)".
        if(lib){ if(await lib.handle(req, res, p, new URL(req.url, 'http://x'))) return }
        else if(p === '/api/config')
            return send(res, 200, JSON.stringify({library: false}), 'application/json; charset=utf-8', {'Cache-Control': 'no-store'});

        if(p === '/' || p === '') p = '/' + APP;
        if(!STATIC_FILES.has(p) && !p.startsWith(STATIC_PREFIX)) return send(res, 404, 'Not found: ' + p);
        // No dotfiles or NULs anywhere in the path, then confirm the resolved path stays under ROOT.
        if(p.includes('\0') || p.split('/').some(s => s.startsWith('.'))) return send(res, 403, 'Forbidden');
        const abs = normalize(join(ROOT, p));
        if(abs !== ROOT && !abs.startsWith(ROOT + sep)) return send(res, 403, 'Forbidden');

        let st;
        try{ st = statSync(abs) }catch{ return send(res, 404, 'Not found: ' + p) }
        if(st.isDirectory()) return send(res, 403, 'Forbidden');

        const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';

        // Weights and the ORT runtime are content-addressed by filename and never edited in place, so
        // they cache hard. Everything else must not: manifest.json is REGENERATED by fetch-models.mjs,
        // and serving a stale one is genuinely dangerous - freeDimensionOverrides read from an old
        // manifest build a wrong-shaped graph that fails obscurely (or worse, silently). Only the
        // immutable binary payloads get the long TTL.
        // Be precise about WHAT is immutable. Only third-party runtime bytes under /ai/ort/ and the
        // downloaded weights are content-fixed. Everything else under /ai/ is OUR source -
        // ai-worker.js, ai/src/*.js, manifest.json - and is edited constantly. A broad `/ai/*.js` rule
        // silently pins ai-worker.js for a year, so edits appear to do nothing and you debug ghosts.
        const immutable = p.startsWith('/ai/ort/') || /^\/ai\/models\/.+\.(onnx|bin)$/i.test(p);
        serveFile(req, res, abs, st, type, {'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store'});
    };
    const wrapped = (req, res) => handler(req, res).catch(e => {
        console.error('  request failed:', req.method, req.url, e && e.message);
        if(!res.headersSent) send(res, 500, 'Internal error'); else res.destroy();
    });
    const srv = cfg.tlsCert
        ? createHttps({cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey)}, wrapped)
        : createHttp(wrapped);
    srv.library = lib;
    return srv;
}

// ----------------------------------------------------------------------------------------- main

async function main(){
    let cfg;
    try{ cfg = loadConfig(process.argv.slice(2)) }
    catch(e){ console.error('\n  ' + e.message + '\n'); process.exit(1) }
    if(cfg.help){ console.log(HELP); return }
    if(cfg.hashPassword !== undefined){
        let pw = cfg.hashPassword;
        if(pw === true){ pw = ''; for await(const c of process.stdin) pw += c; pw = pw.replace(/\r?\n$/, '') }
        if(!pw){ console.error('\n  Empty password.\n'); process.exit(1) }
        console.log(await hashPassword(pw));
        return;
    }
    const err = validateConfig(cfg);
    if(err){ console.error('\n  ' + err + '\n'); process.exit(1) }

    const tls = !!cfg.tlsCert, scheme = tls ? 'https' : 'http';
    const app = createApp(cfg);
    // Replay the index before accepting connections, so a corrupt journal fails loudly at startup.
    if(app.library){
        try{ await app.library.ready }
        catch(e){ console.error(`\n  Cannot open the index in ${cfg.data}: ${e.message}\n`); process.exit(1) }
    }
    app
    .on('error', e => {
        if(e.code === 'EADDRINUSE'){
            console.error(`\n  Port ${cfg.port} is already in use.\n\n` +
                `  Not falling back to another port on purpose: the port is part of the origin, and a\n` +
                `  different origin means a fresh IndexedDB - your metadata cache and favorites would\n` +
                `  silently reset. Free ${cfg.port}, or set GURU_PORT and use that port from now on.\n`);
            process.exit(1);
        }
        throw e;
    })
    .listen(cfg.port, cfg.host, () => {
        const local = isLoopback(cfg.host);
        console.log(`\n  Guru Manager  ->  ${scheme}://${local ? cfg.host : 'localhost'}:${cfg.port}/\n`);
        console.log(`  Serving ${ROOT}`);
        if(app.library){
            const st = app.library.store;
            console.log(`  Library ${app.library.dir}`);
            console.log(`  Index   ${st.recs.size} records, ${cfg.data}${st.corrupt ? `  (${st.corrupt} unreadable line(s) skipped; a .bak was kept)` : ''}`);
        }
        if(cfg.configPath) console.log(`  Config  ${cfg.configPath}`);
        if(local){
            console.log(`  Bound to ${cfg.host} only - not reachable from the network.`);
        }else{
            const hosts = cfg.host === '0.0.0.0' || cfg.host === '::' ? lanAddresses() : [cfg.host];
            for(const h of hosts) console.log(`  LAN     ${scheme}://${h}:${cfg.port}/`);
        }
        if(cfg.password || cfg.passwordHash) console.log('  Password required (any username).');
        if(!local && !tls){
            console.log('\n  WARNING: plain HTTP. The password and every image cross the LAN in cleartext, and');
            console.log('  browsers will not run on-device AI search on a non-localhost http:// page.');
            console.log('  Use --tls-cert/--tls-key to fix both.');
        }
        console.log(`\n  Note: this is a different browser origin than file://, so the metadata cache and`);
        console.log(`  favorites start empty here. That is expected, not a bug.\n`);
    });
}

if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
