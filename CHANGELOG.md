# Changelog

All notable changes to **screendoc-mcp** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/). Each released version maps to a git tag `vX.Y.Z`
on the `production` branch.

## [Unreleased]

### Added
- Live progress reporting (`notifications/progress` + stderr) for
  `create_document`, `update_document`, and `run_flow`.
- Auto-cleanup of `.docmcp/captures/**` after a successful PDF build
  (`keepCaptures: true` to opt out); flows, recipes, plans, and PDFs are kept.
- Release scripts (`release:patch|minor|major|rc`) and a production/staging/develop
  branch model.

## [0.1.0] - 2026-07-23

### Added
- Initial MCP server: `doc_status`, `project_scan`, `capture_screen`,
  `create_document`, `update_document`, `list_documents`, `plan_capture`,
  `run_flow`, `reconcile_capture`, `save_recipe`, `extract_annotations`,
  `set_credential`.
- Maestro-flow-first capture (iOS + Android), coverage gate, visual-flow PDF
  output, incremental change badges + changelog.
