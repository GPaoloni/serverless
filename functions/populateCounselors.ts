/* eslint-disable import/no-extraneous-dependencies */
import '@twilio-labs/serverless-runtime-types';
import TE from 'fp-ts/lib/TaskEither';
import T from 'fp-ts/lib/Task';
import { pipe } from 'fp-ts/lib/pipeable';
import {
  Context,
  ServerlessCallback,
  ServerlessFunctionSignature,
  TwilioResponse,
} from '@twilio-labs/serverless-runtime-types/types';
import { WorkspaceInstance } from 'twilio/lib/rest/taskrouter/v1/workspace';
import { WorkerInstance } from 'twilio/lib/rest/taskrouter/v1/workspace/worker';

const TokenValidator = require('twilio-flex-token-validator').functionValidator;

const getStandardResponse = () => {
  const response = new Twilio.Response();
  response.setHeaders({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  });
  return response;
};

const send = (response: TwilioResponse) => (statusCode: number) => (body: string | object) => (
  callback: ServerlessCallback,
) => {
  response.setStatusCode(statusCode);
  response.setBody(body);
  callback(null, response);
};

const parse = (workspaceSID: string | undefined) =>
  workspaceSID
    ? TE.right(workspaceSID)
    : TE.left({ message: 'Error: WorkspaceSID parameter not provided', status: 400 });

const getWorkspace = (context: Context) => (sid: string) =>
  TE.tryCatch(
    () =>
      context
        .getTwilioClient()
        .taskrouter.workspaces(sid)
        .fetch(),
    () => ({
      message: 'Error: workspace not found with the WorkspaceSID provided',
      status: 502,
    }),
  );

const getWorkers = (workspace: WorkspaceInstance) =>
  TE.tryCatch(
    () => workspace.workers().list(),
    () => ({
      message: "Error: couldn't retrieve workers for the WorkspaceSID provided",
      status: 502,
    }),
  );

const extractAttributes = (workers: WorkerInstance[]) =>
  TE.tryCatch(
    async () =>
      workers.map(w => {
        const attributes = JSON.parse(w.attributes);
        return {
          sid: w.sid,
          fullName: attributes.full_name as string,
          helpline: attributes.helpline as string,
        };
      }),
    () => ({
      message: "Error: couldn't parse JSON response",
      status: 502,
    }),
  );

const filterIfHelpline = (helpline: string | undefined) => (
  workers: {
    sid: string;
    fullName: string;
    helpline: string;
  }[],
) => {
  const filteredWorkers = helpline ? workers.filter(w => w.helpline === helpline) : workers;
  return filteredWorkers.map(({ fullName, sid }) => ({ fullName, sid }));
};

type ReqBody = {
  workspaceSID: string | undefined;
  helpline: string | undefined;
};

export const handler: ServerlessFunctionSignature = TokenValidator(
  async (context: Context, event: ReqBody, callback: ServerlessCallback) => {
    const response = getStandardResponse();

    try {
      const { helpline, workspaceSID } = event;

      const runEndpoint = pipe(
        parse(workspaceSID),
        TE.chain(getWorkspace(context)),
        TE.chain(getWorkers),
        TE.chain(extractAttributes),
        TE.map(filterIfHelpline(helpline)),
        TE.fold(
          err => T.of(send(response)(err.status)(err)(callback)),
          workerSummaries => T.of(send(response)(200)({ workerSummaries })(callback)),
        ),
      );

      await runEndpoint();
    } catch (err) {
      send(response)(500)(err)(callback);
    }
  },
);
