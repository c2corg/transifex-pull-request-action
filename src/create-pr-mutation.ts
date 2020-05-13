import { gql } from './utils';

export default gql`
  mutation CreatePRMutation($input: CreatePullRequestInput!, $body: String!) {
    createPullRequest(input: $input) {
      clientMutationId
      pullRequest {
        body
        title
      }
    }
  }
`;
