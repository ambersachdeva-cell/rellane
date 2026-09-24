/** Keep new work visible through layout changes, while letting a reader stay in history. */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";

export function useConversationScroll(viewKey: string | undefined, empty: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  const nearBottom = useCallback(() => {
    const el = viewport.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  const sync = useCallback(() => {
    const el = viewport.current;
    if (!el || el.clientHeight === 0) return;
    if (following.current) {
      // Instant movement avoids a queued smooth scroll fighting a stream or user input.
      el.scrollTop = el.scrollHeight;
      setShowLatest(false);
    } else setShowLatest(!nearBottom());
  }, [nearBottom]);

  const latest = useCallback(() => { following.current = true; sync(); }, [sync]);
  const pause = useCallback(() => { following.current = false; }, []);

  // React layout changes (including a file review) must settle before browser scroll events.
  useLayoutEffect(sync);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [viewKey, empty, sync]);

  const onScroll = useCallback(() => {
    if (nearBottom()) { following.current = true; setShowLatest(false); }
    else if (!following.current) setShowLatest(true);
    // A shorter viewport is not a request to stop following. Input handlers below
    // distinguish moving through history from a permission panel changing the layout.
  }, [nearBottom]);
  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) pause();
  }, [pause]);
  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (event.clientX >= el.getBoundingClientRect().right - 16) pause();
  }, [pause]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pause();
    if (event.key === "End") { event.preventDefault(); latest(); }
  }, [latest, pause]);

  return { viewport, latest, showLatest, onScroll, onWheel, onPointerDown, onKeyDown, onTouchMove: pause };
}
