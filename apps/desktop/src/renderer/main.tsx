import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";
// katex ships its own stylesheet and its output is unreadable without it — the
// fractions, radicals and spacing are all CSS. Bundled, never fetched.
import "katex/dist/katex.min.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Rellane renderer root is missing.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
