import * as aws from "aws-sdk";
import { createHash } from "crypto";
import { caches } from "../cache";
import { CostBreakdown, CostMetric } from "../cost";
import { faast } from "../faast";
import { log } from "../log";
import { packer, PackerResult } from "../packer";
import { readFile, ensureDir, writeFile } from "fs-extra";
import {
    CloudFunctionImpl,
    FunctionCounters,
    FunctionStats,
    Invocation,
    PollResult,
    ResponseMessage,
    SendableMessage,
    CommonOptions,
    CommonOptionDefaults,
    CleanupOptions,
    UUID
} from "../provider";
import {
    assertNever,
    computeHttpResponseBytes,
    defined,
    hasExpired,
    uuidv4Pattern
} from "../shared";
import { throttle, retry } from "../throttle";
import * as awsNpm from "./aws-npm";
import {
    createSNSTopic,
    createSQSQueue,
    processAwsErrorMessage,
    publishInvocationMessage,
    sendResponseQueueMessage,
    receiveMessages
} from "./aws-queue";
import { getLogGroupName, getLogUrl } from "./aws-shared";
import * as awsTrampoline from "./aws-trampoline";
import { FunctionReturn, WrapperOptions } from "../wrapper";
import { AwsLayerInfo } from "./aws-npm";
import { join } from "path";

const defaultGcWorker = throttle(
    { concurrency: 5, rate: 5, burst: 2 },
    async (work: AwsGcWork, services: AwsServices) => {
        switch (work.type) {
            case "SetLogRetention":
                if (
                    await quietly(
                        services.cloudwatch.putRetentionPolicy({
                            ...work
                        })
                    )
                ) {
                    log.gc(
                        `Added retention policy of ${work.retentionInDays} day(s) to ${
                            work.logGroupName
                        }`
                    );
                }
                break;
            case "DeleteResources":
                await deleteResources(work.resources, services, log.gc);
                break;
            case "DeleteLayerVersion":
                await services.lambda
                    .deleteLayerVersion({
                        LayerName: work.layerName,
                        VersionNumber: work.layerVersion
                    })
                    .promise();
                log.gc(`deleted layer: ${work.layerName}:${work.layerVersion}`);
                break;
            default:
                assertNever(work);
        }
    }
);

/**
 * AWS-specific options. Extends {@link CommonOptions}.
 * @public
 */
export interface AwsOptions extends CommonOptions {
    /**
     * The region to create resources in. Garbage collection is also limited to
     * this region. Default: `"us-west-2"`.
     */
    region?: AwsRegion;
    /**
     * The role that the lambda function will assume when executing user code.
     * Default: `"faast-cached-lambda-role"`. Rarely used.
     * @remarks
     * When a lambda executes, it first assumes an
     * {@link https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html | execution role}
     * to grant access to resources.
     *
     * By default, faast.js creates this execution role for you and leaves it
     * permanently in your account (the role is shared across all lambda
     * functions created by faast.js). By default, faast.js grants administrator
     * privileges to this role so your code can perform any AWS operation it
     * requires.
     *
     * You can
     * {@link https://console.aws.amazon.com/iam/home#/roles | create a custom role}
     * that specifies more limited permissions if you prefer not to grant
     * administrator privileges. Any role you assign for faast functions needs
     * at least the following permissions:
     *
     * - Execution Role:
     * ```json
     *   {
     *       "Version": "2012-10-17",
     *       "Statement": [
     *           {
     *               "Effect": "Allow",
     *               "Action": ["logs:*"],
     *               "Resource": "arn:aws:logs:*:*:log-group:faast-*"
     *           },
     *           {
     *               "Effect": "Allow",
     *               "Action": ["sqs:*"],
     *               "Resource": "arn:aws:sqs:*:*:faast-*"
     *           }
     *       ]
     *   }
     * ```
     *
     * - Trust relationship (also known as `AssumeRolePolicyDocument` in the AWS
     *   SDK):
     * ```json
     *   {
     *     "Version": "2012-10-17",
     *     "Statement": [
     *       {
     *         "Effect": "Allow",
     *         "Principal": {
     *           "Service": "lambda.amazonaws.com"
     *         },
     *         "Action": "sts:AssumeRole"
     *       }
     *     ]
     *   }
     * ```
     *
     */
    RoleName?: string;
    /**
     * Additional options to pass to AWS Lambda creation.
     * @remarks
     * If you need specialized options, you can pass them to the AWS Lambda SDK
     * directly. Note that if you override any settings set by faast.js, you may
     * cause faast.js to not work:
     *
     * ```typescript
     *   const request: aws.Lambda.Types.CreateFunctionRequest = {
     *       FunctionName,
     *       Role,
     *       Runtime: "nodejs8.10",
     *       Handler: "index.trampoline",
     *       Code,
     *       Description: "faast trampoline function",
     *       Timeout,
     *       MemorySize,
     *       DeadLetterConfig: { TargetArn: responseQueueArn },
     *       ...awsLambdaOptions
     *   };
     * ```
     *
     * One use case for this option is to use
     * {@link https://docs.aws.amazon.com/lambda/latest/dg/configuration-layers.html | Lambda Layers}
     * with faast.js.
     */
    awsLambdaOptions?: Partial<aws.Lambda.Types.CreateFunctionRequest>;
    /** @internal */
    gcWorker?: (work: AwsGcWork, services: AwsServices) => Promise<void>;
}

