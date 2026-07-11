const MODIFIER_LABELS = {
  Control: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Meta: "Meta"
} as const;

const MODIFIER_KEYS = new Set(Object.keys(MODIFIER_LABELS));

export function formatShortcutFromEvent(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.key === "Control") {
    parts.push("Ctrl");
  }
  if (event.altKey || event.key === "Alt") {
    parts.push("Alt");
  }
  if (event.shiftKey || event.key === "Shift") {
    parts.push("Shift");
  }
  if (event.metaKey || event.key === "Meta") {
    parts.push("Meta");
  }

  const key = normalizeKey(event.key);
  if (!MODIFIER_KEYS.has(event.key)) {
    parts.push(key);
  }

  return Array.from(new Set(parts)).join("+");
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) {
    return false;
  }
  if (!parsed.key) {
    return MODIFIER_LABELS[event.key as keyof typeof MODIFIER_LABELS] === parsed.modifierOnly;
  }
  if (event.ctrlKey !== parsed.ctrl || event.altKey !== parsed.alt || event.shiftKey !== parsed.shift || event.metaKey !== parsed.meta) {
    return false;
  }
  return normalizeKey(event.key) === parsed.key;
}

export function isShortcutRelease(event: KeyboardEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) {
    return false;
  }
  const key = normalizeKey(event.key);
  return key === parsed.key
    || key === parsed.modifierOnly
    || (key === "Ctrl" && parsed.ctrl)
    || (key === "Alt" && parsed.alt)
    || (key === "Shift" && parsed.shift)
    || (key === "Meta" && parsed.meta);
}

function parseShortcut(shortcut: string): {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key?: string;
  modifierOnly?: string;
} | undefined {
  const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const modifiers = new Set(parts.filter((part) => ["Ctrl", "Alt", "Shift", "Meta"].includes(part)));
  const key = parts.find((part) => !modifiers.has(part));
  const modifierOnly = key ? undefined : parts.at(-1);
  return {
    ctrl: modifiers.has("Ctrl"),
    alt: modifiers.has("Alt"),
    shift: modifiers.has("Shift"),
    meta: modifiers.has("Meta"),
    ...(key ? { key } : {}),
    ...(modifierOnly ? { modifierOnly } : {})
  };
}

function normalizeKey(key: string): string {
  if (key === " ") {
    return "Space";
  }
  if (key.length === 1) {
    return key.toUpperCase();
  }
  return MODIFIER_LABELS[key as keyof typeof MODIFIER_LABELS] ?? key;
}
