import { TrustedRoot } from '@sigstore/protobuf-specs';
import { DEFAULT_MIRROR_URL, getTrustedRoot } from '@sigstore/tuf';

export const trustedRootUrl = `${DEFAULT_MIRROR_URL}/targets/trusted_root.json`;

export async function sigstoreTrustedRoot(cachePath: string): Promise<unknown> {
  return TrustedRoot.toJSON(await getTrustedRoot({ cachePath }));
}