export let defaults: Required<AwsOptions> = {
    ...CommonOptionDefaults,
    region: "us-west-2",
    RoleName: "faast-cached-lambda-role",
    memorySize: 1728,
    awsLambdaOptions: {},
    gcWorker: defaultGcWorker
};

export interface AwsPrices {
    lambdaPerRequest: number;
    lambdaPerGbSecond: number;
    snsPer64kPublish: number;
    sqsPer64kRequest: number;
    dataOutPerGb: number;
    logsIngestedPerGb: number;
}

export class AwsMetrics {
    outboundBytes = 0;
    sns64kRequests = 0;
    sqs64kRequests = 0;
}

export interface AwsResources {
    FunctionName: string;
    RoleName: string;
    region: AwsRegion;
    ResponseQueueUrl?: string;
    ResponseQueueArn?: string;
    RequestTopicArn?: string;
    SNSLambdaSubscriptionArn?: string;
    logGroupName: string;
    layer?: AwsLayerInfo;
}

export interface AwsServices {
    readonly lambda: aws.Lambda;
    readonly cloudwatch: aws.CloudWatchLogs;
    readonly iam: aws.IAM;
    readonly sqs: aws.SQS;
    readonly sns: aws.SNS;
    readonly pricing: aws.Pricing;
    readonly sts: aws.STS;
}

/**
 * @internal
 */
export interface AwsState {
    resources: AwsResources;
    services: AwsServices;
    options: Required<AwsOptions>;
    metrics: AwsMetrics;
    gcPromise?: Promise<void>;
}

export type AwsGcWork =
    | {
          type: "SetLogRetention";
          logGroupName: string;
          retentionInDays: number;
      }
    | {
          type: "DeleteResources";
          resources: AwsResources;
      }
    | {
          type: "DeleteLayerVersion";
          layerName: string;
          layerVersion: number;
      };

export function carefully<U>(arg: aws.Request<U, aws.AWSError>) {
    return arg.promise().catch(err => log.warn(err));
}

export async function quietly<U>(arg: aws.Request<U, aws.AWSError>) {
    try {
        return await arg.promise();
    } catch (err) {
        return;
    }
}

function zipStreamToBuffer(zipStream: NodeJS.ReadableStream): Promise<Buffer> {
    const buffers: Buffer[] = [];
    return new Promise((resolve, reject) => {
        zipStream.on("data", data => buffers.push(data as Buffer));
        zipStream.on("end", () => resolve(Buffer.concat(buffers)));
        zipStream.on("error", reject);
    });
}

export const createAwsApis = throttle(
    { concurrency: 1, memoize: true },
    async (region: string) => {
        const logger = log.awssdk.enabled ? { log: log.awssdk } : undefined;
        aws.config.update({ correctClockSkew: true, maxRetries: 6, logger });
        const services = {
            iam: new aws.IAM({ apiVersion: "2010-05-08", region }),
            lambda: new aws.Lambda({ apiVersion: "2015-03-31", region }),
            cloudwatch: new aws.CloudWatchLogs({ apiVersion: "2014-03-28", region }),
            sqs: new aws.SQS({ apiVersion: "2012-11-05", region }),
            sns: new aws.SNS({ apiVersion: "2010-03-31", region }),
            pricing: new aws.Pricing({ region: "us-east-1" }),
            sts: new aws.STS({ apiVersion: "2011-06-15", region })
        };
        return services;
    }
);

const ensureRole = throttle(
    { concurrency: 1, rate: 5, memoize: true },
    async (RoleName: string, services: AwsServices) => {
        const { iam } = services;
        log.info(`Checking for cached lambda role`);
        const previousRole = await quietly(iam.getRole({ RoleName }));
        if (previousRole) {
            return previousRole.Role.Arn;
        }
        if (RoleName !== defaults.RoleName) {
            throw new Error(`Could not find role ${RoleName}`);
        }
        log.info(`Creating default role "${RoleName}" for faast trampoline function`);
        const AssumeRolePolicyDocument = JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Principal: { Service: "lambda.amazonaws.com" },
                    Action: "sts:AssumeRole",
                    Effect: "Allow"
                }
            ]
        });
        const roleParams: aws.IAM.CreateRoleRequest = {
            AssumeRolePolicyDocument,
            RoleName,
            Description: "role for lambda functions created by faast",
            MaxSessionDuration: 3600
        };
        log.info(`Calling createRole`);
        const PolicyArn = "arn:aws:iam::aws:policy/AdministratorAccess";
        try {
            const roleResponse = await iam.createRole(roleParams).promise();
            log.info(`Attaching administrator role policy`);
            await iam.attachRolePolicy({ RoleName, PolicyArn }).promise();
            return roleResponse.Role.Arn;
        } catch (err) {
            if (err.code === "EntityAlreadyExists") {
                const roleResponse = await iam.getRole({ RoleName }).promise();
                await iam.attachRolePolicy({ RoleName, PolicyArn }).promise();
                return roleResponse.Role.Arn;
            }
            throw err;
        }
    }
);

