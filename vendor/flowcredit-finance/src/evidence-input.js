/*
 * Evidence intake boundary. JSON is parsed as JSON once, never as natural language.
 * This module retains raw inputs for review, excludes score fields from draft facts,
 * and withholds monetary text whenever its meaning is unsafe to carry into the core.
 * It does not verify user claims or create evidence provenance or risk scores.
 */
import { INTAKE_SCHEMA_V03 } from "./intake-v03.js";
import { extractNaturalLanguageDraft } from "./nl-draft-v01.js";

export const EVIDENCE_INPUT_VERSION = "evidence-input/v0.1";

const GROUPS = new Set(["scope", "tokenActivity", "computeBusiness", "creditProfile", "historyCrossCheck"]);
const ALLOWED = new Set([
  ...Object.keys(INTAKE_SCHEMA_V03.fields), "taskType", "address", "assessmentAsOf",
  "monthlyRevenueUsd", "monthlyComputeSpendUsd", "loopWashRatePct", "currentExposure"
]);
const WRAPPER_METADATA = new Set(["draft", "target", "draftId", "apiVersion", "contractVersion", "modelConsent", "businessType", "assessmentId", "assessmentAccessToken", "expectedRevision", "evidenceLabel", "correctsSourceId", "reason", "profile"]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function failure(rawText, code, message, raw) {
  return { kind: "structured", valid: false, parserVersion: EVIDENCE_INPUT_VERSION, rawText, ...(raw === undefined ? {} : { raw }),
    error: { code, message }, warnings: [], matchedFields: [], ignoredInputs: [] };
}

// JSON.parse permits duplicate object keys. Refuse those before they can silently replace
// a previously supplied claim. The input has already passed JSON.parse at this point.
export function duplicateJsonKey(json) {
  const stack = [];
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < json.length) {
        if (json[index] === "\\") { index += 2; continue; }
        if (json[index] === '"') break;
        index += 1;
      }
      const frame = stack.at(-1);
      if (frame?.type === "object" && frame.expectKey) {
        const key = JSON.parse(json.slice(start, index + 1));
        if (frame.keys.has(key)) return key;
        frame.keys.add(key);
        frame.expectKey = false;
      }
    } else if (char === "{") stack.push({ type: "object", keys: new Set(), expectKey: true });
    else if (char === "[") stack.push({ type: "array" });
    else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && stack.at(-1)?.type === "object") stack.at(-1).expectKey = true;
  }
  return null;
}

function topLevelObjects(source) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (depth > 0 && quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (depth > 0 && char === '"') { quoted = true; continue; }
    if (char === "{") { if (!depth) start = index; depth += 1; }
    else if (char === "}") {
      if (!depth) return { spans, malformed: true };
      depth -= 1;
      if (!depth) spans.push({ text: source.slice(start, index + 1), start, end: index + 1 });
    }
  }
  return { spans, malformed: depth !== 0 || quoted };
}

function flattenStructured(raw) {
  if (Object.hasOwn(raw, "draft") && !isObject(raw.draft)) {
    return { error: { code: "INVALID_STRUCTURED_INPUT", message: "The draft property must be a JSON object." } };
  }
  const wrapped = Object.hasOwn(raw, "draft");
  const source = wrapped ? raw.draft : raw;
  const draft = {};
  const origins = new Map();
  const ignoredInputs = [];
  let error;
  const collect = (entries, prefix) => {
    for (const [key, value] of Object.entries(entries)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!ALLOWED.has(key)) { ignoredInputs.push(path); continue; }
      if (origins.has(key) && JSON.stringify(draft[key]) !== JSON.stringify(value)) {
        error = { code: "STRUCTURED_INPUT_CONFLICT", message: `Conflicting values for ${key} at ${origins.get(key)} and ${path}; supply one explicit value.` };
        continue;
      }
      if (!origins.has(key)) { draft[key] = structuredClone(value); origins.set(key, path); }
    }
  };
  collect(Object.fromEntries(Object.entries(source).filter(([key]) => !GROUPS.has(key))), wrapped ? "draft" : "");
  for (const key of GROUPS) {
    if (!Object.hasOwn(source, key)) continue;
    if (!isObject(source[key])) {
      error = { code: "INVALID_STRUCTURED_INPUT", message: `${key} must be a JSON object.` };
      continue;
    }
    collect(source[key], `${wrapped ? "draft." : ""}${key}`);
  }
  if (wrapped) {
    for (const key of Object.keys(raw)) {
      if (ALLOWED.has(key) || GROUPS.has(key)) {
        error = { code: "STRUCTURED_INPUT_CONFLICT", message: `The request mixes draft with top-level facts at ${key}; put all facts inside draft.` };
      } else if (!WRAPPER_METADATA.has(key)) ignoredInputs.push(key);
    }
  }
  return { draft, ignoredInputs: [...new Set(ignoredInputs)].sort(), sourcePaths: Object.fromEntries(origins), error };
}

