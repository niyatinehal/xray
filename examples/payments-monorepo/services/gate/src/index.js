import express from "express";
import clientRouter from "./routers/client.js";
import publicRouter from "./routers/public.js";
const app = express();
app.use("/v1/checkouts", clientRouter);
app.use("/public", publicRouter);
export default app;
