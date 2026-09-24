/**
 * Shortcuts Synthesizer — describe an automation, get a real macOS Shortcut.
 *
 * The point is that the result outlives Rellane. An installed Shortcut runs
 * from Siri, the menu bar, an iPhone, and a schedule, with Rellane closed. This
 * is the feature that makes the app extend the operating system instead of
 * being another silo you have to remember to open.
 *
 * A Shortcut is a plist of action dictionaries. Building it here rather than
 * asking a model to emit one is deliberate: a malformed plist fails to import
 * with an error nobody can act on, and the structure is completely mechanical
 * once the intent is known. The model's job — later — is turning a sentence
 * into that intent, not into XML.
 */

/** The actions Rellane knows how to assemble. */
export type ActionKind =
  | { readonly kind: "comment"; readonly text: string }
  | { readonly kind: "getFolder"; readonly path: string }
  | { readonly kind: "getFilesInFolder" }
  | { readonly kind: "filterByExtension"; readonly extensions: readonly string[] }
  | { readonly kind: "moveTo"; readonly path: string }
  | { readonly kind: "notify"; readonly title: string; readonly body: string }
  | { readonly kind: "openApp"; readonly bundleId: string };

export interface ShortcutSpec {
  readonly name: string;
  readonly actions: readonly ActionKind[];
}

/** Apple's identifiers for the built-in actions used above. */
const IDENTIFIERS: Readonly<Record<string, string>> = Object.freeze({
  comment: "is.workflow.actions.comment",
  getFolder: "is.workflow.actions.file.getlink",
  getFilesInFolder: "is.workflow.actions.file.getfoldercontents",
  filterByExtension: "is.workflow.actions.filter.files",
  moveTo: "is.workflow.actions.file.move",
  notify: "is.workflow.actions.notification",
  openApp: "is.workflow.actions.openapp"
});

/** XML-escapes text going into a plist string. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function dict(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([key, value]) => `\t\t\t\t<key>${key}</key>\n\t\t\t\t${value}`).join("\n");
}

function str(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

function parametersFor(action: ActionKind): readonly (readonly [string, string])[] {
  switch (action.kind) {
    case "comment":
      return [["WFCommentActionText", str(action.text)]];
    case "getFolder":
      return [["WFFile", str(action.path)]];
    case "getFilesInFolder":
      return [["WFFolder", str("")]];
    case "filterByExtension":
      return [["WFContentItemFilter", str(action.extensions.join(","))]];
    case "moveTo":
      return [["WFFileDestinationPath", str(action.path)]];
    case "notify":
      return [
        ["WFNotificationActionTitle", str(action.title)],
        ["WFNotificationActionBody", str(action.body)]
      ];
    case "openApp":
      return [["WFAppIdentifier", str(action.bundleId)]];
  }
}

/**
 * Builds the `.shortcut` plist.
 *
 * Emitted as XML rather than binary plist so the file is inspectable — you can
 * open it and read exactly what is about to be installed, which matters for
 * something that will run without Rellane watching.
 */
