# Changelog

All notable changes to this project are documented here.

## [1.2.2] - 2026-10-16

### Changed

- Bump the development dependency to Pi 1.3.0, which clears the dev-only `npm audit` findings from transitive dependencies.
- Stop hard-coding a "latest tested" Pi version in the README; CI covers the minimum supported release (0.80.2) and the latest published release.
- Run CI weekly and on manual dispatch so the latest Pi release is tested continuously, not only on pushes, and keep scheduled runs in their own concurrency group so they do not cancel pushes to `main`.

## [1.2.1] - 2026-09-12

### Fixed

- Keep the `$` sigil visible after submission and render successfully loaded skill mentions with Pi's theme-native `mdCode` accent color.
- Leave failed and escaped references visually unstyled so the transcript does not imply that they loaded successfully.
- Avoid introducing code markers that would alter existing inline-code spans, Markdown links, autolinks, URLs, or path-like tokens.
- Preserve unrelated escaped dollars in prices, shell text, and Windows paths when another skill reference is transformed.

### Changed

- Replace the duplicate gallery assets with one accurate 1200×630 package preview and point Pi package metadata to it.

### Quality

- Exercise Pi's real `UserMessageComponent` with built-in dark and light themes and verify repeated, escaped, failed, URL/path, and Markdown-adjacent mention rendering.

## [1.2.0] - 2026-09-12

### Fixed

- Preserve multiline prompts, blank lines, indentation, code fences, and intentional repeated spaces during skill expansion.
- Give every skill in a merged invocation its own canonical skill path and relative-reference directory.
- Leave unreadable skill references untouched while loading the remaining skills successfully.
- Preserve image attachments when transforming RPC or interactive input.
- Clear transient skill UI state after a turn.

### Changed

- Build and cache the skill registry from Pi command metadata without reading every `SKILL.md` during autocomplete.
- Read only invoked skill files, concurrently and asynchronously.
- Match references against Pi's installed registry and ignore Markdown code, unknown variables, and extension-injected messages.
- Rank autocomplete prefix matches first and cap results at 20.
- Support installed skill names beginning with a digit.
- Warn when combined skill instructions exceed 50,000 characters.

### Quality and release

- Replace simulated E2E expansion with tests of the production handler plus Pi's real `parseSkillBlock`, Jiti loader, and `ExtensionRunner`.
- Enforce coverage thresholds and strict TypeScript indexed/optional-property checks.
- Test Node 22.19/24, Windows/Linux, and Pi 0.80.2/0.85.1 in CI.
- Pin GitHub Actions revisions, add MIT license text, and document a manual npm release checklist.

[1.2.2]: https://github.com/QuangThai/pi-multi-skills/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/QuangThai/pi-multi-skills/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/QuangThai/pi-multi-skills/compare/v1.1.3...v1.2.0
