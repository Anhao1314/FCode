import { mkdir, readFile, writeFile, rename, unlink, rmdir, lstat, link } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { digest, packageError, stable } from "./evidence-package.js";

const assessmentId = id => typeof id === "string" && /^ea-[a-f0-9]{64}$/.test(id);
const sourceId = id => typeof id === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(id);
const hexDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const transactions = new AsyncLocalStorage();
const queues = new Map();
const integrityFailure = message => packageError(message, "SOURCE_INTEGRITY_FAILURE", 500);
const manifestFailure = message => packageError(message, "ASSESSMENT_INTEGRITY_FAILURE", 500);
const withoutBody = source => { const { body, ...receipt } = source; return receipt; };
const unsigned = record => { const { storageIntegrity, ...payload } = record; return payload; };

async function publishImmutable(path, content) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    // Publishing a fully written hard link avoids EEXIST readers seeing a
    // partially written key/blob from another assessment or process.
    try { await link(temporary, path); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

function validateRecord(record, expectedId) {
  if (!record || record.id !== expectedId || !assessmentId(record.id) || !Number.isInteger(record.revision) || record.revision < 1 || !record.entity?.id || !Array.isArray(record.sources) || !Array.isArray(record.observations)) throw manifestFailure("The stored assessment identity or evidence manifest is invalid.");
  const sources = new Map();
  for (const source of record.sources) {
    if (!sourceId(source.id) || !hexDigest(source.contentHash) || sources.has(source.id)) throw integrityFailure("The assessment contains an invalid or duplicate source receipt.");
    sources.set(source.id, source);
  }
  const observations = new Set();
  for (const observation of record.observations) {
    if (!sourceId(observation.id) || observations.has(observation.id) || !sources.has(observation.sourceId) || observation.entityId !== record.entity.id) throw integrityFailure("An observation has a duplicate identity or does not bind to this assessment's entity and source.");
    observations.add(observation.id);
  }
  for (const source of record.sources) {
    if (source.parentSourceId && !sources.has(source.parentSourceId)) throw integrityFailure("A source parent is absent from the evidence manifest.");
    const visited = new Set([source.id]);
    let cursor = source;
    while (cursor.supersededBy) {
      if (visited.has(cursor.supersededBy) || !sources.has(cursor.supersededBy)) throw integrityFailure("Source corrections contain an invalid or cyclic supersession relationship.");
      visited.add(cursor.supersededBy);
      cursor = sources.get(cursor.supersededBy);
    }
  }
}

function verifyAppendOnly(current, next) {
  if (!current) return;
  if (stable(current.entity) !== stable(next.entity) || stable(current.operationPeriod) !== stable(next.operationPeriod) && current.operationPeriod != null || current.target !== next.target || current.owner !== next.owner || current.accessTokenHash !== next.accessTokenHash) throw integrityFailure("Assessment identity, ownership and established period are immutable.");
  const nextSources = new Map(next.sources.map(source => [source.id, source]));
  for (const original of current.sources) {
    const updated = nextSources.get(original.id);
    if (!updated) throw integrityFailure("An existing source receipt cannot be removed.");
    const { supersededBy: originalCorrection, correctionReason: originalReason, ...originalReceipt } = withoutBody(original);
    const { supersededBy: updatedCorrection, correctionReason: updatedReason, ...updatedReceipt } = withoutBody(updated);
    if (stable(originalReceipt) !== stable(updatedReceipt) || originalCorrection && (updatedCorrection !== originalCorrection || updatedReason !== originalReason)) throw integrityFailure("An existing source receipt cannot be rewritten or rebound.");
    if (!originalCorrection && updatedCorrection && (original.kind !== "user_structured" || typeof updatedReason !== "string" || !updatedReason.trim())) throw integrityFailure("Only an explicit reasoned user correction can supersede a source.");
  }
  const nextObservations = new Map(next.observations.map(observation => [observation.id, observation]));
  for (const observation of current.observations) if (stable(observation) !== stable(nextObservations.get(observation.id))) throw integrityFailure("An existing observation cannot be removed or rewritten.");
}

// The runtime host is trusted. HMAC detects stored-manifest changes; it does not
// attest a source, identify a customer, or protect against an operator with the key.
// Per-assessment lock directories are never expired automatically. After a crash,
// an operator must verify that the owning process stopped before recovering a lock.
export class AssessmentStore {
  constructor(root) { this.root = resolve(root); }
  async initialize() {
    await mkdir(join(this.root, "records"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, "snapshots"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, "locks"), { recursive: true, mode: 0o700 });
    const keyPath = join(this.root, "integrity.key");
    try { await lstat(keyPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; await publishImmutable(keyPath, randomBytes(32)); }
    const metadata = await lstat(keyPath);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw manifestFailure("The runtime integrity key is unavailable or has unsafe permissions.");
    const key = await readFile(keyPath);
    if (key.length !== 32) throw manifestFailure("The runtime integrity key is unavailable or has unsafe permissions.");
    return key;
  }
  newId() { return `ea-${randomBytes(32).toString("hex")}`; }
  sign(record, key) {
    return { version: "flowcredit.storage-integrity/v1", algorithm: "HMAC-SHA256", signature: createHmac("sha256", key).update(stable(unsigned(record))).digest("hex") };
  }
  verifySignature(record, key) {
    if (!record.storageIntegrity) throw packageError("This unsigned assessment predates the authority boundary. Reassess from original evidence; automatic promotion or migration is disabled.", "ASSESSMENT_REASSESSMENT_REQUIRED", 409);
    const receipt = record.storageIntegrity;
    if (receipt.version !== "flowcredit.storage-integrity/v1" || receipt.algorithm !== "HMAC-SHA256" || !hexDigest(receipt.signature) || !timingSafeEqual(Buffer.from(receipt.signature, "hex"), Buffer.from(this.sign(record, key).signature, "hex"))) throw manifestFailure("The stored assessment manifest failed its integrity signature check.");
  }
  async snapshot(source) {
    if (!hexDigest(source.contentHash)) throw integrityFailure("Invalid source content hash.");
    let content;
    try { content = await readFile(join(this.root, "snapshots", `${source.contentHash}.txt`), "utf8"); }
    catch (error) { if (error.code === "ENOENT") throw integrityFailure("A required stored raw source is missing."); throw error; }
    if (digest(content) !== source.contentHash) throw integrityFailure("Stored source failed its content hash check.");
    return content;
  }
  async load(id, { authorize } = {}) {
    if (!assessmentId(id)) throw packageError("Assessment not found.", "ASSESSMENT_NOT_FOUND", 404);
    let text;
    try { text = await readFile(join(this.root, "records", `${id}.json`), "utf8"); }
    catch (error) { if (error.code === "ENOENT") throw packageError("Assessment not found.", "ASSESSMENT_NOT_FOUND", 404); throw error; }
    let record;
    try { record = JSON.parse(text); } catch { throw manifestFailure("The stored assessment is not valid JSON."); }
    this.verifySignature(record, await this.initialize());
    validateRecord(record, id);
    let historical;
    try { historical = await readFile(join(this.root, "records", `${id}.r${record.revision}.json`), "utf8"); }
    catch (error) { if (error.code === "ENOENT") throw manifestFailure("The assessment's published immutable revision is missing."); throw error; }
    if (historical !== text) throw manifestFailure("The current assessment does not match its published immutable revision.");
    // A private-source integrity error must not become an oracle for somebody
    // who only possesses the shared API credential or a leaked assessment ID.
    // Authorize the signed manifest before accessing any underlying raw record.
    if (authorize) await authorize(record);
    for (const source of record.sources) await this.snapshot(source);
    return record;
  }
  async source(record, id) {
    if (!sourceId(id)) throw packageError("Source not found.", "SOURCE_NOT_FOUND", 404);
    const source = record.sources.find(item => item.id === id);
    if (!source) throw packageError("Source not found.", "SOURCE_NOT_FOUND", 404);
    return { source, content: await this.snapshot(source) };
  }
  async exclusive(id, operation) {
    if (!assessmentId(id)) throw packageError("Assessment not found.", "ASSESSMENT_NOT_FOUND", 404);
    const queueKey = `${this.root}\n${id}`;
    const active = transactions.getStore();
    if (active?.held && active.root === this.root && active.id === id) return operation();
    const previous = queues.get(queueKey) || Promise.resolve();
    let release;
    const waiting = new Promise(resolveWaiting => { release = resolveWaiting; });
    queues.set(queueKey, waiting);
    await previous;
    const lockPath = join(this.root, "locks", id);
    let ownedLock = false;
    let lockOwner;
    let transaction;
    try {
      await this.initialize();
      try { await mkdir(lockPath, { mode: 0o700 }); ownedLock = true; }
      catch (error) {
        if (error.code === "EEXIST") throw packageError("This assessment has an active or interrupted transaction. Retry only after its process completes, or ask the operator to verify recovery.", "ASSESSMENT_LOCKED", 409);
        throw error;
      }
      lockOwner = JSON.stringify({ processId: process.pid, token: randomBytes(16).toString("hex") });
      await writeFile(join(lockPath, "owner.json"), lockOwner, { mode: 0o600, flag: "wx" });
      transaction = { root: this.root, id, held: true };
      return await transactions.run(transaction, operation);
    } finally {
      if (transaction) transaction.held = false;
      try {
        if (ownedLock && lockOwner) {
          // Do not remove a replacement lock created by operator intervention.
          const retainedOwner = await readFile(join(lockPath, "owner.json"), "utf8");
          if (retainedOwner !== lockOwner) throw manifestFailure("The transaction lock changed ownership; operator recovery is required.");
          await unlink(join(lockPath, "owner.json"));
          await rmdir(lockPath);
        }
      } finally {
        release();
        if (queues.get(queueKey) === waiting) queues.delete(queueKey);
      }
    }
  }
  async save(record, expectedRevision, signal) {
    if (!assessmentId(record.id) || !Number.isInteger(expectedRevision) || expectedRevision < 0 || record.revision !== expectedRevision + 1) throw packageError("Invalid assessment identity or revision.");
    return this.exclusive(record.id, () => this.publish(record, expectedRevision, signal));
  }
  async publish(record, expectedRevision, signal) {
    signal?.throwIfAborted();
    const key = await this.initialize();
    let current;
    try { current = await this.load(record.id); }
    catch (error) { if (error.code !== "ASSESSMENT_NOT_FOUND") throw error; }
    if ((current?.revision || 0) !== expectedRevision) throw packageError("This assessment changed. Reload it before adding evidence.", "REVISION_CONFLICT", 409);
    const copy = JSON.parse(JSON.stringify(record));
    delete copy.storageIntegrity;
    validateRecord(copy, record.id);
    verifyAppendOnly(current, copy);
    for (const source of copy.sources) {
      if (source.body !== undefined) {
        const content = typeof source.body === "string" ? source.body : JSON.stringify(source.body);
        if (digest(content) !== source.contentHash) throw integrityFailure("Acquired source failed its content hash check.");
        await publishImmutable(join(this.root, "snapshots", `${source.contentHash}.txt`), content);
        delete source.body;
      }
      // This also checks EEXIST blobs; raw evidence is required for every publication.
      await this.snapshot(source);
    }
    signal?.throwIfAborted();
    copy.storageIntegrity = this.sign(copy, key);
    const text = JSON.stringify(copy);
    const directory = join(this.root, "records");
    const revisionPath = join(directory, `${record.id}.r${record.revision}.json`);
    const temporary = join(directory, `${record.id}.${randomBytes(8).toString("hex")}.tmp`);
    let revisionWritten = false;
    try {
      // Under the held transaction lock and verified current CAS, this next
      // revision cannot be published history. Only an unpublished crash orphan
      // may be removed. No earlier revision is ever deleted or replaced.
      await unlink(revisionPath).catch(error => { if (error.code !== "ENOENT") throw error; });
      await writeFile(revisionPath, text, { mode: 0o600, flag: "wx" });
      revisionWritten = true;
      await writeFile(temporary, text, { mode: 0o600 });
      signal?.throwIfAborted();
      await rename(temporary, join(directory, `${record.id}.json`));
    } catch (error) {
      await unlink(temporary).catch(() => {});
      if (revisionWritten) await unlink(revisionPath).catch(() => {});
      throw error;
    }
    return copy;
  }
}
