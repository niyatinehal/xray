import express from "express";
import { setupGpsEventListeners } from "./setupGpsEventListeners.js";
import apiRouter from "./routers/api.js";
const app = express();
app.use("/v1", apiRouter);
setupGpsEventListeners();
export default app;
