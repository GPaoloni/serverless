/* eslint-disable import/no-extraneous-dependencies */
import '@twilio-labs/serverless-runtime-types';
import * as TE from 'fp-ts/lib/TaskEither';
import * as T from 'fp-ts/lib/Task';
import * as E from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/pipeable';
import { flow } from 'fp-ts/lib/function';
import * as t from 'io-ts';
import { failure } from 'io-ts/lib/PathReporter';
import {
  Context,
  ServerlessCallback,
  ServerlessFunctionSignature,
  TwilioResponse,
} from '@twilio-labs/serverless-runtime-types/types';
import { WorkspaceInstance } from 'twilio/lib/rest/taskrouter/v1/workspace';
import { WorkerInstance } from 'twilio/lib/rest/taskrouter/v1/workspace/worker';

const TokenValidator = require('twilio-flex-token-validator').functionValidator;

// Code that can be factored out

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

const decodeWith = <A>(decoder: t.Decoder<unknown, A>) =>
  flow(
    decoder.decode,
    E.mapLeft(errors => failure(errors).join('\n')),
    E.mapLeft(message => ({ message, status: 400 })),
    TE.fromEither,
  );

// Code specific to this endpoint

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

const reqbody = t.type({
  workspaceSID: t.string,
  helpline: t.string,
});

type ReqBody = t.TypeOf<typeof reqbody>;

export const handler: ServerlessFunctionSignature = TokenValidator(
  async (context: Context, event: ReqBody, callback: ServerlessCallback) => {
    const response = getStandardResponse();

    try {
      const runEndpoint = pipe(
        TE.right(event),
        TE.chain(decodeWith(reqbody)),
        TE.map(({ workspaceSID }) => workspaceSID),
        TE.chain(getWorkspace(context)),
        TE.chain(getWorkers),
        TE.chain(extractAttributes),
        TE.map(filterIfHelpline(event.helpline)),
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
