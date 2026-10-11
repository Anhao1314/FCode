import { acquirePublicEvidence } from "./public-evidence.js";
import { digest, packageError } from "./evidence-package.js";
import { evaluateObservationAuthority } from "./evidence-authority.js";

// Reuses the registered extractor, with an inert snapshot map instead of network.
// A model cannot supply a URL, a fetch implementation, an extractor or source bytes.
export async function replaySavedPublicSource(record, sourceId, readSnapshot) {
  const selected = record.sources.find(item => item.id === sourceId && !item.supersededBy);
  if (!selected) throw packageError("Source not found.", "SOURCE_NOT_FOUND", 404);
  const snapshots = new Map();
  for (const source of record.sources.filter(item => ["issuer_disclosure", "public_api"].includes(item.kind) && !item.supersededBy)) {
    const { content } = await readSnapshot(source.id);
    if (digest(content) !== source.contentHash) throw packageError("Source integrity failure.", "SOURCE_INTEGRITY_FAILURE", 500);
    snapshots.set(source.id, { source, content });
  }
  const current = snapshots.get(sourceId);
  if (!current) return { source: selected, content: (await readSnapshot(sourceId)).content, anchors: [], profileSupported: false };
  const byUrl = new Map([...snapshots.values()].map(item => [item.source.url, item]));
  byUrl.set(selected.url, current);
  if (record.entity.id === "arweave:mainnet" && /\/block\/hash\//.test(selected.url)) {
    const hash = selected.url.split("/").at(-1);
    const info = [...snapshots.values()].find(item => { try { return item.source.url === "https://arweave.net/info" && JSON.parse(item.content).current === hash; } catch { return false; } });
    if (info) byUrl.set(info.source.url, info); else byUrl.delete("https://arweave.net/info");
  }
  let stamp = selected.retrievedAt;
  const result = await acquirePublicEvidence(record.entity.id, {
    now: () => stamp,
    fetchImpl: async url => {
      const snapshot = byUrl.get(url);
      if (!snapshot) throw new Error("Required retained snapshot is unavailable.");
      stamp = snapshot.source.retrievedAt;
      return new Response(snapshot.content, { status: 200, headers: { "content-type": snapshot.source.contentType } });
    }
  });
  const anchors = result.observations.filter(item => item.sourceId === sourceId && evaluateObservationAuthority(record, item, selected).permissions.contextualCalculation);
  return { source: selected, content: current.content, anchors, profileSupported: anchors.length > 0, acquisition: result.acquisition };
}

// Presentation only. These inert excerpts are not a second evidence extractor.
export function sourceView(source, content, anchors) {
  const inert = content.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const plain = value => value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  const tables = [...inert.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map(item => [...item[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(row => plain(row[1])));
  const locators = anchors.map(item => {
    const match = /^table\[(\d+)\]\/row\[(\d+)\]\/cell\[(\d+)\]$/.exec(item.locator);
    return { metric: item.metric, locator: item.locator, ...(match ? { tableHeaders: tables[Number(match[1])]?.slice(0, 6), row: tables[Number(match[1])]?.[Number(match[2])] } : {}) };
  });
  return { sourceId: source.id, sourceHash: source.contentHash, title: source.title || source.url || "Saved source", untrustedContent: plain(inert).slice(0, 18000), availableLocators: locators, truncated: plain(inert).length > 18000 };
}
