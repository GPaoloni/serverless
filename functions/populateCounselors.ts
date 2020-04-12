/* eslint-disable import/no-extraneous-dependencies */
import '@twilio-labs/serverless-runtime-types';
import { left, right, chain, fold, map, tryCatch } from 'fp-ts/lib/TaskEither';
import { of } from 'fp-ts/lib/Task';
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

const send = (response: TwilioResponse) => (statusCode: number) => (body: string | object) => (
  callback: ServerlessCallback,
) => {
  response.setStatusCode(statusCode);
  response.setBody(body);
  callback(null, response);
};

type EventBody = {
  workspaceSID: string | undefined;
  helpline: string | undefined;
};

const parse = (workspaceSID: string | undefined) =>
  workspaceSID
    ? right(workspaceSID)
    : left({ message: 'Error: WorkspaceSID parameter not provided', status: 400 });

const getWorkspace = (context: Context) => (sid: string) => {
  return tryCatch(
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
};

const getWorkers = (workspace: WorkspaceInstance) => {
  return tryCatch(
    () => workspace.workers().list(),
    () => ({
      message: "Error: couldn't retrieve workers for the WorkspaceSID provided",
      status: 502,
    }),
  );
};

const extractAttributes = (workers: WorkerInstance[]) => {
  return tryCatch(
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
};

const filterIfHelpline = (helpline: string | undefined) => (
  values: {
    sid: string;
    fullName: string;
    helpline: string;
  }[],
) => {
  if (helpline) {
    return values
      .filter(w => w.helpline === helpline)
      .map(({ fullName, sid }) => ({ fullName, sid }));
  }
  return values.map(({ fullName, sid }) => ({ fullName, sid }));
};

export const handler: ServerlessFunctionSignature = TokenValidator(
  async (context: Context, event: {}, callback: ServerlessCallback) => {
    const response = new Twilio.Response();
    response.appendHeader('Access-Control-Allow-Origin', '*');
    response.appendHeader('Access-Control-Allow-Methods', 'OPTIONS, POST, GET');
    response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.appendHeader('Content-Type', 'application/json');

    try {
      const body = event as EventBody;
      const { helpline, workspaceSID } = body;

      await pipe(
        parse(workspaceSID),
        chain(getWorkspace(context)),
        chain(getWorkers),
        chain(extractAttributes),
        map(filterIfHelpline(helpline)),
        fold(
          err => of(send(response)(err.status)(err)(callback)),
          workerSummaries => of(send(response)(200)({ workerSummaries })(callback)),
        ),
      )();
    } catch (err) {
      send(response)(500)(err)(callback);
    }
  },
);
