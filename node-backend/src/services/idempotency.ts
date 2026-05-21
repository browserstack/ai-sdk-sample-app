/**
 * Idempotency helper for Stage 6 workflows.
 *
 * Implements the `ensure(resource)` pattern from CONTRACTS.md section 5:
 * look up by name, create if missing, update on drift (or delete+recreate
 * when no `.update` exists), reuse if matching.
 */

export interface EnsureOptions<T> {
  name: string;
  listFn: () => Promise<unknown> | unknown;
  createFn: (expected: Record<string, unknown>) => Promise<T> | T;
  updateFn?: ((id: string, expected: Record<string, unknown>) => Promise<T> | T) | null;
  deleteFn?: ((id: string) => Promise<unknown> | unknown) | null;
  expected: Record<string, unknown>;
  driftCheck: (existing: T, expected: Record<string, unknown>) => boolean;
  supportUpdate?: boolean;
  log?: (msg: string) => void;
}

function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.data)) return r.data;
    if (Array.isArray(r.evaluators)) return r.evaluators;
    if (Array.isArray(r.experiments)) return r.experiments;
    if (Array.isArray(r.experimentRuns)) return r.experimentRuns;
  }
  return [];
}

export function firstMatchByName<T>(items: T[], name: string): T | undefined {
  return items.find((it) => {
    if (it && typeof it === "object") {
      const rec = it as Record<string, unknown>;
      return rec.name === name;
    }
    return false;
  });
}

export function getId(resource: unknown): string | undefined {
  if (resource && typeof resource === "object") {
    const r = resource as Record<string, unknown>;
    const id = r.id ?? r.evaluatorListId ?? r.datasetId;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

export async function ensure<T>(opts: EnsureOptions<T>): Promise<T> {
  const {
    name, listFn, createFn, updateFn, deleteFn, expected, driftCheck,
    supportUpdate = true, log,
  } = opts;

  const raw = await Promise.resolve(listFn());
  const items = asArray(raw) as T[];
  const existing = firstMatchByName(items, name);

  if (!existing) {
    log?.(`'${name}' not found; creating`);
    return await Promise.resolve(createFn(expected));
  }

  if (driftCheck(existing, expected)) {
    const rid = getId(existing);
    if (supportUpdate && updateFn && rid) {
      log?.(`'${name}' drift detected; updating`);
      return await Promise.resolve(updateFn(rid, expected));
    }
    if (deleteFn && rid) {
      log?.(`'${name}' drift detected; deleting+recreating (no .update)`);
      await Promise.resolve(deleteFn(rid));
      return await Promise.resolve(createFn(expected));
    }
    log?.(`'${name}' drift detected but no update/delete available; reusing`);
    return existing;
  }

  log?.(`'${name}' exists with current spec; reusing`);
  return existing;
}
