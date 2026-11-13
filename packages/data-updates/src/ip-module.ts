import { ipDatabaseModule } from '@sharedid-edge/ip-ranges';
import type { EdgeModule } from '@sharedid-edge/core';
import { snapshotModule, type SnapshotModuleOptions } from './module.js';
import type { CountrySnapshot } from './country-data.js';

export { validateCountrySnapshot, type CountrySnapshot } from './country-data.js';

/** Opt-in replacement for a bundled country module; its mode and privacy rules stay the same. */
export function countrySnapshotModule(options: Omit<SnapshotModuleOptions<CountrySnapshot>, 'create' | 'definition'> & { readonly name: string; readonly ipservice?: number }): EdgeModule {
  return snapshotModule({
    ...options,
    definition: { name: options.name },
    create: snapshot => {
      const module = ipDatabaseModule({ name: options.name, data: snapshot.data, info: snapshot.info, ...(options.ipservice === undefined ? {} : { ipservice: options.ipservice }), ...(options.now === undefined ? {} : { now: options.now }) });
      return context => module.run(context);
    }
  });
}
