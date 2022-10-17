# transifex-pull-request-action

A Github Action that fetches translations from transifex and proposes a pull request to merge these.

## Edit / add GraphQL queries and mutations

`src/types` folder contains generated type definitions based on queries. Run `npm run types` to update.

## Release a version

```sh
npm run lint
npm run build
npm run pack
```

Then bump version number in `package.json` and `package-lock.json`. Push commits.

Keep an major version tag synchronized with updates, e.g. if you publish version `v2.0.3`, then a `v2` branch should be positioned at the same location.
