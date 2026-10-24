/**
 * 6 个工具的 description 常量（给模型看）。
 * 「用法说明 + 注意事项」格式，内容对齐 Claude Code 的工具描述习惯。
 */

export const BashDescription = `Executes a given bash command in the working directory with a timeout.

Usage:
- Commands run in a persistent working directory (the project root); each call gets a fresh shell.
- Output (stdout + stderr) and exit code are returned as text; commands with heavy output are truncated.
- Timing-sensitive commands (tests, dev servers) should pipe or redirect output to a file, then read it.
- When searching with grep, always quote the pattern and target path explicitly.

Notes:
- IMPORTANT: Avoid using this tool to run cat, head, tail, sed, awk, or echo commands. Instead use the dedicated ReadFile, EditFile, or WriteFile tools which provide a better experience.
- Use Glob to find files by name and Grep to search file contents instead of find / grep on the command line.
- Quote paths that contain spaces with double quotes.
- NEVER modify git config, run destructive git commands (reset --hard, push --force, branch -D, clean -fd), or commit/push without the user asking.
- NEVER use --no-verify or skip hooks; do not add secrets to commands or logs.`;

export const ReadFileDescription = `Reads a file from the local filesystem and returns its text content with line numbers (line numbers start at 1; the format is \`lineno\\tcontent\`).

Usage:
- Reads up to 2000 lines by default; use offset (0-based line offset) and limit to page through longer files.
- Line numbers let you reference exact locations in later edits and replies.
- Prefer absolute paths; the working directory can change between calls.

Notes:
- If the file does not exist or the path is a directory, a structured error is returned.
- Do not use this tool for directory listings — use Glob with a pattern instead.`;

export const WriteFileDescription = `Writes text content to a file, overwriting it if it already exists. Parent directories are created automatically.

Usage:
- Provide the full text content; the whole file is replaced, not appended.
- Prefer absolute paths.
- For targeted changes to an existing file, prefer EditFile over rewriting the whole file.

Notes:
- Overwrites cannot be undone; make sure the full content is what you intend.
- If the path cannot be written, a structured error is returned.`;

export const EditFileDescription = `Performs an exact string replacement in a file: replaces old_string with new_string.

Usage:
- You MUST read the file with ReadFile before editing. This tool will fail otherwise.
- old_string must match the file content exactly, including whitespace and indentation.
- old_string must be unique in the file unless replace_all is true; include surrounding context lines to make it unique.
- Read the file first so you know the exact current content before editing.

Notes:
- Returns a clear error with the match count when old_string matches 0 times or more than once (and replace_all is not set) — adjust old_string or set replace_all and retry.
- Setting replace_all to true replaces every occurrence.`;

export const GlobDescription = `Finds files matching a glob pattern (e.g. \`**/*.ts\`, \`src/**/*.test.ts\`) and returns matching file paths.

Usage:
- Optional path argument sets the search root (defaults to the working directory).
- Results ignore common uninteresting directories (.git, node_modules, dist, build, vendor, venv, etc.) and are sorted by most recently modified, capped at 1000 entries.

Notes:
- Use Glob when you know (part of) the file name; use Grep when you need to find content inside files.
- dotfiles/dot-directories are not matched.`;

export const GrepDescription = `Searches file contents with a case-insensitive regular expression and returns matches as \`file:line:content\`.

Usage:
- Optional path limits the search to a file or directory; optional include filters file names by glob (e.g. \`*.ts\`).
- Results are capped at 500 matches; a truncation notice is appended when the cap is hit.

Notes:
- Use Grep to find where something is defined or used; combine with ReadFile to inspect matches.
- Invalid regular expressions return a structured error.`;
