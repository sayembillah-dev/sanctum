// Standalone test of repairToolArguments (JS mirror of the TS in lib/agent.ts)
function repairToolArguments(argsJson) {
  const attempt = (text) => {
    try { JSON.parse(text); return text; } catch { return null; }
  };
  const s = (argsJson ?? "").trim();
  if (!s) return "{}";
  const direct = attempt(s);
  if (direct !== null) return direct;
  let t = s.replace(/,\s*([}\]])/g, "$1");
  let ok = attempt(t);
  if (ok !== null) return ok;
  let out = "", inStr = false, esc = false;
  for (const ch of t) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\" && inStr) { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch < " ") {
      out += ch === "\n" ? "\\n" : ch === "\t" ? "\\t" : ch === "\r" ? "\\r" : "";
      continue;
    }
    out += ch;
  }
  t = out;
  ok = attempt(t);
  if (ok !== null) return ok;
  if (inStr) t += '"';
  const stack = [];
  inStr = false; esc = false;
  for (const ch of t) {
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  while (stack.length) t += stack.pop() === "{" ? "}" : "]";
  ok = attempt(t);
  if (ok !== null) return ok;
  for (let i = 0; i < 8 && t.trimEnd().length; i++) {
    const trimmed = t.trimEnd();
    const last = trimmed.slice(-1);
    if (last !== "}" && last !== "]") break;
    t = trimmed.slice(0, -1);
    ok = attempt(t);
    if (ok !== null) return ok;
  }
  return null;
}

const cases = [
  ["valid untouched", '{"nodes":[],"edges":[],"updates":[]}', true],
  ["empty -> {}", "", true],
  ["trailing comma", '{"nodes":[],"edges":[],}', true],
  ["raw newline in string", '{"nodes":[{"name":"a\nb","type":"x"}],"edges":[],"updates":[]}', true],
  ["missing closers", '{"nodes":[{"name":"a","type":"x"}],"edges":[]', true],
  ["unterminated string + missing closers", '{"nodes":[{"name":"a b","type":"x}],"edges":[]', null], // ambiguous: genuinely unfixable
  ["excess closer", '{"nodes":[],"edges":[],"updates":[]}}', true],
  ["garbage", "not json at all", null],
];
let pass = 0, fail = 0;
for (const [label, input, expect] of cases) {
  const r = repairToolArguments(input);
  const parsed = r === null ? null : JSON.parse(r);
  const got = parsed !== null;
  const okTest = expect === null ? !got : got;
  if (expect !== null && got === true) { /* fine */ }
  if (okTest) { pass++; console.log("PASS:", label, r === null ? "(null)" : ""); }
  else { fail++; console.log("FAIL:", label, "->", r); }
}
// ambiguous case: if repaired, result must at least parse (never throws)
console.log(fail === 0 ? "ALL PASS" : fail + " FAILURES");