export async function createLayer(
    lambda: aws.Lambda,
    packageJson: string | object | undefined,
    useDependencyCaching: boolean,
    FunctionName: string
): Promise<AwsLayerInfo | undefined> {
    if (!packageJson) {
        return;
    }
    log.info(`Building node_modules`);

    const packageJsonContents =
        typeof packageJson === "string"
            ? (await readFile(packageJson)).toString()
            : JSON.stringify(packageJson);

    let LayerName;
    if (useDependencyCaching) {
        const hasher = createHash("sha256");
        hasher.update(packageJsonContents);
        const cacheKey = hasher.digest("hex");
        LayerName = `faast-${cacheKey}`;
        const layers = await quietly(lambda.listLayerVersions({ LayerName }));
        if (layers && layers.LayerVersions) {
            const { Version, LayerVersionArn } = layers.LayerVersions[0];
            if (Version && LayerVersionArn) {
                return { Version, LayerVersionArn, LayerName };
            }
        }
    } else {
        LayerName = FunctionName;
    }

    try {
        const cloudFunc = await faast("aws", awsNpm, require.resolve("./aws-npm"), {
            timeout: 300,
            memorySize: 2048,
            mode: "https",
            gc: false,
            maxRetries: 0,
            webpackOptions: {
                externals: []
            }
        });
        try {
            const installArgs: awsNpm.NpmInstallArgs = {
                packageJsonContents,
                LayerName
            };
            const { installLog, layerInfo } = await cloudFunc.functions.npmInstall(
                installArgs
            );
            log.info(installLog);
            return layerInfo;
        } finally {
            await cloudFunc.cleanup();
        }
    } catch (err) {
        log.warn(`createPackageLayer error:`);
        throw err;
    }
}

export function logUrl(state: AwsState) {
    const { region, FunctionName } = state.resources;
    return getLogUrl(region, FunctionName);
}

export const initialize = throttle(
    { concurrency: Infinity, rate: 2 },
    async (fModule: string, nonce: UUID, options: Required<AwsOptions>, dir: string) => {
        log.info(`Nonce: ${nonce}`);
        const { region, timeout, memorySize } = options;
        log.info(`Creating AWS APIs`);
        const services = await createAwsApis(region);
        const { lambda, sts } = services;
        const FunctionName = `faast-${nonce}`;
        const accountId = await getAccountId(sts);

        const { packageJson, useDependencyCaching } = options;

        async function createFunctionRequest(
            Code: aws.Lambda.FunctionCode,
            Role: string,
            responseQueueArn: string,
            layerInfo?: AwsLayerInfo
        ) {
            const { Layers = [], ...rest } = options.awsLambdaOptions;
            if (layerInfo) {
                Layers.push(layerInfo.LayerVersionArn);
            }
            const request: aws.Lambda.Types.CreateFunctionRequest = {
                FunctionName,
                Role,
                Runtime: "nodejs8.10",
                Handler: "index.trampoline",
                Code,
                Description: "faast trampoline function",
                Timeout: timeout,
                MemorySize: memorySize,
                DeadLetterConfig: { TargetArn: responseQueueArn },
                Layers,
                ...rest
            };
            log.info(`createFunctionRequest: %O`, request);
            try {
                const func = await retry(4, () =>
                    lambda.createFunction(request).promise()
                );
                log.info(
                    `Created function ${func.FunctionName}, FunctionArn: ${
                        func.FunctionArn
                    }`
                );
                return func;
            } catch (err) {
                log.warn(`Could not initialize lambda function: ${err}`);
                throw err;
            }
        }

        async function createCodeBundle() {
            const wrapperOptions = {
                childProcessTimeoutMs: timeout * 1000 - 50
            };
            const bundle = awsPacker(fModule, dir, options, wrapperOptions);
            return { ZipFile: await zipStreamToBuffer((await bundle).archive) };
        }

        const { RoleName } = options;
        const state: AwsState = {
            resources: {
                FunctionName,
                RoleName,
                region,
                logGroupName: getLogGroupName(FunctionName)
            },
            services,
            metrics: new AwsMetrics(),
            options
        };

        const { gc, retentionInDays, gcWorker } = options;
        if (gc) {
            log.gc(`Starting garbage collector`);
            state.gcPromise = collectGarbage(
                gcWorker,
                services,
                region,
                accountId,
                retentionInDays
            );
            state.gcPromise.catch(_silenceWarningLackOfSynchronousCatch => {});
        }

        try {
            log.info(`Creating lambda function`);
            const rolePromise = ensureRole(RoleName, services);
            const responseQueuePromise = createResponseQueueImpl(state, FunctionName);
            const pricingPromise = requestAwsPrices(services.pricing, region);
            const layerPromise = createLayer(
                services.lambda,
                packageJson,
                useDependencyCaching,
                FunctionName
            );

            const codeBundle = await createCodeBundle();
            const packageDir = process.env["FAAST_PACKAGE_DIR"];
            if (packageDir) {
                log.webpack(`FAAST_PACKAGE_DIR: ${packageDir}`);
                const packageFile = join(packageDir, FunctionName) + ".zip";
                await ensureDir(packageDir);
                await writeFile(packageFile, codeBundle.ZipFile);
                log.info(`Wrote ${packageFile}`);
            }
            const roleArn = await rolePromise;
            const responseQueueArn = await responseQueuePromise;
            const layer = await layerPromise;
            if (layer) {
                state.resources.layer = layer;
            }
            const lambda = await createFunctionRequest(
                codeBundle,
                roleArn,
                responseQueueArn,
                layer
            );

            const { mode } = options;
            if (mode === "queue" || mode === "auto") {
                await createRequestQueueImpl(state, FunctionName, lambda.FunctionArn!);
            }
            await pricingPromise;
            log.info(`Lambda function initialization complete.`);
            return state;
        } catch (err) {
            const newError = new Error("Could not initialize cloud function");
            log.warn(`${newError.stack}`);
            log.warn(`Underlying error: ${err.stack}`);
            await cleanup(state, { deleteResources: true, deleteCaches: false });
            throw err;
        }
    }
);

