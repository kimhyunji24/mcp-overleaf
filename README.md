# mcp-overleaf

An [MCP](https://modelcontextprotocol.io) server that lets Claude, Cursor, and other MCP clients **read, edit, compile and review** your Overleaf LaTeX projects — and lets you **write in Markdown and publish to Overleaf as LaTeX**.

| Tool | What it does | Needs |
|---|---|---|
| `write_markdown` | Convert Markdown to LaTeX and write it to a file or replace a section | git **or** cookie (none for `dry_run`) |
| `list_projects` | List your projects and their IDs | cookie |
| `list_files` | List files in a project | git **or** cookie |
| `read_file` | Read a file (optionally a line range) | git **or** cookie |
| `get_outline` | Section tree across `\input`/`\include`d files, with file:line | git **or** cookie |
| `read_section` | Source of one section by title | git **or** cookie |
| `edit_file` | Exact string replace, then save to Overleaf | git **or** cookie |
| `write_file` | Create / overwrite a file, then save to Overleaf | git **or** cookie |
| `compile` | Compile on Overleaf; errors and warnings with file:line | cookie |
| `download_pdf` | Compile and save the PDF locally | cookie |
| `get_comments` | Review comment threads, with the commented text and location | cookie |
| `add_comment` | Start a comment thread on a passage, like highlighting it in the editor | cookie |
| `reply_comment` | Reply to a comment thread | cookie |
| `resolve_comment` | Resolve or reopen a comment thread | cookie |
| `move_file` | Rename or move a file or folder (creates target folders) | git **or** cookie |
| `delete_file` | Delete a file or folder (restorable from History) | git **or** cookie |

Projects can be referred to by ID, by Overleaf URL, or (with a cookie) by name.

## Writing in Markdown

Draft in Markdown (or have your assistant draft it), then let `write_markdown` turn it into LaTeX inside your Overleaf project:

```markdown
## Method {#sec:method}

We fine-tune the model of @sec:background on our data [@smith2020; @lee2021, p. 3].
The loss is $\mathcal{L} = -\sum_i \log p(y_i)$.

$$
\theta^* = \arg\min_\theta \mathcal{L}(\theta)
$$ {#eq:opt}

![Overview of the pipeline](figs/pipeline.pdf){#fig:pipeline width=80%}

| Model | Acc. |
|:------|-----:|
| Ours  | 91.2 |

Table: Main results {#tbl:main}
```

becomes `\section{Method}\label{sec:method}`, `\cite{smith2020,lee2021}`, an `equation` with `\label{eq:opt}`, a `figure` and a `table` with captions and labels.

| Markdown | LaTeX |
|---|---|
| `#`, `##`, … | shallowest level → `\section` (or `top_level`), then `\subsection`, … |
| `## Title {#sec:x}` / `{-}` | `\label{sec:x}` / starred (unnumbered) heading |
| `*it*`, `**bold**`, `` `code` ``, `~~strike~~` | `\emph`, `\textbf`, `\texttt`, `\sout` |
| `$…$`, `$$…$$ {#eq:x}` | kept as-is / `equation` with label |
| `[@a; @b, p. 3]`, `@a` | `\cite[p. 3]{a,b}`, `\cite{a}` |
| `@fig:x`, `@sec:x`, `@eq:x`, `@tbl:x` | `\ref{…}` |
| `![cap](img){#fig:x width=60%}` | `figure` with `\includegraphics`, caption, label |
| pipe table + `Table: cap {#tbl:x}` | `table` + `tabular` |
| `[^1]` / `^[inline]` footnotes | `\footnote{…}` |
| lists, task lists, `>` quotes, fenced code | `itemize`/`enumerate`, `quote`, `verbatim` |
| `\anycommand{…}`, `\begin{env}…\end{env}` | passed through untouched |

Where it goes:

- `path: "sections/method.tex"`: create or overwrite that file (then `\input` it from your main file). The main file is never overwritten, because that would delete the preamble.
- `path` + `mode: "append"`: add to the end of a file, before `\end{document}`.
- `section: "Method"`: replace an existing section. If your Markdown starts with a heading, the heading is replaced too; otherwise only the body is, and the existing `\label` is kept. Headings are leveled relative to that section.
- `md_path`: read a local `.md` file instead of passing text.
- `dry_run: true`: show the LaTeX without pushing anything.

The tool warns when the output needs a package your preamble doesn't load (e.g. `hyperref` for links, `graphicx` for figures).

## Credentials

mcp-overleaf uses two independent ways in. Configure one or both.

**Git token** (`OVERLEAF_GIT_TOKEN`): the official route, with real commits. Overleaf Git integration requires the project owner to have a paid or institutional plan.
Overleaf → Account Settings → *Git Integration* → *Generate token*.

**Session cookie** (`OVERLEAF_SESSION_COOKIE`): works on **free plans**. Enables listing projects, compiling, PDFs and comments, and reading and writing files when Git is not available. **A cookie alone is enough for everything.**
Log in to overleaf.com, open DevTools → Application (Chrome) / Storage (Firefox) → Cookies → `https://www.overleaf.com`, and copy the value of `overleaf_session2`. It expires when you log out. These are Overleaf's internal web endpoints, not a public API, so they may change.

> Both credentials give full access to your projects. Treat them like passwords and never commit them.

## Setup

Requires Node.js 20+ and git.

### Claude Code

```bash
claude mcp add overleaf -e OVERLEAF_GIT_TOKEN=olp_... -e OVERLEAF_SESSION_COOKIE=s%3A... -- npx -y mcp-overleaf
```

### Claude Desktop / Cursor / others

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "mcp-overleaf"],
      "env": {
        "OVERLEAF_GIT_TOKEN": "olp_...",
        "OVERLEAF_SESSION_COOKIE": "s%3A...",
        "OVERLEAF_PROJECT_ID": "optional default project id"
      }
    }
  }
}
```

On Windows, if the client cannot find `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "mcp-overleaf"]`.

### All options

| Variable | Default | |
|---|---|---|
| `OVERLEAF_GIT_TOKEN` | | Git integration token |
| `OVERLEAF_SESSION_COOKIE` | | `overleaf_session2` value, or a full `name=value` cookie string for other instances |
| `OVERLEAF_PROJECT_ID` | | Default project when a tool call omits `project` |
| `OVERLEAF_BASE_URL` | `https://www.overleaf.com` | Self-hosted / Community Edition URL |
| `OVERLEAF_GIT_URL` | `https://git.overleaf.com` | Git bridge URL. For Server Pro use `https://<your-site>/git` |
| `OVERLEAF_MCP_CACHE_DIR` | `~/.mcp-overleaf` | Where project copies and PDFs are kept |
| `OVERLEAF_GIT_AUTHOR_NAME` / `_EMAIL` | `Overleaf MCP` | Commit author |

