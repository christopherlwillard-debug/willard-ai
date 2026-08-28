---
name: GitHub workflow push authentication
description: Replit's GitHub OAuth connection can push repository code but may lack the workflow scope required for .github/workflows changes.
---

For pushes that add or update GitHub Actions workflow files, use a valid classic GitHub PAT with `repo` and `workflow` scopes through a temporary askpass helper. Replit's attached GitHub OAuth connection may authenticate normally but be rejected for workflow changes. GitHub accepts the PAT reliably when the askpass username is `x-access-token`; never put the token in a remote URL or print it.

**Why:** GitHub explicitly rejects OAuth App credentials without `workflow`, while a classic PAT can have that scope.

**How to apply:** Validate the PAT privately with `/user`, then push using `GIT_ASKPASS`; remove the temporary helper immediately afterward. If the PAT can push but returns 403 for Actions dispatch or cancellation, use the connected GitHub integration proxy for those Actions API calls.