import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AssessmentStore } from "../src/assessment-store.js";
import { EvidenceAssessmentService } from "../src/evidence-service.js";
import { digest, makeUserEvidence } from "../src/evidence-package.js";

// These are deliberately adversarial in-memory adapters and disposable records.
// They test boundary enforcement; they are not real-connector success evidence.
const now = () => "2026-10-06T08:00:00.000Z";
const entity = { id: "revision-boundary-operation", name: "Revision boundary operation", kind: "user-declared-operation", status: "resolved" };
const month = { start: "2026-09-01", end: "2026-09-30" };
const owner = "Bearer boundary-test-owner";
const emptyAcquire = async () => ({ entity: { ...entity }, sources: [], observations: [], acquisition: [], warnings: [] });
const draft = { label: entity.name, periodStart: month.start, periodEnd: month.end, repaymentRatePct: 96, overdue30Pct: 2 };
const authorized = record => ({ authorization: owner, accessToken: record.assessmentAccessToken });

async function harness(t, acquire = emptyAcquire) {
  const root = await mkdtemp(join(tmpdir(), "fc-evidence-revision-adversarial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AssessmentStore(root);
  return { root, store, service: new EvidenceAssessmentService({ store, acquire, now }) };
}

function adapterPackage(value = 100) {
  const body = JSON.stringify({ revenue: value });
  const source = { id: "src-fixed-adapter-id", kind: "issuer_disclosure", title: "Boundary fixture", retrievedAt: now(), contentHash: digest(body), body, contentType: "application/json" };
  return { entity: { ...entity }, sources: [source], observations: [{ id: `obs-adapter-${value}`, sourceId: source.id, entityId: entity.id, metric: "revenue", value, unit: "USD", period: { kind: "duration", ...month }, scope: "entity-total", basis: "issuer-disclosed-IFRS", locator: "/revenue", origin: "public_adapter", validation: "valid" }], acquisition: [], warnings: [] };
}

test("a corrupted raw snapshot cannot retain a readable risk result or enter a continuation", async t => {
  const { root, store, service } = await harness(t);
  const initial = await service.create({ draft }, { authorization: owner });
  await writeFile(join(root, "snapshots", `${initial.sources[0].contentHash}.txt`), "corrupted raw ledger");
  await assert.rejects(service.read(initial.id, owner, initial.assessmentAccessToken), error => error.code === "SOURCE_INTEGRITY_FAILURE");
  await assert.rejects(service.continue(initial.id, { expectedRevision: 1, draft: { payingCustomers: 10 } }, authorized(initial)), error => error.code === "SOURCE_INTEGRITY_FAILURE");
  const stored = JSON.parse(await readFile(join(root, "records", `${initial.id}.json`), "utf8"));
  assert.equal(stored.revision, 1);
  await assert.rejects(store.source(stored, initial.sources[0].id), error => error.code === "SOURCE_INTEGRITY_FAILURE");
});

test("missing raw snapshots block recalculation instead of relying only on retained observation values", async t => {
  const { root, service } = await harness(t);
  const initial = await service.create({ draft }, { authorization: owner });
  await rm(join(root, "snapshots", `${initial.sources[0].contentHash}.txt`));
  await assert.rejects(service.continue(initial.id, { expectedRevision: 1, draft: { payingCustomers: 10 } }, authorized(initial)), error => error.code === "SOURCE_INTEGRITY_FAILURE");
});

test("an existing content-addressed file is checked before a new assessment can reuse it", async t => {
  const { root, store, service } = await harness(t);
  const acquired = makeUserEvidence(draft, { entityId: entity.id, now });
  await store.initialize();
  await writeFile(join(root, "snapshots", `${acquired.sources[0].contentHash}.txt`), "different bytes at a claimed hash");
  await assert.rejects(service.create({ draft }, { authorization: owner }), error => error.code === "SOURCE_INTEGRITY_FAILURE");
});

test("an adapter cannot replace raw evidence behind an existing source identity", async t => {
  let call = 0;
  const { service } = await harness(t, async () => adapterPackage(++call === 1 ? 100 : 900));
  const initial = await service.create({ target: entity.name }, { authorization: owner });
  await assert.rejects(service.continue(initial.id, { expectedRevision: 1 }, { ...authorized(initial), refresh: true }), error => error.code === "SOURCE_INTEGRITY_FAILURE");
  const retained = await service.read(initial.id, owner, initial.assessmentAccessToken);
  assert.equal(retained.revision, 1);
  assert.deepEqual(retained.observations.map(item => item.value), [100]);
});

test("an observation identity cannot silently hide a changed entity or value on refresh", async t => {
  let call = 0;
  const { service } = await harness(t, async () => {
    const acquired = adapterPackage(100);
    if (++call > 1) Object.assign(acquired.observations[0], { entityId: "another-legal-entity", value: 900 });
    return acquired;
  });
  const initial = await service.create({ target: entity.name }, { authorization: owner });
  await assert.rejects(service.continue(initial.id, { expectedRevision: 1 }, { ...authorized(initial), refresh: true }), error => error.code === "SOURCE_INTEGRITY_FAILURE");
  assert.equal((await service.read(initial.id, owner, initial.assessmentAccessToken)).revision, 1);
});

test("correcting back to original values creates a new receipt without reactivating a superseded receipt", async t => {
  const { service } = await harness(t);
  const initial = await service.create({ draft }, { authorization: owner });
  const updatedDraft = { ...draft, repaymentRatePct: 40 };
  const next = await service.continue(initial.id, { expectedRevision: 1, draft: updatedDraft, correctsSourceId: initial.sources[0].id, reason: "Changed receipt" }, authorized(initial));
  const activeSource = next.sources.find(source => !source.supersededBy);
  const correctedBack = await service.continue(initial.id, { expectedRevision: 2, draft, correctsSourceId: activeSource.id, reason: "Restore original declared values with a new receipt" }, authorized(initial));
  const latest = correctedBack.sources.find(source => !source.supersededBy);
  assert.notEqual(latest.id, initial.sources[0].id);
  assert.notEqual(latest.id, activeSource.id);
  assert.equal(correctedBack.sources.find(source => source.id === initial.sources[0].id).supersededBy, activeSource.id);
  assert.equal(correctedBack.sources.find(source => source.id === activeSource.id).supersededBy, latest.id);
  assert.equal((await service.read(initial.id, owner, initial.assessmentAccessToken)).revision, 3);
});

test("separate store instances sharing one runtime have one continuation winner and immutable revision history", async t => {
  const { root, service } = await harness(t);
  const other = new EvidenceAssessmentService({ store: new AssessmentStore(root), acquire: emptyAcquire, now });
  for (let attempt = 0; attempt < 4; attempt++) {
    const initial = await service.create({ draft: { ...draft, label: `${entity.name} ${attempt}` } }, { authorization: owner });
    const replies = await Promise.allSettled([
      service.continue(initial.id, { expectedRevision: 1, draft: { payingCustomers: 10 } }, authorized(initial)),
      other.continue(initial.id, { expectedRevision: 1, draft: { payingCustomers: 20 } }, authorized(initial))
    ]);
    assert.equal(replies.filter(reply => reply.status === "fulfilled").length, 1, JSON.stringify(replies.map(reply => reply.status === "rejected" ? reply.reason.code : "published")));
    assert.equal(replies.find(reply => reply.status === "rejected").reason.code, "REVISION_CONFLICT");
    const published = JSON.parse(await readFile(join(root, "records", `${initial.id}.json`), "utf8"));
    const historical = JSON.parse(await readFile(join(root, "records", `${initial.id}.r2.json`), "utf8"));
    assert.deepEqual(historical, published);
  }
});

test("source lookup is assessment-bound even when raw bytes are deduplicated", async t => {
  const { service } = await harness(t);
  const first = await service.create({ draft }, { authorization: "Bearer isolated-owner-a" });
  const second = await service.create({ draft: { ...draft, label: "Different operation receipt" } }, { authorization: "Bearer isolated-owner-b" });
  await assert.rejects(service.source(first.id, first.sources[0].id, "Bearer isolated-owner-b", first.assessmentAccessToken), error => error.status === 404);
  await assert.rejects(service.source(second.id, first.sources[0].id, "Bearer isolated-owner-b", second.assessmentAccessToken), error => error.status === 404);
  assert.equal((await service.source(first.id, first.sources[0].id, "Bearer isolated-owner-a", first.assessmentAccessToken)).content, JSON.stringify(draft));
});

test("repeating raw bytes through another ingestion route cannot rewrite the original source parent", async t => {
  const { service } = await harness(t);
  const first = await service.create({ draft }, { authorization: owner });
  const originalSource = first.sources[0];
  const second = await service.continue(first.id, { expectedRevision: 1, structuredText: JSON.stringify(draft) }, authorized(first));
  const retained = second.sources.find(source => source.id === originalSource.id);
  assert.equal(retained.parentSourceId, originalSource.parentSourceId);
  assert.equal(retained.extractionMethod, originalSource.extractionMethod);
  assert.equal(retained.retrievedAt, originalSource.retrievedAt);
  assert.equal(retained.contentHash, originalSource.contentHash);
});

function storedFixture(store, overrides = {}) {
  const acquired = makeUserEvidence(draft, { entityId: entity.id, now });
  return { id: store.newId(), revision: 1, entity: { ...entity }, profile: "ai-inference", operationPeriod: { ...month }, target: entity.name, updatedAt: now(), ...acquired, assessment: { deterministicRisk: { dimensionScores: { repayment: null } } }, ...overrides };
}

test("unsigned existing manifests require reassessment instead of automatic authority migration", async t => {
  const { root, store } = await harness(t);
  await store.initialize();
  const unsigned = storedFixture(store);
  await writeFile(join(root, "records", `${unsigned.id}.json`), JSON.stringify(unsigned));
  await assert.rejects(store.load(unsigned.id), error => error.code === "ASSESSMENT_REASSESSMENT_REQUIRED");
  await assert.rejects(store.save({ ...unsigned, revision: 2 }, 1), error => error.code === "ASSESSMENT_REASSESSMENT_REQUIRED");
});

test("signed manifests bind raw receipts, observation values, scope and cached calculations", async t => {
  const { root, store } = await harness(t);
  const mutations = [
    record => { record.sources[0].kind = "public_api"; },
    record => { record.observations.find(observation => observation.metric === "repaymentRatePct").value = 100; },
    record => { record.entity.id = "different-entity"; },
    record => { record.operationPeriod.end = "2026-10-31"; },
    record => { record.assessment.deterministicRisk.dimensionScores.repayment = 100; }
  ];
  for (const mutate of mutations) {
    const initial = await store.save(storedFixture(store), 0);
    const modified = structuredClone(initial);
    mutate(modified);
    // Changing both current and historical files cannot manufacture the HMAC.
    for (const filename of [`${initial.id}.json`, `${initial.id}.r1.json`]) await writeFile(join(root, "records", filename), JSON.stringify(modified));
    await assert.rejects(store.load(initial.id), error => error.code === "ASSESSMENT_INTEGRITY_FAILURE");
  }
});

test("the current signed manifest must exactly match its immutable published revision", async t => {
  const { root, store } = await harness(t);
  const initial = await store.save(storedFixture(store), 0);
  await writeFile(join(root, "records", `${initial.id}.r1.json`), "modified historical manifest");
  await assert.rejects(store.load(initial.id), error => error.code === "ASSESSMENT_INTEGRITY_FAILURE");
});

test("a runtime integrity key is 32 bytes and 0600, and unsafe permissions fail closed", async t => {
  const { root, store } = await harness(t);
  const initial = await store.save(storedFixture(store), 0);
  const keyPath = join(root, "integrity.key");
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(keyPath)).byteLength, 32);
  await chmod(keyPath, 0o644);
  await assert.rejects(store.load(initial.id), error => error.code === "ASSESSMENT_INTEGRITY_FAILURE");
});

