import express from "express";
import { setupCommonEventListeners } from "./setupCommonEventListeners.js";
import authRouter from "./routers/authRouter.js";
const app = express(); app.use("/v1/auth", authRouter); setupCommonEventListeners();
