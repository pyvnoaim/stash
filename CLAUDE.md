# Stash

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
(`settings-dialog.tsx:287`). Portainer strips `.git` from its clone before building, so there is
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