test("direct save preserves CAS and source/observation immutability across store instances", async t => {
  const { root, store } = await harness(t);
  const initial = await store.save(storedFixture(store), 0);
  const other = new AssessmentStore(root);
  const next = { ...initial, revision: 2 };
  const replies = await Promise.allSettled([store.save(next, 1), other.save(next, 1)]);
  assert.equal(replies.filter(reply => reply.status === "fulfilled").length, 1);
  assert.equal(replies.find(reply => reply.status === "rejected").reason.code, "REVISION_CONFLICT");
  const current = await store.load(initial.id);
  const tampered = structuredClone(current);
  tampered.revision = 3;
  tampered.observations[0].value = "different raw meaning";
  await assert.rejects(store.save(tampered, 2), error => error.code === "SOURCE_INTEGRITY_FAILURE");
  assert.equal((await store.load(initial.id)).revision, 2);
});

test("direct save cannot replace the original assessment capability hash", async t => {
  const { store } = await harness(t);
  const initial = await store.save(storedFixture(store, { accessTokenHash: digest("original assessment capability fixture") }), 0);
  await assert.rejects(store.save({ ...initial, revision: 2, accessTokenHash: digest("replacement capability fixture") }, 1), error => error.code === "SOURCE_INTEGRITY_FAILURE");
  assert.equal((await store.load(initial.id)).accessTokenHash, initial.accessTokenHash);
});

