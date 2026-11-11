import {test} from 'node:test';
import assert from 'node:assert/strict';
import {certNames, sanString, parseArgs} from './make-cert.mjs';

const ifaces = {
    Ethernet: [{family: 'IPv4', address: '10.0.0.200', internal: false}, {family: 'IPv6', address: 'fe80::1', internal: false}],
    Loop: [{family: 'IPv4', address: '127.0.0.1', internal: true}],
    Auto: [{family: 4, address: '169.254.9.9', internal: false}],
};

test('names: hostname, loopback and LAN IPv4 only, deduped, lowercased', () => {
    const n = certNames({hostname: 'GPU-Box', interfaces: ifaces, extra: ['gpu-box', 'GPU.lan']});
    assert.deepEqual(n, ['gpu-box', 'localhost', '127.0.0.1', '::1', '10.0.0.200', 'gpu.lan']);
});

test('names: an invalid extra host throws, an odd OS hostname is skipped', () => {
    assert.throws(() => certNames({hostname: 'x', interfaces: {}, extra: ['bad host!']}), /Not a valid/);
    assert.ok(!certNames({hostname: 'bad_host', interfaces: {}}).includes('bad_host'));
});

test('sanString tags IPs and DNS names', () => {
    assert.equal(sanString(['gpu-box', '127.0.0.1', '::1']), 'DNS:gpu-box,IP:127.0.0.1,IP:::1');
});

test('parseArgs', () => {
    const o = parseArgs(['--host', 'a', '--host', 'b', '--force', '--days', '30']);
    assert.deepEqual([o.host, o.force, o.days], [['a', 'b'], true, 30]);
    assert.throws(() => parseArgs(['--days', '0']), /positive/);
    assert.throws(() => parseArgs(['--nope']), /Unknown/);
    assert.throws(() => parseArgs(['--out']), /needs a value/);
});
