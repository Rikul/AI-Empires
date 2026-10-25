import { validateRecord } from '../shared/record';
import { newRecord } from '../shared/engine';
import type { MatchConfig } from '../shared/types';

/** Validate a new-match configuration by running it through the record validator. */
export function validateConfigOnly(config: MatchConfig): string[] {
  if (!config || typeof config !== 'object') return ['config is required'];
  const rec = newRecord(config, 'validate', 'validate');
  const v = validateRecord(JSON.parse(JSON.stringify(rec)), { verify: false });
  return v.errors;
}
