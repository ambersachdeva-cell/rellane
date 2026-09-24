/**
 * Every screen of the loop, with fixtures, in a browser.
 *
 * THE-PLAN closed with a note that has been outstanding since: *"I could not
 * screenshot the running app… A visual review is still outstanding."* Two of
 * these screens were built, reviewed by a second model, and shipped without
 * anybody ever looking at them, which is how a product ends up correct and
 * unusable at the same time.
 *
 * The running app cannot easily be driven to an arbitrary screen — Electron's
 * accessibility bridge exposes the buttons but `AXPress` does not reach React —
 * so this renders the same components against the same stylesheets, with data
 * shaped like a real print shop's.
 *
 * ## It is not part of any build
 *
 * `vite.config.ts` lists `index.html` and `overlay.html` and nothing else, so
 * this page exists only under `npm run dev`. It ships in no bundle and the main
 * process has no route to it. Every callback below is inert: this is a page for
 * looking at, and a harness that could write to a book would eventually be
 * pointed at a real one.
 */

import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Deal, DealSummary, TodayItem } from "@cadrane/contracts";
import { TodayView } from "./components/TodayView.js";
import { DealsView } from "./components/DealsView.js";
import { DealRoom } from "./components/DealRoom.js";
import { ShopName } from "./components/ShopName.js";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/app.css";
import "./styles/review.css";

const NOW = Date.parse("2026-09-13T10:00:00.000Z");
const DAY = 86_400_000;
const nothing = async (): Promise<void> => undefined;

const TODAY: readonly TodayItem[] = [
  {
    kind: "quotation",
    id: "q2",
    line: "Gupta Sweets has had the quote for 9 days with no answer.",
    severity: "urgent",
    days: 9
  },
  {
    kind: "enquiry",
    id: "e1",
    line: "Verma Textiles asked for a price 3 days ago and has not had one.",
    severity: "urgent",
    days: 3
  },
  {
    kind: "enquiry",
    id: "e7",
    line: "Somebody who came in asked for a price 1 day ago and has not had one.",
    severity: "warning",
    days: 1
  }
];

const DEALS: readonly DealSummary[] = [
  {
    enquiryId: "e1",
    channel: "whatsapp",
    receivedAt: NOW - 3 * DAY,
    partyName: "Verma Textiles",
    triage: "real",
    excerpt: "bhai 500 visiting cards banwane hain, 300 gsm matte, dono side printing. rate kya…",
    state: null,
    totalPaise: null,
    closedAt: null,
    closedReason: null
  },
  {
    enquiryId: "e2",
    channel: "indiamart",
    receivedAt: NOW - 9 * DAY,
    partyName: "Gupta Sweets",
    triage: "real",
    excerpt: "Requirement: 2000 brochures, A4 tri-fold, 170 gsm art paper, 4 colour both sides.",
    state: "sent",
    totalPaise: 3_422_000,
    closedAt: null,
    closedReason: null
  },
  {
    enquiryId: "e3",
    channel: "phone",
    receivedAt: NOW - 12 * DAY,
    partyName: "Rao & Sons",
    triage: "real",
    excerpt: "Wedding card 250 pieces, gold foil, maroon envelope. Samples dekhne aayenge…",
    state: "won",
    totalPaise: 1_050_000,
    closedAt: NOW - 8 * DAY,
    closedReason: "Came in on Saturday, liked the second sample, paid half up front"
  },
  {
    enquiryId: "e4",
    channel: "whatsapp",
    receivedAt: NOW - 21 * DAY,
    partyName: "Mehra Interiors",
    triage: "real",
    excerpt: "Flex banner 10x4 feet, 2 nos, for shop opening. Kitna hoga?",
    state: "lost",
    totalPaise: 192_000,
    closedAt: NOW - 15 * DAY,
    closedReason: "Went with the shop near the station, they did it same day"
  },
  {
    enquiryId: "e5",
    channel: "email",
    receivedAt: NOW - 30 * DAY,
    partyName: null,
    triage: "real",
    excerpt: "Letterheads 1000 nos, 100 gsm bond, single colour. Also need 500 envelopes…",
    state: "no_reply",
    totalPaise: 525_000,
    closedAt: NOW - 9 * DAY,
    closedReason: "Sent the rate, followed up twice, nothing since"
  },
  {
    enquiryId: "e6",
    channel: "email",
    receivedAt: NOW - 5 * DAY,
    partyName: null,
    triage: "junk",
    excerpt: "Boost your business with our premium SEO and digital marketing package!!",
    state: null,
    totalPaise: null,
    closedAt: null,
    closedReason: null
  }
];

