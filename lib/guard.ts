/** Content scan for text destined for long-term memory.
 *  Lean port of Hermes tools/threat_patterns.py (strict-scope subset).
 *
 *  Why: remembered content is later injected into the system prompt as
 *  authoritative context -- a stored injection is a *persistent* jailbreak,
 *  and a stored credential is a leak that outlives the chat. The remember
 *  tool writes model-generated content verbatim, so it is the scan point.
 *
 *  Returns a pattern id when blocked, null when clean. */

const FILLER = String.raw`(?:\w+\s+){0,8}`;

const PATTERNS: [RegExp, string][] = [
  // Classic prompt injection (memory is later prompt-injected)
  [new RegExp(String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions`, "i"), "prompt_injection"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [new RegExp(String.raw`disregard\s+${FILLER}(your|all|any)\s+${FILLER}(instructions|rules|guidelines)`, "i"), "disregard_rules"],
  [/<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i, "html_comment_injection"],
  [new RegExp(String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`, "i"), "deception_hide"],
  // Hardcoded secrets -- never persist credentials into the brain
  [/(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}/i, "hardcoded_secret"],
  // Exfiltration
  [/curl\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/wget\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
  [/(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?:\/\//i, "send_to_url"],
  [new RegExp(String.raw`(include|output|print|share)\s+${FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`, "i"), "context_exfil"],
];

// Invisible / bidirectional unicode used in injection attacks:
// invisible operators U+2062-64, directional isolates U+2066-69,
// zero-width space, LRM/RLM, bidi embeddings/overrides, BOM.
const INVISIBLE_RE = /[\u2062-\u2064\u2066-\u2069\u200B\u200E\u200F\u202A-\u202E\uFEFF]/;

const MAX_SCAN_CHARS = 65_536;

export function scanMemoryContent(content: string): string | null {
  const text = (content ?? "").slice(0, MAX_SCAN_CHARS);
  if (INVISIBLE_RE.test(text)) return "invisible_unicode";
  for (const [re, id] of PATTERNS) {
    if (re.test(text)) return id;
  }
  return null;
}
