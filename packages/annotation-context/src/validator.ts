import type { ContextFields } from './types.js';

/** Validates the context extension fields (contextId) */
export const validateContextFields = (value: unknown): value is ContextFields => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.contextId === 'string' && v.contextId !== '';
};
