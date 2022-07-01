import { writeFileSync } from 'fs';
import { join as path } from 'path';
import fetch from 'node-fetch';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { exec } from '@actions/exec';
import { po } from 'gettext-parser';
import { print } from 'graphql/language/printer';
import {
  CreatePr,
  CreatePrMutation,
  CreatePrMutationVariables,
  DeleteBranch,
  DeleteBranchMutation,
  DeleteBranchMutationVariables,
  TransifexBranch,
  TransifexBranchQuery,
  TransifexBranchQueryVariables,
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
const branch = core.getInput('branch');

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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    result[key] = typeof obj[key] === 'string' ? obj[key]! : sort(obj[key] as NestedStrings);
  }
  return result;
};

const fetchTranslation = async (lang: string): Promise<string> => {
  const headers: HeadersInit = {
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
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-non-null-asserted-optional-chain
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
      await exec('git', ['rebase', 'origin/master']);
    } else {
      core.info(`Create new branch ${branch}`);
      await exec('git', ['checkout', '-b', branch]);
    }

    // retrieve gettext files from transifex and transform them to appropriate JSON files.
    core.info('Retrieve translations from Transifex');
    for (const lang of locales) {
      core.info(`  > ${lang}`);
      const translationBody = await fetchTranslation(lang);
      // parse gettext file
      const gettext = po.parse(translationBody);

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
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
        }
      }
      writeFileSync(`${outputFolder}${lang}.json`, JSON.stringify(sort(json), null, 2) + '\n');
    }

    core.info('Check whether new files bring modifications to the current branch');
    let gitStatus = '';
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

    core.info('Add files and commit on master');
    await exec('git', ['add', '.']);
    await exec('git', ['commit', '-m', 'Update translations from transifex']);

    // setup credentials
    await exec('bash', [path(__dirname, 'setup-credentials.sh')]);

    core.info('Push branch to origin');
    if (transifexBranchExists) {
      await exec('git', ['push', '--force']);
    } else {
      await exec('git', ['push', '--set-upstream', 'origin', branch]);
    }

    // create PR if not exists
    if (!transifexPR) {
      core.info(`Creating new PR for branch ${branch}`);
      const queryData: CreatePrMutationVariables = {
        input: {
          title: '🎓 Import i18n from Transifex',
          body: 'Translations have been updated on Transifex. Review changes, merge this PR and have a 🍺.',
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-non-null-asserted-optional-chain
          repositoryId: query?.repository?.id!,
          baseRefName: 'master',
          headRefName: branch,
        },
      };
      await octokit.graphql<CreatePrMutation>({ query: print(CreatePr), ...queryData });
    } else {
      core.info('PR already exists');
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
