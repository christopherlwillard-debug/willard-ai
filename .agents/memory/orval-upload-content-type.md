---
name: Orval upload content-type
description: Generated binary-upload clients hardcode a single content-type; how to send the real one
---

When an OpenAPI path's requestBody lists multiple binary content types (e.g.
image/png, image/jpeg, image/svg+xml), orval generates an upload function whose
fetch sets `headers: { 'Content-Type': '<first listed>' , ...options?.headers }`.
So it always sends the first type unless overridden.

**Why:** orval picks one content-type at generation time; it does not infer it from
the Blob/File passed at runtime.

**How to apply:** Call the generated function directly (not the bare hook) and pass
the real type: `uploadFn(file, { headers: { 'Content-Type': file.type } })`. Wrap in
`useMutation({ mutationFn: (file) => uploadFn(file, { headers: { 'Content-Type': file.type } }) })`.
Keep the server's accepted content-type allowlist in sync with the File MIME types
the browser produces (svg → image/svg+xml, jpg → image/jpeg).