## How it works

- **Git mode**: each project is cloned into the cache dir. Reads pull at most every 15 s; every edit pulls, commits, and pushes immediately, rebasing once if someone else edited in the meantime. If the push still fails, the local copy is reset and the error says the change was not saved. The token is passed through environment-scoped git config, so it is never written to disk or shown in the process list.
- Overleaf warns that [pushes from Git can lose or displace tracked changes and comments](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration). Avoid editing passages that have active review comments through Git.
- **Web mode** (no Git access, cookie set): the project zip is downloaded fresh before every write, the change is applied, and the file is saved through the editor's upload endpoint (the same one as "Upload" in the Overleaf UI; missing folders are created). Overleaf applies the new content as a diff, so review comments on unchanged text stay attached (verified on overleaf.com). There are no commits; use Overleaf's History to review or undo. Projects that answer "no git access" are remembered for the session, so Git is not retried.
- File paths are confined to the project; `..`, absolute paths and `.git/` are rejected.

## Development

```bash
npm install
npm test
npm run inspect
```

`npm run inspect` opens the MCP Inspector against the local build.

## Roadmap

- Reviewing tracked changes (accept / reject)
- Uploading images and other binary files
- Diffs and history

Contributions are welcome.

## Acknowledgements

Inspired by [mjyoo2/OverleafMCP](https://github.com/mjyoo2/OverleafMCP) (MIT). This is an independent rewrite.

## License

MIT
