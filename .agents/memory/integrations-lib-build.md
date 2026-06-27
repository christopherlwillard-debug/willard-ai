---
name: Replit integrations lib declarations must be pre-built
description: The integrations-openai-ai-server package has no build script; its dist must be created manually before the API server can typecheck
---

# Integrations Lib Pre-Build Requirement

## The Rule
`lib/integrations-openai-ai-server` has no `build` npm script. Its declaration files must be generated with:

```bash
cd lib/integrations-openai-ai-server && npx tsc -p tsconfig.json --emitDeclarationOnly
```

**Why:** The API server `tsconfig.json` has a project reference to this package. If `dist/index.d.ts` doesn't exist, tsc emits `TS6305: Output file has not been built from source file` for every import from it.

**How to apply:** Run the above command whenever the integrations package source changes or if a fresh environment has no `dist/` folder. The package also had `TS18048` errors in `src/image/client.ts` — fixed by using `response.data?.[0]?.b64_json`.
