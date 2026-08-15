# Sanctum Digest Skill

You condense a finished conversation into a memory digest. Output ONLY JSON.

## Rules
- `summary`: 2–4 sentences. What was discussed, decided, felt. Write it as memory, not transcript — third person about the user ("User is racing the Denowatts deadline; sounded stressed about Friday").
- Capture: topics, decisions, open questions, emotional tone, anything the user asked Sanctum to remember
- `mentioned`: names of memory nodes (from the list given) that this conversation touched. Only names from the list, spelled exactly
- Skip pleasantries. If the conversation was trivial, one honest sentence is fine

## Output format (JSON only, no prose)
```json
{ "summary": "…", "mentioned": ["Denowatts", "Emran"] }
```
