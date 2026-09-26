import { readFileSync } from 'node:fs';
import {
  supplyChainPolicyV1Digest,
  supplyChainPolicyV2Digest,
} from '../../src/policies';
import { loadPolicy } from '../../src/policy';

export const supplyChainPolicyV1 = {
  bytes: (): Uint8Array =>
    readFileSync(
      new URL('../../policies/supply-chain-policy-v1.json', import.meta.url),
    ),
  digest: supplyChainPolicyV1Digest,
};

export function loadSupplyChainPolicyV1() {
  return loadPolicy(supplyChainPolicyV1.bytes(), supplyChainPolicyV1.digest);
}

export const supplyChainPolicyV2 = {
  bytes: (): Uint8Array =>
    readFileSync(
      new URL('../../policies/supply-chain-policy-v2.json', import.meta.url),
    ),
  digest: supplyChainPolicyV2Digest,
};

export function loadSupplyChainPolicyV2() {
  return loadPolicy(supplyChainPolicyV2.bytes(), supplyChainPolicyV2.digest);
}
