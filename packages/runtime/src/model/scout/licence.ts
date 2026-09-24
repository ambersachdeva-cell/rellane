/**
 * Can this model ship inside a product someone sells?
 *
 * This is a real hazard, not a formality. Two models that a scout would
 * otherwise rank highly are non-commercial: `Salesforce/xLAM-7b-fc-r` is
 * `cc-by-nc-4.0` and `vikp/surya_layout` is `cc-by-nc-sa-4.0`. Both were
 * verified against the Hugging Face API on 2026-08-21. Neither announces the
 * restriction anywhere a user would look.
 *
 * A language model's memory of licences is not trustworthy either — during
 * research one confidently reported `surya_layout` as GPL-3.0. So this reads
 * the tag the API actually returns and classifies it by table, never by
 * inference.
 */

export type LicenceClass =
  /** Permissive. Safe to ship commercially with attribution. */
  | "permissive"
  /** Usable commercially but with conditions worth reading (source sharing, use limits). */
  | "conditional"
  /** Forbids commercial use. Must not be installed into a product that is sold. */
  | "non-commercial"
  /** Copyleft that can reach your own source if linked or served. */
  | "copyleft"
  /** No licence tag at all — treat as unknown rights, which is not the same as permitted. */
  | "unknown";

interface LicenceFacts {
  readonly klass: LicenceClass;
  readonly label: string;
  readonly note: string;
}

/**
 * Keyed on the bare SPDX-ish id Hugging Face puts in its `license:` tag.
 * Deliberately explicit — an unrecognised id falls through to "unknown" rather
 * than being guessed at from its shape.
 */
const TABLE: Readonly<Record<string, LicenceFacts>> = Object.freeze({
  "apache-2.0": { klass: "permissive", label: "Apache 2.0", note: "Ship it. Keep the notice file." },
  mit: { klass: "permissive", label: "MIT", note: "Ship it. Keep the notice file." },
  "bsd-3-clause": { klass: "permissive", label: "BSD 3-Clause", note: "Ship it. Keep the notice file." },
  "bsd-2-clause": { klass: "permissive", label: "BSD 2-Clause", note: "Ship it. Keep the notice file." },
  "cc-by-4.0": { klass: "permissive", label: "CC BY 4.0", note: "Commercial use allowed with attribution." },
  "cc0-1.0": { klass: "permissive", label: "CC0", note: "Public domain dedication." },

  "llama3.1": { klass: "conditional", label: "Llama 3.1 Community", note: "Commercial use allowed below a monthly-user threshold. Read it before selling." },
  "llama3.2": { klass: "conditional", label: "Llama 3.2 Community", note: "Commercial use allowed below a monthly-user threshold. Read it before selling." },
  "llama3.3": { klass: "conditional", label: "Llama 3.3 Community", note: "Commercial use allowed below a monthly-user threshold. Read it before selling." },
  gemma: { klass: "conditional", label: "Gemma Terms", note: "Commercial use allowed, subject to a prohibited-use policy." },
  "openrail++": { klass: "conditional", label: "OpenRAIL++", note: "Commercial use allowed, with binding use restrictions." },
  openrail: { klass: "conditional", label: "OpenRAIL", note: "Commercial use allowed, with binding use restrictions." },

  "cc-by-nc-4.0": { klass: "non-commercial", label: "CC BY-NC 4.0", note: "Non-commercial only. Cannot ship in a product you sell." },
  "cc-by-nc-sa-4.0": { klass: "non-commercial", label: "CC BY-NC-SA 4.0", note: "Non-commercial only. Cannot ship in a product you sell." },
  "cc-by-nc-nd-4.0": { klass: "non-commercial", label: "CC BY-NC-ND 4.0", note: "Non-commercial, no derivatives." },
  "mistral-research": { klass: "non-commercial", label: "Mistral Research", note: "Research only. A separate licence is required to sell." },

  "gpl-3.0": { klass: "copyleft", label: "GPL 3.0", note: "Linking this can oblige you to publish your own source." },
  "agpl-3.0": { klass: "copyleft", label: "AGPL 3.0", note: "Serving this over a network can oblige you to publish your own source." },
  "lgpl-3.0": { klass: "copyleft", label: "LGPL 3.0", note: "Weaker copyleft, but dynamic linking terms still apply." }
});

export interface LicenceVerdict extends LicenceFacts {
  readonly id: string | null;
  /** False means: do not install this into a build that will be sold. */
  readonly commercialSafe: boolean;
}

/** Reads the `license:<id>` tag out of a Hugging Face tag list. */
export function licenceIdFromTags(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith("license:")) {
      const id = tag.slice("license:".length).trim().toLowerCase();
      return id.length > 0 ? id : null;
    }
  }
  return null;
}

export function classifyLicence(id: string | null): LicenceVerdict {
  if (id === null) {
    return {
      id: null,
      klass: "unknown",
      label: "No licence stated",
      note: "The model does not declare a licence. Absence of terms is not permission.",
      commercialSafe: false
    };
  }
  const facts = TABLE[id];
  if (facts === undefined) {
    return {
      id,
      klass: "unknown",
      label: id,
      note: "This licence is not one Rellane recognises. Read it before shipping.",
      commercialSafe: false
    };
  }
  return {
    id,
    ...facts,
    commercialSafe: facts.klass === "permissive" || facts.klass === "conditional"
  };
}

export function classifyFromTags(tags: readonly string[]): LicenceVerdict {
  return classifyLicence(licenceIdFromTags(tags));
}
