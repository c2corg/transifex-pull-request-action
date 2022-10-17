# transifex-pull-request-action

A Github Action that fetches translations from transifex and proposes a pull request to merge these.

## Usage

```yaml
name: Retrieve i18n from Transifex

on:
  workflow_dispatch:
  schedule:
    - cron: '0 */6 * * *'

jobs:
  retrieve-18n:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3
        with:
          fetch-depth: 0
      - name: Configure git
        run: |
          git config --global user.email "action@github.com"
          git config --global user.name "GitHub Action"
      - name: Retrieve i18n from Transifex and create PR if applies
        uses: c2corg/transifex-pull-request-action@v3
        with:
          transifex_token: ${{ secrets.TRANSIFEX_TOKEN }}
          transifex_organisation: camptocamp-association
          transifex_project: c2corg_ui
          transifex_resource: main
          output: src/translations
          locales: ca, de, en, es, eu, fr, hu, it, ru, sl, zh_CN
          github_token: ${{ secrets.GITHUB_TOKEN }}
          branch: transifex/i18n
```

## Action inputs

Inputs with defaults are **optional**.

| Name                   | Description                                                                                                                                                                                               | Default                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| github_token           | `GITHUB_TOKEN` (`contents: write`, `pull-requests: write`) or a `repo` scoped [Personal Access Token (PAT)](https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token). |                          |
| transifex_token        | Transifex token.                                                                                                                                                                                          |                          |
| transifex_organisation | Transifex organisation.                                                                                                                                                                                   |                          |
| transifex_project      | Transifex project.                                                                                                                                                                                        |                          |
| transifex_resource     |                                                                                                                                                                                                           |                          |
| branch                 | The pull request branch name.                                                                                                                                                                             | `transifex/i18n-updates` |
| base_branch            | The target branch into which the pull request will be merged.                                                                                                                                             | `master`                 |
| output                 | Folder where to output files.                                                                                                                                                                             |                          |
| locales                | A list of locales to fetch, separated by commas.                                                                                                                                                          |                          |
| labels                 | A comma separated list of labels to apply to the pull request.                                                                                                                                            | (no label)               |

One will usually run this action on a cron basis (say, every day or week)

## Contributing

### Edit / add GraphQL queries and mutations

`src/generated` folder contains generated type definitions based on queries. Run `npm run graphql` to update.

### Release a version

```sh
npm run lint
npm run build
npm run pack
```

Then bump version number in `package.json` and `package-lock.json` using `npm release` command. Push commits.

Keep an major version tag synchronized with updates, e.g. if you publish version `v2.0.3`, then a `v2` branch should be positioned at the same location.
