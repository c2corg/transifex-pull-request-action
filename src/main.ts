import * as core from '@actions/core';
import { exec } from '@actions/exec';
import * as github from '@actions/github';
import { writeFileSync } from 'fs';
import { po } from 'gettext-parser';
import { print } from 'graphql/language/printer';
import { join as path } from 'path';
import {
  AddLabels,
  AddLabelsMutation,
  AddLabelsMutationVariables,
  CreatePr,
  CreatePrMutation,
  CreatePrMutationVariables,
  DeleteBranch,
  DeleteBranchMutation,
  DeleteBranchMutationVariables,
  Labels,
  LabelsQuery,
  LabelsQueryVariables,
  TransifexBranch,
  TransifexBranchQuery,
  TransifexBranchQueryVariables,
  UpdatePullRequest,
  UpdatePullRequestMutation,
  UpdatePullRequestMutationVariables,
} from './generated/graphql';

const transifexToken = core.getInput('transifex_token');
const transifexOrganisation = core.getInput('transifex_organisation');
const transifexProject = core.getInput('transifex_project');
const transifexResource = core.getInput('transifex_resource');
const outputFolder = core.getInput('output').endsWith('/') ? core.getInput('output') : core.getInput('output') + '/';
const locales = core
  .getInput('locales')
  .split(',')
  .map((locale) => locale.trim())
  .filter((locale) => !!locale);
const githubToken = core.getInput('github_token');
const repositoryOwner = github.context.repo.owner;
const repositoryName = github.context.repo.repo;
const branch = core.getInput('branch') || 'transifex/i18n-updates';
const baseBranch = core.getInput('base_branch') || 'master';
const labels = (core.getInput('labels') || '')
  .split(',')
  .map((label) => label.trim())
  .filter((label) => !!label);
const transform = core.getInput('transform') || 'none';

const octokit = github.getOctokit(githubToken);

type NestedStrings = {
  [key: string]: string | NestedStrings;
};

const sleep = (ms: number): Promise<unknown> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Sort nested object by its keys.
 */
const sort = (obj: NestedStrings): NestedStrings => {
  const result: NestedStrings = {};
  for (const key of Object.keys(obj).sort()) {
    result[key] = typeof obj[key] === 'string' ? obj[key]! : sort(obj[key] as NestedStrings);
  }
  return result;
};

const fetchTranslation = async (lang: string): Promise<string> => {
  const headers = {
    'Content-Type': 'application/vnd.api+json',
    Authorization: `Bearer ${transifexToken}`,
  };

  const raw = JSON.stringify({
    data: {
      type: 'resource_translations_async_downloads',
      attributes: {
        content_encoding: 'text',
        file_type: 'default',
        mode: 'default',
        pseudo: false,
      },
      relationships: {
        resource: {
          data: {
            type: 'resources',
            id: `o:${transifexOrganisation}:p:${transifexProject}:r:${transifexResource}`,
          },
        },
        language: {
          data: {
            type: 'languages',
            id: `l:${lang}`,
          },
        },
      },
    },
  });

  let response = await fetch('https://rest.api.transifex.com/resource_translations_async_downloads', {
    method: 'POST',
    headers,
    body: raw,
    redirect: 'follow',
  });
  const downloadStatusUrl = response.headers.get('Content-Location');
  if (!downloadStatusUrl) {
    throw new Error(
      `Unable to retrieve translation file for ${lang} (unable to request file download action) [${response.status}]`,
    );
  }

  let attempts = 0;
  do {
    await sleep(1000);
    response = await fetch(downloadStatusUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
    });
  } while (response.status !== 303 && ++attempts < 10);

  const downloadUrl = response.headers.get('location');
  if (!downloadUrl) {
    throw new Error(
      `Unable to retrieve translation file for ${lang} (unable to retrieve file download location) [${response.status}]`,
    );
  }
  response = await fetch(downloadUrl);
  return response.text();
};

function poToJson(src: string, lang: string): string {
  // parse gettext file
  const gettext = po.parse(src);
  // build JSON file from gettext
  const json: {
    [lang: string]: {
      [msgid: string]: string | { [msgctxt: string]: string };
    };
  } = {};
  for (const msgctxt in gettext.translations) {
    const values = gettext.translations[msgctxt];
    for (let msgid in values) {
      msgid = msgid.trim();
      if (!msgid) {
        // skip artifactory empty key
        continue;
      }
      const { msgstr: msgstrs } = values[msgid]!;
      const msgstr = msgstrs[0]; // we do not handle specific formats
      if (!msgstr || !msgstr.trim() || msgid === msgstr.trim()) {
        // to save bits, skip entries whose value is equal to key or empty
        continue;
      }

      const jsonLang = json[lang] || {};
      if (msgctxt !== '') {
        jsonLang[msgid] = jsonLang[msgid] || {};
        if (typeof jsonLang[msgid] === 'string') {
          jsonLang[msgid] = { $$noContext: jsonLang[msgid] as string };
        }
        (jsonLang[msgid] as { [msgctxt: string]: string })[msgctxt] = msgstr;
      } else {
        if (typeof jsonLang[msgid] === 'object') {
          (jsonLang[msgid] as { [msgctxt: string]: string })['$$noContext'] = msgstr;
        } else {
          jsonLang[msgid] = msgstr;
        }
      }
      json[lang] = jsonLang;
    }
  }
  return JSON.stringify(sort(json), null, 2);
}

