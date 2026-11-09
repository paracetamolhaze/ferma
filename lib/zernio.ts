import { readZernioKey } from './integration-settings';
import { zernioClient } from './zernio-client';
export { ProviderError } from './zernio-client';
export async function createZernioClient(owner: string, profileId: string) {
  return zernioClient(await readZernioKey(owner, profileId));
}
