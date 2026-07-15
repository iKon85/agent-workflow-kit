import { createHash } from 'node:crypto';

export const CENSUS_BUILDER_VERSION = '1';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprintCensus({ denominator, evidence, families }) {
  const structural = (entries) => entries.map(({ family, kind, path }) => ({ family, kind, path }));
  const topology = {
    denominator: structural(denominator),
    evidence: structural(evidence),
    families,
  };
  return {
    builder: sha256(`agent-workflow-kit-census:${CENSUS_BUILDER_VERSION}`),
    topology: sha256(JSON.stringify(topology)),
  };
}