test("concurrent assessments publish complete shared blobs and one complete runtime integrity key", async t => {
  const { root } = await harness(t);
  const instances = Array.from({ length: 8 }, () => new AssessmentStore(root));
  const published = await Promise.all(instances.map(store => store.save(storedFixture(store), 0)));
  for (const record of published) assert.equal((await instances[0].load(record.id)).revision, 1);
  assert.equal((await readFile(join(root, "integrity.key"))).byteLength, 32);
});

test("duplicate source and observation identities cannot be signed into an initial manifest", async t => {
  const { store } = await harness(t);
  const duplicateSource = storedFixture(store);
  duplicateSource.sources.push({ ...duplicateSource.sources[0], kind: "public_api" });
  await assert.rejects(store.save(duplicateSource, 0), error => error.code === "SOURCE_INTEGRITY_FAILURE");
  const duplicateObservation = storedFixture(store);
  duplicateObservation.observations.push({ ...duplicateObservation.observations[0], value: 100 });
  await assert.rejects(store.save(duplicateObservation, 0), error => error.code === "SOURCE_INTEGRITY_FAILURE");
});

test("actual supersession cycles remain rejected even through direct store publication", async t => {
  const { store } = await harness(t);
  const record = storedFixture(store);
  const second = makeUserEvidence({ ...draft, repaymentRatePct: 40 }, { entityId: entity.id, now });
  record.sources[0].supersededBy = second.sources[0].id;
  record.sources[0].correctionReason = "Explicit replacement";
  record.sources.push(...second.sources);
  record.observations.push(...second.observations);
  const published = await store.save(record, 0);
  const cyclic = structuredClone(published);
  cyclic.revision = 2;
  cyclic.sources[1].supersededBy = cyclic.sources[0].id;
  cyclic.sources[1].correctionReason = "Attempt to reactivate superseded receipt";
  await assert.rejects(store.save(cyclic, 1), error => error.code === "SOURCE_INTEGRITY_FAILURE");
  assert.equal((await store.load(published.id)).revision, 1);
});

