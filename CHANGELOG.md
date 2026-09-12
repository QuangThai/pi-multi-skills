# Changelog

All notable changes to this project are documented here.

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

[1.2.0]: https://github.com/QuangThai/pi-multi-skills/compare/v1.1.3...v1.2.0
