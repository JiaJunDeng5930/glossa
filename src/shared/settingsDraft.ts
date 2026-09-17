import { applySettingsPatch, diffSettings, type SettingsPatch } from "./settings";
import type { GlossaSettings } from "./types";

export type SettingsFieldScope = readonly string[] | ((path: string) => boolean);

export interface SettingsDraft {
  readonly base: GlossaSettings;
  readonly value: GlossaSettings;
  readonly dirty: boolean;
  readonly saving: boolean;
  edit(patch: SettingsPatch): void;
  acceptExternal(settings: GlossaSettings): void;
  save(scope?: SettingsFieldScope): Promise<void>;
  subscribe(listener: (draft: SettingsDraft) => void): () => void;
}

export interface SettingsDraftOptions {
  initial: GlossaSettings;
  persist(patch: SettingsPatch): Promise<GlossaSettings>;
}

type RevisionMap = Map<string, number>;

/**
 * Keep the persisted snapshot and local edits separate.  The revision map is
 * deliberately field based: a save can settle while a user is editing and a
 * field that was changed back to its old value must still remain local until
 * the corresponding save has been reconciled.
 */
export function createSettingsDraft(options: SettingsDraftOptions): SettingsDraft {
  let base = options.initial;
  let value = options.initial;
  let revisions: RevisionMap = new Map();
  let nextRevision = 0;
  let savePromise: Promise<void> | undefined;
  let pendingSave: { submitted: RevisionMap } | undefined;
  const subscribers = new Set<(draft: SettingsDraft) => void>();

  const dirty = (): boolean => Object.keys(diffSettings(base, value)).length > 0;
  const notify = (): void => {
    for (const subscriber of subscribers) {
      subscriber(api);
    }
  };
  const isInScope = (path: string, scope: SettingsFieldScope | undefined): boolean => {
    if (!scope) {
      return true;
    }
    if (typeof scope === "function") {
      return scope(path);
    }
    return scope.some((candidate) => path === candidate || path.startsWith(`${candidate}.`));
  };
  const patchPaths = (patch: SettingsPatch, prefix = ""): string[] => {
    const paths: string[] = [];
    for (const [key, entry] of Object.entries(patch as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        paths.push(...patchPaths(entry as SettingsPatch, path));
      } else {
        paths.push(path);
      }
    }
    return paths;
  };
  const patchForSave = (scope: SettingsFieldScope | undefined): SettingsPatch => {
    const changed = diffSettings(base, value);
    const selected = new Set(patchPaths(changed).filter((path) => revisions.has(path) && isInScope(path, scope)));
    const selectedPatch: Record<string, unknown> = {};
    const visit = (entry: unknown, prefix: string): void => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        if (!selected.has(prefix)) {
          return;
        }
        const parts = prefix.split(".");
        let cursor = selectedPatch;
        for (const part of parts.slice(0, -1)) {
          cursor = (cursor[part] ??= {}) as Record<string, unknown>;
        }
        cursor[parts.at(-1)!] = entry;
        return;
      }
      for (const [key, child] of Object.entries(entry)) {
        visit(child, prefix ? `${prefix}.${key}` : key);
      }
    };
    visit(changed, "");
    return selectedPatch as SettingsPatch;
  };
  const mergeExternal = (external: GlossaSettings): void => {
    const local = value;
    const localPaths = new Set(patchPaths(diffSettings(base, local)));
    if (pendingSave) {
      for (const [path, revision] of revisions) {
        const submittedRevision = pendingSave.submitted.get(path);
        if (submittedRevision !== undefined && submittedRevision !== revision) {
          localPaths.add(path);
        }
      }
    }
    const nextValue = structuredClone(external) as GlossaSettings;
    for (const path of localPaths) {
      assignPath(nextValue, path, readPath(local, path));
    }
    base = external;
    value = nextValue;
  };
  const api: SettingsDraft = {
    get base(): GlossaSettings {
      return base;
    },
    get value(): GlossaSettings {
      return value;
    },
    get dirty(): boolean {
      return dirty();
    },
    get saving(): boolean {
      return savePromise !== undefined;
    },
    edit(patch): void {
      const paths = patchPaths(patch);
      value = applySettingsPatch(value, patch);
      for (const path of paths) {
        nextRevision += 1;
        revisions.set(path, nextRevision);
      }
      notify();
    },
    acceptExternal(settings): void {
      mergeExternal(settings);
      notify();
    },
    save(scope): Promise<void> {
      if (savePromise) {
        return savePromise;
      }
      const patch = patchForSave(scope);
      const submitted = new Map<string, number>();
      for (const path of patchPaths(patch)) {
        const revision = revisions.get(path);
        if (revision !== undefined) {
          submitted.set(path, revision);
        }
      }
      pendingSave = { submitted };
      savePromise = options.persist(patch).then((committed) => {
        const previousBase = base;
        const local = value;
        pendingSave = undefined;
        base = committed;
        const remaining = new Map<string, number>();
        for (const [path, revision] of revisions) {
          const submittedRevision = submitted.get(path);
          if (submittedRevision === revision) continue;
          if (submittedRevision === undefined && readPath(previousBase, path) === readPath(local, path)) continue;
          remaining.set(path, revision);
        }
        revisions = remaining;
        const nextValue = structuredClone(committed) as GlossaSettings;
        for (const path of remaining.keys()) {
          assignPath(nextValue, path, readPath(local, path));
        }
        value = nextValue;
        notify();
      }).finally(() => {
        pendingSave = undefined;
        savePromise = undefined;
        notify();
      });
      notify();
      return savePromise;
    },
    subscribe(listener): () => void {
      subscribers.add(listener);
      listener(api);
      return () => subscribers.delete(listener);
    }
  };
  return api;
}

function readPath(value: GlossaSettings, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function assignPath(value: GlossaSettings, path: string, entry: unknown): void {
  const parts = path.split(".");
  let cursor = value as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = entry;
}
