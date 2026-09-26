import v1Text from '../policies/supply-chain-policy-v1.json' with { type: 'text' };
import v2Text from '../policies/supply-chain-policy-v2.json' with { type: 'text' };
import {
  supplyChainPolicyV1Digest,
  supplyChainPolicyV2Digest,
} from './policies';
import {
  loadPolicy,
  PolicyLoadError,
  type Policy,
  type PolicyDigest,
} from './policy';

function embedded(text: unknown, digest: PolicyDigest): Policy {
  if (typeof text !== 'string') {
    throw new PolicyLoadError(`policy ${digest} was not embedded as text`);
  }

  return loadPolicy(new TextEncoder().encode(text), digest);
}

export function canonicalPolicy(): Policy {
  return embedded(v2Text, supplyChainPolicyV2Digest);
}

export function pinnedPolicies(): ReadonlyMap<PolicyDigest, Policy> {
  const policies = [
    embedded(v1Text, supplyChainPolicyV1Digest),
    canonicalPolicy(),
  ];

  return new Map(policies.map((policy) => [policy.ref.digest, policy]));
}
