import { writeFileSync } from 'fs';
import { join as path } from 'path';
import fetch from 'node-fetch';
import * as core from '@actions/core';
import { GitHub, context } from '@actions/github';
import { exec } from '@actions/exec';
import { RequestParameters } from '@octokit/graphql/dist-types/types';
import { po } from 'gettext-parser';

import createPRMutation from './create-pr-mutation';
import transifexBranchQuery from './transifex-branch-query';
import { CreatePRMutationVariables, CreatePRMutation } from './types/CreatePRMutation';
import {
  TransifexBranchQuery,
  TransifexBranchQueryVariables,
  TransifexBranchQuery_repository_refs_edges,
  TransifexBranchQuery_repository_refs_edges_node_associatedPullRequests_edges,
} from './types/TransifexBranchQuery';

const transifexToken = core.getInput('transifexToken');
const transifexProject = core.getInput('transifexProject');
const transifexResource = core.getInput('transifexResource');
const locales = core
  .getInput('locales')
  .split(',')
  .map((locale) => locale.trim())
  .filter((locale) => !!locale);
const githubToken = core.getInput('githubToken');
const repositoryOwner = context.repo.owner;
const repositoryName = context.repo.repo;
const branch = core.getInput('branch');

const octokit = new GitHub(githubToken);

// helper function to make apollo generated types work with octokit graphql queries
const graphql = <Q, V>(query: string, variables: V): Promise<Q | null> => {
  return octokit.graphql(query, (variables as unknown) as RequestParameters) as Promise<Q | null>;
};

type NestedStrings = {
  [key: string]: string | NestedStrings;
};

/**
 * Sort nested object by its keys.
 */
const sort = (obj: NestedStrings): NestedStrings => {
  const result: NestedStrings = {};
  for (const key of Object.keys(obj).sort()) {
    result[key] = typeof obj[key] === 'string' ? obj[key] : sort(obj[key] as NestedStrings);
  }
  return result;
};

async function run(): Promise<void> {
  try {
    // check if there is a branch and a pull request matching already existing for translations
    const query = await graphql<TransifexBranchQuery, TransifexBranchQueryVariables>(transifexBranchQuery, {
      owner: repositoryOwner,
      name: repositoryName,
      branch,
    });

    const transifexBranchExists = query?.repository?.refs?.totalCount || false;
    let transifexPR: string | undefined = undefined;
    if (transifexBranchExists) {
      const pullRequests = (query?.repository?.refs?.edges as ReadonlyArray<
        TransifexBranchQuery_repository_refs_edges
      >)[0].node?.associatedPullRequests;
      if (pullRequests?.totalCount === 1) {
        transifexPR = (pullRequests.edges as ReadonlyArray<
          TransifexBranchQuery_repository_refs_edges_node_associatedPullRequests_edges
        >)[0].node?.id;
      }
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

    // checkout transifex branch or create it
    if (transifexBranchExists) {
      await exec('git', ['checkout', branch]);
    } else {
      await exec('git', ['checkout', '-b', branch]);
    }

    // retrieve gettext files from transifex and transform them to appropriate JSON files.
    const transifexBaseUrl = `https://www.transifex.com/api/2/project/${transifexProject}/resource/${transifexResource}`;
    for (const lang of locales) {
      const response = await fetch(`${transifexBaseUrl}/translation/${lang}/?mode=reviewed&file`, {
        headers: {
          Authorization: `Basic ${Buffer.from('api:' + transifexToken).toString('base64')}`,
        },
      });
      if (response.status !== 200) {
        throw new Error(`Error when retrieving lang ${lang}`);
      }

      // parse gettext file
      const gettext = po.parse(await response.text());

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
          const { msgstr: msgstrs } = values[msgid];
          const msgstr = msgstrs[0]; // we do not handle specific formats
          if (!msgstr.trim() || msgid === msgstr.trim()) {
            // to save bits, skip entries whose value is equal to key or empty
            continue;
          }

          json[lang] = json[lang] || {};
          if (msgctxt !== '') {
            json[lang][msgid] = json[lang][msgid] || {};
            if (typeof json[lang][msgid] === 'string') {
              json[lang][msgid] = { $$noContext: msgstr };
            }
            (json[lang][msgid] as { [msgctxt: string]: string })[msgctxt] = msgstr;
          } else {
            if (typeof json[lang][msgid] === 'object') {
              (json[lang][msgid] as { [msgctxt: string]: string }).$$noContext = msgstr;
            } else {
              json[lang][msgid] = msgstr;
            }
          }
        }
      }
      writeFileSync(`src/translations/dist/${lang}.json`, JSON.stringify(sort(json), null, 2));
    }

    // check whether new files bring modifications to the current branch
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

    // add files, commit and rebase on master
    await exec('git', ['add', '.']);
    await exec('git', ['commit', '-m', '"Update translations from transifex"']);
    await exec('git', ['rebase', 'origin/master']);

    // setup credentials
    await exec('bash', [path(__dirname, 'setup-credentials.sh')]);

    // push branch
    if (transifexBranchExists) {
      await exec('git', ['push']);
    } else {
      await exec('git', ['push', '--set-upstream', 'origin', branch]);
    }

    // create PR if not exists
    if (!transifexPR) {
      await graphql<CreatePRMutation, CreatePRMutationVariables>(createPRMutation, {
        input: {
          title: 'Import i18n from Transifex',
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          repositoryId: query?.repository?.id!,
          baseRefName: 'master',
          headRefName: branch,
        },
      });
    }

    // go back to previous branch
    await exec('git', ['checkout', currentBranch]);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