test("manifest authorization runs before raw-source integrity checks", async t => {
  const { root, store } = await harness(t);
  const published = await store.save(storedFixture(store), 0);
  await writeFile(join(root, "snapshots", `${published.sources[0].contentHash}.txt`), "corrupted private record");
  const deny = () => { throw Object.assign(new Error("Assessment not found."), { code: "ASSESSMENT_NOT_FOUND", status: 404 }); };
  await assert.rejects(store.load(published.id, { authorize: deny }), error => error.code === "ASSESSMENT_NOT_FOUND" && error.status === 404);
  await assert.rejects(store.load(published.id, { authorize: () => {} }), error => error.code === "SOURCE_INTEGRITY_FAILURE");
});

test("an interrupted cross-process lock is not expired or removed by another store", async t => {
  const { root, store } = await harness(t);
  const initial = await store.save(storedFixture(store), 0);
  const lockPath = join(root, "locks", initial.id);
  await mkdir(lockPath);
  const ownerReceipt = JSON.stringify({ processId: "stopped-or-active-unknown", token: "operator-must-verify" });
  await writeFile(join(lockPath, "owner.json"), ownerReceipt);
  await assert.rejects(store.save({ ...initial, revision: 2 }, 1), error => error.code === "ASSESSMENT_LOCKED");
  assert.equal(await readFile(join(lockPath, "owner.json"), "utf8"), ownerReceipt);
  assert.equal((await store.load(initial.id)).revision, 1);
});

test("a real second process cannot publish while the first process holds the assessment lock", async t => {
  const { root, store } = await harness(t);
  const initial = await store.save(storedFixture(store), 0);
  const script = `import { AssessmentStore } from ${JSON.stringify(new URL("../src/assessment-store.js", import.meta.url).href)};
const store = new AssessmentStore(process.argv[1]);
await store.exclusive(process.argv[2], async () => {
  process.stdout.write("locked\\n");
  await new Promise(resolve => process.stdin.once("data", resolve));
});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, initial.id], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => { throw new Error("Lock subprocess exited before acquiring its lock."); })
  ]);
  await assert.rejects(store.save({ ...initial, revision: 2 }, 1), error => error.code === "ASSESSMENT_LOCKED");
  child.stdin.end("release");
  await once(child, "exit");
  const published = await store.save({ ...initial, revision: 2 }, 1);
  assert.equal(published.revision, 2);
});

test("a shared service bearer alone, or another assessment's token, cannot read or continue a private package", async t => {
  const { root, service } = await harness(t);
  const first = await service.create({ draft }, { authorization: owner });
  const second = await service.create({ draft: { ...draft, label: "Second bearer-shared receipt" } }, { authorization: owner });
  assert.equal(typeof first.assessmentAccessToken, "string");
  assert.notEqual(first.assessmentAccessToken, second.assessmentAccessToken);
  await assert.rejects(service.read(first.id, owner), error => error.status === 404);
  await assert.rejects(service.read(first.id, owner, second.assessmentAccessToken), error => error.status === 404);
  await assert.rejects(service.continue(first.id, { expectedRevision: 1, draft: { payingCustomers: 10 } }, authorized(second)), error => error.status === 404);
  await assert.rejects(service.source(first.id, first.sources[0].id, owner, second.assessmentAccessToken), error => error.status === 404);
  const readable = await service.read(first.id, owner, first.assessmentAccessToken);
  assert.equal(Object.hasOwn(readable, "assessmentAccessToken"), false);
  assert.equal(Object.hasOwn(readable, "assessmentAccessTokenHash"), false);
  assert.equal(Object.hasOwn(readable, "accessTokenHash"), false);
  assert.equal((await readFile(join(root, "records", `${first.id}.json`), "utf8")).includes(first.assessmentAccessToken), false);
});
