# Sanctum Type Registry

Living registry — reuse before creating. New types may be appended when nothing fits.

## Node types
- **Person** — a human (attrs: role, org)
- **Project** — a named project/product
- **Task** — something to do (attrs: due, status)
- **Org** — company / team
- **Place** — location
- **Note** — idea / insight / fact

## Edge types
- **said** — Person stated or requested something
- **owns** — Person owns or created something (minted by the agent, 2026-08-15)
- **works_on** — Person works on Project
- **part_of** — Task/Fact belongs to Project
- **due_by** — Task deadline
- **mentions** — dump references an entity
- **related_to** — weak catch-all (use sparingly)