const MONEY_LABELS = {
  revenueUsd: String.raw`revenueUsd|monthly\s+revenue|revenue|月收入|月营收|月流水|每月收入|营业收入|收入`,
  computeSpendUsd: String.raw`computeSpendUsd|compute\s+spend|compute\s+cost|gpu\s+cost|算力支出|算力成本|算力花费|算力费用|计算支出`
};
const MONEY = String.raw`(?:US\$|USD\s*|\$|EUR\s*|GBP\s*|RMB\s*|CNY\s*|HKD\s*|[€£¥￥])?\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|万|千|亿|[kKmMbB])?\s*(USD|美元|美金|EUR|GBP|RMB|CNY|HKD|人民币|港元|欧元|英镑|元)?(?![a-zA-Z0-9_%％]|\.\d)`;
const SCALE = { 万: 1e4, 千: 1e3, 亿: 1e8, k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
const NON_USD = /人民币|港元|欧元|英镑|RMB|CNY|HKD|EUR|GBP|[€£¥￥]|(?:^|\s)元(?:\s|$)/i;
const USD = /US\$|\$|\bUSD\b|美元|美金/i;
const UNIT_PRICE = /\bper\b|\/(?:\s*(?:gpu|token|hour|hr|h\b|month|mo\b|unit))|每\s*(?:GPU|小时|时|百万|千|个|单位)|unit\s+price|单价/i;
const COMPONENT = /\b(?:component|sub[- ]?component|segment|portion|subset|API|cloud|subscription)\b|子项|分项|其中|订阅|云业务/i;

function monetaryCandidates(source, field) {
  const pattern = new RegExp(`(?:${MONEY_LABELS[field]})[^\\d%;，;\n]{0,32}?${MONEY}`, "gi");
  const candidates = [];
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const previous = source.slice(0, start).search(/[^.;\n，;]*$/);
    const tail = source.slice(start + match[0].length).split(/[;\n，]/, 1)[0].slice(0, 90);
    const prefix = source.slice(Math.max(previous, start - 45), start);
    const context = `${prefix}${match[0]}${tail}`;
    const amount = Number(match[1].replaceAll(",", "")) * (SCALE[String(match[2] || "").toLowerCase()] || 1);
    const reasons = [];
    if (/\b(?:crore|lakh|cents?|bn|mn)\b/i.test(tail)) reasons.push("unsupported-amount-unit");
    if (match[1].includes(",") && !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(match[1])) reasons.push("invalid-number-format");
    if (NON_USD.test(context)) reasons.push("non-usd-currency");
    if (!USD.test(match[0]) && !match[0].toLowerCase().startsWith(field.toLowerCase())) reasons.push("currency-unspecified");
    if (UNIT_PRICE.test(context)) reasons.push("unit-price");
    if (COMPONENT.test(prefix + match[0])) reasons.push("revenue-component");
    if (amount < 0 || /[-−]\s*(?:US\$|USD|\$)?\s*\d|\(\s*(?:US\$|\$)?\s*\d/.test(match[0])) reasons.push("negative-amount");
    // Approximations are not promoted into canonical facts by a text matcher.
    if (/(?:~|≈|约|rough|estimate|estimated|approximately|about)\s*(?:US\$|USD|\$)?\s*[+-]?\d/i.test(match[0])) reasons.push("estimated-amount");
    candidates.push({ amount, reasons, text: match[0], start });
  }
  return candidates;
}

export function safeTextDraft(text) {
  const source = typeof text === "string" ? text : "";
  const extracted = extractNaturalLanguageDraft(source);
  const draft = { ...extracted.draft };
  const withheldFields = [];
  const warnings = [...extracted.warnings];
  for (const field of Object.keys(MONEY_LABELS)) {
    const candidates = monetaryCandidates(source, field);
    delete draft[field];
    if (!candidates.length) {
      if (Object.hasOwn(extracted.draft, field)) {
        const message = `${field} was withheld because the amount syntax was not safely recognized; provide a numeric USD total in structured facts.`;
        withheldFields.push({ field, reasons: ["unsupported-amount-syntax"], message, candidates: [] });
        warnings.push(message);
      }
      continue;
    }
    const reasons = [...new Set(candidates.flatMap(candidate => candidate.reasons))];
    if (new Set(candidates.map(candidate => candidate.amount)).size > 1) reasons.push("competing-amounts");
    if (candidates.length > 1 && candidates.some(candidate => candidate.reasons.includes("revenue-component"))) reasons.push("component-total-ambiguity");
    if (reasons.length) {
      const message = `${field} was withheld (${[...new Set(reasons)].join(", ")}); provide an explicit period, USD total and source, or structured facts.`;
      withheldFields.push({ field, reasons: [...new Set(reasons)], message, candidates });
      warnings.push(message);
    } else if (Number.isFinite(candidates[0].amount)) draft[field] = candidates[0].amount;
  }
  // The compatibility parser may also swallow a minus before hours/rates/counts.
  // Refuse those fields when a negative value is stated near their label.
  const negativeLabels = {
    gpuHours: String.raw`GPU\s*(?:hours?|使用量|使用时长|使用|时长)?|gpuHours`,
    repaymentRatePct: String.raw`repayment(?:\s+rate)?|repaymentRatePct|还款率`,
    overdue30Pct: String.raw`overdue(?:\s+rate)?|overdue30Pct|逾期率`,
    payingCustomers: String.raw`(?:paying|paid)\s*customers?|payingCustomers|付费\s*客户`,
    top5ConcentrationPct: String.raw`top\s*5|top5ConcentrationPct|前\s*5\s*大客户`
  };
  for (const [field, labels] of Object.entries(negativeLabels)) {
    if (!Object.hasOwn(draft, field) || !new RegExp(`(?:${labels})[^\\d;，\n]{0,24}-\\s*\\d`, "i").test(source)) continue;
    delete draft[field];
    const message = `${field} was withheld because a negative value was stated; provide a nonnegative measured value.`;
    withheldFields.push({ field, reasons: ["negative-value"], message, candidates: [] });
    warnings.push(message);
  }
  return { draft, matchedFields: Object.keys(draft), warnings, withheldFields };
}

/**
 * Returns a structured result, including explicit errors rather than falling back to
 * numeric text extraction after broken/ambiguous JSON. raw/rawText always remain
 * available to the caller; draft contains only known facts with unchanged JSON types.
 */
export function parseEvidenceInput(prompt) {
  const rawText = typeof prompt === "string" ? prompt : "";
  const source = rawText.trim();
  if (typeof prompt !== "string") return failure(rawText, "INVALID_INPUT", "The prompt must be a string.");
  const objects = topLevelObjects(source);
  const declaredJson = /^[{[]/.test(source) || /```\s*json\b/i.test(source) || /\bJSON\s*[:：]/i.test(source);
  if (objects.malformed) return failure(rawText, "INVALID_STRUCTURED_INPUT", "Unbalanced JSON object; correct the object before assessment.");
  if (objects.spans.length > 1) return failure(rawText, "AMBIGUOUS_STRUCTURED_INPUT", "Multiple JSON objects were supplied; combine them into one explicit object.");
  if (!objects.spans.length) {
    if (declaredJson) return failure(rawText, "INVALID_STRUCTURED_INPUT", "Provide one valid JSON object, rather than an array or malformed JSON.");
    return { kind: "text", valid: true, parserVersion: EVIDENCE_INPUT_VERSION, rawText, ...safeTextDraft(rawText), ignoredInputs: [] };
  }
  if (source.startsWith("[")) return failure(rawText, "INVALID_STRUCTURED_INPUT", "Provide one JSON object, rather than an array.");
  const span = objects.spans[0];
  const fenceStarts = [...source.matchAll(/```\s*json\b/gi)];
  if (fenceStarts.length > 1 || (fenceStarts.length && !/```\s*json\s*[\s\S]*?```/i.test(source))) {
    return failure(rawText, "INVALID_STRUCTURED_INPUT", "Provide one closed JSON code block.");
  }
  let raw;
  try { raw = JSON.parse(span.text); }
  catch { return failure(rawText, "INVALID_STRUCTURED_INPUT", "The structured input is not valid JSON; it was not reinterpreted as natural language."); }
  const duplicate = duplicateJsonKey(span.text);
  if (duplicate !== null) return failure(rawText, "STRUCTURED_INPUT_CONFLICT", `Duplicate JSON key ${duplicate}; supply each claim once.`, raw);
  const flattened = flattenStructured(raw);
  if (flattened.error) return failure(rawText, flattened.error.code, flattened.error.message, raw);
  const warnings = [];
  if (flattened.ignoredInputs.length) warnings.push("Unknown or authoritative result fields were retained in raw input and excluded from draft facts.");
  if (source.slice(0, span.start).trim() || source.slice(span.end).trim()) warnings.push("Only the JSON object supplied facts; surrounding prose was retained for review and did not modify those facts.");
  return { kind: "structured", valid: true, parserVersion: EVIDENCE_INPUT_VERSION, rawText, raw,
    draft: flattened.draft, matchedFields: Object.keys(flattened.draft), ignoredInputs: flattened.ignoredInputs,
    warnings, withheldFields: [], sourcePaths: flattened.sourcePaths };
}
