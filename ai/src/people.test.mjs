// Manual person layer — pA/pR, hand-made people, and the one thing that actually breaks:
// aiCluster() overwrites every faces[].c and REPLACES aiMeta.clusters, so any manual work stored in
// clusterer-owned state is erased on the next Analyze run. Test 3 is the whole point of this file;
// a test that only checks "bulk edit sets the tag" passes while that bug is fully present.
//
//   node serve.mjs &   then   node --test ai/src/people.test.mjs
//
// Runs the REAL page through Playwright, because the functions under test read module-level globals
// (cache, fReg, aiMeta, AIC) that cannot be imported. Seeds fReg alongside cache — aiClusterMembers
// filters on fReg.has(p), so a cache-only item is invisible and every assertion would pass vacuously.
import {test, before, after, describe} from 'node:test';
import assert from 'node:assert';
import {chromium} from 'playwright';

const URL_ = process.env.GURU_URL || 'http://127.0.0.1:8787/';
let browser, page;

// Stub db so seeded mock paths never reach the real IndexedDB, exactly as CLAUDE.md prescribes.
const SEED = `
db = {transaction:()=>({objectStore:()=>({put(){},delete(){}}), set oncomplete(f){setTimeout(f,0)}})};
const mk = (p, faces, pA, pR) => {
    const v = {p, n:p.split('/').pop(), d:1000, m:null, faces};
    if (pA) v.pA = pA;
    if (pR) v.pR = pR;
    cache.set(p, v);
    fReg.set(p, {name:v.n, getFile:async()=>new File([new Uint8Array(4)], v.n)});
    return v;
};
`;

before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    const res = await page.goto(URL_);
    assert.ok(res && res.ok(), `serve.mjs not reachable at ${URL_} — start it first`);
    await page.waitForFunction(() => typeof window.peopleOf === 'function');
});
after(async () => { if (browser) await browser.close(); });

// Fresh state per test: the globals are module-level and persist across evaluate() calls.
const run = fn => page.evaluate(`(async () => {
    cache.clear(); fReg.clear();
    aiMeta = {p:'__ai__', clusters:[], nextM:1000000};
    AIC = new Map();
    ${SEED}
    return await (${fn})();
})()`);

describe('peopleOf', () => {
    test('detected, added, suppressed and their combinations', async () => {
        const r = await run(`() => {
            const f = c => [{box:[0,0,10,10], score:1, c}];
            return {
                none:      peopleOf(mk('a.png', [])),
                detected:  peopleOf(mk('b.png', f(3))),
                noise:     peopleOf(mk('c.png', f(-1))),
                addedOnly: peopleOf(mk('d.png', [], [7])),
                both:      peopleOf(mk('e.png', f(3), [7])),
                suppressed:peopleOf(mk('f.png', f(3), null, [3])),
                addThenSup:peopleOf(mk('g.png', [], [7], [7])),
                noRecord:  peopleOf(undefined)
            };
        }`);
        assert.deepStrictEqual(r.none, []);
        assert.deepStrictEqual(r.detected, [3]);
        assert.deepStrictEqual(r.noise, [], 'c<0 is the noise bucket, not a person');
        assert.deepStrictEqual(r.addedOnly, [7]);
        assert.deepStrictEqual(r.both, [3, 7]);
        assert.deepStrictEqual(r.suppressed, [], 'pR must win over a detection');
        assert.deepStrictEqual(r.addThenSup, []);
        assert.deepStrictEqual(r.noRecord, []);
    });
});

