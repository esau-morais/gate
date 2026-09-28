import { readFileSync } from 'node:fs';
import {
  supplyChainPolicyV1Digest,
  supplyChainPolicyV2Digest,
  supplyChainPolicyV3Digest,
  supplyChainPolicyV4Digest,
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

export const supplyChainPolicyV3 = {
  bytes: (): Uint8Array =>
    readFileSync(
      new URL('../../policies/supply-chain-policy-v3.json', import.meta.url),
    ),
  digest: supplyChainPolicyV3Digest,
};

export function loadSupplyChainPolicyV3() {
  return loadPolicy(supplyChainPolicyV3.bytes(), supplyChainPolicyV3Digest);
}

export const supplyChainPolicyV4 = {
  bytes: (): Uint8Array =>
    readFileSync(
      new URL('../../policies/supply-chain-policy-v4.json', import.meta.url),
    ),
  digest: supplyChainPolicyV4Digest,
};

export function loadSupplyChainPolicyV4() {
  return loadPolicy(supplyChainPolicyV4.bytes(), supplyChainPolicyV4Digest);
}