async function invoke(
    state: AwsState,
    call: Invocation,
    cancel: Promise<void>
): Promise<ResponseMessage | void> {
    const { metrics, services, resources, options } = state;
    switch (options.mode) {
        case "https":
            const { lambda } = services;
            const { FunctionName } = resources;
            return invokeHttps(lambda, FunctionName, call, metrics, cancel);
        case "queue":
        case "auto":
            const { sns } = services;
            const { RequestTopicArn } = resources;
            await publishInvocationMessage(sns, RequestTopicArn!, call, metrics);
            return;
        default:
            assertNever(options.mode);
    }
}

function publish(state: AwsState, message: SendableMessage): Promise<void> {
    const { services, resources } = state;
    return sendResponseQueueMessage(services.sqs, resources.ResponseQueueUrl!, message);
}

function poll(state: AwsState, cancel: Promise<void>): Promise<PollResult> {
    return receiveMessages(
        state.services.sqs,
        state.resources.ResponseQueueUrl!,
        state.metrics,
        cancel
    );
}

function responseQueueId(state: AwsState): string | undefined {
    return state.resources.ResponseQueueUrl;
}

async function invokeHttps(
    lambda: aws.Lambda,
    FunctionName: string,
    message: Invocation,
    metrics: AwsMetrics,
    cancel: Promise<void>
): Promise<ResponseMessage | void> {
    const request: aws.Lambda.Types.InvocationRequest = {
        FunctionName,
        Payload: message.body,
        LogType: "None"
    };
    let awsRequest = lambda.invoke(request);
    const rawResponse = await Promise.race([awsRequest.promise(), cancel]);
    if (!rawResponse) {
        log.info(`cancelling lambda invoke`);

        awsRequest.abort();
        return;
    }

    if (rawResponse.LogResult) {
        log.info(Buffer.from(rawResponse.LogResult!, "base64").toString());
    }

    let body: string | FunctionReturn;
    if (rawResponse.FunctionError) {
        const response = processAwsErrorMessage(rawResponse.Payload as string);
        body = {
            type: "error",
            callId: message.callId,
            value: new Error(response)
        };
    } else {
        body = rawResponse.Payload! as string;
    }
    metrics.outboundBytes += computeHttpResponseBytes(
        rawResponse.$response.httpResponse.headers
    );
    return {
        kind: "response",
        callId: message.callId,
        body,
        rawResponse,
        timestamp: Date.now()
    };
}

export async function deleteRole(RoleName: string, iam: aws.IAM) {
    const policies = await carefully(iam.listAttachedRolePolicies({ RoleName }));
    const AttachedPolicies = (policies && policies.AttachedPolicies) || [];
    await Promise.all(
        AttachedPolicies.map(p => p.PolicyArn!).map(PolicyArn =>
            carefully(iam.detachRolePolicy({ RoleName, PolicyArn }))
        )
    ).catch(log.warn);
    const rolePolicyListResponse = await carefully(iam.listRolePolicies({ RoleName }));
    const RolePolicies =
        (rolePolicyListResponse && rolePolicyListResponse.PolicyNames) || [];
    await Promise.all(
        RolePolicies.map(PolicyName =>
            carefully(iam.deleteRolePolicy({ RoleName, PolicyName }))
        )
    ).catch(log.warn);
    await carefully(iam.deleteRole({ RoleName }));
}

