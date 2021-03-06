---
id: faastjs
title: faastjs package
hide_title: true
---
<!-- Do not edit this file. It is automatically generated by API Documenter. -->


## faastjs package

Faast.js transforms ordinary JavaScript modules into serverless cloud functions that can run on AWS Lambda and Google Cloud Functions.

The main entry point to faast.js is the [faast()](./faastjs.faast.md) function, which returns an object that implements the [FaastModule](./faastjs.faastmodule.md) interface. The most common options are [CommonOptions](./faastjs.commonoptions.md)<!-- -->. Using faast.js requires writing two modules, one containing the functions to upload to the cloud, and the other that invokes faast.js and calls the resulting cloud functions.

## Classes

|  Class | Description |
|  --- | --- |
|  [CostMetric](./faastjs.costmetric.md) | A line item in the cost estimate, including the resource usage metric measured and its pricing. |
|  [CostSnapshot](./faastjs.costsnapshot.md) | A summary of the costs incurred by a faast.js module at a point in time. Output of [FaastModule.costSnapshot()](./faastjs.faastmodule.costsnapshot.md)<!-- -->. |
|  [FaastError](./faastjs.faasterror.md) | A subclass of Error that is thrown by faast.js APIs and cloud function invocations. |
|  [FaastModuleProxy](./faastjs.faastmoduleproxy.md) | Implementation of [FaastModule](./faastjs.faastmodule.md)<!-- -->. |
|  [FunctionStats](./faastjs.functionstats.md) | Summary statistics for function invocations. |
|  [FunctionStatsEvent](./faastjs.functionstatsevent.md) | Summarize statistics about cloud function invocations. |
|  [PersistentCache](./faastjs.persistentcache.md) | A simple persistent key-value store. Used to implement [Limits.cache](./faastjs.limits.cache.md) for [throttle()](./faastjs.throttle.md)<!-- -->. |
|  [Statistics](./faastjs.statistics.md) | Incrementally updated statistics on a set of values. |

## Functions

|  Function | Description |
|  --- | --- |
|  [faast(provider, fmodule, options)](./faastjs.faast.md) | The main entry point for faast with any provider and only common options. |
|  [faastAws(fmodule, options)](./faastjs.faastaws.md) | The main entry point for faast with AWS provider. |
|  [faastGoogle(fmodule, options)](./faastjs.faastgoogle.md) | The main entry point for faast with Google provider. |
|  [faastLocal(fmodule, options)](./faastjs.faastlocal.md) | The main entry point for faast with Local provider. |
|  [throttle({ concurrency, retry, rate, burst, memoize, cache }, fn)](./faastjs.throttle.md) | A decorator for rate limiting, concurrency limiting, retry, memoization, and on-disk caching. See [Limits](./faastjs.limits.md)<!-- -->. |

## Interfaces

|  Interface | Description |
|  --- | --- |
|  [AwsOptions](./faastjs.awsoptions.md) | AWS-specific options for [faastAws()](./faastjs.faastaws.md)<!-- -->. Extends [CommonOptions](./faastjs.commonoptions.md)<!-- -->. |
|  [CleanupOptions](./faastjs.cleanupoptions.md) | Options that apply to the [FaastModule.cleanup()](./faastjs.faastmodule.cleanup.md) method. |
|  [CommonOptions](./faastjs.commonoptions.md) | Options common across all faast.js providers. Used as argument to [faast()](./faastjs.faast.md)<!-- -->. |
|  [FaastModule](./faastjs.faastmodule.md) | The main interface for invoking, cleaning up, and managing faast.js cloud functions. Returned by [faast()](./faastjs.faast.md)<!-- -->. |
|  [GoogleOptions](./faastjs.googleoptions.md) | Google-specific options for [faastGoogle()](./faastjs.faastgoogle.md)<!-- -->. Extends [CommonOptions](./faastjs.commonoptions.md)<!-- -->. |
|  [Limits](./faastjs.limits.md) | Specify [throttle()](./faastjs.throttle.md) limits. These limits shape the way throttle invokes the underlying function. |
|  [LocalOptions](./faastjs.localoptions.md) | Local provider options for [faastLocal()](./faastjs.faastlocal.md)<!-- -->. Extends [CommonOptions](./faastjs.commonoptions.md)<!-- -->. |

## Namespaces

|  Namespace | Description |
|  --- | --- |
|  [CostAnalyzer](./faastjs.costanalyzer.md) | Analyze the cost of a workload across many provider configurations. |

## Variables

|  Variable | Description |
|  --- | --- |
|  [log](./faastjs.log.md) | Faast.js loggers. |
|  [providers](./faastjs.providers.md) | An array of all available provider. |

## Type Aliases

|  Type Alias | Description |
|  --- | --- |
|  [AwsFaastModule](./faastjs.awsfaastmodule.md) | The return type of [faastAws()](./faastjs.faastaws.md)<!-- -->. See [FaastModuleProxy](./faastjs.faastmoduleproxy.md)<!-- -->. |
|  [AwsRegion](./faastjs.awsregion.md) | Valid AWS [regions](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html)<!-- -->. Not all of these regions have Lambda support. |
|  [GoogleFaastModule](./faastjs.googlefaastmodule.md) | The return type of [faastGoogle()](./faastjs.faastgoogle.md)<!-- -->. See [FaastModuleProxy](./faastjs.faastmoduleproxy.md)<!-- -->. |
|  [GoogleRegion](./faastjs.googleregion.md) | Valid Google Cloud [regions](https://cloud.google.com/compute/docs/regions-zones/)<!-- -->. Only some of these \[regions have Cloud Functions\](https://cloud.google.com/functions/docs/locations). |
|  [LocalFaastModule](./faastjs.localfaastmodule.md) | The return type of [faastLocal()](./faastjs.faastlocal.md)<!-- -->. See [FaastModuleProxy](./faastjs.faastmoduleproxy.md)<!-- -->. |
|  [Promisified](./faastjs.promisified.md) | <code>Promisified&lt;M&gt;</code> is the type of [FaastModule.functions](./faastjs.faastmodule.functions.md)<!-- -->. |
|  [PromisifiedFunction](./faastjs.promisifiedfunction.md) | The type of functions on [FaastModule.functions](./faastjs.faastmodule.functions.md)<!-- -->. Used by [Promisified](./faastjs.promisified.md)<!-- -->. |
|  [Provider](./faastjs.provider.md) | The type of all supported cloud providers. |
|  [Unpacked](./faastjs.unpacked.md) | The type returned by a <code>Promise</code>. |
