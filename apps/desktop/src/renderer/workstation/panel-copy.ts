export type PanelId =
  | "sessions"
  | "crew"
  | "dispatch"
  | "agents"
  | "agent-editor"
  | "files"
  | "data"
  | "chart"
  | "search"
  | "insights"
  | "publish"
  | "pairing"
  | "knowledge"
  | "connectors"
  | "usage"
  | "diagnostics";

export interface PanelCopy {
  readonly empty: {
    readonly lead: string;
    readonly detail: string;
    readonly action: string | null;
  };
  readonly loading: string;
  readonly failed: string;
}

const FALLBACK_COPY: PanelCopy = {
  empty: {
    lead: "Nothing here yet.",
    detail: "When you start something, it will appear here.",
    action: null,
  },
  loading: "Looking this up.",
  failed: "Could not load this panel.",
};

export const PANEL_COPY: Readonly<Record<PanelId, PanelCopy>> = {
  sessions: {
    empty: {
      lead: "No conversations yet.",
      detail: "Start a new case to ask your subscriptions a question.",
      action: "New case",
    },
    loading: "Opening your conversations.",
    failed: "Could not load your conversations.",
  },
  crew: {
    empty: {
      lead: "No team run yet.",
      detail: "Choose two or more subscriptions to divide a task between them.",
      action: "Start a run",
    },
    loading: "Checking team progress.",
    failed: "Could not load the team run.",
  },
  dispatch: {
    empty: {
      lead: "No plan created.",
      detail: "Send a task to see it divided into steps for your subscriptions.",
      action: "Create a plan",
    },
    loading: "Planning the steps.",
    failed: "Could not load the plan.",
  },
  agents: {
    empty: {
      lead: "No custom helpers yet.",
      detail: "Create your own helper by writing instructions in plain words.",
      action: "Create a helper",
    },
    loading: "Loading your helpers.",
    failed: "Could not load your helpers.",
  },
  "agent-editor": {
    empty: {
      lead: "No helper selected.",
      detail: "Pick a helper from the list or create one to edit its instructions.",
      action: "New helper",
    },
    loading: "Opening the editor.",
    failed: "Could not load this helper.",
  },
  files: {
    empty: {
      lead: "No files attached.",
      detail: "Add documents or notes here so your subscriptions can read them.",
      action: "Add a file",
    },
    loading: "Reading your files.",
    failed: "Could not load your files.",
  },
  data: {
    empty: {
      lead: "No tables here yet.",
      detail: "Bring in a spreadsheet to inspect your business numbers.",
      action: "Add a table",
    },
    loading: "Loading your numbers.",
    failed: "Could not read this table.",
  },
  chart: {
    empty: {
      lead: "No chart to show.",
      detail: "Select a table with numbers to see a visual summary.",
      action: "Pick numbers",
    },
    loading: "Drawing your chart.",
    failed: "Could not draw this chart.",
  },
  search: {
    empty: {
      lead: "No matches found.",
      detail: "Try different words to find notes, cases, or answers.",
      action: "Clear search",
    },
    loading: "Searching your cases.",
    failed: "Could not complete this search.",
  },
  insights: {
    empty: {
      lead: "No findings yet.",
      detail: "When your subscriptions review each other, what they learn will show here.",
      action: null,
    },
    loading: "Gathering findings.",
    failed: "Could not load findings.",
  },
  publish: {
    empty: {
      lead: "Nothing ready to share.",
      detail: "Pick an answer or document to prepare it as a clean report.",
      action: "Choose an answer",
    },
    loading: "Preparing your document.",
    failed: "Could not prepare this document.",
  },
  pairing: {
    empty: {
      lead: "No phone connected.",
      detail: "Connect your phone to check progress or stop a run when away.",
      action: "Connect your phone",
    },
    loading: "Checking connection.",
    failed: "Could not check connection.",
  },
  knowledge: {
    empty: {
      lead: "No facts stored yet.",
      detail: "Save important details about your work so future runs remember them.",
      action: "Add a note",
    },
    loading: "Reading stored notes.",
    failed: "Could not load stored notes.",
  },
  connectors: {
    empty: {
      lead: "No subscriptions found.",
      detail: "Sign in to your tools on this Mac to let them answer questions.",
      action: "Check sign in",
    },
    loading: "Checking installed tools.",
    failed: "Could not check your tools.",
  },
  usage: {
    empty: {
      lead: "Nothing asked yet.",
      detail: "Once you have sent something to a subscription, what you have used will show here.",
      action: "Start something",
    },
    loading: "Reading your receipts.",
    failed: "Could not load your usage.",
  },
  diagnostics: {
    empty: {
      lead: "No checks run yet.",
      detail: "Run a check to see which tools and subscriptions are working on this Mac.",
      action: "Run all checks",
    },
    loading: "Checking your system.",
    failed: "Could not run diagnostics.",
  },
};

export function copyFor(panel: PanelId): PanelCopy {
  const resolved = PANEL_COPY[panel];
  if (resolved !== undefined) {
    return resolved;
  }
  // Safe fallback avoids unexpected runtime errors if passed an unregistered identifier
  return FALLBACK_COPY;
}