async function deleteResources(
    resources: Partial<AwsResources>,
    services: AwsServices,
    output: (msg: string) => void = log.info
) {
    const {
        FunctionName,
        RoleName,
        region,
        RequestTopicArn,
        ResponseQueueUrl,
        ResponseQueueArn,
        SNSLambdaSubscriptionArn,
        logGroupName,
        layer,
        ...rest
    } = resources;
    const _exhaustiveCheck: Required<typeof rest> = {};

    const { lambda, sqs, sns, iam } = services;
    if (SNSLambdaSubscriptionArn) {
        if (
            await quietly(sns.unsubscribe({ SubscriptionArn: SNSLambdaSubscriptionArn }))
        ) {
            output(`Deleted request queue subscription to lambda`);
        }
    }
    if (RoleName) {
        await deleteRole(RoleName, iam);
    }
    if (RequestTopicArn) {
        if (await quietly(sns.deleteTopic({ TopicArn: RequestTopicArn }))) {
            output(`Deleted request queue topic: ${RequestTopicArn}`);
        }
    }
    if (ResponseQueueUrl) {
        if (await quietly(sqs.deleteQueue({ QueueUrl: ResponseQueueUrl }))) {
            output(`Deleted response queue: ${ResponseQueueUrl}`);
        }
    }
    if (layer) {
        if (
            await quietly(
                lambda.deleteLayerVersion({
                    LayerName: layer.LayerName,
                    VersionNumber: layer.Version
                })
            )
        ) {
            output(`Deleted lambda layer: ${layer.LayerName}:${layer.Version}`);
        }
    }
    if (FunctionName) {
        if (await quietly(lambda.deleteFunction({ FunctionName }))) {
            output(`Deleted function: ${FunctionName}`);
        }
    }
    if (logGroupName) {
        if (await quietly(services.cloudwatch.deleteLogGroup({ logGroupName }))) {
            output(`Deleted log group ${logGroupName}`);
        }
    }
}

async function addLogRetentionPolicy(
    FunctionName: string,
    cloudwatch: aws.CloudWatchLogs
) {
    const logGroupName = getLogGroupName(FunctionName);
    const response = quietly(
        cloudwatch.putRetentionPolicy({ logGroupName, retentionInDays: 1 })
    );
    if (response !== undefined) {
        log.info(`Added 1 day retention policy to log group ${logGroupName}`);
    }
}

export async function cleanup(state: AwsState, options: Required<CleanupOptions>) {
    log.info(`aws cleanup starting.`);
    await addLogRetentionPolicy(state.resources.FunctionName, state.services.cloudwatch);
    if (state.gcPromise) {
        log.info(`Waiting for garbage collection...`);
        await state.gcPromise;
        log.info(`Garbage collection done.`);
    }

    if (options.deleteResources) {
        log.info(
            `Cleaning up faast infrastructure for ${state.resources.FunctionName}...`
        );
        // Don't delete cached role. It may be in use by other instances of
        // faast. Don't delete logs. They are often useful. By default log
        // stream retention will be 1 day, and gc will clean out the log group
        // after the streams are expired. Don't delete a lambda layer that is
        // used to cache packages.
        const { logGroupName, RoleName, layer, ...rest } = state.resources;
        await deleteResources(rest, state.services);
        if (!state.options.useDependencyCaching || options.deleteCaches) {
            await deleteResources({ layer }, state.services);
        }
    }
    log.info(`aws cleanup done.`);
}

const logGroupNameRegexp = new RegExp(`^/aws/lambda/(faast-${uuidv4Pattern})$`);

function functionNameFromLogGroup(logGroupName: string) {
    const match = logGroupName.match(logGroupNameRegexp);
    return match && match[1];
}

let lastGc: number | undefined;

function forEachPage<R>(
    description: string,
    request: aws.Request<R, aws.AWSError>,
    process: (page: R) => Promise<void>
) {
    const throttlePaging = throttle({ concurrency: 1, rate: 1 }, async () => {});
    return new Promise((resolve, reject) => {
        request.eachPage((err, page, done) => {
            if (err) {
                log.warn(`GC: Error when listing ${description}: ${err}`);
                reject(err);
                return false;
            }
            if (page === null) {
                resolve();
            } else {
                process(page).then(() => throttlePaging().then(done));
            }
            return true;
        });
    });
}

