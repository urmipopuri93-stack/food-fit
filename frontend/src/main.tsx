import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import App from "./App";
import Landing from "./Landing";
import HeatmapPage from "./HeatmapPage";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource-variable/inter";
import "@fontsource-variable/pixelify-sans";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/dashboard" element={<App />} />
        <Route path="/map" element={<HeatmapPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