const SENT: Deal = {
  enquiryId: "e2",
  channel: "indiamart",
  receivedAt: NOW - 9 * DAY,
  rawText:
    "Requirement: 2000 brochures, A4 tri-fold, 170 gsm art paper, 4 colour both sides.\n\nPlease share best rate and delivery timeline. We need delivery before the 25th for a trade fair.\n\nRegards,\nGupta Sweets, Karol Bagh",
  partyId: "p2",
  partyName: "Gupta Sweets",
  partyPhone: "98765 43210",
  triage: "real",
  quotation: {
    quotationId: "q2",
    state: "sent",
    gstRateBp: 1800,
    draftedAt: NOW - 9 * DAY,
    sentAt: NOW - 9 * DAY,
    closedAt: null,
    closedReason: null,
    lines: [
      {
        id: "l1",
        position: 1,
        description: "2000 A4 tri-fold brochures, 170 gsm art paper, 4 colour both sides",
        quantity: 2000,
        unit: "pcs",
        unitPricePaise: 1450,
        linePaise: 2_900_000
      }
    ],
    netPaise: 2_900_000,
    totalPaise: 3_422_000
  }
} as Deal;

const DRAFT: Deal = {
  ...SENT,
  enquiryId: "e8",
  quotation: {
    ...SENT.quotation!,
    quotationId: "q8",
    state: "draft",
    sentAt: null,
    lines: [
      {
        id: "l1",
        position: 1,
        description: "2000 A4 tri-fold brochures, 170 gsm art paper, 4 colour both sides",
        quantity: 2000,
        unit: "pcs",
        unitPricePaise: 1450,
        linePaise: 2_900_000
      },
      {
        id: "l2",
        position: 2,
        description: "Lamination, matte, both sides",
        quantity: 2000,
        unit: "pcs",
        unitPricePaise: 180,
        linePaise: 360_000
      }
    ],
    netPaise: 3_260_000,
    totalPaise: 3_846_800
  }
} as Deal;

const FRESH: Deal = {
  ...SENT,
  enquiryId: "e1",
  channel: "whatsapp",
  receivedAt: NOW - 3 * DAY,
  rawText:
    "bhai 500 visiting cards banwane hain, 300 gsm matte, dono side printing. rate kya lagega? thursday tak chahiye",
  partyName: "Verma Textiles",
  quotation: null
} as Deal;

function Screen({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="review__screen">
      <h2 className="review__label">{title}</h2>
      <p className="review__note">{note}</p>
      <div className="review__frame">
        <div className="review__work">{children}</div>
      </div>
    </section>
  );
}

/**
 * One screen at a time, chosen by `?only=`.
 *
 * A single long page is easier to write and impossible to photograph: the
 * screenshot tool captures the top of the document whatever the page is
 * scrolled to. Each screen gets its own address instead.
 */
const ONLY = new URLSearchParams(window.location.search).get("only");
const showing = (id: string): boolean => ONLY === null || ONLY === id;

