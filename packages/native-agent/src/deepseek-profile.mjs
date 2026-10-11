import { PLAN_VERSION, fail } from './contracts.mjs';
export const DEEPSEEK_MODEL = 'deepseek-flash';
export const DEEPSEEK_ROUTE = 'deepseek-flash-m3-a';
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

export function inspectDeepSeekEnvelope(envelope) {
  const usage = envelope.usage;
  const hit = usage?.prompt_cache_hit_tokens, miss = usage?.prompt_cache_miss_tokens;
  const cached = usage?.prompt_tokens_details?.cached_tokens, reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  let usageValid = true;
  if (usage !== undefined && usage !== null) usageValid = integer(hit) && integer(miss) && hit + miss === usage.prompt_tokens && usage.prompt_tokens_details !== null && typeof usage.prompt_tokens_details === 'object' && !Array.isArray(usage.prompt_tokens_details);
  if (cached !== undefined) usageValid &&= integer(cached) && cached <= usage.prompt_tokens && (hit === undefined || cached === hit);
  if (reasoning !== undefined) usageValid &&= integer(reasoning) && reasoning <= usage.completion_tokens;
  const message = envelope.choices[0].message;
  const createdValid = Number.isSafeInteger(envelope.created) && envelope.created >= 0;
  const metadataValid = envelope.object === 'chat.completion' && identifier(envelope.id) && identifier(envelope.system_fingerprint) && createdValid && envelope.choices[0].index === 0;
  const nonThinking = (message.reasoning_content === undefined || message.reasoning_content === null || message.reasoning_content === '') && (reasoning === undefined || reasoning === 0);
  const metadata = { providerRequestId: identifier(envelope.id) ? envelope.id : null, systemFingerprint: identifier(envelope.system_fingerprint) ? envelope.system_fingerprint : null, created: createdValid ? envelope.created : null, cacheHitTokens: usageValid && integer(hit) ? hit : null, cacheMissTokens: usageValid && integer(miss) ? miss : null, cachedTokens: usageValid && integer(cached) ? cached : null, reasoningTokens: usageValid && integer(reasoning) ? reasoning : null, usageDetailsValid: usageValid, inputTokenGuarantee: 'NOT_PROVEN', externalBilling: 'NOT_PROVEN' };
  return { metadata, usageValid, outputValid: metadataValid && nonThinking, reason: metadataValid ? 'DEEPSEEK_NONTHINKING_VIOLATION' : 'DEEPSEEK_ENVELOPE_INVALID' };
}
export function deepSeekProfile(mode, purpose) {
  if (!['disabled', 'injected-http-test', 'live'].includes(mode) || !['static-plan', 'loop-action'].includes(purpose)) fail('DEEPSEEK_CONFIGURATION');
  const example = { version: PLAN_VERSION, steps: [{ id: 'observe', tool: 'evidence.read', arguments: {} }, ...(purpose === 'static-plan' ? [{ id: 'assess', tool: 'evidence.assess', arguments: {} }] : [])] };
  const instruction = purpose === 'loop-action' ? 'Return exactly one registered read action. Use the previous verified observation summary: no observations -> evidence.read; one read with facts -> evidence.assess; an empty read -> evidence.read. Runtime alone decides termination.' : 'Propose registered read actions. Include evidence.read and evidence.assess to verify the task.';
  const system = `Return only JSON, never permissions, credentials, financial values or completion claims. ${instruction} JSON example: ${JSON.stringify(example)}`;
  return Object.freeze({ mode: mode === 'live' ? 'deepseek-live' : mode === 'disabled' ? 'deepseek-disabled' : 'deepseek-injected-http-test', systemBytes: Buffer.byteLength(system), pricingKinds: Object.freeze(mode === 'live' ? ['host-reviewed-snapshot'] : ['synthetic']), contract: Object.freeze({ version: 'flowcredit.deepseek-profile/m3-a-v1', model: DEEPSEEK_MODEL, endpoint: DEEPSEEK_ENDPOINT, thinking: 'disabled', purpose, system, inputAccounting: 'message-utf8-bytes-plus-512-NOT_PROVEN' }), configureWire(wire) {
    if (wire.model !== DEEPSEEK_MODEL || wire.stream !== false || wire.messages.length !== 2 || wire.messages[0].role !== 'system' || wire.messages[1].role !== 'user') fail('DEEPSEEK_WIRE_DENIED');
    wire.thinking = { type: 'disabled' }; wire.messages[0].content = system;
  }, inspectEnvelope: inspectDeepSeekEnvelope });
}