export function buildShortcutPlist(spec: ShortcutSpec): string {
  const actions = spec.actions
    .map((action) => {
      const identifier = IDENTIFIERS[action.kind];
      const parameters = parametersFor(action);
      return [
        "\t\t<dict>",
        "\t\t\t<key>WFWorkflowActionIdentifier</key>",
        `\t\t\t${str(identifier ?? "is.workflow.actions.comment")}`,
        "\t\t\t<key>WFWorkflowActionParameters</key>",
        "\t\t\t<dict>",
        dict(parameters),
        "\t\t\t</dict>",
        "\t\t</dict>"
      ].join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>WFWorkflowClientVersion</key>",
    "\t<string>2038.0.4</string>",
    "\t<key>WFWorkflowMinimumClientVersion</key>",
    "\t<integer>900</integer>",
    "\t<key>WFWorkflowTypes</key>",
    "\t<array>",
    "\t\t<string>NCWidget</string>",
    "\t\t<string>WatchKit</string>",
    "\t</array>",
    "\t<key>WFWorkflowIcon</key>",
    "\t<dict>",
    "\t\t<key>WFWorkflowIconGlyphNumber</key>",
    "\t\t<integer>59511</integer>",
    "\t\t<key>WFWorkflowIconStartColor</key>",
    "\t\t<integer>946986751</integer>",
    "\t</dict>",
    "\t<key>WFWorkflowActions</key>",
    "\t<array>",
    actions,
    "\t</array>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

/**
 * A sentence read as a Shortcut, or null when it is not understood.
 *
 * Deterministic on purpose for the same reason the Librarian's filing is: the
 * shapes people ask for are few and the phrasing varies. When a model does
 * write these, it will produce a `ShortcutSpec` — never the plist — so the
 * output is still validated by the code below before anything is installed.
 */
export function readShortcutIntent(
  sentence: string,
  context: { readonly folder: string }
): ShortcutSpec | null {
  const lowered = sentence.toLowerCase();

  const tidy = /(tidy|organis|organiz|sort|file|clean)/u.test(lowered);
  if (tidy) {
    return {
      name: shortcutName(sentence),
      actions: [
        { kind: "comment", text: `Made by Rellane from: "${sentence.trim()}"` },
        { kind: "getFolder", path: context.folder },
        { kind: "getFilesInFolder" },
        { kind: "moveTo", path: `${context.folder}/Documents` },
        {
          kind: "notify",
          title: "Rellane",
          body: "Filed the loose documents in your folder."
        }
      ]
    };
  }

  const notify = /(remind|notify|tell me|alert)/u.test(lowered);
  if (notify) {
    return {
      name: shortcutName(sentence),
      actions: [
        { kind: "comment", text: `Made by Rellane from: "${sentence.trim()}"` },
        { kind: "notify", title: "Rellane", body: sentence.trim() }
      ]
    };
  }

  return null;
}

/** A short, filesystem-safe name derived from what was asked for. */
export function shortcutName(sentence: string): string {
  const words = sentence
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .slice(0, 5);
  const name = words.join(" ").trim();
  return name.length === 0 ? "Rellane Shortcut" : name.replace(/^\w/u, (c) => c.toUpperCase());
}

/**
 * Checks a spec before it becomes a file.
 *
 * The gate exists because this artefact runs unattended and outside Rellane —
 * so anything wrong with it is discovered later, by the user, with no context.
 */
export function validate(spec: ShortcutSpec): { ok: true } | { ok: false; problem: string } {
  if (spec.name.trim().length === 0) {
    return { ok: false, problem: "A Shortcut needs a name." };
  }
  if (spec.name.includes("/")) {
    return { ok: false, problem: "A Shortcut name cannot contain a slash." };
  }
  if (spec.actions.length === 0) {
    return { ok: false, problem: "That would install a Shortcut that does nothing." };
  }
  for (const action of spec.actions) {
    if (IDENTIFIERS[action.kind] === undefined) {
      return { ok: false, problem: `Rellane does not know the action “${action.kind}”.` };
    }
  }
  return { ok: true };
}

/** Plain description of what the Shortcut will do, for the approval sheet. */
export function describeShortcut(spec: ShortcutSpec): readonly string[] {
  return spec.actions.map((action) => {
    switch (action.kind) {
      case "comment":
        return "Leave a note saying where it came from";
      case "getFolder":
        return `Look at ${action.path}`;
      case "getFilesInFolder":
        return "Take the files inside it";
      case "filterByExtension":
        return `Keep only ${action.extensions.join(", ")}`;
      case "moveTo":
        return `Move them to ${action.path}`;
      case "notify":
        return `Show a notification: “${action.body}”`;
      case "openApp":
        return `Open ${action.bundleId}`;
    }
  });
}
