import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { BrandProvider } from "@/brand/BrandContext";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <BrandProvider>
        <App />
      </BrandProvider>
    </BrowserRouter>
  </StrictMode>,
);