function Review() {
  return (
    <div className="review">
      {!showing("today") ? null : <Screen title="Today" note="A shop with three things waiting. Urgent takes the danger hue; nothing else on the screen competes with it.">
        <TodayView
          items={TODAY}
          freshBook={false}
          onOpen={() => undefined}
          onRefresh={() => undefined}
          onAddEnquiry={nothing}
        />
      </Screen>}

      {!showing("first") ? null : <Screen title="Today — a first morning" note="An empty book. The loop in three sentences, a worked example, and the form already open.">
        <TodayView
          items={[]}
          freshBook
          onOpen={() => undefined}
          onRefresh={() => undefined}
          onAddEnquiry={nothing}
        />
      </Screen>}

      {!showing("deals") ? null : <Screen title="Enquiries" note="Every one the shop has had and what came of it. Only an ending takes colour; the owner's reason sits with the row it belongs to.">
        <DealsView deals={DEALS} more={false} now={NOW} onOpen={() => undefined} />
      </Screen>}

      {!showing("fresh") ? null : <Screen title="A deal with nothing priced" note="The customer's words on the left, and the two things that can be done about them on the right.">
        <DealRoom
          deal={FRESH}
          now={NOW}
          backTo="Enquiries"
          onBack={() => undefined}
          onDraft={() => undefined}
          onReadEnquiry={async () => ({ lines: [], said: "" })}
          onAddLine={nothing}
          onRemoveLine={nothing}
          onRecall={async (like) =>
            like.toLowerCase().includes("visiting")
              ? [
                  {
                    description: "500 visiting cards, 300 gsm matte, both sides",
                    quantity: 500,
                    unit: "pcs",
                    unitPricePaise: 450,
                    at: NOW - 23 * DAY,
                    partyName: "Rao & Sons"
                  },
                  {
                    description: "1000 visiting cards, 300 gsm matte",
                    quantity: 1000,
                    unit: "pcs",
                    unitPricePaise: 380,
                    at: NOW - 96 * DAY,
                    partyName: "Mehra Interiors"
                  }
                ]
              : []
          }
          onMessage={async () => null}
          onSend={() => undefined}
          onClose={() => undefined}
          onSetCustomer={nothing}
          onTriage={() => undefined}
          onModels={() => undefined}
          onWhatsApp={async () => ({ said: "", canAdd: false })}
          onAllowCustomer={async () => ""}
        />
      </Screen>}

      {!showing("shop") ? null : <Screen title="Your shop, in Settings" note="The only setting on that screen a customer ever sees. Blank is allowed and means the quotation goes out unsigned.">
        <div className="settings">
          <section className="section">
            <h3 className="section__title">Your shop</h3>
            <ShopName name="" onSave={() => undefined} />
          </section>
          <section className="section">
            <h3 className="section__title">Your shop, filled in</h3>
            <ShopName name="Sachdeva Printers" onSave={() => undefined} />
          </section>
        </div>
      </Screen>}

      {!showing("draft") ? null : <Screen title="A draft being priced" note="Two lines and a rate the owner typed. Each line can come back off while it is still a draft; once it is sent it cannot.">
        <DealRoom
          deal={DRAFT}
          now={NOW}
          backTo="Enquiries"
          onBack={() => undefined}
          onDraft={() => undefined}
          onReadEnquiry={async () => ({ lines: [], said: "" })}
          onAddLine={nothing}
          onRemoveLine={nothing}
          onRecall={async (like) =>
            like.toLowerCase().includes("visiting")
              ? [
                  {
                    description: "500 visiting cards, 300 gsm matte, both sides",
                    quantity: 500,
                    unit: "pcs",
                    unitPricePaise: 450,
                    at: NOW - 23 * DAY,
                    partyName: "Rao & Sons"
                  },
                  {
                    description: "1000 visiting cards, 300 gsm matte",
                    quantity: 1000,
                    unit: "pcs",
                    unitPricePaise: 380,
                    at: NOW - 96 * DAY,
                    partyName: "Mehra Interiors"
                  }
                ]
              : []
          }
          onMessage={async () => null}
          onSend={() => undefined}
          onClose={() => undefined}
          onSetCustomer={nothing}
          onTriage={() => undefined}
          onModels={() => undefined}
          onWhatsApp={async () => ({ said: "", canAdd: false })}
          onAllowCustomer={async () => ""}
        />
      </Screen>}

      {!showing("sent") ? null : <Screen title="A deal sent and waiting" note="Priced, sent, and unanswered for nine days. The outcome dock is pinned and does not scroll.">
        <DealRoom
          deal={SENT}
          now={NOW}
          backTo="Today"
          onBack={() => undefined}
          onDraft={() => undefined}
          onReadEnquiry={async () => ({ lines: [], said: "" })}
          onAddLine={nothing}
          onRemoveLine={nothing}
          onRecall={async (like) =>
            like.toLowerCase().includes("visiting")
              ? [
                  {
                    description: "500 visiting cards, 300 gsm matte, both sides",
                    quantity: 500,
                    unit: "pcs",
                    unitPricePaise: 450,
                    at: NOW - 23 * DAY,
                    partyName: "Rao & Sons"
                  },
                  {
                    description: "1000 visiting cards, 300 gsm matte",
                    quantity: 1000,
                    unit: "pcs",
                    unitPricePaise: 380,
                    at: NOW - 96 * DAY,
                    partyName: "Mehra Interiors"
                  }
                ]
              : []
          }
          onMessage={async () => null}
          onSend={() => undefined}
          onClose={() => undefined}
          onSetCustomer={nothing}
          onTriage={() => undefined}
          onModels={() => undefined}
          onWhatsApp={async () => ({ said: "", canAdd: false })}
          onAllowCustomer={async () => ""}
        />
      </Screen>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Review />
  </StrictMode>
);