describe('applyPersonEdit', () => {
    test('removing a DETECTED person suppresses it instead of mutating faces[].c', async () => {
        const r = await run(`() => {
            const v = mk('a.png', [{box:[0,0,1,1], score:1, c:3}]);
            const changed = applyPersonEdit(v, 3, 'rm');
            return {changed, pR:v.pR, pA:v.pA, faceC:v.faces[0].c, eff:peopleOf(v)};
        }`);
        assert.strictEqual(r.changed, true);
        assert.deepStrictEqual(r.pR, [3]);
        assert.strictEqual(r.faceC, 3, 'faces[].c must be untouched — aiCluster() owns it');
        assert.deepStrictEqual(r.eff, []);
    });

    test('removing an ADDED person splices pA and writes no suppression', async () => {
        const r = await run(`() => {
            const v = mk('a.png', [], [7]);
            applyPersonEdit(v, 7, 'rm');
            return {pA:v.pA, pR:v.pR, eff:peopleOf(v)};
        }`);
        assert.strictEqual(r.pA, undefined, 'empty arrays are deleted, not stored');
        assert.strictEqual(r.pR, undefined, 'nothing detected, so nothing to suppress');
        assert.deepStrictEqual(r.eff, []);
    });

    test('adding clears an existing suppression', async () => {
        const r = await run(`() => {
            const v = mk('a.png', [{box:[0,0,1,1], score:1, c:3}], null, [3]);
            applyPersonEdit(v, 3, 'add');
            return {pR:v.pR, pA:v.pA, eff:peopleOf(v)};
        }`);
        assert.strictEqual(r.pR, undefined);
        assert.strictEqual(r.pA, undefined, 'already detected — no pA entry needed');
        assert.deepStrictEqual(r.eff, [3]);
    });

    test('"set" replaces everything, and does not suppress the id it is setting', async () => {
        const r = await run(`() => {
            const v = mk('a.png', [{box:[0,0,1,1], score:1, c:3}], [7]);
            applyPersonEdit(v, 3, 'set');
            return {eff:peopleOf(v), pR:v.pR};
        }`);
        assert.deepStrictEqual(r.eff, [3], 'remove-all must run before the add, or 3 suppresses itself');
        assert.strictEqual((r.pR || []).includes(3), false);
    });

    test('a no-op edit reports false so the toast can count real writes', async () => {
        const r = await run(`() => {
            const v = mk('a.png', [{box:[0,0,1,1], score:1, c:3}]);
            return applyPersonEdit(v, 3, 'add');
        }`);
        assert.strictEqual(r, false);
    });
});

describe('survives re-analysis', () => {
    // THE TRAP. aiCluster() rewrites faces[].c for every face the worker assigned and rebuilds
    // aiMeta.clusters from the worker's response. The stub's `assign` array must cover every seeded
    // face, or the byKey loop no-ops and this passes for the wrong reason.
    test('manual tags and a hand-made person both outlive a cluster rebuild', async () => {
        const r = await run(`async () => {
            // Two embedded faces minimum — aiCluster() early-returns on vecs.length<2 and the
            // reassignment below would never run.
            const v1 = mk('a.png', [{box:[0,0,1,1], score:1, c:3, emb:new Int8Array(512), embS:0.1}]);
            const v2 = mk('b.png', [], [1000000]);          // hand-tagged only, no detection
            const v3 = mk('c.png', [{box:[0,0,1,1], score:1, c:3, emb:new Int8Array(512), embS:0.1}]);
            aiMeta.clusters = [
                {id:3, name:'Detected Rob', n:2},
                {id:1000000, name:'Hand-made Ann', manual:true, hidden:false}
            ];
            AIC = new Map(aiMeta.clusters.map(c => [c.id, c.name]));
            applyPersonEdit(v1, 1000000, 'add');           // hand-tag on a detected image too

            // Stand in for the worker: reassign both real faces to a brand-new cluster id, and
            // return a cluster table that knows nothing about the manual person.
            const realSend = window.aiSend;
            window.aiSend = async () => ({assign:[9,9], clusters:[{id:9, n:2, cent:new Int8Array(512), centS:0.1}]});
            try { await aiCluster(); } finally { window.aiSend = realSend; }

            return {
                ids: aiMeta.clusters.map(c => c.id).sort((a,b)=>a-b),
                manualStillThere: aiMeta.clusters.some(c => c.id === 1000000 && c.manual),
                manualName: AIC.get(1000000) || (aiMeta.clusters.find(c=>c.id===1000000)||{}).name,
                reassigned: v1.faces[0].c,
                v1People: peopleOf(v1),
                v2People: peopleOf(v2)
            };
        }`);
        assert.strictEqual(r.reassigned, 9, 'stub did not reach the byKey loop — test would be vacuous');
        assert.deepStrictEqual(r.ids, [9, 1000000]);
        assert.strictEqual(r.manualStillThere, true, 'hand-made person deleted by the cluster rebuild');
        assert.strictEqual(r.manualName, 'Hand-made Ann');
        assert.deepStrictEqual(r.v1People, [9, 1000000], 'hand tag lost from a re-clustered image');
        assert.deepStrictEqual(r.v2People, [1000000], 'hand tag lost from an image with no detections');
    });
});

