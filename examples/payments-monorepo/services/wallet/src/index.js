import express from "express";
import { setupWalletEventListeners } from "./setupWalletEventListeners.js";
import router from "./routers/client.js";
const app = express(); app.use("/v1/deposits", router); setupWalletEventListeners();
