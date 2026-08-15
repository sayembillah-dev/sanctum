// Test the trivial-prompt gate regex (mirror of TRIVIAL_PROMPT_RE in lib/agent.ts)
const re =
  /^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k)[\s!?.:;,"'‘’“”—–…()\[\]{}<>*&^%$#@!+=` ]*$/i;

const SHOULD_MATCH = ["ok", "thanks!", "Hi", "lgtm", "done???", "go ahead", "k", "thank you :)", "yes."];
const SHOULD_NOT = [
  "k8s",
  "yolo",
  "note this",
  "ok so what about Denowatts?",
  "hey can you recap my week",
  "nextjs",
  "continue the refactor we discussed",
  "great — what was the deadline again?",
];

const bad = [];
for (const t of SHOULD_MATCH) if (!re.test(t)) bad.push("should-match: " + t);
for (const t of SHOULD_NOT) if (re.test(t)) bad.push("should-NOT-match: " + t);
console.log(bad.length ? "FAILURES:\n" + bad.join("\n") : "TRIVIAL-GATE-OK");
process.exit(bad.length ? 1 : 0);