async function run(): Promise<void> {
  try {
    // check if there is a branch and a pull request matching already existing for translations
    const queryData: TransifexBranchQueryVariables = {
      owner: repositoryOwner,
      name: repositoryName,
      branch,
    };
    const query = await octokit.graphql<TransifexBranchQuery>({ query: print(TransifexBranch), ...queryData });

    let transifexBranchExists = query?.repository?.refs?.totalCount || false;
    let transifexPR: string | undefined = undefined;
    if (transifexBranchExists) {
      const pullRequests = query?.repository?.refs?.edges?.[0]?.node?.associatedPullRequests;
      if (pullRequests?.totalCount === 1) {
        transifexPR = pullRequests.edges?.[0]?.node?.id;
      }
    }
    if (transifexBranchExists && !transifexPR) {
      // delete branch first, it should have been done anyway when previous PR was merged
      core.info(`Branch ${branch} already exists but no PR associated, delete it first`);
      const queryData: DeleteBranchMutationVariables = {
        input: {
          // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
          refId: query?.repository?.refs?.edges?.[0]?.node?.id!,
        },
      };
      octokit.graphql<DeleteBranchMutation>({ query: print(DeleteBranch), ...queryData });
      transifexBranchExists = !transifexBranchExists;
    }

    // keep track of current branch
    let currentBranch = '';
    await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      listeners: {
        stdout: (data: Buffer): void => {
          currentBranch += data.toString().trim();
        },
      },
    });

    if (transifexBranchExists) {
      core.info(`Checkout branch ${branch}`);
      await exec('git', ['fetch']);
      await exec('git', ['checkout', branch]);
      await exec('git', ['rebase', `origin/${baseBranch}`]);
    } else {
      core.info(`Create new branch ${branch}`);
      await exec('git', ['checkout', '-b', branch]);
    }

    // retrieve gettext files from transifex and transform them to appropriate JSON files.
    core.info('Retrieve translations from Transifex');
    for (const lang of locales) {
      core.info(`  > ${lang}`);
      const translationBody = await fetchTranslation(lang);

      let content: string = translationBody;
      switch (transform) {
        case 'po-to-json':
          content = poToJson(content, lang) + '\n';
          break;
        case 'none':
        default:
        // nothing to do
      }

      writeFileSync(`${outputFolder}${lang}.json`, content);
    }

    core.info('Check whether new files bring modifications to the current branch');
    let gitStatus = '';
    await exec('git', ['config', 'color.status', 'false']);
    await exec('git', ['status', '-s'], {
      listeners: {
        stdout: (data: Buffer): void => {
          gitStatus += data.toString().trim();
        },
      },
    });
    if (!gitStatus.trim()) {
      core.info('No changes. Exiting');
      return;
    }

    core.info(`Add files and commit on ${baseBranch}`);
    await exec('git', ['add', '.']);
    await exec('git', ['commit', '-a', '-m', 'Update translations from transifex']);

    // setup credentials
    await exec('bash', [path(__dirname, 'setup-credentials.sh')]);

    core.info('Push branch to origin');
    if (transifexBranchExists) {
      await exec('git', ['push', '--force']);
    } else {
      await exec('git', ['push', '--set-upstream', 'origin', branch]);
    }

    // create PR if not exists, update otherwise
    const title = 'i18n: import translations from Transifex 🎓';
    const body = 'Translations have been updated on Transifex. Review changes, merge this PR and have a 🍺.';
    let prId: string;
    if (!transifexPR) {
      core.info(`Creating new PR for branch ${branch}`);
      const queryData: CreatePrMutationVariables = {
        input: {
          title,
          body,
          // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
          repositoryId: query?.repository?.id!,
          baseRefName: baseBranch,
          headRefName: branch,
        },
      };
      const response = await octokit.graphql<CreatePrMutation>({ query: print(CreatePr), ...queryData });
      // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
      prId = response.createPullRequest?.pullRequest?.id!;
    } else {
      core.info('PR already exists, updating');
      const mutationData: UpdatePullRequestMutationVariables = {
        input: {
          pullRequestId: transifexPR,
          title,
          body,
        },
      };
      const response = await octokit.graphql<UpdatePullRequestMutation>({
        query: print(UpdatePullRequest),
        ...mutationData,
      });
      // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
      prId = response.updatePullRequest?.pullRequest?.id!;
    }

    // apply labels (if matching label found, do not attempt to create missing label)
    const labelsQueryData: LabelsQueryVariables = {
      owner: repositoryOwner,
      name: repositoryName,
    };
    const labelIds =
      (await octokit.graphql<LabelsQuery>({ query: print(Labels), ...labelsQueryData })).repository?.labels?.edges
        // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
        ?.filter((edge) => labels.includes(edge?.node?.name!))
        // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
        .map((edge) => edge?.node?.id!) ?? [];
    if (labelIds.length) {
      const addLabelsMutationData: AddLabelsMutationVariables = {
        input: {
          labelableId: prId,
          labelIds,
        },
      };
      await octokit.graphql<AddLabelsMutation>({ query: print(AddLabels), ...addLabelsMutationData });
    }

    // go back to previous branch
    await exec('git', ['checkout', currentBranch]);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

run();
