import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { installCardNumberFit } from "./lib/fitCardNumbers";
import { installDisableNumberWheel } from "./lib/disableNumberWheel";

installCardNumberFit();
installDisableNumberWheel();

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
