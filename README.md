# Gemini Decision — magpie provider plugin

> **Third-party community plugin.** Not affiliated with, endorsed by, or sponsored by
> Google. *Gemini* and *Google* are trademarks of Google LLC. This plugin calls Google's
> publicly documented **Gemini Decisions API**
> (`POST https://generativelanguage.googleapis.com/v1beta/decisions`) with **your own**
> API key — no reverse-engineered or private protocol. You bear any account, quota,
> billing and interface-change risk.

Exposes Google's `gemini-decision-1` — a Decisions-API-only, calibrated classifier
(Jev-equivalent) — as a **magpie System One decider**, so it can serve as a
routing-group classifier (hard/easy intent routing, tool selection, policy checks).

## Why a plugin

`gemini-decision-1` supports `createDecision` only, not `generateContent`/chat, and
magpie ships no native Google decision preset (its `decide=` presets are
Bailian/Qwen/Volcengine, all System One). magpie's documented provider-plugin hook is
the sanctioned bridge: the config hook marks the provider `decide: true` and the model
`decides: true`; magpie then posts each classifier question to the provider's
`{baseURL}/systemone` **through the plugin loader's `fetch`**, which translates to the
Google Decisions API and maps the calibrated answers back. No upstream modification.

## Install

```sh
magpie plugin add <path-or-git-url>      # this folder, or its git remote
magpie plugin login gemini-decision      # paste a Google AI Studio API key
magpie provider test gemini-decision     # expect: ✓ decide
```

The key needs access to the Gemini Decisions API (a standard AI Studio key works).
`provider test` shows `✗ chat — no model to try`: **expected**, a `decides` model is
offered as a classifier and refused for chat.

## Use as a routing-group classifier

```sh
# the group needs intent rules; the classifier tells which intent a message is
magpie group rule classifier <group> gemini-decision/gemini-decision-1

# revert to a chat classifier at any time
magpie group rule classifier <group> <provider>/<chat-model>
```

Verify with `magpie usage --csv`: classifier calls appear as `kind=routing` rows for
`gemini-decision-1`; the group request's `served_model` shows the resolved member.

## How it works

magpie's intent classifier is two-phase (see magpie `internal/gateway/decide.go`):

1. **Calibration** (`jevLevelled`): `levels` (noul — "are these kinds one scale?") plus
   `work<N>` (score over a 4-level work scale), state `{kinds:[intent descriptions]}`.
   magpie reads `answers.levels.noul` (≥0.5 ⇒ levels) and each `work<N>.score`.
2. **Classification** (`askJev`/`readJev`): `intent`/`level` (choice) plus `effort`
   (score), state `{message, previous_*}`. magpie reads `choice` + `confidence` +
   `probabilities` (via `sureOf`) and the effort `score`.

Translation performed by the loader `fetch`:

- `state` → `input`: a lone `{message}`/`{text}` becomes plain text; anything else is
  JSON so the questions' `kinds[N]` / `previous_*` references resolve.
- `predicate` → `noul`; choice `criteria` map and score `criteria` array pass through
  (Google accepts null choice descriptions); missing `instructions` are synthesised.
- Answers: noul → `{noul, confidence}`, choice → `{choice, confidence, probabilities}`,
  score → `{score, confidence, probabilities}`. Probabilities pass straight through so
  magpie's `sureOf` can normalise them.
- `usage.total_input_tokens` → `input_tokens` (output is 0) so magpie accounts the call.

## Notes

- **No hot-reload:** restart `magpie serve` after editing `index.ts`.
- **Restricted networks:** the loader honours `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
  (Bun's fetch needs an explicit proxy; the macOS system proxy is ignored).
- **Cost:** Decisions API is $0.10 / 1M input tokens, $0 output; a classifier call is a
  few hundred input tokens.
- Runs on magpie's bundled Bun plugin host; no extra runtime to install.

## Files

- `index.ts` — the plugin (config / auth loader / provider hooks).
- `package.json` — manifest (`magpie` name, summary, concurrency).
- `scripts/git-hooks/pre-commit` — leak guard (see below).

## Development

Git hooks are not versioned, so install the leak guard after cloning:

```sh
cp scripts/git-hooks/pre-commit .git/hooks/pre-commit
```

It scans staged additions for personal info / credential shapes and credential-shaped
filenames, reports counts without printing matched text, and skips itself.

## License

MIT