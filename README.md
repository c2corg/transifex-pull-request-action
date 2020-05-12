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