export async function collectGarbage(
    executor: typeof defaultGcWorker,
    services: AwsServices,
    region: AwsRegion,
    accountId: string,
    retentionInDays: number
) {
    if (executor === defaultGcWorker) {
        if (lastGc && Date.now() <= lastGc + 3600 * 1000) {
            return;
        }
        const gcEntry = await caches.awsGc.get("gc");
        if (gcEntry) {
            try {
                const lastGcPersistent = JSON.parse(gcEntry.toString());
                if (
                    lastGcPersistent &&
                    typeof lastGcPersistent === "number" &&
                    Date.now() <= lastGcPersistent + 3600 * 1000
                ) {
                    lastGc = lastGcPersistent;
                    return;
                }
            } catch (err) {
                log.warn(err);
            }
        }
        lastGc = Date.now();
        caches.awsGc.set("gc", lastGc.toString());
    }
    const promises: Promise<void>[] = [];
    function scheduleWork(work: AwsGcWork) {
        promises.push(executor(work, services));
    }
    const functionsWithLogGroups = new Set();

    const logGroupRequest = services.cloudwatch.describeLogGroups({
        logGroupNamePrefix: "/aws/lambda/faast-"
    });
    await forEachPage("log groups", logGroupRequest, async ({ logGroups = [] }) => {
        logGroups.forEach(g =>
            functionsWithLogGroups.add(functionNameFromLogGroup(g.logGroupName!))
        );

        garbageCollectLogGroups(
            logGroups,
            retentionInDays,
            region,
            accountId,
            scheduleWork
        );
    });

    const listFunctionsRequest = services.lambda.listFunctions();
    await forEachPage(
        "lambda functions",
        listFunctionsRequest,
        async ({ Functions = [] }) => {
            const fnPattern = new RegExp(`^faast-${uuidv4Pattern}$`);
            const funcs = (Functions || [])
                .filter(fn => fn.FunctionName!.match(fnPattern))
                .filter(fn => !functionsWithLogGroups.has(fn.FunctionName))
                .filter(fn => hasExpired(fn.LastModified, retentionInDays))
                .map(fn => fn.FunctionName!);
            deleteGarbageFunctions(region, accountId, funcs, scheduleWork);
        }
    );

    // Collect Lambda Layers
    const layersRequest = services.lambda.listLayers({
        CompatibleRuntime: "nodejs"
    });
    await forEachPage("Lambda Layers", layersRequest, async ({ Layers = [] }) => {
        for (const layer of Layers) {
            if (layer.LayerName!.match(/^faast-/)) {
                const layerVersionRequest = services.lambda.listLayerVersions({
                    LayerName: layer.LayerName!,
                    CompatibleRuntime: "nodejs"
                });
                await forEachPage(
                    "Lambda Layer Versions",
                    layerVersionRequest,
                    async ({ LayerVersions = [] }) => {
                        LayerVersions.forEach(layerVersion => {
                            if (hasExpired(layerVersion.CreatedDate, retentionInDays)) {
                                scheduleWork({
                                    type: "DeleteLayerVersion",
                                    layerName: layer.LayerName!,
                                    layerVersion: layerVersion.Version!
                                });
                            }
                        });
                    }
                );
            }
        }
    });
    await Promise.all(promises);
}

export async function getAccountId(sts: aws.STS) {
    const response = await sts.getCallerIdentity().promise();
    const { Account, Arn, UserId } = response;
    log.info(`Account ID: %O`, { Account, Arn, UserId });
    return response.Account!;
}

function garbageCollectLogGroups(
    logGroups: aws.CloudWatchLogs.LogGroup[],
    retentionInDays: number,
    region: AwsRegion,
    accountId: string,
    scheduleWork: (work: AwsGcWork) => void
) {
    const logGroupsMissingRetentionPolicy = logGroups.filter(
        g => g.retentionInDays === undefined
    );

    logGroupsMissingRetentionPolicy.forEach(g =>
        scheduleWork({
            type: "SetLogRetention",
            logGroupName: g.logGroupName!,
            retentionInDays
        })
    );

    const garbageFunctions = logGroups
        .filter(g => hasExpired(g.creationTime, retentionInDays))
        .filter(g => g.storedBytes! === 0)
        .map(g => functionNameFromLogGroup(g.logGroupName!))
        .filter(defined);

    deleteGarbageFunctions(region, accountId, garbageFunctions, scheduleWork);
}

function deleteGarbageFunctions(
    region: AwsRegion,
    accountId: string,
    garbageFunctions: string[],
    scheduleWork: (work: AwsGcWork) => void
) {
    garbageFunctions.forEach(FunctionName => {
        const resources: AwsResources = {
            FunctionName,
            region,
            RoleName: "",
            RequestTopicArn: getSNSTopicArn(region, accountId, FunctionName),
            ResponseQueueUrl: getResponseQueueUrl(region, accountId, FunctionName),
            logGroupName: getLogGroupName(FunctionName)
        };
        scheduleWork({ type: "DeleteResources", resources });
    });
}

export async function awsPacker(
    functionModule: string,
    dir: string,
    options: CommonOptions,
    wrapperOptions: WrapperOptions
): Promise<PackerResult> {
    return packer(
        dir,
        awsTrampoline,
        functionModule,
        {
            ...options,
            webpackOptions: {
                externals: new RegExp("^aws-sdk/?"),
                ...options.webpackOptions
            }
        },
        wrapperOptions
    );
}

function getSNSTopicName(FunctionName: string) {
    return `${FunctionName}-Requests`;
}

