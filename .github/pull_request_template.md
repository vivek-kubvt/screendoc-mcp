<!-- screendoc-mcp — PR template. Flow: feature/* → develop → staging → production -->

## What & why

<!-- One or two lines: what this changes and the reason. -->

## Target branch

- [ ] `develop` — feature / fix (default)
- [ ] `staging` — promoting develop for QA (release candidate)
- [ ] `production` — promoting a tagged release

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `CHANGELOG.md` updated under **[Unreleased]**
- [ ] Version bump done via `npm run release:*` (release PRs only)
