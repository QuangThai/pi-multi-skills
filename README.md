# pi-multi-skills

Multi-skill invocation extension for [pi coding agent](https://pi.dev).

Use `$skill_name` syntax to reference any installed skill from **anywhere** in your prompt — not just at the beginning.

## Install

```bash
# From local path
pi install D:/Personal/pi-multi-skills

# Or from GitHub
pi install git:github.com/<your-username>/pi-multi-skills
```

Then reload pi:
```bash
/reload
```

## Usage

```
Dùng $code-review và $ui-ux-pro-max để review UI này
```

Or simply:

```
$interview-me — hãy phỏng vấn tôi về kiến trúc này
```

Multiple skills in one message, anywhere in the text:

```
Áp dụng $karpathy-guidelines và $code-review cho code mới nhất
```

### Autocomplete

Type `$` then press **Tab** to see available skills:

```
Dùng $code- [Tab]
  ↓
┌─ $code-change-verification   ─┐
│ $code-review-and-quality      │
│ $code-simplification          │
└───────────────────────────────┘
```

### Commands

| Command | Description |
|---------|-------------|
| `/skills` | List all available skills |
| `/skills-search <keyword>` | Search skills by keyword |

## How it works

1. **Resolver** scans all skill locations (global `~/.pi/agent/skills/`, `~/.agents/skills/`, project `.pi/skills/`, git/npm packages)
2. **Parser** extracts `$skill_name` references from user input
3. **Injector** reads SKILL.md and injects content into system prompt before the agent runs
4. **Autocomplete** provides `$` + Tab suggestions during typing

## Architecture

```
pi-multi-skills/
├── package.json    # Pi package metadata
├── index.ts        # Event wiring: input → before_agent_start → turn_end
├── resolver.ts     # Skill discovery from all locations
├── parser.ts       # $skill_name regex parsing
├── tests/          # Unit tests
└── tsconfig.json   # TypeScript strict config
```
