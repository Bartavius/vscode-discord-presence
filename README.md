# Discord Presence (Private)

A minimal VS Code extension that shows your editor activity on Discord. It is a privacy-first replacement for `icrawl.discord-vscode`.

## What Discord receives

Discord receives exactly this, and nothing else:

| Situation | Shown on Discord |
|---|---|
| No file open | `Idling` |
| Editing | `Editing a typescript file` (or `Coding` when `showLanguage` is off) |
| Debugging | `Debugging a typescript file` (or `Debugging`) |

It also gets an elapsed-time counter starting from when the window opened, plus your application's `vscode` image.

It never reads or sends file names, paths, workspace or folder names, remote hosts, git branches, or repository URLs. `src/activity.ts` has no input field for any of them, so a setting can't turn them on.

## Security properties

- **No runtime dependencies.** The shipped bundle uses only `vscode` and Node built-ins (`net`, `crypto`, `fs`, `os`, `path`). It makes no HTTP requests and opens no WebSockets. It only talks to Discord's local socket.
- **Bounded parsing.** Frames over 64 KB, or that aren't valid JSON, drop the connection instead of being buffered.
- **Socket trust check.** On macOS and Linux it only connects to a real socket file (not a symlink) owned by your user account. The folder it's in must also be one no other user can write to, or a sticky folder like `/tmp`, so nobody can swap the socket between the check and the connect.
- **User-only settings.** Every setting is `application`-scoped, so a cloned repo's `.vscode/settings.json` can't change them.
- **No auto-updates.** It is installed from a local `.vsix` and never published, so nobody else can push an update to you.
- **Pinned build tools.** Dev dependencies are pinned to exact versions and locked in `pnpm-lock.yaml`. pnpm 10 doesn't run dependency install scripts.

## Setup

1. **Create a Discord application.** Go to <https://discord.com/developers/applications> and click **New Application**. Its name is what appears after "Playing", for example "Visual Studio Code".
2. **Add the image.** Under **Rich Presence → Art Assets**, upload an image named `vscode`.
3. **Copy the Application ID** from **General Information**.
4. **Build:**
   ```sh
   pnpm install
   pnpm package        # typecheck + tests + build -> vscode-discord-presence.vsix
   ```
5. **Install:** in VS Code, open the Command Palette and run **Extensions: Install from VSIX...**, then pick `vscode-discord-presence.vsix`.
6. **Configure:** in your user settings, set `"discordPresence.clientId": "<your application ID>"`.

Discord's desktop app must be running, with activity sharing turned on under **User Settings → Activity Privacy**.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `discordPresence.enabled` | `true` | Turn presence on or off. The status bar item also toggles it. |
| `discordPresence.clientId` | `""` | Your Discord application ID. Nothing connects until this is set. |
| `discordPresence.showLanguage` | `true` | Include the active file's language. |

Commands: **Discord Presence: Toggle** and **Discord Presence: Reconnect**.

## Development

```sh
pnpm check     # tsc --noEmit + node --test (Node >= 22.18 for TypeScript type stripping)
pnpm build     # esbuild -> dist/extension.cjs
pnpm package   # check + build + .vsix
```

`test/ipc.test.ts` runs the real client against a fake Discord socket server. It covers the handshake, `SET_ACTIVITY`, ping/pong, oversized frames, and rejected client IDs.

When updating dev dependencies, prefer releases that are at least two weeks old, and review the lockfile diff.