describe('search and People view see the manual layer', () => {
    test('face:person-N matches an image tagged purely by hand', async () => {
        const r = await run(`() => {
            const v = mk('a.png', [], [1000000]);
            return searchFields('a.png', v).face;
        }`);
        assert.match(r, /person-1000000/, 'searchFields.face missed pA — "Show all" would return nothing');
    });

    test('a suppressed person no longer matches, though the detection is still on disk', async () => {
        const r = await run(`() => {
            const v = mk('a.png', [{box:[0,0,1,1], score:1, c:3}], null, [3]);
            return searchFields('a.png', v).face;
        }`);
        assert.doesNotMatch(r, /person-3/);
    });

    test('aiClusterMembers reports hand-tagged images with i:-1 so aiDrawCrop bails', async () => {
        const r = await run(`() => {
            mk('a.png', [], [1000000]);
            mk('b.png', [{box:[0,0,1,1], score:1, c:3}]);
            const m = aiClusterMembers();
            return {manual:m.get(1000000), detected:m.get(3)};
        }`);
        assert.strictEqual(r.manual.length, 1);
        assert.strictEqual(r.manual[0].i, -1, 'no detection box exists — a canvas crop would be broken');
        assert.strictEqual(r.detected[0].i, 0);
    });

    test('a cache entry missing from fReg is ignored (the aiBuildMat trap, same shape)', async () => {
        const r = await run(`() => {
            const v = mk('a.png', [], [1000000]);
            fReg.delete('a.png');
            return aiClusterMembers().has(1000000);
        }`);
        assert.strictEqual(r, false);
    });
});

// Removing someone from every photo they appear in must not strand them. Both of these were found
// by driving the real UI, not by reading the code.
describe('a person at zero photos is still reachable', () => {
    test('a NAMED cluster keeps its card, so rename and Merge survive', async () => {
        const r = await run(`() => {
            mk('a.png', [{box:[0,0,1,1], score:1, c:3}], null, [3]);   // suppressed everywhere
            mk('b.png', [{box:[0,0,1,1], score:1, c:5}]);
            mk('c.png', [{box:[0,0,1,1], score:1, c:9}]);
            aiMeta.clusters = [{id:3, name:'Rob'}, {id:5, name:'Sam'}, {id:9, name:''}];
            AIC = new Map([[3,'Rob'], [5,'Sam'], [9,'']]);
            cache.delete('c.png'); fReg.delete('c.png');               // unnamed, files gone
            setView('faces'); rend();
            return [...document.querySelectorAll('.face-card')].map(c => c.id);
        }`);
        assert.ok(r.includes('fc-3'), 'a named person removed from every photo lost their only card');
        assert.ok(r.includes('fc-5'));
        assert.strictEqual(r.includes('fc-9'), false, 'an unnamed cluster with no files left is dropped');
    });

    test('the merge target list matches what the picker offers', async () => {
        const r = await run(`() => {
            mk('a.png', [{box:[0,0,1,1], score:1, c:3}], null, [3]);
            mk('b.png', [{box:[0,0,1,1], score:1, c:5}]);
            aiMeta.clusters = [{id:3, name:'Rob'}, {id:5, name:'Sam'}];
            AIC = new Map([[3,'Rob'], [5,'Sam']]);
            aiPickPerson({title:'x', exclude:[5]});
            const offered = [...document.getElementById('personSel').options]
                .map(o => parseInt(o.value, 10)).filter(n => !isNaN(n));
            aiPickClose(null);
            return offered;
        }`);
        // aiMergePrompt's guard uses the same !hidden filter, so anything offered is accepted.
        assert.deepStrictEqual(r, [3], 'picker offered a target aiMergePrompt would reject');
    });

    test('a hand-made id is allocated above every existing cluster id', async () => {
        const r = await run(`async () => {
            aiMeta.clusters = [{id: 1000005, name:'Old'}];
            aiMeta.nextM = 1000000;
            return await aiNewPerson('New');
        }`);
        assert.strictEqual(r, 1000006, 'nextM alone would have collided with an existing id');
    });
});

