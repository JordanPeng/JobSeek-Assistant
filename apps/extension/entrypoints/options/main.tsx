import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";

import { OptionsApp } from "./OptionsApp";
import "./style.css";

const root = document.querySelector("#root");
if (!root) throw new Error("Options root element is missing.");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <OptionsApp />
  </React.StrictMode>,
);
