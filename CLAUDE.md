# Stash

A personal tool for one person: the owner, on their own server (stash.pyvno.xyz) and their own
Macs. Build for that. No onboarding for other users, no self-hosting guidance for anyone else, no
notarization or App Store concerns.

- Web app: React + Vite + Tailwind + shadcn in `src/`, sync server and MCP in `server/`.
- Mac app: `macos/Stash.swift`, a WKWebView around the live site, plus what a tab cannot do (Disk
  tool, ⌃⌥Space capture, notifications, self-update). The page's half is `src/lib/mac.ts`.
- How it should look and read: **`DESIGN.md`**. Follow it for any UI or copy change.

Checks before any push: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## Bump the version on every push

`main` is what deploys. A push to `origin/main` fires a GitHub webhook at Portainer, which
re-clones the repo and rebuilds the stack — so every push is a release, and the version has to
move with it.

Before committing, bump `package.json`:

```sh
npm version patch --no-git-tag-version
```

Then stage `package.json` and `package-lock.json` with the rest of the change, so one commit
carries both the work and the version it shipped as. `--no-git-tag-version` matters: plain
`npm version patch` makes its own commit and tag, which splits the bump away from the change it
describes.

Which part to move:

- **patch** — fixes, refactors, copy, styling. The default; use it unless there's a reason not to.
- **minor** — a new feature someone would notice.
- **major** — a breaking change to the sync API, the stored document shape, or the server routes.

### Why it matters

The version is the only way to tell what a deployment is actually running. `vite.config.ts` reads
it out of `package.json` into `__BUILD__`, and Settings → About shows it beside `__BUILT_AT__`
(`settings-dialog.tsx:352`). Portainer strips `.git` from its clone before building, so there is
no commit sha on the deployed side — `__BUILD__` is the whole story. Leave the version alone and
two different builds both claim to be the same one, and the only thing separating them is a
timestamp.

That also makes it the way to check a deploy landed: if the webhook fired but Settings still shows
the old version, Portainer re-cloned without rebuilding the image.

Never push tags by hand: a tag push is a `push` event too, and the Portainer webhook would deploy
twice.

## Don't commit lockfile churn

`npm` rewrites `package-lock.json` when the local npm is a different version from the one that
generated it — dropping `libc` platform fields and optional native deps. `Dockerfile` runs
`npm ci` on `node:24-alpine` (musl), which needs exactly that metadata to resolve the right
binaries. If `package-lock.json` shows up modified and you didn't change a dependency, revert it:

```sh
git checkout -- package-lock.json
```

The version-field change from `npm version` is the one legitimate exception.

## The Mac app ships as `public/Stash.zip`

The site's "Get the Mac app" serves `public/Stash.zip`, and installed apps update themselves from it
(`update()` in `macos/Stash.swift`), so a new zip is a release to every Mac the app is on. The
Docker build is Linux and cannot compile Swift, so `macos/build.sh` builds it here and writes three
files to commit together: the zip, `Stash.zip.sig`, and `mac.json`. Any change to `macos/` means
bumping the version first, then rerunning `macos/build.sh` — the zip carries the version, and an
app only updates when `mac.json` names a newer one.

The signature is made with `~/.config/stash/mac-update.key`, which is not in the repo. Installed apps
accept only zips signed with it, and only a newer version than they run. Lose the key and
`sign.swift` makes a new one, and each Mac's app has to be replaced by hand once, because it
still trusts the old key.
