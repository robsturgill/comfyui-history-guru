// Makes the TLS certificate + key that serve.mjs needs for https.
//
//   node make-cert.mjs                    certs/guru.crt + certs/guru.key for this machine
//   node make-cert.mjs --host gpu.lan     add a name or IP the browser will use (repeatable)
//   node make-cert.mjs --force            replace an existing pair
//   node make-cert.mjs --help
//
// Uses mkcert when it is installed (its CA is trusted by this machine's browsers, so no warning here),
// else openssl (self-signed: every device shows a warning until you trust certs/guru.crt).
// Node cannot write an X.509 certificate with its stdlib alone, so one of those two must exist.
//
// The certificate lists every name a client may type: this machine's hostname, localhost, loopback, each
// LAN IP, and `allowedHosts` from guru.config.json. A name missing from the list is a browser error,
// so re-run with --force after the LAN address changes.

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, chmodSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {hostname as osHostname, networkInterfaces} from 'node:os';
import {isIP} from 'node:net';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');

const HELP = `Usage: node make-cert.mjs [options]

  --out <dir>      output directory (default: certs/ next to this script)
  --host <name>    extra DNS name or IP to put in the certificate; repeatable
  --days <n>       openssl validity in days (default 825; mkcert picks its own)
  --openssl        use openssl even if mkcert is installed
  --force          overwrite an existing guru.crt / guru.key
  --help           this text
`;

// Names the certificate must cover, deduped, lowercase, DNS or IP. Pure so it can be tested.
export function certNames({hostname, interfaces, extra = []}){
    const out = [], seen = new Set();
    const add = (n, strict) => {
        n = String(n || '').trim().toLowerCase();
        if(!n || seen.has(n)) return;
        if(!isIP(n) && !/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(n)){
            if(strict) throw new Error(`Not a valid DNS name or IP address: ${n}`);
            return;
        }
        seen.add(n); out.push(n);
    };
    add(hostname); add('localhost'); add('127.0.0.1'); add('::1');
    for(const list of Object.values(interfaces || {})) for(const a of list || []){
        // `family` is the number 4 on some Node 18 builds and the string 'IPv4' elsewhere.
        const v4 = a.family === 'IPv4' || a.family === 4;
        if(v4 && !a.internal && !a.address.startsWith('169.254.')) add(a.address);
    }
    for(const n of extra) add(n, true);
    return out;
}

export function sanString(names){
    return names.map(n => (isIP(n) ? 'IP:' : 'DNS:') + n).join(',');
}

export function parseArgs(argv){
    const o = {out: join(ROOT, 'certs'), host: [], days: 825, force: false, openssl: false, help: false};
    for(let i = 0; i < argv.length; i++){
        const a = argv[i], val = () => {
            if(i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        if(a === '--out') o.out = resolve(val());
        else if(a === '--host') o.host.push(val());
        else if(a === '--days'){
            o.days = +val();
            if(!Number.isInteger(o.days) || o.days < 1) throw new Error('--days must be a positive integer');
        }
        else if(a === '--force') o.force = true;
        else if(a === '--openssl') o.openssl = true;
        else if(a === '--help' || a === '-h') o.help = true;
        else throw new Error(`Unknown option: ${a}`);
    }
    return o;
}

const ok = (cmd, args) => { const r = spawnSync(cmd, args, {encoding: 'utf8'}); return !r.error && r.status === 0 ? r : null };

// On Windows openssl is usually only inside Git for Windows, which does not put it on PATH.
function findOpenssl(){
    const c = ['openssl'];
    if(process.platform === 'win32') for(const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')])
        if(base) c.push(join(base, 'Git', 'mingw64', 'bin', 'openssl.exe'), join(base, 'Git', 'usr', 'bin', 'openssl.exe'));
    return c.find(p => (p === 'openssl' || existsSync(p)) && ok(p, ['version'])) || null;
}

function configAllowedHosts(){
    try{
        const f = JSON.parse(readFileSync(join(ROOT, 'guru.config.json'), 'utf8'));
        return {hosts: Array.isArray(f.allowedHosts) ? f.allowedHosts : [], hasTls: !!(f.tls && f.tls.cert && f.tls.key)};
    }catch{ return {hosts: [], hasTls: false} }
}

export function main(argv = process.argv.slice(2)){
    let o;
    try{ o = parseArgs(argv) }catch(e){ console.error(e.message + '\n\n' + HELP); return 2 }
    if(o.help){ console.log(HELP); return 0 }

    const cfg = configAllowedHosts();
    let names;
    try{ names = certNames({hostname: osHostname(), interfaces: networkInterfaces(), extra: [...cfg.hosts, ...o.host]}) }
    catch(e){ console.error(e.message); return 2 }

    const crt = join(o.out, 'guru.crt'), key = join(o.out, 'guru.key');
    if(!o.force && (existsSync(crt) || existsSync(key))){
        console.error(`Already exists: ${existsSync(crt) ? crt : key}\nRe-run with --force to replace it.`);
        return 1;
    }
    mkdirSync(o.out, {recursive: true});

    const mkcert = o.openssl ? null : ok('mkcert', ['-CAROOT']);
    let how;
    if(mkcert){
        const r = spawnSync('mkcert', ['-cert-file', crt, '-key-file', key, ...names], {stdio: 'inherit'});
        if(r.status !== 0){ console.error('mkcert failed.'); return 1 }
        const root = join(mkcert.stdout.trim(), 'rootCA.pem');
        how = existsSync(root)
            ? `Signed by your mkcert CA. This machine trusts it only after \`mkcert -install\` has run once.\n` +
              `Other devices (phone, laptop) must trust this CA file once, then there is no warning:\n  ${root}`
            : 'mkcert has no CA yet. Run `mkcert -install` once, then re-run this with --force.';
    }else{
        const openssl = findOpenssl();
        if(!openssl){
            console.error('Neither mkcert nor openssl was found.\n' +
                '  Easiest: install mkcert (winget install FiloSottile.mkcert  |  brew install mkcert), then re-run.\n' +
                '  Or install openssl (it ships with Git for Windows).');
            return 1;
        }
        const cn = names.find(n => !isIP(n)) || 'localhost';
        const r = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(o.days),
            '-keyout', key, '-out', crt, '-subj', '/CN=' + cn, '-addext', 'subjectAltName=' + sanString(names)],
            {encoding: 'utf8'});
        if(r.error || r.status !== 0){ console.error(`openssl failed:\n${(r.stderr || (r.error && r.error.message) || '').trim()}`); return 1 }
        how = `Self-signed, so every browser warns until you trust ${crt} on that device.\n` +
              'For a warning-free setup install mkcert and re-run with --force.';
    }
    try{ chmodSync(key, 0o600) }catch{}

    console.log(`\nWrote ${crt}\n      ${key}   (private; never share or commit it)`);
    console.log(`Valid for: ${names.join(', ')}`);
    console.log('\n' + how);
    if(!cfg.hasTls) console.log('\nAdd to guru.config.json:\n  "tls": {"cert": "certs/guru.crt", "key": "certs/guru.key"}');
    console.log('\nA client must use one of the names above. If the LAN IP changes, re-run with --force.');
    return 0;
}

if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