function getSNSTopicArn(region: string, accountId: string, FunctionName: string) {
    const TopicName = getSNSTopicName(FunctionName);
    return `arn:aws:sns:${region}:${accountId}:${TopicName}`;
}

function getSQSName(FunctionName: string) {
    return `${FunctionName}-Responses`;
}

function getResponseQueueUrl(region: string, accountId: string, FunctionName: string) {
    const queueName = getSQSName(FunctionName);
    return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
}

function createRequestQueueImpl(
    state: AwsState,
    FunctionName: string,
    FunctionArn: string
) {
    const { sns, lambda } = state.services;
    const { resources } = state;

    log.info(`Creating SNS request topic`);
    const createTopicPromise = createSNSTopic(sns, getSNSTopicName(FunctionName));

    const assignRequestTopicArnPromise = createTopicPromise.then(
        topic => (resources.RequestTopicArn = topic)
    );

    const addPermissionsPromise = createTopicPromise.then(topic => {
        log.info(`Adding SNS invoke permissions to function`);
        return addSnsInvokePermissionsToFunction(FunctionName, topic, lambda);
    });

    const subscribePromise = createTopicPromise.then(topic => {
        log.info(`Subscribing SNS to invoke lambda function`);
        return sns
            .subscribe({
                TopicArn: topic,
                Protocol: "lambda",
                Endpoint: FunctionArn
            })
            .promise();
    });

    const assignSNSResponsePromise = subscribePromise.then(
        snsResponse => (resources.SNSLambdaSubscriptionArn = snsResponse.SubscriptionArn!)
    );

    return Promise.all([
        createTopicPromise,
        assignRequestTopicArnPromise,
        addPermissionsPromise,
        subscribePromise,
        assignSNSResponsePromise
    ]);
}

export async function createResponseQueueImpl(state: AwsState, FunctionName: string) {
    const { sqs } = state.services;
    const { resources } = state;
    log.info(`Creating SQS response queue`);
    const { QueueUrl, QueueArn } = await createSQSQueue(
        getSQSName(FunctionName),
        60,
        sqs
    );
    resources.ResponseQueueUrl = QueueUrl;
    resources.ResponseQueueArn = QueueArn;
    log.info(`Created response queue`);
    return QueueArn!;
}

function addSnsInvokePermissionsToFunction(
    FunctionName: string,
    RequestTopicArn: string,
    lambda: aws.Lambda
) {
    lambda
        .addPermission({
            FunctionName,
            Action: "lambda:InvokeFunction",
            Principal: "sns.amazonaws.com",
            StatementId: `${FunctionName}-Invoke`,
            SourceArn: RequestTopicArn
        })
        .promise();
}

/**
 * Valid AWS
 * {@link https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html | regions}.
 * Not all of these regions have Lambda support.
 * @public
 */
export type AwsRegion =
    | "us-east-1"
    | "us-east-2"
    | "us-west-1"
    | "us-west-2"
    | "ca-central-1"
    | "eu-central-1"
    | "eu-west-1"
    | "eu-west-2"
    | "eu-west-3"
    | "ap-northeast-1"
    | "ap-northeast-2"
    | "ap-northeast-3"
    | "ap-southeast-1"
    | "ap-southeast-2"
    | "ap-south-1"
    | "sa-east-1";

const locations = {
    "us-east-1": "US East (N. Virginia)",
    "us-east-2": "US East (Ohio)",
    "us-west-1": "US West (N. California)",
    "us-west-2": "US West (Oregon)",
    "ca-central-1": "Canada (Central)",
    "eu-central-1": "EU (Frankfurt)",
    "eu-west-1": "EU (Ireland)",
    "eu-west-2": "EU (London)",
    "eu-west-3": "EU (Paris)",
    "ap-northeast-1": "Asia Pacific (Tokyo)",
    "ap-northeast-2": "Asia Pacific (Seoul)",
    "ap-northeast-3": "Asia Pacific (Osaka-Local)",
    "ap-southeast-1": "Asia Pacific (Singapore)",
    "ap-southeast-2": "Asia Pacific (Sydney)",
    "ap-south-1": "Asia Pacific (Mumbai)",
    "sa-east-1": "South America (São Paulo)"
};

export const awsPrice = throttle(
    { concurrency: 6, rate: 5, memoize: true, cache: caches.awsPrices },
    async (
        pricing: aws.Pricing,
        ServiceCode: string,
        filter: { [key: string]: string }
    ) => {
        try {
            function first(obj: any) {
                return obj[Object.keys(obj)[0]];
            }
            function extractPrice(obj: any) {
                const prices = Object.keys(obj.priceDimensions).map(key =>
                    Number(obj.priceDimensions[key].pricePerUnit.USD)
                );
                return Math.max(...prices);
            }
            const priceResult = await pricing
                .getProducts({
                    ServiceCode,
                    Filters: Object.keys(filter).map(key => ({
                        Field: key,
                        Type: "TERM_MATCH",
                        Value: filter[key]
                    }))
                })
                .promise();
            if (priceResult.PriceList!.length > 1) {
                log.warn(
                    `Price query returned more than one product '${ServiceCode}' ($O)`,
                    filter
                );
                priceResult.PriceList!.forEach(p => log.warn(`%O`, p));
            }
            const pList: any = priceResult.PriceList![0];
            const price = extractPrice(first(pList.terms.OnDemand));
            return price;
        } catch (err) {
            const { message: m } = err;
            if (
                !m.match(/Rate exceeded/) &&
                !m.match(/EPROTO/) &&
                !m.match(/socket hang up/)
            ) {
                log.warn(`Could not get AWS pricing for '${ServiceCode}' (%O)`, filter);
                log.warn(err);
            }
            throw err;
        }
    }
);

