# Contributing

Thanks for helping improve this project! Two ways to contribute:

## Report a bug or request a feature

Open an **Issue** and use the matching template:

- **Bug report** — something does not work. Include what you ran, what you
  expected, what actually happened, and the error text.
- **Feature request** — a tool or improvement you need (for example a new
  WhatsApp action the MCP should expose).

Please search existing issues first to avoid duplicates. **Never paste a
session folder, `creds.json`, pairing codes, API keys or `.env` contents
into an issue** — a session is a full WhatsApp login.

## Send a fix or an update (fork + pull request)

1. **Fork** this repository.
2. Create a branch in your fork: `fix/<short-name>` or `feat/<short-name>`.
3. Make your change. Keep it focused — one bug or one feature per PR.
4. Test before you submit:
   - `node --check src/index.js` (and any file you touched)
   - Start the server offline (`WA_AUTOCONNECT=0`) and confirm the tools
     list still loads; if you added a tool, confirm it appears.
   - If you touched pairing, describe how you tested it (QR or code).
5. Open a **Pull Request** against `main` with a clear description of what
   changed and why.

## Ground rules

- English only in code, comments, docs and commit messages.
- Never commit `session/`, `session.zip`, `wa-session.zip`, `.env` or any
  credentials — they are git-ignored on purpose.
- New tools follow the existing pattern in `src/index.js`: zod schema,
  short English description, an `audit(...)` line, and a JSON result via
  the `ok(...)` helper.
- Be kind in issues and reviews.
