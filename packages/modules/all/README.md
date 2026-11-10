# @sharedid-edge/modules

The list of modules built into every [SharedID Edge](../../../README.md) adapter: [`ip`](../ip/README.md), [`ec`](../ec/README.md), [`geo`](../geo/README.md), [`reflect`](../reflect/README.md) and [`bot`](../bot/README.md). The Cloudflare Worker, the Node.js server, the AWS Lambda function, the Vercel adapter and the Azure Functions app all import it, so a module added here is available on every platform at once.

Being built in doesn't turn a module on. Each one does nothing until it's listed in `SID_MODULES`; see the main README's [Modules](../../../README.md#modules) section.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';

const handler = createHandler({ config: resolveConfig(env), modules: builtInModules });
```

`builtInModules` is a frozen `readonly EdgeModule[]`. To add a module of your own, or a vendor module, pass a longer list:

```ts
import { builtInModules } from '@sharedid-edge/modules';
import { myModule } from './my-module.js';

const modules = [...builtInModules, myModule];
```

Vendor modules (in [`packages/vendor-modules/`](../../vendor-modules/README.md)) are never in this list: a deployer opts in to each one when building.
