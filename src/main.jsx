import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CoupleStampCard from "../couple-stamp-card.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <CoupleStampCard />
  </StrictMode>,
);