describe('export / import round trip', () => {
    test('pA, pR, manual clusters and nextM all survive', async () => {
        const r = await run(`async () => {
            mk('a.png', [], [1000000]);
            mk('b.png', [{box:[0,0,1,1], score:1, c:3}], null, [3]);
            cache.get('b.png').ai = AIV;
            aiMeta.clusters = [{id:3, name:'Rob', n:1}, {id:1000000, name:'Ann', manual:true}];
            aiMeta.nextM = 1000001;
            AIC = new Map(aiMeta.clusters.map(c => [c.id, c.name]));

            const ex = aiBuildExport();
            const j = JSON.parse(ex.json);
            const plan = aiImportPlan(ex.json);
            await aiImportApply(plan, {includeChanged:true});
            return {
                exportedA: j.items.find(i => i.p === 'a.png'),
                exportedManual: j.clusters.find(c => c.id === 1000000),
                nextM: j.nextM,
                pA: cache.get('a.png').pA,
                pR: cache.get('b.png').pR,
                clusterIds: aiMeta.clusters.map(c => c.id).sort((a,b)=>a-b)
            };
        }`);
        assert.ok(r.exportedA, 'an item tagged by hand but never analyzed was dropped from the export');
        assert.deepStrictEqual(r.exportedA.pA, [1000000]);
        assert.strictEqual(r.exportedManual.manual, true);
        assert.strictEqual(r.nextM, 1000001);
        assert.deepStrictEqual(r.pA, [1000000]);
        assert.deepStrictEqual(r.pR, [3]);
        assert.deepStrictEqual(r.clusterIds, [3, 1000000]);
    });

    test('a v1 export still imports — bumping PORTV must not orphan the user own files', async () => {
        const r = await run(`() => {
            mk('a.png', [{box:[0,0,1,1], score:1, c:3}]);
            cache.get('a.png').ai = AIV;
            aiMeta.clusters = [{id:3, name:'Rob', n:1}];
            const j = JSON.parse(aiBuildExport().json);
            j.guruAI = 1; delete j.nextM;
            j.items.forEach(i => { delete i.pA; delete i.pR; });
            j.clusters.forEach(c => delete c.manual);
            return aiImportPlan(JSON.stringify(j)).total;      // throws if the check is an equality test
        }`);
        assert.strictEqual(r, 1);
    });

    test('a manual tag the import does not define is dropped and counted', async () => {
        const r = await run(`async () => {
            mk('a.png', [{box:[0,0,1,1], score:1, c:3}]);
            cache.get('a.png').ai = AIV;
            aiMeta.clusters = [{id:3, name:'Rob', n:1}];
            const txt = aiBuildExport().json;
            // A second image carrying a tag for a person the export knows nothing about.
            mk('z.png', [], [1000000]);
            const res = await aiImportApply(aiImportPlan(txt), {includeChanged:true});
            return {dropped:res.dropped, pA:cache.get('z.png').pA};
        }`);
        assert.strictEqual(r.dropped, 1);
        assert.strictEqual(r.pA, undefined, 'a stale id would silently point at a stranger');
    });
});

describe('view memory', () => {
    test('libView tracks the last library view and every excursion returns to it', async () => {
        const r = await page.evaluate(() => {
            setView('grid');
            const afterGrid = libView;
            setView('stats');       // excursion: must not overwrite libView
            const duringStats = libView;
            toggleStats();
            const backFrom = vMode;
            setView('faces');
            backToLibrary();
            return {afterGrid, duringStats, backFrom, backFromFaces:vMode,
                    stored:localStorage.getItem('guru-view')};
        });
        assert.strictEqual(r.afterGrid, 'grid');
        assert.strictEqual(r.duringStats, 'grid', 'stats is an excursion, not a library view');
        assert.strictEqual(r.backFrom, 'grid');
        assert.strictEqual(r.backFromFaces, 'grid');
        assert.strictEqual(r.stored, 'grid');
    });
});
