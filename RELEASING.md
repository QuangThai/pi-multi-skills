# Releasing

Publishing is intentionally manual and runs from a maintainer's machine. The repository does not contain an automated npm publishing workflow.

## Prerequisites

- Use Node.js 22.19 or newer.
- Sign in to npm with an account that can publish `pi-multi-skills` and has two-factor authentication enabled.
- Start from a clean, up-to-date `main` branch.

## Release checklist

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` for the release.
2. Install and verify the exact release tree:

   ```bash
   npm ci
   npm run verify
   npm audit --audit-level=high
   npm audit --omit=dev --audit-level=high
   npm pack --dry-run --ignore-scripts
   ```

3. Review the packed file list and working-tree diff.
4. Commit the release, then create a tag matching the package version exactly:

   ```bash
   git tag -a v1.2.0 -m "v1.2.0"
   ```

5. Push the commit and tag, and wait for CI on the tag to pass.
6. From the tagged, clean checkout, publish interactively:

   ```bash
   npm publish --access public
   ```

7. Confirm the published version and files:

   ```bash
   npm view pi-multi-skills version
   npm view pi-multi-skills dist
   ```

Do not store an npm token in the repository. If publishing automation is added later, prefer npm trusted publishing with short-lived OIDC credentials.
