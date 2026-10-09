# Claude Desktop Acceptance

- Date: 2026-10-09
- Active Claude config: `C:\Users\王\AppData\Local\Claude-3p\claude_desktop_config.json`
- Bridge config backup: `C:\Users\王\AppData\Local\Claude-3p\claude_desktop_config.json.backup-20261009T141629143Z`

## Result

- Claude Desktop MCP tools appeared: yes. Claude connected to `claude-codex-bridge` and discovered all seven fixed-purpose `codex_*` tools.
- Checkpoint behavior matched: yes. The harmless acceptance session `ccad43d6-1b4e-4dbd-b67b-8ec93179111f` completed `T1`, returned a checkpoint, and did not start another task.
- Final report appeared in the Claude task: yes. After the user replied `继续`, Claude displayed the final report as a normal message and marked the acceptance status as passed.
- Original project modification count: zero. `C:\Users\王\Desktop\单词` still contains only `painless-考研红宝书-20261009.pdf`; its last-write time is 2026-10-09 18:58:58, before the bridge runs. No bridge session points at the original project.
- Real acceptance artifact: `acceptance.txt` contains exactly `bridge acceptance ok`.
- Scripted copied-project run: `C:\Users\王\Documents\Codex\2026-10-09\_bridge-e2e\word-project-copy-20261009-215030` produced 300 records, 300 unique sorted words, 300 TXT records, and 300 CSV data rows with columns `WORD,WORD_CLASS,TRANSLATION`.

## Remaining Issue

The copied word-project output is not byte-for-byte identical to the earlier known-good run because `T1` normalizes full-width `；` part-of-speech separators to ASCII `;`. The record counts and CSV structure match.

Exact reproduction:

1. Copy `C:\Users\王\Desktop\单词` to a temporary project directory.
2. Run the bridge plan through `T1`, `T2`, and `T3`, replying `继续` after each checkpoint.
3. Compare the four output files with the earlier known-good run by SHA-256.

Expected: counts and schema match; byte hashes differ where full-width `；` was normalized to `;`.
