export { scanCensus } from './scan.mjs';
export { CENSUS_BUILDER_VERSION, fingerprintCensus } from './fingerprint.mjs';
export { CENSUS_STATES, CENSUS_VERDICTS, resolveCensusState } from './state.mjs';
export { diffCensus } from './delta.mjs';
export { activateCensus, CensusTransactionError } from './transaction.mjs';

export function serializeCensus(census) {
  return `${JSON.stringify(census)}\n`;
}
