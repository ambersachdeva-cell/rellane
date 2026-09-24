import { describe, expect, it } from "vitest";
import {
  MAX_PAGE_BYTES,
  MAX_TEXT_CHARS,
  readWebPage,
  whyUrlRefused
} from "./web-read.js";

function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("whyUrlRefused", () => {
  it("refuses private network addresses across all protected ranges", () => {
    const targets = [
      "http://localhost",
      "http://sub.localhost:8080/",
      "http://127.0.0.1",
      "http://127.0.0.5:3000/",
      "http://[::1]",
      "http://169.254.0.1",
      "http://10.0.0.1",
      "http://172.16.0.1",
      "http://172.31.255.255/",
      "http://192.168.0.1",
      "http://router.local"
    ];

    for (const target of targets) {
      expect(whyUrlRefused(target)).toBe(
        "Web addresses pointing to your local network are not allowed."
      );
    }
  });

  it("refuses direct IP literals", () => {
    expect(whyUrlRefused("http://8.8.8.8")).toBe(
      "Web addresses cannot use an IP address directly."
    );
  });

  it("refuses URLs with credentials", () => {
    expect(whyUrlRefused("https://alice:secret@example.com/notes")).toBe(
      "Web addresses containing usernames or passwords cannot be used."
    );
  });

  it("refuses non-http schemes", () => {
    expect(whyUrlRefused("ftp://example.com/resource")).toBe(
      "Only web addresses starting with http:// or https:// can be read."
    );
    expect(whyUrlRefused("file:///etc/passwd")).toBe(
      "Only web addresses starting with http:// or https:// can be read."
    );
  });

  it("refuses URLs exceeding 2,000 characters", () => {
    const excessive = `https://example.com/${"a".repeat(2001)}`;
    expect(whyUrlRefused(excessive)).toBe(
      "Web addresses cannot be longer than 2,000 characters."
    );
  });

  it("accepts valid public web addresses", () => {
    expect(whyUrlRefused("https://example.com/article")).toBeNull();
  });
});

describe("readWebPage", () => {
  it("refuses a redirect chain landing on a private address without fetching it", async () => {
    const fetchedUrls: string[] = [];
    const restore = mockFetch(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      fetchedUrls.push(url);
      if (url === "https://example.com/gateway") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://192.168.1.1/admin" }
        });
      }
      return new Response("private", { status: 200 });
    });

    try {
      const outcome = await readWebPage("https://example.com/gateway", 1_700_000_000_000);
      expect(outcome).toEqual({
        status: "refused",
        reason: "Web addresses pointing to your local network are not allowed."
      });
      expect(fetchedUrls).toEqual(["https://example.com/gateway"]);
    } finally {
      restore();
    }
  });

  it("follows redirects and reports the final destination URL", async () => {
    const restore = mockFetch(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "https://example.com/hop1") {
        return new Response(null, {
          status: 301,
          headers: { Location: "https://example.com/final-article" }
        });
      }
      return new Response("<html><head><title>Final Page</title></head><body><p>Arrived.</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    });

    try {
      const outcome = await readWebPage("https://example.com/hop1", 1_700_000_000_000);
      expect(outcome.status).toBe("read");
      if (outcome.status === "read") {
        expect(outcome.url).toBe("https://example.com/final-article");
        expect(outcome.title).toBe("Final Page");
        expect(outcome.text).toBe("Arrived.");
      }
    } finally {
      restore();
    }
  });

  it("decodes HTML entities and strips chrome, scripts and styling", async () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Market Overview</title>
  <script>console.log("secret");</script>
  <style>body { color: red; }</style>
</head>
<body>
  <header><nav>Home &gt; Reports</nav></header>
  <h1>Market Overview</h1>
  <p>Output rose &mdash; matching &quot;forecasts&quot; &copy; 2026.</p>
  <aside>Ads</aside>
  <footer>Copyright 2026</footer>
</body>
</html>`;

    const restore = mockFetch(async () => {
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    });

    try {
      const outcome = await readWebPage("https://example.com/report", 1_700_000_000_000);
      expect(outcome.status).toBe("read");
      if (outcome.status === "read") {
        expect(outcome.title).toBe("Market Overview");
        expect(outcome.text).toContain('Output rose — matching "forecasts" © 2026.');
        expect(outcome.text).not.toContain("secret");
        expect(outcome.text).not.toContain("Home > Reports");
        expect(outcome.text).not.toContain("Ads");
      }
    } finally {
      restore();
    }
  });

  it("sets the truncated flag when extracted text exceeds character limits", async () => {
    const longParagraph = `<p>${"word ".repeat(30_000)}</p>`;
    const restore = mockFetch(async () => {
      return new Response(longParagraph, {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    });

    try {
      const outcome = await readWebPage("https://example.com/huge", 1_700_000_000_000);
      expect(outcome.status).toBe("read");
      if (outcome.status === "read") {
        expect(outcome.truncated).toBe(true);
        expect(outcome.text.length).toBe(MAX_TEXT_CHARS);
      }
    } finally {
      restore();
    }
  });

  it("reads plain text files using the host as the title", async () => {
    const plainText = "First line of notes.\n\nSecond paragraph of notes.";
    const restore = mockFetch(async () => {
      return new Response(plainText, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    });

    try {
      const outcome = await readWebPage("https://example.com/notes.txt", 1_700_000_000_000);
      expect(outcome.status).toBe("read");
      if (outcome.status === "read") {
        expect(outcome.title).toBe("example.com");
        expect(outcome.text).toBe(plainText);
        expect(outcome.truncated).toBe(false);
      }
    } finally {
      restore();
    }
  });
});