export const requestAwsPrices = async (
    pricing: aws.Pricing,
    region: AwsRegion
): Promise<AwsPrices> => {
    const location = locations[region];
    return {
        lambdaPerRequest: await awsPrice(pricing, "AWSLambda", {
            location,
            group: "AWS-Lambda-Requests"
        }).catch(_ => 0.0000002),
        lambdaPerGbSecond: await awsPrice(pricing, "AWSLambda", {
            location,
            group: "AWS-Lambda-Duration"
        }).catch(_ => 0.00001667),
        snsPer64kPublish: await awsPrice(pricing, "AmazonSNS", {
            location,
            group: "SNS-Requests-Tier1"
        }).catch(_ => 0.5 / 1e6),
        sqsPer64kRequest: await awsPrice(pricing, "AWSQueueService", {
            location,
            group: "SQS-APIRequest-Tier1",
            queueType: "Standard"
        }).catch(_ => 0.4 / 1e6),
        dataOutPerGb: await awsPrice(pricing, "AWSDataTransfer", {
            fromLocation: location,
            transferType: "AWS Outbound"
        }).catch(_ => 0.09),
        logsIngestedPerGb: await awsPrice(pricing, "AmazonCloudWatch", {
            location,
            group: "Ingested Logs",
            groupDescription: "Existing system, application, and custom log files"
        }).catch(_ => 0.5)
    };
};

export async function costEstimate(
    state: AwsState,
    counters: FunctionCounters,
    statistics: FunctionStats
): Promise<CostBreakdown> {
    const costs = new CostBreakdown();
    const { region } = state.resources;
    const prices = await requestAwsPrices(state.services.pricing, region);

    const { memorySize = defaults.memorySize } = state.options;
    const billedTimeStats = statistics.estimatedBilledTime;
    const seconds = (billedTimeStats.mean / 1000) * billedTimeStats.samples || 0;
    const provisionedGb = memorySize / 1024;
    const functionCallDuration = new CostMetric({
        name: "functionCallDuration",
        pricing: prices.lambdaPerGbSecond * provisionedGb,
        unit: "second",
        measured: seconds,
        comment: `https://aws.amazon.com/lambda/pricing (rate = ${prices.lambdaPerGbSecond.toFixed(
            8
        )}/(GB*second) * ${provisionedGb} GB = ${(
            prices.lambdaPerGbSecond * provisionedGb
        ).toFixed(8)}/second)`
    });
    costs.push(functionCallDuration);

    const functionCallRequests = new CostMetric({
        name: "functionCallRequests",
        pricing: prices.lambdaPerRequest,
        measured: counters.invocations,
        unit: "request",
        comment: "https://aws.amazon.com/lambda/pricing"
    });
    costs.push(functionCallRequests);

    const { metrics } = state;
    const outboundDataTransfer = new CostMetric({
        name: "outboundDataTransfer",
        pricing: prices.dataOutPerGb,
        measured: metrics.outboundBytes / 2 ** 30,
        unit: "GB",
        comment: "https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer"
    });
    costs.push(outboundDataTransfer);

    const sqs: CostMetric = new CostMetric({
        name: "sqs",
        pricing: prices.sqsPer64kRequest,
        measured: metrics.sqs64kRequests,
        unit: "request",
        comment: "https://aws.amazon.com/sqs/pricing"
    });
    costs.push(sqs);

    const sns: CostMetric = new CostMetric({
        name: "sns",
        pricing: prices.snsPer64kPublish,
        measured: metrics.sns64kRequests,
        unit: "request",
        comment: "https://aws.amazon.com/sns/pricing"
    });
    costs.push(sns);

    const logIngestion: CostMetric = new CostMetric({
        name: "logIngestion",
        pricing: prices.logsIngestedPerGb,
        measured: 0,
        unit: "GB",
        comment:
            "https://aws.amazon.com/cloudwatch/pricing/ - Log ingestion costs not currently included.",
        informationalOnly: true
    });
    costs.push(logIngestion);

    return costs;
}

export const AwsImpl: CloudFunctionImpl<AwsOptions, AwsState> = {
    name: "aws",
    initialize,
    defaults,
    cleanup,
    costEstimate,
    logUrl,
    invoke,
    publish,
    poll,
    responseQueueId
};
